/** The eight tools. Capability split, all of it measured rather than assumed: browse_feed, search_count, search_suggest and related_items run on the api page and need nothing but goofish's mtop client; item_view and search_items drive the dom page and read what its own bundle fetches; capabilities never raises, even if the browser is gone. Nothing that touches a page goes through anything but browser.ts, so a Playwright failure arrives as a typed XianyuError rather than escaping a tool call.
 *
 *  The four mtop-only tools do not queue behind the two that drive a browser, and that is the largest
 *  latency change in the server: they used to share one page, so a search that took 70s held up a feed
 *  call that does 1.5s of work. That promise is kept *here* rather than in the entry point: the lock is
 *  taken by the three tools that read the one navigating page (`search_items`, `item_view`,
 *  `recommendations`), and by nothing else. Wrapping every tool at the entry point instead -- which is
 *  what used to happen -- silently re-serialised the four fast ones behind every slow one, and the test
 *  that claimed to prove otherwise called `t.run` directly and so never exercised the shipped path. */
import { z } from 'zod';
import type { Page } from 'playwright';
import { DetailUnavailableError, describe, GatedError, NavigationError, ParseError, SearchUnavailableError, XianyuError } from './errors.ts';
import { ensureGoofishUrl, evaluate, exclusive, getSession, HOME, reloadFresh, settle } from './browser.ts';
import { detailListing, FEED_NORMALIZE_JS, hasAllTerms, ITEM_SCRAPE_JS, PAGER_CLICK_JS, PAGER_STATE_JS, queryTerms, RAIL_MARKERS, SCROLL_TO_JS, SCRAPE_CARDS_JS, searchListings, SEARCH_INPUT_JS, SEARCH_MARK, SEARCH_STATE_JS } from './extract.ts';
type Data = Record<string, any>;
// The mtop endpoints this server is allowed to name. Recovered by extracting all 51 `mtop.*` names from goofish's own JS bundles (idle-pc/xy-site); reading the minified call sites gave the exact parameter shapes, which is what made these work first time. All answer anonymously, and a test fails the build if any other mtop name appears.
//
// The last two are never called by us. They are named because the page calls them and we read the
// replies off the wire -- see `item_view` and `search_items`. Re-issuing either through the page's own
// mtop client, with the payload the page itself sent, answers TIMEOUT::接口超时: goofish stamps the
// requests its own bundle originates with a per-call anti-bot blob, and a request we synthesise does
// not carry it. Letting the page make the call and reading what comes back works, and returns strictly
// more than scraping the DOM did.
const FEED_API = 'mtop.taobao.idlehome.home.webpc.feed';
// The match counter. The search page calls it with the same payload shape as search and reads `data.hitnum`, so it answers "how many items match this keyword" for a logged-out visitor even on the page loads where search is declined. This is the endpoint that makes keyword work possible without the search page: about 28,800 for "x220" (it drifts, 28,791 / 28,804 / 28,810 observed), 0 for nonsense.
const HITNUM_API = 'mtop.taobao.idle.filter.hitnum.pc.get';
const SUGGEST_API = 'mtop.taobao.idlemtopsearch.pc.search.suggest';
const RECOMMEND_API = 'mtop.taobao.idle.item.web.recommend.list';
const LOGINUSER_API = 'mtop.taobao.idlemessage.pc.loginuser.get';   // never used to act as a user: it exists only to *prove* the session is logged out
const DETAIL_API = 'mtop.taobao.idle.pc.detail';
const SEARCH_API = 'mtop.taobao.idlemtopsearch.pc.search';
// pageSize is hardcoded to 30 in goofish's bundle and the endpoint rejects anything else with FAIL_BIZ_COMMON_PARAM_ILLEGAL, so `limit` is applied client-side after the call. A missing itemId is rejected outright, so the generic case uses goofish's own seed id -- what its bundle substitutes when there is no item context.
const RECOMMEND_PAGE_SIZE = 30, RECOMMEND_SEED_ITEM_ID = '809806779491';
// goofish's own feed runs out of pages long before this; the bound only exists so a nonsense page_number cannot become a nonsense request.
const MAX_PAGES = 25, MAX_LIMIT = 500, MAX_PAGE_NUMBER = 10_000;
// Every field item_view reports, in one place so the honesty contract (fields_present / fields_missing) and the scraper cannot drift apart. Exported, and a test asserts every entry is a key the scraper actually returns.
export const ITEM_FIELDS = ['title', 'price', 'want_count', 'browse_count', 'description', 'seller', 'seller_tenure_years', 'seller_items_sold', 'seller_positive_rate', 'image_urls', 'collect_count', 'quantity', 'item_status', 'shipping_fee', 'seller_city', 'seller_signature', 'seller_reply_rate_24h', 'seller_items_listed', 'seller_avatar', 'seller_zhima_verified', 'brand', 'condition', 'used_years', 'location', 'publish_time'] as const;
// goofish renders anonymous pages as a coin flip: the same URL comes back fully rendered or as an empty shell. Retry a few times before calling it a failure. Reloads are cache-busted with a nonce, since a cached empty shell is exactly the failure to escape.
const RENDER_ATTEMPTS = 5, RENDER_SETTLE_MS = 3500;
const SEARCH_ATTEMPTS = 4, MAX_SEARCH_ATTEMPTS = 10;
// The pager only ever renders boxes 1..10 (`1 2 ... 10 ... 50`), so 10 pages is as deep as this
// route goes without clicking the ellipsis: 300 listings, against the 50 a comparison needs.
const MAX_SEARCH_PAGES = 10, MAX_SEARCH_DETAIL = 50;
// The whole pager: ten numbered boxes at 30 listings a page. That is the most a walk can collect,
// and it is also the bound a huge walk has to respect alongside the wall clock.
const MAX_SEARCH_ITEMS = MAX_SEARCH_PAGES * 30, DEFAULT_SEARCH_ITEMS = 120;
// How long item_view waits for the page's own detail call before deciding the listing is not coming.
// The reply lands with the render that uses it, so this is the same window the old DOM poll needed
// (32s) and nothing more: the point of the change is that a reply which never comes is a dead listing,
// not a slow one, and a 90s budget that has to cover two minutes of reloads was buying nothing.
const ITEM_READY_WAIT_MS = 32_000;
// How long search waits for the page's own search call after Enter. Same reasoning: the results render
// from that reply, so there is no separate DOM wait to cover.
const SEARCH_REPLY_WAIT_MS = 32_000;
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
// ------------------------------------------------- v0.2 listing schema shaping
// The normalisers in extract.ts stay close to the wire -- raw strings, in goofish's own shapes -- because the tests pin that contract. This one place is where the published listing schema is produced: typed values, and an explicit `missing` list that names every documented field the page did not render. Raw stays raw in extract.ts; typed starts here.
/** Numeric at the boundary. '366', '¥1,299.00' and raw transport sums all become a plain number; anything unreadable is null, not a silently invented 0. */
const toNum = (v: unknown): number | null => { const s = String(v ?? '').replace(/[^\d.]/g, ''); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
/** goofish carries epochs as numbers or numeric strings, milliseconds in practice (a 13-digit fixture), seconds in some payloads. Anything that does not parse is null rather than a garbage date. An already-ISO string passes through so a detail reply that supplied one is not double-converted and lost. */
const epochToIso = (v: unknown): string | null => {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n >= 1e11 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const NUMERIC_KEYS = new Set(['price', 'original_price', 'shipping_fee', 'want_count', 'browse_count', 'collect_count', 'quantity', 'image_count', 'seller_tenure_years', 'seller_items_sold', 'seller_items_listed', 'seller_positive_rate', 'seller_reply_rate_24h']);
const TEXT_KEYS = ['title', 'description', 'seller', 'seller_city', 'seller_avatar', 'seller_signature', 'seller_last_active', 'brand', 'condition', 'used_years', 'item_status', 'city', 'category_id'];
/** The documented fields whose null/empty state is reported in an item's `missing` list. Booleans are deliberately absent: `is_video: false` is an answer, not a gap. */
const MISSING_CHECK = ['title', 'price', 'original_price', 'description', 'seller', 'seller_city', 'seller_avatar', 'seller_signature', 'seller_last_active', 'seller_tenure_years', 'seller_items_sold', 'seller_items_listed', 'seller_positive_rate', 'seller_reply_rate_24h', 'brand', 'condition', 'used_years', 'item_status', 'city', 'category_id', 'image_count', 'want_count', 'browse_count', 'collect_count', 'quantity', 'shipping_fee', 'want_count', 'publish_time', 'location', 'image_urls', 'tags'];
/** Shape one raw listing into the documented v0.2 item: typed values, every omitted field of the schema family named in `missing`. Absent keys are filled with null where the schema expects the key to be there, so two routes that answered different parts of the listing produce items with the same key surface -- a detail page, a search card and a feed card differ only in which values are null, never in which keys exist. */
const normalizeItem = (item: any): any => {
  const out: any = { ...item };
  for (const k of Object.keys(out)) if (NUMERIC_KEYS.has(k)) out[k] = toNum(out[k]);
  for (const k of TEXT_KEYS) if (out[k] === '') out[k] = null;
  out.publish_time = 'publish_time' in out ? epochToIso(out.publish_time) : null;
  if (out.location === undefined || out.location === '' || out.location === null) {
    const c = (typeof out.seller_city === 'string' && out.seller_city) || (typeof out.city === 'string' && out.city) || null;
    out.location = c ? { city: c } : null;
  }
  for (const k of ['shipping_fee', 'browse_count', 'condition', 'brand', 'original_price', 'want_count']) if (!(k in out)) out[k] = null;
  out.missing = MISSING_CHECK.filter((f) => out[f] === null || out[f] === undefined || out[f] === '' || (Array.isArray(out[f]) && out[f].length === 0));
  return out;
};

const clamp = (value: unknown, low: number, high: number): number => { const n = Number(value); return Number.isFinite(n) ? Math.max(low, Math.min(Math.trunc(n), high)) : low; };
const itemIdFromUrl = (url: unknown): string => String(url ?? '').match(/[?&]id=(\d+)/)?.[1] ?? '';
/** Accept a bare item id or a goofish item URL and return the bare digits. */
const normalizeItemId = (value: unknown): string => { const s = String(value ?? '').trim(); return itemIdFromUrl(s) || (/^\d+$/.test(s) ? s : ''); };
const asText = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
/** A count for a human-readable line: "" when the payload had none, never a 0 standing in for one. */
const asCount = (v: unknown): string => (v === '' || v === null || v === undefined ? '' : String(v));
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
/** "Non-empty" presence: an array is truthy in JS, so a gallery that never loaded must not be reported as if it were there. With the typed schema, 0 and false are real answers (a listing with no wants, a seller that is not zhima-verified), not missing values. */
const present = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
};
/** Wall-clock budget for one best-effort tool's retry *loop*, overridable via XIANYU_<NAME>_BUDGET_S, floored at 5s and capped at 600s: a floor keeps the tools usable, and a ceiling keeps the override from restoring the multi-minute hang the function exists to prevent. It does not bound the call -- a page load costs 10-25s on a slow link, and one already in flight runs to completion. Read per call, so a script can change it. */
export const budget = (name: string, defaultS: number): number => { const raw = process.env[`XIANYU_${name}_BUDGET_S`]; const n = Number(raw); return raw?.trim() && Number.isInteger(n) ? clamp(n, 5, 600) : defaultS; };
/** The runtime ceiling on one search_items call, overridable via XIANYU_SEARCH_MAX_ITEMS and read
 *  per call like `budget`. It clamps both `limit` and how deep the pager walk goes (one page per
 *  30 listings), so even "pages: 10, limit: 500" stops at this many results -- and the point of
 *  the ceiling is that a capped walk fits inside the XIANYU_SEARCH_BUDGET_S wall clock, since the
 *  deeper the walk the more serial page loads it spends on the one shared dom page. Default answers
 *  the whole pager; the floor keeps a typo'd override from silently neutering search. */
export const searchCap = (): number => { const raw = process.env.XIANYU_SEARCH_MAX_ITEMS; const n = Number(raw); return raw?.trim() && Number.isInteger(n) ? clamp(n, 30, MAX_SEARCH_ITEMS) : MAX_SEARCH_ITEMS; };
/** The one way this file reads the DOM. `Session.open` checks the allowlist on the URL it landed on, but that is point-in-time: `search_items` then polls for up to 32s and `item_view` for up to 32s before it reads anything, and the page can be moved off goofish in that window. So the check is repeated on the URL that is live *now*, in the same statement as the read, and every scraper goes through here. `timeoutS` is for the cheap probes, which must not inherit the 90s an in-page read is allowed. */
const scrape = (page: Page, fn: any, arg: any, what: string, timeoutS?: number): Promise<any> => { ensureGoofishUrl(page.url()); return evaluate(page, fn, arg, what, timeoutS); };
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
  const items = dedupe((normalized || []).filter((i: any) => i.item_id)).map(normalizeItem);
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
  const items = dedupe((normalized || []).filter((i: any) => i.item_id)).map(normalizeItem);
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
  const items = rankItems(dedupe(payload.items), cap).map(normalizeItem);
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
  // Type, then READ BACK what the input actually holds. goofish's SPA re-renders the search input
  // under the cursor, and a `keyboard.type` burst that spans a re-render is silently truncated:
  // measured, "thinkpad x220" landing as "th", which then submits an empty-ish keyword and returns
  // the rail, which used to be reported as a refusal. The input is refocused and the missing tail
  // re-sent until it holds the whole query, so a lost keystroke is a retry rather than a wrong answer.
  // A cleared field is typed from the start (the SPA discarded the prefix, not just the tail).
  for (let tries = 0; tries < 4; tries++) {
    const held = String(box?.value ?? '');
    if (held === query) break;
    if (held && query.startsWith(held)) { await page.keyboard.type(query.slice(held.length), { delay: 60 }); }
    else {
      // The input holds something that is not a prefix of this query -- which is the *normal* state
      // on a warm page, where it still holds the previous search. Typing over it appends, and
      // "thinkpad x220" + "ipad air" submits as one nonsense keyword that legitimately finds nothing.
      // Select-all and type replaces the selection with real key events, which the SPA's own
      // controlled input actually sees; assigning `.value` would not, because React never hears it.
      await scrape(page, SEARCH_INPUT_JS, SEARCH_MARK, 'search input refocus');
      if (held) await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(query, { delay: 60 });
    }
    await settle(page, 350);
    box = await scrape(page, SEARCH_INPUT_JS, SEARCH_MARK, 'search input read-back');
    if (box?.value === query) break;
  }
  if (box?.value !== query) return { retryable: 'incomplete-keystrokes', typed: String(box?.value ?? ''), wanted: query, home_path: box?.path || '' };
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

/** Search goofish as a logged-out visitor, by typing into its own search box.
 *
 *  Anonymous search works logged out, but not by URL: measured 2x2x2 over headed/headless,
 *  fresh/persistent profile and direct-URL/search-input, and only the cell that typed into the SPA's
 *  header input returned results -- every direct-URL cell, headed included, served the 猜你喜欢 rail.
 *
 *  Two things make it fast, and both are new:
 *
 *  1. The answer is the page's own `mtop.taobao.idlemtopsearch.pc.search` reply, read off the wire.
 *     That payload is 30 structured results -- the same card shape the homepage feed returns, so the
 *     same normaliser reads it -- where the DOM scrape could see a title, a price and a city and
 *     nothing else. A want count, a seller and an image per listing are simply not in the DOM card,
 *     and they are all here.
 *  2. A warm page is reused. Re-searching by retyping into the header input of the page already
 *     showing results is an SPA route change: measured 4-12s, against 15-41s for a cold load, and a
 *     cold load is what every attempt used to pay. The homepage is only reloaded when there is no
 *     page, when the input is not there, or when a page load has failed.
 *
 *  The relevance guard is unchanged in spirit and now runs over real titles: a *fraction* of the
 *  results must really match, so a rail can never be presented as results.
 *
 *  Nothing clicks anything, and that is a measured result rather than a style choice. goofish's
 *  anonymous login dialog puts an ant-modal-mask over the header; the listings render *underneath* it,
 *  so a read works through the mask and needs no dismissal. Measured headed, same URL, one fresh
 *  context per arm: with nothing dismissed the cards were in the DOM by t+12s under the mask, while
 *  dismissing at t+6s or t+12s clicked four close controls and the result list then never rendered at
 *  any later sample, serving the 猜你喜欢 rail instead. The searchbox flow also has to `focus()`
 *  rather than click, because Playwright's click actionability check times out against that mask
 *  (measured: element resolved, never receiving the event) while `focus()` needs no pointer. */
const searchItems = async ({ query, limit = DEFAULT_SEARCH_ITEMS, attempts = SEARCH_ATTEMPTS, pages = 1, detail = 0 }: SearchArgs): Promise<Data> => {
  const q = requireQuery(query), maxAttempts = clamp(attempts, 1, MAX_SEARCH_ATTEMPTS), cap = clamp(limit, 1, searchCap()), pagesWanted = clamp(pages, 1, Math.max(1, Math.min(MAX_SEARCH_PAGES, Math.ceil(searchCap() / 30))));
  const session = getSession(), log: any[] = [];
  let payload: any = {};
  // The budget has to fit what was asked for. Depth is a page load per listing at ~8s, so a
  // `detail: 50` needs minutes and the flat 90s default would have silently refused most of
  // them -- the 8-deep case measured 0/8 answered before this.
  const started = Date.now(), deadline = started + budget('SEARCH', detail > 0 ? Math.min(600, 60 + detail * 10) : 90) * 1000;
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    // A failed page load is a declined attempt, not a fatal error: this network throws ERR_INSUFFICIENT_RESOURCES / ERR_ADDRESS_UNREACHABLE often enough that aborting the whole call would make search useless. The clock is checked at the foot of the loop either way, so ten failed loads cannot outrun the budget.
    payload = {};
    const via = attemptNo <= SEARCH_TYPED_ATTEMPTS ? 'searchbox' : 'direct_url';
    // The warm path. `session.open` is skipped when the page already holds a usable input, so the
    // second and later searches of a session are SPA route changes rather than fresh loads. Only a
    // page that is not on goofish, has no input, or is mid-flight with no results forces a load.
    const reuse = via === 'searchbox' && (await warmInputUsable(session));
    let page: Page | null = null;
    if (reuse) { page = await session.domReady(); log.push({ attempt: attemptNo, via, reused_page: true, path: page.url() }); }
    else {
      try { page = await session.open(via === 'searchbox' ? HOME : buildSearchUrl(q)); }
      catch (e: unknown) { if (!(e instanceof XianyuError)) throw e; const d = describe(e); log.push({ attempt: attemptNo, via, error: `${d.error_type}: ${d.message.slice(0, 120)}` }); }
    }
    if (page) {
      if (via === 'searchbox') {
        // Forget every reply the page has made so far, so the only search reply this attempt can
        // accept is one its own keystroke provoked. Without this a warm page hands back the previous
        // query's results -- a full 30, all of them for the wrong keyword -- and the relevance guard
        // throws away a perfectly good answer to go looking for a DOM fallback.
        session.domTap.clear();
        const step = await typeSearch(page, q, deadline);
        log.push({ attempt: attemptNo, via, ...step });
        if (!step.submitted) { if (Date.now() >= deadline) break; continue; }
      }
      // The page's own search call is the answer. `take` claims the reply, so a later attempt cannot
      // be handed this one -- and the leftover DOM poll below only runs if no reply ever arrived.
      const reply = await session.domTap.take(SEARCH_API, Math.min(SEARCH_REPLY_WAIT_MS, Math.max(0, deadline - Date.now())));
      if (reply?.ok) {
        // Walk the pager for the rest. One reply is 30 listings and the search API cannot be
        // re-issued (replaying the page's own payload through the same client answers TIMEOUT), so the
        // page's own pager is the only way deeper -- and it is much cheaper than a fresh load.
        const replies = [reply.data];
        // Walking the pager is not deterministic: page 3 sometimes returns items already seen on
        // pages 1-2, and a degraded page can match far fewer than its 30. Measured across three
        // sessions, `pages: 2` yielded 25, 28 and 55 matches out of 60 scanned. For a caller who asked
        // for `limit` listings that is a silent shortfall, so the walk tops up -- bounded, so a
        // genuinely thin market cannot turn a cheap call into an expensive one.
        const seen = () => new Set(replies.flatMap((d) => searchListings(d).map((c) => c?.detailParams?.itemId).filter(Boolean))).size;
        const TOPUP_PAGES = 2;
        for (let want = 2; want <= Math.min(MAX_SEARCH_PAGES, pagesWanted + TOPUP_PAGES); want++) {
          if (want > pagesWanted && seen() >= cap) break;
          if (Date.now() >= deadline) { log.push({ stopped: `time budget reached at page ${want}` }); break; }
          // The reply arrives a moment before the pager finishes rebuilding itself, and clicking in
          // that window finds no page box at all -- measured as `pages: 3` walking one page and then
          // giving up with "no such page box" on a pager that plainly had one. So wait until the pager
          // says it is showing the page we are leaving.
          const here = await waitForPager(page, String(want - 1), Math.min(6000, Math.max(0, deadline - Date.now())));
          if (!here.settled) log.push({ pager: want, note: `the pager still said ${JSON.stringify(here.on_page)} when we asked for page ${want}` });
          const clicked = await scrape(page, PAGER_CLICK_JS, { page: String(want) }, `pager click ${want}`);
          if (!clicked?.ok) { log.push({ pager: want, ok: false, why: clicked?.why || 'unknown', on_page: clicked?.on_page }); break; }
          const next = await session.domTap.take(SEARCH_API, Math.min(SEARCH_REPLY_WAIT_MS, Math.max(0, deadline - Date.now())));
          if (!next?.ok) { log.push({ pager: want, ok: false, why: next ? `mtop said ${next.ret}` : 'no reply' }); break; }
          const n = searchListings(next.data).length;
          replies.push(next.data);
          log.push({ pager: want, ok: true, items: n });
        }
        const found = await finishSearch(page, replies, q, cap);
        if (found) {
          log.push({ attempt: attemptNo, via, source: 'search_api', pages: replies.length, results: found.scanned });
          const out = { query: q, source: 'search_api', via, account_required: false, attempts: attemptNo, attempt_log: log, ...found };
          if (detail < 1) return out;
          const deep = await enrichDetails(session, found.items, detail, deadline, out.items);
          return { ...out, items: deep.items, detail_requested: deep.report.requested, detailed: deep.report.ok, detail_ms: deep.report.ms_total,
            // Per-listing outcomes, so a caller knows exactly which of the fifty it got in full and
            // which are still cards -- rather than having to infer it from a missing field.
            detail_report: deep.report.per_listing };
        }
      }
      if (reply && !reply.ok) log.push({ attempt: attemptNo, via, search_api_ret: reply.ret });
      for (let until = Date.now() + SEARCH_RESULT_WAIT_MS; Date.now() < until && Date.now() < deadline;) {
        await settle(page, 1000);
        // Over-ask, then filter. The scraper stops collecting at `limit` but counts to the end of the page, and the filter below runs over what it *collected*, so truncating at `limit` first let a few leading non-matching cards empty the result set and report a successful, self-contradicting answer next to `query_hits: 195`.
        payload = (await scrape(page, SCRAPE_CARDS_JS, { query: q, terms: queryTerms(q), limit: Math.max(cap, 200), rails: RAIL_MARKERS }, 'search-page scrape')) ?? {};
        if (payload?.rendered) break;
      }
      // The fraction is over every card on the page, not the `limit` we kept, and it is counted on the
      // looser of the two relevance rules -- all the query's terms, in any order -- for the same reason
      // the API route does: goofish titles are not in the searcher's word order.
      const cards = Number(payload.cards_scanned) || 0, hits = Number(payload.query_hits) || 0, tokenHits = Number(payload.token_hits) || 0;
      const minHits = Math.max(1, Math.ceil(cards * MIN_MATCH_FRACTION)), accepted = Math.max(hits, tokenHits);
      const declined = !payload.rendered || Boolean(payload.rail) || Boolean(payload.says_no_results) || Boolean(payload.blocked) || accepted < minHits;
      log.push({ attempt: attemptNo, via, rendered: Boolean(payload.rendered), scraped_cards: cards, query_hits: hits, token_hits: tokenHits, accepted_hits: accepted, min_query_hits: minHits, rail: payload.rail || '', says_no_results: Boolean(payload.says_no_results), blocked: Boolean(payload.blocked) });
      if (!declined) {
        // Only the matches, so `count` and every item agree with each other and with the query.
        const items = rankItems(dedupe(payload.items.filter((i: any) => i.matches_query)), cap);
        for (const it of items) rememberCard(it);
        return { query: q, source: 'search_page_dom', via, account_required: false, attempts: attemptNo, attempt_log: log, query_hits: hits, token_hits: tokenHits, matched_by: hits === tokenHits ? 'phrase' : 'all_terms', min_query_hits: minHits, scraped_cards: cards, non_matching_count: Math.max(0, cards - tokenHits), count: items.length, items };
      }
    }
    if (Date.now() >= deadline) { log.push({ attempt: attemptNo, stopped: 'time budget reached' }); break; }
  }
  // Count distinct attempts, not log entries. A searchbox attempt logs twice -- the typing step and
  // then the scrape -- so counting entries reported "6 attempt(s)" for a call that made 3, and counted
  // the typed attempts the same way. An operator reading a refusal to decide whether to raise
  // `attempts` or the budget needs the real number.
  const attemptsMade = new Set(log.filter((e) => e.attempt).map((e) => e.attempt)).size;
  const typed = new Set(log.filter((e) => e.via === 'searchbox' && e.attempt).map((e) => e.attempt)).size;
  const last = log.filter((e) => e.scraped_cards !== undefined || e.error || e.retryable || e.search_api_ret).pop() || {};
  throw new SearchUnavailableError(`goofish never served a usable result set for ${JSON.stringify(q)} in ${Math.round((Date.now() - started) / 1000)}s, over ${attemptsMade} attempt(s) of which ${typed} typed the query into the search box. `
    + 'Search here is a keystroke, not a URL: navigating to /search?q= is measured to serve the 猜你喜欢 rail instead of results (20 cards, zero query hits), so the query is typed into the header input and submitted. Typed attempts fail in four ways, all retried, and the counts say which: `no-search-input-on-homepage` means the page came back as a footer-only shell with no input at all, `incomplete-keystrokes` means the SPA re-rendered the input mid-typing and swallowed part of the query (`typed` is what actually landed, `wanted` the full query; the input is refocused and the tail re-sent before this is reported), `enter-did-not-submit` means the keys landed (`typed`) but the router never moved off `/`, and a `blocked: true` attempt is goofish serving its "非法访问 / 请使用正常浏览器" page instead of the app, which is server-side and lifts after a pause. A `search_api_ret` is goofish\'s own refusal of the search call itself, most often RGV587 ("被挤爆啦") when the anonymous IP is being throttled. A `token_hits` above `query_hits` means the page held matches that contain every word of the query but not the query as one substring.\n  stopped on: '
    + `${log.find((e) => e.stopped)?.stopped || 'the attempt count'}\n  last attempt: ${JSON.stringify(last)}\n  page text: ${JSON.stringify(String(payload.text_preview || '').slice(0, 140))}\n  the wall-clock budget XIANYU_SEARCH_BUDGET_S (90s default) is what bounds the retries, and one attempt is a page load only when the page is cold -- a warm page re-searches in seconds. browse_feed, search_count and search_suggest are unaffected, do not drive a browser page, and always work.`);
};

/** Is the dom page already sitting somewhere with a usable search input, so a search can be typed
 *  into it instead of paying for a fresh page load? A page that is still loading, that is showing the
 *  risk-control notice, or that has been moved off goofish all answer no -- and a `no` is safe, because
 *  the caller then does a real `open`, which re-checks the allowlist properly. The read goes through
 *  `scrape` so the URL is re-checked in the same statement, exactly as every other DOM read is. */
const warmInputUsable = async (session: any): Promise<boolean> => {
  try {
    const page = await session.domReady();
    if (page.isClosed()) return false;
    return Boolean((await scrape(page, SEARCH_INPUT_JS, SEARCH_MARK, 'warm input check', 5))?.found);
  } catch { return false; }
};

/** Turn a captured search reply into ranked, deduped, filtered listings -- or null if it is not a
 *  believable result set for this query. The same relevance guard as the DOM path: a *fraction* of
 *  the results have to really carry the query, so a rail can never be presented as results. A result
 *  carries it by containing the phrase, or by containing every term of it in any order -- see
 *  `queryTerms`, which is the difference between this working on this site and returning nothing. */
const finishSearch = async (page: Page, payloads: any[], q: string, cap: number): Promise<any | null> => {
  // Every page walked contributes its 30 listings, and they are pooled before the guard runs: the
  // fraction has to be over the whole result set, or page 2 could be judged on 30 cards while the
  // answer claims a hundred.
  const cards: any[] = [];
  for (const d of payloads) cards.push(...searchListings(d));
  if (!cards.length) return null;
  const normalized = await evaluate(page, FEED_NORMALIZE_JS, { rows: cards }, 'search normalization');
  const low = q.toLowerCase(), terms = queryTerms(q);
  const all = dedupe((normalized || []).filter((i: any) => i.item_id));
  if (!all.length) return null;
  const titleOf = (i: any) => String(i.title || '').toLowerCase();
  const phrases = all.filter((i: any) => low && titleOf(i).includes(low));
  const matches = all.filter((i: any) => hasAllTerms(i.title, terms));
  const scanned = all.length;
  const minHits = Math.max(1, Math.ceil(scanned * MIN_MATCH_FRACTION));
  // Fewer than a fifth of the results really matching is what a declined search looks like from the
  // API side too, so the same refusal applies; a short page of real matches still passes on the floor of one.
  if (matches.length < minHits) return null;
  const items = rankItems(matches, cap);
  for (const it of items) rememberCard(it);
  return { query_hits: phrases.length, token_hits: matches.length, min_query_hits: minHits, scraped_cards: scanned, pages_fetched: payloads.length,
    // Which rule actually admitted the set, so a caller can see that a result came from the looser
    // term match rather than the exact phrase. `phrase` means the two agreed.
    matched_by: matches.length === phrases.length ? 'phrase' : 'all_terms',
    non_matching_count: Math.max(0, scanned - matches.length), count: items.length, items };
};

/** Wait until the results pager reports `want` as its active page. Bounded, and honest about it:
 *  a false `settled` is not an error, it just means the next click is being made on a pager that has
 *  not caught up, and the click itself reports that. */
const waitForPager = async (page: Page, want: string, budgetMs: number): Promise<{ settled: boolean; on_page: string }> => {
  const until = Date.now() + budgetMs;
  for (;;) {
    const st = await scrape(page, PAGER_STATE_JS, null, 'pager state', 5).catch(() => null);
    if (st && String(st.on_page) === want) return { settled: true, on_page: want };
    if (Date.now() >= until) return { settled: false, on_page: String(st?.on_page ?? '') };
    await settle(page, 250);
  }
};

/** Read the top `want` of a ranked result set in full, in place, and say what each one cost.
 *
 *  This is the expensive half, and it is worth being blunt about the cost: the detail route is one
 *  page load per listing at ~8s, and it does not parallelise. Four browser tabs loading four item
 *  pages at once measured 8.2s per listing against ~9s serially -- goofish throttles per IP, so
 *  concurrency buys nothing and only risks getting more of them declined. 20 listings is about 2.5
 *  minutes; the 50 a side-by-side comparison wants is about 7.
 *
 *  A listing that will not answer is reported as such and left as a card, never dropped: a partial
 *  answer is what a caller can reason about, a silently shorter list is not. */
const enrichDetails = async (session: any, ranked: any[], want: number, deadline: number, all: any[]): Promise<{ items: any[]; report: any }> => {
  const targets = ranked.slice(0, want).filter((i: any) => i?.item_id);
  if (!targets.length) return { items: all, report: { requested: 0, ok: 0, per_listing: [] } };
  const byId = new Map(all.map((i: any) => [String(i.item_id), i]));
  const report: any[] = [];
  for (const t of targets) {
    if (Date.now() >= deadline) { report.push({ item_id: t.item_id, ok: false, why: 'time budget reached' }); continue; }
    const t0 = Date.now();
    try {
      const read = await readListing(session, String(t.item_id), deadline);
      const card = byId.get(String(t.item_id));
      if (read.listing) { Object.assign(card, read.listing, { detail_source: read.listing.source, detailed: true }); report.push({ item_id: t.item_id, ok: true, ms: Date.now() - t0, source: read.listing.source }); }
      else { card.detailed = false; report.push({ item_id: t.item_id, ok: false, why: read.payload?.api_ret || read.payload?.site_error ? `goofish said: ${read.payload.api_ret || 'its own error page'}` : 'the page would not answer' }); }
    } catch (e: any) { report.push({ item_id: t.item_id, ok: false, why: `${e?.error_type ?? 'Error'}: ${String(e?.message ?? e).slice(0, 80)}` }); }
  }
  return { items: all, report: { requested: targets.length, ok: report.filter((r) => r.ok).length,
    // What the depth cost, so a caller can decide whether to ask for more without timing it themselves.
    ms_total: report.reduce((a, b) => a + (b.ms ?? 0), 0), per_listing: report } };
};

/** Ids search has already returned this process, newest last. `search_items` fills it, and item_view
 *  checks it first: searching for a term and then viewing a result is the ordinary sequence, and in
 *  that case the listing is already in hand, so a search card answers without a page load at all. A
 *  card is only ever a *fallback* -- the detail API has everything and the card has five fields -- so
 *  this is the exception, not the rule. Bounded, so a long-lived server does not accumulate every
 *  listing it has ever seen. */
const seenIds = new Map<string, any>();
const rememberCard = (it: any): void => { if (it?.item_id) { seenIds.delete(String(it.item_id)); seenIds.set(String(it.item_id), it); if (seenIds.size > 500) seenIds.delete(seenIds.keys().next().value as string); } };
/** Forget every remembered card. Module state outlives a single call, and a test that has seeded it
 *  with one listing would otherwise have its next `item_view` answered from the cache. */
export const resetCardCache = (): void => { seenIds.clear(); };

/** One listing by id. The page is loaded and its own detail reply is what answers -- measured 4-10s,
 *  and about fifteen fields a search card does not have. A card this process already returned from a
 *  search is the *fallback*, for a listing the item page will not serve: it is the ordinary
 *  "search, then open a result" sequence, but since the detail call is cheap there is no longer a
 *  reason to short-circuit on it and throw those fields away. This replaced a fallback that ran up
 *  to eight whole keyword searches, each a fresh 10-25s page load. */
const itemView = async ({ item_id }: ItemArgs): Promise<Data> => {
  const item = normalizeItemId(item_id);
  if (!item) throw new XianyuError(`item_id must be digits or a goofish item URL, got ${JSON.stringify(item_id)}`);
  // The clock starts before the load, not after it -- a budget that ignores the slowest step in the
  // call is not a budget. The detail reply lands with the render that uses it, so the wait is one
  // window rather than a load plus a poll: measured, 4-6s warm and about 10s cold.
  const started = Date.now(), deadline = started + budget('ITEM_VIEW', 90) * 1000;
  // The item page is loaded on the DOM page and its own `mtop.taobao.idle.pc.detail` reply is what the
  // answer is built from. That call is not ours to make: re-issuing it through the same client, with
  // the same payload, times out, because goofish stamps requests the page originates with a per-call
  // anti-bot blob. So the page makes the call and we read the reply off the wire.
  //
  // This replaces a premise the tool was built on. It used to be documented -- in three separate
  // comments, and in the tool description -- that "goofish does not serve item pages to logged-out
  // visitors" and that the answer had to come from a search sweep instead. Measured against the live
  // site, that is not true: the detail block renders, and the detail API answers SUCCESS anonymously,
  // carrying the title, the full gallery, the description and the seller's statistics. The old code
  // therefore spent its budget reloading a page that was never going to answer, and the sweep it fell
  // back to -- up to eight keyword searches, each a fresh page load -- was dead weight on a path that
  // almost never ran.
  const session = getSession(), read = await readListing(session, item, deadline);
  if (read.listing) {
    const l = read.listing;
    // `item_id` is added here rather than in `readListing` because the two routes return different
    // shapes -- the API route has it in the payload, the DOM route has it as `page_item_id` -- and the
    // envelope has to be the same whichever one answered.
    return { ...l, item_id: item, page_item_id: item, url: `${HOME}item?id=${item}`, account_required: false,
      attempts: read.tries, wants: asCount(l.want_count), browses: asCount(l.browse_count),
      reco_anchors: 0, image_candidates: (l.image_urls || []).length,
      fields_present: ITEM_FIELDS.filter((f) => present(l[f])), fields_missing: ITEM_FIELDS.filter((f) => !present(l[f])) };
  }
  // Nothing to report. Name the cause rather than the symptom.
  const payload = read.payload;
  const why = payload?.api_ret ? `goofish's own detail API refused it: ${payload.api_ret}`
    : payload?.api_item_id ? `the page answered about item ${payload.api_item_id} instead of ${item}`
    : payload?.site_error ? 'goofish served its own "网络不见了" error page on every attempt'
    : payload?.rail_only ? 'every load mounted the app and held only recommendation cards, with no listing in it'
    : 'the page stayed an empty shell';
  throw new DetailUnavailableError(
    `item ${item} could not be read for this anonymous visitor after ${read.tries} page load(s) in ${Math.round((Date.now() - started) / 1000)}s: ${why}. Most often this id is sold, removed, or too old to still be live -- goofish answers a dead id with no listing rather than an error. `
    + `Page text: ${JSON.stringify(String(payload?.head_preview || '').slice(0, 160))}`);
};

/** The core of `item_view`, shared with `search_items`' `detail` argument: load the item page, read
 *  the call it makes for itself, and return the listing. Never throws -- a caller that is reading 20
 *  listings wants "this one would not answer", not an exception that abandons the other nineteen.
 *
 *  It owns the navigation as well as the read, because the reply it wants only exists once the page
 *  has loaded: the first version of the `detail` argument reused this function without the load and
 *  quietly produced zero details for every listing, since a page sitting on a search results page
 *  never issues a detail call. That failure is invisible in the envelope unless you ask, which is
 *  exactly why `search_items` publishes `detail_report`. */
const readListing = async (session: any, item: string, deadline: number): Promise<{ listing: any | null; payload: any; tries: number; page: Page }> => {
  const page = await session.open(`${HOME}item?id=${item}`);
  let payload: any = {}, tries = 0;
  for (tries = 1; tries <= RENDER_ATTEMPTS; tries++) {
    // The API reply and the DOM are read in the same loop, not one then the other: the detail block
    // paints from that same reply, so waiting for one tells you about the other, and two serial
    // waits would double the call for no new information.
    const reply = await session.domTap.take(DETAIL_API, Math.min(ITEM_READY_WAIT_MS, Math.max(0, deadline - Date.now())));
    if (reply) {
      if (reply.ok) {
        const listing = detailListing(reply.data, item);
        if (listing) return { listing: { ...listing, source: 'item_detail_api' }, payload, tries, page };
        // It answered with a different listing, or with no listing at all. That is a page that is not
        // the one that was asked for, and the id check below would refuse it -- but saying so now is
        // cheaper than waiting out a poll that cannot change it.
        payload = { api_item_id: asText(reply.data?.itemDO?.itemId) };
        break;
      }
      payload = { api_ret: reply.ret };
      break;
    }
    payload = (await scrape(page, ITEM_SCRAPE_JS, { item_id: item, rails: RAIL_MARKERS }, 'item-page scrape')) ?? {};
    if (payload?.detail_rendered) break;
    if (tries >= RENDER_ATTEMPTS || Date.now() >= deadline) break;
    // Two of the pages this loop meets are not "not ready", they are answered. A rail-only page is
    // the app having mounted and drawn 猜你喜欢 instead; goofish's "网络不见了" notice is its edge
    // failing outright. Both are terminal for this URL, and spending five reloads and ~2 minutes
    // proving it to a caller who is waiting on an answer is the defect.
    if (payload?.site_error || payload?.rail_only) break;
    await evaluate(page, SCROLL_TO_JS, 400, 'gallery nudge');
    await settle(page, 400);
    await evaluate(page, SCROLL_TO_JS, 0, 'gallery nudge');
    await reloadFresh(page);
    await settle(page, RENDER_SETTLE_MS);
  }
  if (!payload?.detail_rendered) {
    // Last resort before giving up: a listing this process already returned from a search. That is
    // the ordinary "search, then open a result" sequence, and a card is a real listing -- but it is a
    // card, so `source` says so and the fields only the detail page has are named as missing rather
    // than left looking read.
    const cached = seenIds.get(item);
    if (cached) {
      // Unless this same process already read it in full. `search_items`'s `detail` argument merges
      // the detail fields into the very card object the cache holds, so a listing deepened earlier in
      // this session comes back with a description and a seller's statistics -- and blanking those
      // here would throw away data we were actually holding. The blanking is for the plain-card case
      // only, and is exactly the set of fields a card cannot have.
      const blank = cached.detailed ? {} : { description: '', want_count: '', browse_count: '', seller: '', seller_tenure_years: '', seller_items_sold: '', seller_positive_rate: '' };
      const fields = { ...cached, ...blank, item_id: item, page_item_id: item };
      return { listing: { ...fields, source: 'search_card_cache', attempts: tries, page_attempts: tries,
        note: `the item page did not answer for this listing (${payload?.api_ret || payload?.site_error ? 'refused' : 'rendered no detail block'}), so this is the listing as an earlier ${cached.detailed ? 'detail read' : 'search'} in this session published it${cached.detailed ? '' : '. The description, the want and browse counts and the seller\'s statistics live on the item page and are reported missing rather than guessed'}.`,
        ...Object.fromEntries(ITEM_FIELDS.map((f) => [f, fields[f] ?? (f === 'image_urls' ? [] : '')])) }, payload, tries, page };
    }
    return { listing: null, payload, tries, page };
  }
  // Unconditional: a page that renders the detail block but has no `?id=` in its URL is a redirect or
  // a challenge page, not the listing, and skipping the check when `served` is empty is what let an
  // off-site page's fields be reported as this item's.
  const served = String(payload.page_item_id ?? '');
  if (served !== item) throw new ParseError(`asked goofish for item ${item} but the page it served reports item ${served || '(no ?id= in its URL)'}; refusing to report one listing's fields as another's.`);
  return { listing: { ...Object.fromEntries(ITEM_FIELDS.map((f) => [f, payload[f] ?? (f === 'image_urls' ? [] : '')])), source: 'item_page_dom' }, payload, tries, page };
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
      'search_items: keyword search with real depth -- pages walks the result pager for 30 listings a page (up to 10 pages, measured 4 to 81-82 matches in 19-36s, and it tops up by two pages if the pool comes up short of limit), and detail reads the top N in full (one page load each at 7.5-10s; measured 50 full listings, 39 fields, ~246 photos, 0 failures, in 410-550s). Retried because goofish declines some page loads.',
      'item_view: title, price, want/browse counts, description, seller with city/tenure/sales/rating, brand, condition and every photo, from the detail call the item page makes for itself',
    ],
    anonymous_flakiness: [
      'search_items works logged out, but goofish declines on some page loads: the search call is not even made and the page renders the 猜你喜欢 rail instead. It retries, and only accepts a reply or a page when a fraction of the listing titles really contain the query.',
      'The three DOM tools (search_items, item_view, recommendations) can also be served goofish\'s risk-control page instead of the app, which renders zero cards and no rail. That is named as risk_control_page in the output, and it clears after a pause; the four API tools keep working throughout because they need only the mtop client.',
      'Anonymous page rendering is throttled per IP and degrades to an empty shell with no error; the DOM-scraping tools retry and then report what they got.',
    ],
    notes: [
      'goofish puts a dismissible login dialog over anonymous pages. It does not gate anything and it does not need closing: the listing cards are already in the DOM underneath its ant-modal-mask, and clicking its close controls was measured to stop the result list from rendering. This server never clicks it.',
      'The feed is not keyword-filterable and ignores cCatId, so it samples inventory rather than answering queries.',
      'Item detail is read from the call the page makes for itself rather than one this server issues: the same API with the same payload, re-issued through the page\'s own mtop client, answers TIMEOUT::接口超时, because goofish attaches a per-call anti-bot blob to the requests its own bundle originates. Letting the page ask and reading the reply is both the only route that works and the richer one.',
      'The four mtop-only tools run on a separate page from the three that drive a browsing page, so a slow search does not hold up a fast feed call.',
      'Chromium on a network with broken IPv6 can fail to connect at all (ERR_ADDRESS_UNREACHABLE) where curl succeeds, which looks like an empty page -- see the cause list below.',
    ],
    // The measurements that used to live inside the tool descriptions, where every agent paid for them on
    // every session whether it searched or not. They are here instead: fetched once, on demand, by the
    // agent that is about to pay the latency and actually needs to know what it costs.
    measured_latency: {
      'cold browser launch': '~5s, once per session; the session is then reused',
      'item page load': '4-10s; ~8s per listing for `detail`, and it does NOT parallelise -- 4 tabs at once measured 8.2s/listing against ~9s serial, because goofish throttles per IP. 20 listings is about 2.5 minutes, 50 is about 7',
      'search, warm page': '4-12s (an SPA route change); the first search of a session pays 15-41s for a cold load',
      'search pager walk': '30 listings a page at 5-9.5s each, against 13-25s for a fresh page load',
      'how many of a page match': 'varies a lot -- across three sessions `pages: 2` gave 25, 28 and 55 matches of 60 scanned, and `pages: 4` gave 81 of 90. Read `count`; do not assume 30 a page',
      'deep comparison, measured': '`pages: 2, limit: 50, detail: 50` returned 50 full listings, 39 fields and 247 photos, no failures, in 410s',
      'the four mtop-only tools': 'browse_feed / search_count / search_suggest / related_items take no page load at all beyond the boot URL, and do not queue behind a search',
    },
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
const SEARCH_ARGS = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_SEARCH_ITEMS).default(DEFAULT_SEARCH_ITEMS),
  attempts: z.number().int().min(1).max(MAX_SEARCH_ATTEMPTS).default(SEARCH_ATTEMPTS),
  // How many result pages to walk. One page is 30 listings; the pager is clicked (the page's own
  // control, never a dialog dismissal) and each extra page costs 5-9.5s rather than the 13-25s of
  // a fresh load. Capped at 10 because the pager only ever renders boxes 1..10 -- 300 listings.
  // This is a floor, not a ceiling: if those pages leave fewer than `limit` matches, up to two more
  // are walked, because a degraded page should not silently under-deliver.
  pages: z.number().int().min(1).max(MAX_SEARCH_PAGES).default(1),
  // How many of the ranked results to read in full: description, every photo, and the seller's
  // tenure, sales count, rating, reply rate and signature. One page load each, ~8s, and it does
  // NOT go faster in parallel -- goofish throttles per IP, so 4 tabs at once measured 8.2s per
  // listing against ~9s serially. 20 is about 2.5 minutes; 50 is about 7.
  detail: z.number().int().min(0).max(MAX_SEARCH_DETAIL).default(0),
};
const RELATED_ARGS = { item_id: z.string().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).default(30), page: z.number().int().min(1).max(MAX_PAGE_NUMBER).default(1) };
const ITEM_ARGS = { item_id: z.string().min(1) };
const RECO_ARGS = { limit: z.number().int().min(1).max(MAX_LIMIT).default(30), url: z.string().optional() };
type FeedArgs = Args<typeof FEED_ARGS>; type CountArgs = Args<typeof COUNT_ARGS>; type SuggestArgs = Args<typeof SUGGEST_ARGS>;
type SearchArgs = Args<typeof SEARCH_ARGS>; type RelatedArgs = Args<typeof RELATED_ARGS>; type ItemArgs = Args<typeof ITEM_ARGS>; type RecoArgs = Args<typeof RECO_ARGS>;

type ToolDef = { name: string; description: string; schema: z.ZodRawShape; run: (args: any) => Promise<Data> };
/** Wrap a tool so it takes the one lock that matters: the three DOM tools read and navigate the single
 *  shared `domPage`, so two of them at once would navigate it out from under each other and one would
 *  report the other's page as its own data. The four mtop-only tools and `capabilities` are deliberately
 *  left out -- they never touch `domPage`, so making them queue behind a 70s search bought nothing but
 *  latency. The lock lives here, on the tools that need it, rather than in the entry point where it
 *  would apply to all eight. */
const locked = (run: (args: any) => Promise<Data>): ((args: any) => Promise<Data>) => (args: any) => exclusive(() => run(args));
const tool = <S extends z.ZodRawShape>(def: { name: string; description: string; schema: S; run: (args: Args<S>) => Promise<Data> }): ToolDef => def as ToolDef;
const NO_ACCOUNT = ' No Xianyu account, cookie or login is required or used. Read-only: this server cannot publish, message, or change anything.';
export const TOOLS: ToolDef[] = [
  tool({ name: 'capabilities', description: 'Report what this server can do without a Xianyu account right now, probing the live site: session_state, feed_reachable, the split between what works and what is flaky, the measured cost of each call, and the known failure causes. Start here if you are unsure whether a call will work, what it will cost, or what a refusal means. Never raises, not even if the browser is gone. Args: none.' + NO_ACCOUNT, schema: {}, run: capabilities }),
  tool({ name: 'browse_feed', description: 'Page through goofish\'s public homepage feed: live listings with item_id, title, price, city, seller, want_count and image_urls. Not keyword-filterable, so use it to sample inventory, not to answer a query. Args: page_number (1-10000, default 1), pages (1-25, default 1), limit (max items, default 60).' + NO_ACCOUNT, schema: FEED_ARGS, run: browseFeed }),
  tool({ name: 'search_count', description: 'How many goofish listings match a keyword, and whether there are any. Unlike search_items this is not subject to goofish\'s per-page-load declines -- verified returning about 28,800 for "x220" and 0 for a nonsense string anonymously. Args: query (str).' + NO_ACCOUNT, schema: COUNT_ARGS, run: searchCount }),
  tool({ name: 'search_suggest', description: 'goofish\'s own search-box autocomplete: keyword suggestions for a prefix, plus the total suggestion count. Args: query (str), limit (default 20).' + NO_ACCOUNT, schema: SUGGEST_ARGS, run: searchSuggest }),
  tool({ name: 'search_items', description: 'Search goofish listings by keyword, logged out. Depth is two arguments. `pages` (1-10, default 1) walks the result pager for 30 listings a page; it is a floor, not a ceiling -- if the pages walked leave fewer than `limit` matches, up to two more are walked. Read `count` rather than assuming 30 a page. `detail` (0-50, default 0) reads that many of the top-ranked results in full -- description, every photo, and the seller with their city, tenure, sales count, rating, reply rate and signature -- one page load each that does not parallelise, so budget roughly a minute per 8; `detail_report` names which answered and what goofish said about the ones that did not. Cards already carry price, want count, city, seller, avatar, photo and tags, so ask for `detail` only on a shortlist. `items` holds just the listings whose titles really carry the query -- as the phrase, or as every term in any order, which is what makes Chinese work (`机械硬盘4t` has 70,000+ listings; the titles read 西数4T机械硬盘). `matched_by` says which rule admitted the set. The recommendation rail is never returned as results; goofish declines some page loads outright, so this retries and may raise `SearchUnavailableError`. For measured costs, call capabilities. Args: query (str), limit (default 120, capped by XIANYU_SEARCH_MAX_ITEMS), attempts (1-10, default 4; the first 3 type into the search box, the last is a direct-URL fallback), pages (1-10, default 1), detail (0-50, default 0).' + NO_ACCOUNT, schema: SEARCH_ARGS, run: locked(searchItems) }),
  tool({ name: 'related_items', description: 'Listings goofish recommends for a given item ("more like this"), or its generic recommendation set when item_id is omitted. Returns real listings with titles, prices and cities. Args: item_id (optional digits or item URL), limit (default 30), page (1-10000, default 1).' + NO_ACCOUNT, schema: RELATED_ARGS, run: relatedItems }),
  tool({ name: 'item_view', description: 'Read one listing, logged out -- title, price, want and browse counts, the description, the seller with their city, tenure, sales and rating, the brand and condition, and every photo. `source` says which route answered -- `item_detail_api` is the full listing, `item_page_dom` is the rendered page, `search_card_cache` is an earlier search result in this session and is missing the description and the seller statistics, which `fields_missing` names rather than guessing. Most often an id that cannot be read has been sold or removed; that raises `DetailUnavailableError`. Args: item_id (digits or item URL).' + NO_ACCOUNT, schema: ITEM_ARGS, run: locked(itemView) }),
  tool({ name: 'recommendations', description: 'Scrape goofish\'s recommendation rails (猜你喜欢 / 为你推荐) for an anonymous visitor from any goofish page. Falls back to live feed listings if the DOM will not cooperate, and says so in `source` and `fallback_reason`. Args: limit (default 30), url (optional goofish page to load, default the homepage).' + NO_ACCOUNT, schema: RECO_ARGS, run: locked(recommendations) }),
];
