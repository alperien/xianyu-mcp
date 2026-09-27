/** The eight tools. Capability split, all of it measured rather than assumed: browse_feed, search_count, search_suggest and related_items work with no account at all; item_view works, from the item *page*; search_items works but goofish declines some page loads, so it retries; recommendations works, with a feed fallback; capabilities never raises, even if the browser is gone. Nothing that touches the page goes through anything but browser.ts, so a Playwright failure arrives as a typed XianyuError rather than escaping a tool call. */
import { z } from 'zod';
import type { Page } from 'playwright';
import { BrowserError, DetailUnavailableError, describe, GatedError, NavigationError, ParseError, SearchUnavailableError, XianyuError } from './errors.ts';
import { ensureGoofishUrl, evaluate, getSession, HOME, reloadFresh, settle } from './browser.ts';
import { FEED_NORMALIZE_JS, ITEM_SCRAPE_JS, RAIL_MARKERS, SCROLL_TO_JS, SCRAPE_CARDS_JS, SEARCH_INPUT_JS, SEARCH_MARK, SEARCH_STATE_JS } from './extract.ts';
type Data = Record<string, any>;
// The five mtop endpoints this server is allowed to name. Recovered by extracting all 51 `mtop.*` names from goofish's own JS bundles (idle-pc/xy-site); reading the minified call sites gave the exact parameter shapes, which is what made these work first time. All five answer anonymously, and a test fails the build if any other mtop name appears.
const FEED_API = 'mtop.taobao.idlehome.home.webpc.feed';
// The match counter. The search page calls it with the same payload shape as search and reads `data.hitnum`, so it answers "how many items match this keyword" for a logged-out visitor even on the page loads where search is declined. This is the endpoint that makes keyword work possible without the search page: about 28,800 for "x220" (it drifts, 28,791 / 28,804 / 28,810 observed), 0 for nonsense.
const HITNUM_API = 'mtop.taobao.idle.filter.hitnum.pc.get';
const SUGGEST_API = 'mtop.taobao.idlemtopsearch.pc.search.suggest';
const RECOMMEND_API = 'mtop.taobao.idle.item.web.recommend.list';
const LOGINUSER_API = 'mtop.taobao.idlemessage.pc.loginuser.get';   // never used to act as a user: it exists only to *prove* the session is logged out
// pageSize is hardcoded to 30 in goofish's bundle and the endpoint rejects anything else with FAIL_BIZ_COMMON_PARAM_ILLEGAL, so `limit` is applied client-side after the call. A missing itemId is rejected outright, so the generic case uses goofish's own seed id -- what its bundle substitutes when there is no item context.
const RECOMMEND_PAGE_SIZE = 30, RECOMMEND_SEED_ITEM_ID = '809806779491';
// goofish's own feed runs out of pages long before this; the bound only exists so a nonsense page_number cannot become a nonsense request.
const MAX_PAGES = 25, MAX_LIMIT = 500, MAX_PAGE_NUMBER = 10_000;
// Every field item_view reports, in one place so the honesty contract (fields_present / fields_missing) and the scraper cannot drift apart. Exported, and a test asserts every entry is a key the scraper actually returns.
export const ITEM_FIELDS = ['title', 'price', 'want_count', 'browse_count', 'description', 'seller', 'seller_tenure_years', 'seller_items_sold', 'seller_positive_rate', 'image_urls'] as const;
// goofish renders anonymous pages as a coin flip: the same URL comes back fully rendered or as an empty shell. Retry a few times before calling it a failure. Reloads are cache-busted with a nonce, since a cached empty shell is exactly the failure to escape.
const RENDER_ATTEMPTS = 5, RENDER_SETTLE_MS = 3500;
const SEARCH_ATTEMPTS = 4, MAX_SEARCH_ATTEMPTS = 10;
const ITEM_READY_POLLS = 24;   // 6s of readiness polling, spent once per item_view call rather than once per attempt
// ---- search is not a URL, it is a keystroke. A 2x2x2 matrix (headed/headless x fresh/persistent
// profile x direct-URL/search-input), one fresh browser per cell, and the only cell that returned
// results was headed + fresh + the SPA's own search input: 30 cards, 29 of whose titles really
// contained the query. Every direct-URL cell -- headed included -- served 20 cards and zero query
// hits, i.e. the 猜你喜欢 rail. So the query is typed into the header input and submitted, and only
// the last attempt falls back to a URL, which is expected to be the rail and is expected to be
// refused. The homepage is also a 512-character footer-only shell for 8-14s before the app mounts,
// so "no input yet" is the normal first ten seconds and is a poll, not a verdict.
const SEARCH_INPUT_WAIT_MS = 15_000, SEARCH_RESULT_WAIT_MS = 32_000, SEARCH_TYPED_ATTEMPTS = 3;
// A result set is only believable if a *fraction* of the page's cards really match, not if one title happens to contain the query: a 40-card rail with 12 incidental hits and one match both pass a `hits > 0` test. 20% of the cards on the page, and never less than one.
const MIN_MATCH_FRACTION = 0.2;
// Ret strings that mean "goofish will not serve this to you", as opposed to a bug.
const GATE_MARKERS = ['mini_login', 'RGV587', 'FAIL_SYS_SESSION_EXPIRED', 'FAIL_SYS_TOKEN', 'ILLEGAL_ACCESS', 'TIMEOUT', '非法访问', '令牌过期'];
// The narrower list, for the one gate that means something specific: `session_state` is the whole point of `capabilities`, and a rate limit (RGV587) or a TIMEOUT says nothing about whether a session exists -- reporting those as proof of anonymity is how a throttled probe reads as a verified fact.
const NO_SESSION_MARKERS = ['SESSION_EXPIRED', 'TOKEN', '令牌过期'];

// ---------------------------------------------------------------- pure helpers
const clamp = (value: unknown, low: number, high: number): number => { const n = Number(value); return Number.isFinite(n) ? Math.max(low, Math.min(Math.trunc(n), high)) : low; };
const itemIdFromUrl = (url: unknown): string => String(url ?? '').match(/[?&]id=(\d+)/)?.[1] ?? '';
/** Accept a bare item id or a goofish item URL and return the bare digits. */
const normalizeItemId = (value: unknown): string => { const s = String(value ?? '').trim(); return itemIdFromUrl(s) || (/^\d+$/.test(s) ? s : ''); };
const requireQuery = (query: unknown): string => { const q = String(query ?? '').trim().replace(/\s+/g, ' '); if (!q) throw new XianyuError('query must not be empty'); return q; };
const buildSearchUrl = (query: string): string => `${HOME}search?q=${encodeURIComponent(query)}`;
const hasMarker = (ret: unknown, markers: string[]): boolean => markers.some((m) => String(ret ?? '').includes(m));
const isGated = (ret: unknown): boolean => hasMarker(ret, GATE_MARKERS);
/** Drop repeats by item id, falling back to the item URL for cards that have no id. */
const dedupe = (items: any[]): any[] => {
  const seen = new Set<string>();
  return items.filter((it) => { const key = it?.item_id || itemIdFromUrl(it?.url); if (!key || seen.has(key)) return false; seen.add(key); return true; });
};
const rankItems = (items: any[], limit: number): any[] => items.slice(0, limit).map((it, i) => ({ ...it, rank: i + 1 }));
/** "Non-empty" presence: an array is truthy in JS, so a gallery that never loaded must not be reported as if it were there. */
const present = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));
/** Wall-clock budget for one best-effort tool's retry *loop*, overridable via XIANYU_<NAME>_BUDGET_S, floored at 5s and capped at 600s: a floor keeps the tools usable, and a ceiling keeps the override from restoring the multi-minute hang the function exists to prevent. It does not bound the call -- a page load costs 10-25s on a slow link, and one already in flight runs to completion. Read per call, so a script can change it. */
export const budget = (name: string, defaultS: number): number => { const raw = process.env[`XIANYU_${name}_BUDGET_S`]; const n = Number(raw); return raw?.trim() && Number.isInteger(n) ? clamp(n, 5, 600) : defaultS; };
/** The one way this file reads the DOM. `Session.open` checks the allowlist on the URL it landed on, but that is point-in-time: `search_items` then polls for up to 14s and `item_view` for up to 6s before it reads anything, and the page can be moved off goofish in that window. So the check is repeated on the URL that is live *now*, in the same statement as the read, and every scraper goes through here. */
const scrape = (page: Page, fn: any, arg: any, what: string): Promise<any> => { ensureGoofishUrl(page.url()); return evaluate(page, fn, arg, what); };
// -------------------------------------------------------------------- the tools
/** Page through goofish's public homepage feed. The feed is personalised-by-anonymity rather than by keyword: each pageNumber returns a different slice of live inventory. Verified 8 pages / 157 unique listings, 0 duplicates, no rate limiting. */
const browseFeed = async ({ page_number = 1, pages = 1, limit = 60 }: FeedArgs): Promise<Data> => {
  const start = clamp(page_number, 1, MAX_PAGE_NUMBER);
  const wanted = Array.from({ length: clamp(pages, 1, MAX_PAGES) }, (_, i) => start + i);
  const session = getSession();
  const page = await session.ensureReady();
  const raw = await session.call(wanted.map((pn) => [`p${pn}`, FEED_API, { pageNumber: pn }] as [string, string, any]));
  const rows: any[] = [], pageReports: any[] = [];
  for (const pn of wanted) {
    const entry = raw?.[`p${pn}`] || {};
    if (!entry.ok) { pageReports.push({ page: pn, ok: false, ret: String(entry.ret || '') }); continue; }
    const cards = Array.isArray(entry.data?.cardList) ? entry.data.cardList : [];
    pageReports.push({ page: pn, ok: true, cards: cards.length });
    rows.push(...cards);
  }
  if (!rows.length) {
    // Nothing came back. A gate across every page is a refusal; anything else is more likely a shape change, and the two need different advice.
    const gated = pageReports.find((r) => isGated(r.ret));
    if (gated) throw new GatedError(`goofish refused the anonymous feed on every page of [${wanted}]: ${gated.ret}. It may be rate limiting this IP; wait a minute and retry.`);
    throw new ParseError(`feed returned no cards for pages [${wanted}]: ${JSON.stringify(pageReports)}. The card shape may have changed.`);
  }
  const normalized = await evaluate(page, FEED_NORMALIZE_JS, { rows: rows.map((r) => r?.cardData || r) }, 'feed normalization');
  const items = dedupe((normalized || []).filter((i: any) => i.item_id));
  if (!items.length) throw new ParseError(`feed returned cards but none had an item id -- the response shape likely changed. First card keys: ${Object.keys(rows[0] || {}).sort().slice(0, 12)}`);
  const ranked = rankItems(items, clamp(limit, 1, MAX_LIMIT));
  return { source: 'homepage_feed', account_required: false, requested_pages: wanted, page_reports: pageReports, raw_cards: rows.length, unique_items: items.length, count: ranked.length, items: ranked };
};

/** How many listings match a keyword. Uses the filter-counter endpoint the search page itself calls to populate its result count: it takes the same payload as search but is a different endpoint, so unlike search it is not subject to goofish's per-page-load declines. */
const searchCount = async ({ query }: CountArgs): Promise<Data> => {
  const q = requireQuery(query);
  const session = getSession();
  await session.ensureReady();
  const entry = (await session.call([['hitnum', HITNUM_API, { pageNumber: 1, keyword: q, rowsPerPage: 30, searchReqFromPage: 'pcSearch', extraFilterValue: '{}', userPositionJson: '{}', customDistance: '', customGps: '', gps: '' }]]))?.hitnum || {};
  if (!entry.ok) throw new GatedError(`goofish refused the match counter for ${JSON.stringify(q)}: ${entry.ret}`);
  const raw = entry.data?.hitnum, count = raw == null || raw === '' ? NaN : Number(raw);
  // A count that cannot be read is not a count of zero: a missing, null, 'oops' or '1,234' hitnum is a shape change, and answering "no matches" to "I don't know" is the one reply this tool must never make.
  if (!(count >= 0)) throw new ParseError(`match counter returned an unreadable hitnum for ${JSON.stringify(q)}: ${JSON.stringify(raw)}. data keys=${Object.keys(entry.data ?? {}).sort().slice(0, 10)}`);
  return { query: q, match_count: Math.trunc(count), has_matches: count > 0, account_required: false, source: 'filter_hitnum' };
};

/** goofish's own search-box autocomplete: turns "x220" into "x220笔记本" and friends, and is a cheap signal that a term is understood at all. */
const searchSuggest = async ({ query, limit = 20 }: SuggestArgs): Promise<Data> => {
  const q = requireQuery(query);
  const session = getSession();
  await session.ensureReady();
  const entry = (await session.call([['sug', SUGGEST_API, { inputWords: q, searchReqFromPage: 'xyPcHome', bucketId: 30, type: 0 }]]))?.sug || {};
  if (!entry.ok) throw new GatedError(`goofish refused the suggestion endpoint for ${JSON.stringify(q)}: ${entry.ret}`);
  const data = entry.data || {}, seen = new Set<string>(), suggestions: any[] = [];
  if (data.items != null && !Array.isArray(data.items)) throw new ParseError(`suggestion payload has a non-list \`items\` (${typeof data.items}); the response shape likely changed. data keys=${Object.keys(data).sort().slice(0, 10)}`);
  for (const it of data.items || []) {
    const text = String(it?.suggest || it?.title || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    suggestions.push({ text, bucket_num: it?.bucketNum ?? null });
  }
  const trimmed = suggestions.slice(0, clamp(limit, 1, MAX_LIMIT));
  return { query: q, account_required: false, source: 'search_suggest', total_count: Number.isInteger(data.totalCount) ? data.totalCount : null, count: trimmed.length, suggestions: trimmed };
};

/** Listings goofish recommends for a given item ("more like this"), or its generic recommendation set when item_id is omitted -- which is what the page itself requests. The cards are the same shapes the homepage feed returns, so they go through the same normalizer. */
const relatedItems = async ({ item_id, limit = 30, page = 1 }: RelatedArgs): Promise<Data> => {
  const iid = item_id ? normalizeItemId(item_id) : '';
  const session = getSession(), pg = await session.ensureReady();
  const entry = (await session.call([['rec', RECOMMEND_API, { itemId: iid || RECOMMEND_SEED_ITEM_ID, categoryId: '', pageNum: clamp(page, 1, MAX_PAGE_NUMBER), pageSize: RECOMMEND_PAGE_SIZE, reqFrom: 'xianyuweb' }]]))?.rec || {};
  if (!entry.ok) throw new GatedError(`goofish refused the recommendation endpoint: ${entry.ret}`);
  const payload = entry.data || {}, cards = Array.isArray(payload.cardList) ? payload.cardList : [];
  if (!cards.length) throw new ParseError(`recommendation endpoint returned no cards for item ${iid || '(generic)'}: keys=${Object.keys(payload).sort().slice(0, 10)}`);
  const normalized = await evaluate(pg, FEED_NORMALIZE_JS, { rows: cards.map((c: any) => c?.cardData || c) }, 'recommendation normalizer');
  const items = dedupe((normalized || []).filter((i: any) => i.item_id));
  if (!items.length) throw new ParseError('recommendation cards had no item ids; the payload shape likely changed');
  const ranked = rankItems(items, clamp(limit, 1, MAX_LIMIT));
  return { item_id: iid || null, page: clamp(page, 1, MAX_PAGE_NUMBER), account_required: false, source: 'item_web_recommend', raw_cards: cards.length, unique_items: items.length, has_more: Boolean(payload.hasMore), count: ranked.length, items: ranked };
};

/** Scrape goofish's 猜你喜欢 / 为你推荐 rails for an anonymous visitor. Renders are flaky, so retry -- under a clock, like the other two best-effort tools, because five renders with a reload between each is up to five minutes of somebody's timeout at the 60s navigation timeout -- and if the DOM never cooperates fall back to the feed API and say so in `source` rather than returning an empty list. */
const recommendations = async ({ limit = 30, url }: RecoArgs): Promise<Data> => {
  const cap = clamp(limit, 1, MAX_LIMIT), target = url || HOME;
  // The clock starts before the load, for the same reason item_view's does: a budget that ignores the slowest step in the call is not a budget, and the elapsed time in `fallback_reason` was understating itself by one page load.
  const started = Date.now(), deadline = started + budget('RECOMMENDATIONS', 45) * 1000;
  const session = getSession(), page = await session.open(target);
  let payload: any = {}, attemptNo = 0;
  for (attemptNo = 1; attemptNo <= RENDER_ATTEMPTS; attemptNo++) {
    payload = await scrape(page, SCRAPE_CARDS_JS, { query: '', limit: cap, rails: RAIL_MARKERS }, 'recommendation scrape');
    if (payload?.items?.length) break;
    if (attemptNo < RENDER_ATTEMPTS && Date.now() < deadline) { await reloadFresh(page); await settle(page, RENDER_SETTLE_MS); }
  }
  if (!payload?.items?.length) {
    const feed = await browseFeed({ pages: 1, limit: cap });
    return { ...feed, source: 'homepage_feed', requested_url: target, fallback_reason: `the DOM at ${page.url()} rendered no cards after ${Math.min(attemptNo, RENDER_ATTEMPTS)} attempt(s) in ${Math.round((Date.now() - started) / 1000)}s (goofish serves anonymous visitors an empty shell part of the time); returned live feed listings instead` };
  }
  const items = rankItems(dedupe(payload.items), cap);
  return { source: 'dom_recommendation', rail: payload.rail || '', page_url: page.url(), account_required: false, attempts: attemptNo, says_no_results_for_query: Boolean(payload.says_no_results), risk_control_page: Boolean(payload.blocked), count: items.length, items };
};

/** Type `query` into goofish's own header search input and press Enter, then wait for the router to
 *  land on /search. Returns the attempt log's verdict rather than throwing, because every way this
 *  can go wrong is retryable and the retry is the caller's decision. Three waits, in order:
 *  (1) the input -- the homepage is a footer-only shell for 8-14s before the app mounts, so a miss is
 *      polled, not concluded; (2) the keys, sent with `keyboard.type` because the SPA owns the
 *      input's value and a DOM assignment React never sees would submit an empty keyword; (3) the
 *      route, which needs ~12s after Enter and during which the SPA destroys the execution context
 *      out from under the poll -- a lost context is waited out, since it is the navigation landing
 *      rather than a failure. Nothing is clicked: the login dialog's ant-modal-mask sits over the
 *      header and Playwright's click actionability check times out against it. */
const typeSearch = async (page: Page, query: string, deadline: number): Promise<any> => {
  let box: any = { found: false };
  for (let until = Date.now() + Math.min(SEARCH_INPUT_WAIT_MS, Math.max(0, deadline - Date.now())); Date.now() < until;) {
    box = await scrape(page, SEARCH_INPUT_JS, SEARCH_MARK, 'search input lookup');
    if (box?.found) break;
    await settle(page, 400);
  }
  if (!box?.found) return { retryable: 'no-search-input-on-homepage', inputs_on_page: box?.inputs ?? 0, page_chars: box?.chars ?? 0, home_path: box?.path || '' };
  await page.keyboard.type(query, { delay: 60 });
  await page.keyboard.press('Enter');
  let state: any = { typed: '', on_search: false, cards: 0 }, lostContexts = 0;
  for (let until = Date.now() + Math.min(SEARCH_RESULT_WAIT_MS, Math.max(0, deadline - Date.now())); Date.now() < until;) {
    await settle(page, 1000);
    try { state = await scrape(page, SEARCH_STATE_JS, SEARCH_MARK, 'search submit poll'); }
    catch (e: unknown) { if (e instanceof NavigationError) throw e; lostContexts++; continue; }   // the SPA replaced the context on its way to /search
    if (state.on_search && state.cards > 0) break;
  }
  if (!state.on_search) return { retryable: 'enter-did-not-submit', typed: state.typed || '', cards_left_on_home: state.cards || 0, lost_contexts: lostContexts, home_path: state.path || '' };
  return { submitted: true, typed: state.typed, result_cards: state.cards, lost_contexts: lostContexts };
};

/** Search goofish as a logged-out visitor, by typing into its own search box. Anonymous search works
 *  logged out, but not by URL: measured 2x2x2 over headed/headless, fresh/persistent profile and
 *  direct-URL/search-input, and only the cell that typed into the SPA's header input returned results
 *  (30 cards, 29 real matches) -- every direct-URL cell, headed included, served the 猜你喜欢 rail.
 *  So each attempt loads the *homepage* and types; the results are then held to the same relevance
 *  guard as before, a *fraction* of the page's card titles having to really contain the query, so the
 *  rail can never be presented as results and `items` holds only the matches. The last attempt is
 *  the one direct-URL navigation, kept so that a refusal can quote a real page rather than a guess;
 *  it is expected to be refused, and that is reported as what it is. Nothing clicks anything. */
const searchItems = async ({ query, limit = 30, attempts = SEARCH_ATTEMPTS }: SearchArgs): Promise<Data> => {
  const q = requireQuery(query), maxAttempts = clamp(attempts, 1, MAX_SEARCH_ATTEMPTS), cap = clamp(limit, 1, MAX_LIMIT);
  const session = getSession(), log: any[] = [];
  let payload: any = {};
  const started = Date.now(), deadline = started + budget('SEARCH', 150) * 1000;
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    // A failed page load is a declined attempt, not a fatal error: this network throws ERR_INSUFFICIENT_RESOURCES / ERR_ADDRESS_UNREACHABLE often enough that aborting the whole call would make search useless. The clock is checked at the foot of the loop either way, so ten failed loads cannot outrun the budget.
    payload = {};
    const via = attemptNo <= SEARCH_TYPED_ATTEMPTS ? 'searchbox' : 'direct_url';
    let page: Page | null = null;
    try { page = await session.open(via === 'searchbox' ? HOME : buildSearchUrl(q)); }
    catch (e: unknown) { if (!(e instanceof XianyuError)) throw e; const d = describe(e); log.push({ attempt: attemptNo, via, error: `${d.error_type}: ${d.message.slice(0, 120)}` }); }
    if (page) {
      // The typed path owns its own waits; the URL path has nothing to wait for but the render.
      if (via === 'searchbox') {
        const step = await typeSearch(page, q, deadline);
        log.push({ attempt: attemptNo, via, ...step });
        if (!step.submitted) { if (Date.now() >= deadline) break; continue; }
      }
      for (let until = Date.now() + SEARCH_RESULT_WAIT_MS; Date.now() < until && Date.now() < deadline;) {
        await settle(page, 1000);
        // Over-ask, then filter. The scraper stops collecting at `limit` but counts to the end of the page, and the filter below runs over what it *collected*, so truncating at `limit` first let a few leading non-matching cards empty the result set and report a successful, self-contradicting answer next to `query_hits: 195`.
        payload = await scrape(page, SCRAPE_CARDS_JS, { query: q, limit: Math.max(cap, 200), rails: RAIL_MARKERS }, 'search-page scrape');
        if (payload?.rendered) break;
      }
      // The fraction is over every card on the page, not the `limit` we kept.
      const cards = Number(payload.cards_scanned) || 0, hits = Number(payload.query_hits) || 0, tokenHits = Number(payload.token_hits) || 0;
      const minHits = Math.max(1, Math.ceil(cards * MIN_MATCH_FRACTION)), declined = !payload.rendered || Boolean(payload.rail) || Boolean(payload.says_no_results) || Boolean(payload.blocked) || hits < minHits;
      log.push({ attempt: attemptNo, via, rendered: Boolean(payload.rendered), scraped_cards: cards, query_hits: hits, token_hits: tokenHits, min_query_hits: minHits, rail: payload.rail || '', says_no_results: Boolean(payload.says_no_results), blocked: Boolean(payload.blocked) });
      if (!declined) {
        // Only the matches, so `count` and every item agree with each other and with the query.
        const items = rankItems(dedupe(payload.items.filter((i: any) => i.matches_query)), cap);
        return { query: q, source: 'search_page_dom', via, account_required: false, attempts: attemptNo, attempt_log: log, query_hits: hits, token_hits: tokenHits, min_query_hits: minHits, scraped_cards: cards, non_matching_count: Math.max(0, cards - hits), count: items.length, items };
      }
    }
    if (Date.now() >= deadline) { log.push({ attempt: attemptNo, stopped: 'time budget reached' }); break; }
  }
  const typed = log.filter((e) => e.via === 'searchbox'), last = log.filter((e) => e.scraped_cards !== undefined || e.error || e.retryable).pop() || {};
  throw new SearchUnavailableError(`goofish never served a usable result set for ${JSON.stringify(q)} in ${Math.round((Date.now() - started) / 1000)}s, over ${log.filter((e) => e.attempt).length} attempt(s) of which ${typed.length} typed the query into the search box. `
    + 'Search here is a keystroke, not a URL: navigating to /search?q= is measured to serve the 猜你喜欢 rail instead of results (20 cards, zero query hits), so the query is typed into the header input and submitted. Typed attempts fail in three ways, all retried, and the counts say which: `no-search-input-on-homepage` means the homepage came back as a footer-only shell with no input at all, `enter-did-not-submit` means the keys landed (`typed`) but the router never moved off `/`, and a `blocked: true` attempt is goofish serving its "非法访问 / 请使用正常浏览器" page instead of the app, which is server-side and lifts after a pause. A `token_hits` above `query_hits` means the page held matches that contain every word of the query but not the query as one substring.\n  stopped on: '
    + `${log.find((e) => e.stopped)?.stopped || 'the attempt count'}\n  last attempt: ${JSON.stringify(last)}\n  page text: ${JSON.stringify(String(payload.text_preview || '').slice(0, 140))}\n  the wall-clock budget XIANYU_SEARCH_BUDGET_S (150s default) is what bounds the retries, and one typed attempt is a 10-25s page load plus up to 15s waiting for the input to mount plus ~12s after Enter, so at the default budget the attempts argument above 3 never runs: raise the budget, not \`attempts\`. browse_feed and search_count are unaffected and always available.`);
};

/** Read one listing from its own page, as a logged-out visitor sees it. The item-detail *API* is not available to anonymous callers (it times out), but the item *page* does render the detail block: price, want/browse counts, description, seller, photos. Rendering is flaky, so retry, and report which fields actually came back instead of inventing any. */
const itemView = async ({ item_id }: ItemArgs): Promise<Data> => {
  const item = normalizeItemId(item_id);
  if (!item) throw new XianyuError(`item_id must be digits or a goofish item URL, got ${JSON.stringify(item_id)}`);
  // The clock starts before the load, not after it: a budget that ignores the slowest step in the call is not a budget.
  const started = Date.now(), deadline = started + budget('ITEM_VIEW', 45) * 1000;
  const session = getSession(), page = await session.open(`${HOME}item?id=${item}`);
  let payload: any = {}, tries = 0;
  for (tries = 1; tries <= RENDER_ATTEMPTS; tries++) {
    payload = await scrape(page, ITEM_SCRAPE_JS, { item_id: item, rails: RAIL_MARKERS }, 'item-page scrape');
    if (payload?.detail_rendered) break;
    if (tries >= RENDER_ATTEMPTS || Date.now() >= deadline) break;
    if (tries === 1) {
      // Only the first load gets a readiness wait. If the listing has not painted within it, the page is a shell and reloading is the only thing that helps -- polling again on every retry just multiplies the wait by the attempt count, which is how this ended up taking a minute.
      for (let i = 0; i < ITEM_READY_POLLS && !payload?.detail_rendered; i++) {
        await settle(page, 250);
        payload = await scrape(page, ITEM_SCRAPE_JS, { item_id: item, rails: RAIL_MARKERS }, 'item-page scrape');
      }
      if (payload?.detail_rendered) break;
    }
    await evaluate(page, SCROLL_TO_JS, 400, 'gallery nudge');
    await settle(page, 400);
    await evaluate(page, SCROLL_TO_JS, 0, 'gallery nudge');
    await reloadFresh(page);
    await settle(page, RENDER_SETTLE_MS);
  }
  if (!payload?.detail_rendered) throw new DetailUnavailableError(
    `item ${item} would not render for this anonymous visitor after ${tries} attempt(s) in ${Math.round((Date.now() - started) / 1000)}s, and the item-detail API is not open to logged-out callers (it times out anonymously). goofish serves anonymous visitors an empty shell for this page part of the time; retry, or pull the listing from browse_feed instead. `
    + `Page text: ${JSON.stringify(String(payload?.head_preview || '').slice(0, 160))}`);
  // Unconditional: a page that renders the detail block but has no `?id=` in its URL is a redirect or a challenge page, not the listing, and skipping the check when `served` is empty is what let an off-site page's fields be reported as this item's.
  const served = String(payload.page_item_id ?? '');
  if (served !== item) throw new ParseError(`asked goofish for item ${item} but the page it served reports item ${served || '(no ?id= in its URL)'}; refusing to report one listing's fields as another's.`);
  return { item_id: item, page_item_id: served, url: `${HOME}item?id=${item}`, source: 'item_page_dom', account_required: false, attempts: tries,
    reco_anchors: payload.reco_anchors || 0, image_candidates: payload.image_candidates || 0,
    fields_present: ITEM_FIELDS.filter((f) => present(payload[f])), fields_missing: ITEM_FIELDS.filter((f) => !present(payload[f])),
    ...Object.fromEntries(ITEM_FIELDS.map((f) => [f, payload[f] ?? (f === 'image_urls' ? [] : '')])) };
};

/** What this server can and cannot do right now, verified against the live site. A diagnostic must never be the thing that crashes, so every probe is guarded and reported as status rather than raised -- including a browser that has gone away. */
const capabilities = async (): Promise<Data> => {
  const session = getSession();
  const status: any = {
    requires_xianyu_account: false, session_state: 'unknown', login_probe_ret: '', feed_reachable: false,
    works_without_account: [
      'browse_feed: paged homepage feed, 20 listings/page, live inventory',
      'search_count / search_suggest: match counter and autocomplete, both undeclined',
      'related_items: more-like-this for an item, or goofish\'s generic set',
      'search_items: keyword search, retried because goofish declines some page loads',
      'item_view: price, want/browse counts, description, seller and stats from the rendered item page (throttled per IP, so it retries and then reports)',
    ],
    anonymous_flakiness: [
      'search_items works logged out, but goofish declines on some page loads: the search API is not even called and the page renders the 猜你喜欢 rail instead. It retries, and only accepts a page when a fraction of its card titles really contain the query.',
      'The three DOM tools (search_items, item_view, recommendations) can also be served goofish\'s risk-control page instead of the app, which renders zero cards and no rail. That is named as risk_control_page in the output, and it clears after a pause; the four API tools keep working throughout because they need only the mtop client.',
      'Anonymous page rendering is otherwise throttled per IP and degrades to an empty shell with no error; the DOM-scraping tools retry and then report what they got.',
    ],
    notes: [
      'goofish puts a dismissible login dialog over anonymous pages. It does not gate anything and it does not need closing: the listing cards are already in the DOM underneath its ant-modal-mask, and clicking its close controls was measured to stop the result list from rendering. This server never clicks it.',
      'The feed is not keyword-filterable and ignores cCatId, so it samples inventory rather than answering queries. The item-detail API is closed to logged-out callers, so item_view reads the rendered page.',
      'Chromium on a network with broken IPv6 can fail to connect at all (ERR_ADDRESS_UNREACHABLE) where curl succeeds, which looks like an empty page -- see the cause list below.',
    ],
    // The known causes, in the order they were actually observed; static, so it survives a dead browser.
    note: 'goofish did not serve a usable page. Known causes, in the order actually observed: (1) the network resolves goofish to IPv6 but has no working IPv6 route, so Chromium gets ERR_ADDRESS_UNREACHABLE where curl over v4 returns 200; (2) resource exhaustion, ERR_INSUFFICIENT_RESOURCES, usually a small /tmp; (3) goofish answering with its risk-control page instead of the app -- a 200 whose whole body reads "非法访问 ... 请使用正常浏览器访问闲鱼" -- which is the state to check for first, because it is indistinguishable from "no results" unless it is named, and it is server-side so it lifts after a pause; (4) a footer-only shell as a successful 200. The four API tools need only the mtop client, which comes up even on (3) and (4), so they survive every one of these.',
  };
  // Each probe is guarded on its own and reports under its own key: merged into one try, a throwing loginuser probe skipped the feed probe and its verdict, and both looked like a dead browser. The per-probe keys are the difference between "not logged in" and "not reachable".
  const probe = async (key: string, run: () => Promise<void>): Promise<void> => { try { await run(); } catch (e: unknown) { const d = describe(e); status[`${key}_error`] = `${d.error_type}: ${d.message}`; } };
  await probe('browser', async () => { await session.ensureReady(); });
  // loginuser.get is used only to prove the session is logged out, never to act as one -- and only a session- or token-shaped ret is proof; anything else leaves session_state 'unknown' rather than reading as anonymity.
  await probe('login', async () => { const me = (await session.call([['me', LOGINUSER_API, {}]]))?.me || {}; status.login_probe_ret = String(me.ret || ''); status.session_state = me.ok ? 'unexpectedly_logged_in' : hasMarker(me.ret, NO_SESSION_MARKERS) ? 'logged_out' : 'unknown'; });
  await probe('feed', async () => { status.feed_reachable = Boolean((await session.call([['f', FEED_API, { pageNumber: 1 }]]))?.f?.ok); });
  // read after the probes, so a browser that had to be relaunched shows up
  status.browser_launches = session.launches;
  return status;
};

// -------------------------------------------------------- the published contract
// The zod shape IS the published argument contract, and each handler's argument type is inferred from that same shape, so a renamed or retyped argument is a type error rather than a silent drift between schema and implementation. `Partial` because the defaults live in the schema; the destructuring defaults in each handler are what a direct call (tests, one-off scripts) gets, and only browse_feed's are asserted behaviourally.
type Args<S extends z.ZodRawShape> = Partial<z.infer<z.ZodObject<S>>>;
const FEED_ARGS = { page_number: z.number().int().min(1).max(MAX_PAGE_NUMBER).default(1), pages: z.number().int().min(1).max(MAX_PAGES).default(1), limit: z.number().int().min(1).max(MAX_LIMIT).default(60) };
const COUNT_ARGS = { query: z.string().min(1) };
const SUGGEST_ARGS = { query: z.string().min(1), limit: z.number().int().min(1).max(MAX_LIMIT).default(20) };
const SEARCH_ARGS = { query: z.string().min(1), limit: z.number().int().min(1).max(MAX_LIMIT).default(30), attempts: z.number().int().min(1).max(MAX_SEARCH_ATTEMPTS).default(SEARCH_ATTEMPTS) };
const RELATED_ARGS = { item_id: z.string().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).default(30), page: z.number().int().min(1).max(MAX_PAGE_NUMBER).default(1) };
const ITEM_ARGS = { item_id: z.string().min(1) };
const RECO_ARGS = { limit: z.number().int().min(1).max(MAX_LIMIT).default(30), url: z.string().optional() };
type FeedArgs = Args<typeof FEED_ARGS>; type CountArgs = Args<typeof COUNT_ARGS>; type SuggestArgs = Args<typeof SUGGEST_ARGS>;
type SearchArgs = Args<typeof SEARCH_ARGS>; type RelatedArgs = Args<typeof RELATED_ARGS>; type ItemArgs = Args<typeof ITEM_ARGS>; type RecoArgs = Args<typeof RECO_ARGS>;

type ToolDef = { name: string; description: string; schema: z.ZodRawShape; run: (args: any) => Promise<Data> };
const tool = <S extends z.ZodRawShape>(def: { name: string; description: string; schema: S; run: (args: Args<S>) => Promise<Data> }): ToolDef => def as ToolDef;
const NO_ACCOUNT = ' No Xianyu account, cookie or login is required or used. Read-only: this server cannot publish, message, or change anything.';
export const TOOLS: ToolDef[] = [
  tool({ name: 'capabilities', description: 'Report what this server can do without a Xianyu account right now, probing the live site: session_state, feed_reachable, and the split between what works, what is flaky, and what to know. Start here if you are unsure whether a call will work. Never raises, not even if the browser is gone. Args: none.' + NO_ACCOUNT, schema: {}, run: capabilities }),
  tool({ name: 'browse_feed', description: 'Page through goofish\'s public homepage feed: live listings with item_id, title, price, city, seller, want_count and image_urls. Not keyword-filterable, so use it to sample inventory, not to answer a query. Args: page_number (1-10000, default 1), pages (1-25, default 1), limit (max items, default 60).' + NO_ACCOUNT, schema: FEED_ARGS, run: browseFeed }),
  tool({ name: 'search_count', description: 'How many goofish listings match a keyword, and whether there are any. Unlike search_items this is not subject to goofish\'s per-page-load declines -- verified returning about 28,800 for "x220" and 0 for a nonsense string anonymously. Args: query (str).' + NO_ACCOUNT, schema: COUNT_ARGS, run: searchCount }),
  tool({ name: 'search_suggest', description: 'goofish\'s own search-box autocomplete: keyword suggestions for a prefix, plus the total suggestion count. Args: query (str), limit (default 20).' + NO_ACCOUNT, schema: SUGGEST_ARGS, run: searchSuggest }),
  tool({ name: 'search_items', description: 'Search goofish listings by keyword, logged out -- verified returning real matches. It works by TYPING the query into goofish\'s own header search box and pressing Enter, not by navigating to /search?q=: measured over a headed/headless x fresh/persistent x URL/input matrix, every direct-URL navigation served the 猜你喜欢 rail instead of results. Retries when the homepage comes back as a shell with no search input, when Enter does not submit, and when a page load fails; the relevance guard still refuses to return rail items as matches, and `items` holds just those cards whose titles really contain the query, so `count` is a match count. Retries are bounded by the wall-clock budget `XIANYU_SEARCH_BUDGET_S` (150s default), and one attempt is a 10-25s page load plus up to 15s for the input to mount plus ~12s after Enter. Args: query (str), limit (default 30), attempts (1-10, default 4; the first 3 type, the last is the direct-URL fallback).' + NO_ACCOUNT, schema: SEARCH_ARGS, run: searchItems }),
  tool({ name: 'related_items', description: 'Listings goofish recommends for a given item ("more like this"), or its generic recommendation set when item_id is omitted. Returns real listings with titles, prices and cities. Args: item_id (optional digits or item URL), limit (default 30), page (1-10000, default 1).' + NO_ACCOUNT, schema: RELATED_ARGS, run: relatedItems }),
  tool({ name: 'item_view', description: 'Read one listing from its goofish item page as a logged-out visitor: price, want/browse counts, description, seller stats and image_urls. The detail API is closed to anonymous callers, so this reads the rendered page, which goofish sometimes serves as an empty shell -- it retries and reports fields_present / fields_missing rather than guessing. Args: item_id (digits or item URL).' + NO_ACCOUNT, schema: ITEM_ARGS, run: itemView }),
  tool({ name: 'recommendations', description: 'Scrape goofish\'s recommendation rails (猜你喜欢 / 为你推荐) for an anonymous visitor from any goofish page. Falls back to live feed listings if the DOM will not cooperate, and says so in `source` and `fallback_reason`. Args: limit (default 30), url (optional goofish page to load, default the homepage).' + NO_ACCOUNT, schema: RECO_ARGS, run: recommendations }),
];
