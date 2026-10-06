/** The ten tools. Six run on the api page and need nothing but goofish's mtop client:
 *  browse_feed, search_count, search_suggest, related_items, seller_profile, seller_items. Two drive
 *  the dom page and read the replies its own bundle fetches: item_view and search_items.
 *  capabilities never raises, even when the browser is gone. Every page read goes through
 *  browser.ts, so a Playwright failure arrives as a typed XianyuError instead of escaping a call.
 *
 *  The mtop-only tools do not queue behind the ones that drive a browser. They used to share one
 *  page, and a 70s search held up a feed call that does 1.5s of work. The lock therefore sits here,
 *  on the three tools that read the one navigating page (`search_items`, `item_view`,
 *  `recommendations`), and nowhere else. Wrapping every tool at the entry point re-serialised the
 *  fast ones behind the slow ones, and the test that claimed to rule that out called `t.run`
 *  directly, so it never ran the shipped path.
 *
 *  `seller_profile` and `seller_items` are why the rule is stated as "where a navigating page is
 *  read" and not as a tool list. With a `user_id` they are two plain mtop calls that take nothing.
 *  With an `item_id` they have to find the seller behind that listing first, and the only route to
 *  one is the detail call the item page makes for itself: they hold the lock for that hop and drop
 *  it before the mtop calls. See `resolveSeller`. */
import { z } from 'zod';
import type { Page } from 'playwright';
import { DetailUnavailableError, describe, GatedError, NavigationError, ParseError, SearchUnavailableError, XianyuError } from './errors.ts';
import { buildBlock } from './build.ts';
import { getItem, getSearchPage, itemKey, itemTtl, missed, notCached, pageReport, putItem, putSearchPage, searchTtl, stats as cacheStats } from './cache.ts';
import type { CacheVerdict } from './cache.ts';
import { ensureGoofishUrl, evaluate, exclusive, getSession, HOME, reloadFresh, settle } from './browser.ts';
import { detailListing, enrichListing, FEED_NORMALIZE_JS, hasAllTerms, ITEM_SCRAPE_JS, PAGER_CLICK_JS, PAGER_STATE_JS, queryTerms, RAIL_MARKERS, SCROLL_TO_JS, SCRAPE_CARDS_JS, searchListings, SEARCH_INPUT_JS, SEARCH_MARK, SEARCH_STATE_JS, sellerListings, sellerProfileOf } from './extract.ts';
type Data = Record<string, any>;
// The mtop endpoints this server is allowed to name. Found by pulling all 51 `mtop.*` names out of
// goofish's own JS bundles (idle-pc/xy-site) and reading the minified call sites for the parameter
// shapes, which is why these nine worked first time. All of them answer anonymously, and a test fails
// the build if any other mtop name shows up anywhere in the tree.
//
// DETAIL_API and SEARCH_API are never called by us. The page calls them and we read the replies off
// the wire, in `item_view` and `search_items`. Re-issuing either through the page's own mtop client,
// with the payload the page itself sent, answers TIMEOUT::接口超时: goofish stamps the requests its
// own bundle originates with a per-call anti-bot blob, and a synthesised request carries none. Letting
// the page make the call works, and returns strictly more than the DOM did.
//
// The two seller endpoints turn that rule round. goofish stamps only what its own bundle originates,
// so an endpoint the *current* page never happens to use can go through the very same client and
// answers normally: `page.head` was verified SUCCESS from an item page, which never calls it, on
// nothing but `{userId}`. Response interception cannot make that call at all, which is why these two
// endpoints exist.
const FEED_API = 'mtop.taobao.idlehome.home.webpc.feed';
// The match counter. The search page calls it with the same payload shape as search and reads
// `data.hitnum`, so it answers "how many items match this keyword" for a logged-out visitor even on
// the loads where search is declined. Keyword work does not need the search page because of this:
// about 28,800 for "x220" (it drifts -- 28,791 / 28,804 / 28,810 observed), 0 for nonsense.
const HITNUM_API = 'mtop.taobao.idle.filter.hitnum.pc.get';
const SUGGEST_API = 'mtop.taobao.idlemtopsearch.pc.search.suggest';
const RECOMMEND_API = 'mtop.taobao.idle.item.web.recommend.list';
const LOGINUSER_API = 'mtop.taobao.idlemessage.pc.loginuser.get';   // never used to act as a user: it exists only to *prove* the session is logged out
const DETAIL_API = 'mtop.taobao.idle.pc.detail';
const SEARCH_API = 'mtop.taobao.idlemtopsearch.pc.search';
// The seller profile endpoint -- the one the /personal?userId= page calls for itself. `{userId}`
// alone is enough: measured, a payload of `encryptedUserId` by itself is refused with
// FAIL_BIZ_CLIENT_PARAM_INVALID, so the encrypted id a search card carries is not a way in, and
// `self: false` or an empty `encryptedUserId` changes nothing. Returns `data.baseInfo` and
// `data.module.{base,shop,social,tabs}`. A user that does not exist answers FAIL_BIZ_USER_NOT_FOUND
// rather than an empty object, which is what makes it worth a tool.
const SELLER_HEAD_API = 'mtop.idle.web.user.page.head';
// One seller's own listings -- the tab the same /personal page heads with 宝贝.
// `{userId, pageNumber, pageSize, needGroupInfo}`. `nextPage` can be trusted; `totalCount` is always 0,
// measured at two page sizes against a seller with six live listings, so nothing reads it.
const SELLER_ITEMS_API = 'mtop.idle.web.xyh.item.list';
// The keys this payload carries whatever else it does, measured on both of its shapes: a page with
// listings on it, and a page past the end (which omits `cardList` and keeps the rest). They tell "this
// seller has nothing here" apart from "this is not the payload I asked for". The first is an answer,
// the second is a `ParseError`, and a check on `cardList` alone cannot tell them apart.
const payloadKeys = ['cardList', 'nextPage', 'totalCount', 'itemGroupList', 'itemTopicList', 'serverTime'];
// pageSize is hardcoded to 30 in goofish's bundle and the endpoint rejects anything else with
// FAIL_BIZ_COMMON_PARAM_ILLEGAL, so `limit` is applied client-side after the call. A missing itemId is
// rejected outright, so the generic case uses goofish's own seed id -- what its bundle substitutes when
// there is no item context.
const RECOMMEND_PAGE_SIZE = 30, RECOMMEND_SEED_ITEM_ID = '809806779491';
// One seller's own listings, 20 a page. Verified at 20 and at 2: at 2 `nextPage` went true and a page 2
// returned the two listings after the first two, so the pager is real and not just a field that exists.
// 20 is also the ceiling goofish enforces, and it is what buys the page ceiling below: 50 pages of 20 is
// 1000 listings, measured as the exact edge (page 50 SUCCESS, page 51 FAIL_BIZ_FORBIDDEN::||最大可查看
// 页数或者每页最大可查看商品数超限; pageSize 30 refused at page 1).
const SELLER_PAGE_SIZE = 20, MAX_SELLER_PAGE = 50;
// goofish's own feed runs out of pages well before this; the bound is here so a nonsense page_number
// cannot become a nonsense request.
const MAX_PAGES = 25, MAX_LIMIT = 500, MAX_PAGE_NUMBER = 10_000;
// Every field item_view reports, in one place so the honesty contract (fields_present /
// fields_missing) and the scraper cannot drift apart. Exported, and a test asserts every entry is a
// key the scraper actually returns.
export const ITEM_FIELDS = ['title', 'price', 'want_count', 'browse_count', 'description', 'seller', 'seller_tenure_years', 'seller_items_sold', 'seller_positive_rate', 'image_urls'] as const;
// The same contract for seller_profile, split in two because the halves come from different places
// and cost different things. The profile endpoint answers the seller's *standing* -- credit tier, shop
// level and score, praise ratio, review count, followers, how many listings they have up, which
// identity checks they have passed -- and says nothing about where they are or how long they have been
// on goofish: those seven live on the item page's `sellerDO`, and reading them costs a page load. A
// caller who passes `user_id` gets the standing fields, the other seven come back null and are named in
// `missing`, and the tool description says which argument buys which half. Exported for the same reason
// ITEM_FIELDS is: a test asserts every entry is a key the tool actually returns, so a field cannot be
// renamed here and left stale there.
export const SELLER_PROFILE_FIELDS = ['display_name', 'avatar_url', 'signature', 'seller_credit', 'buyer_credit', 'level', 'level_score', 'praise_ratio', 'review_count', 'listings_count', 'ratings_count', 'followers', 'following', 'verified_real_name', 'verified_real_person', 'verified_zhima', 'city', 'tenure_years', 'items_sold', 'items_listed', 'positive_rate', 'reply_rate_24h', 'last_active'] as const;
// Which of those come from the item page rather than the profile endpoint. Named as data rather than
// left implicit in an `if`, so the test that pins the honesty contract reads the same list the tool does.
export const SELLER_ITEM_PAGE_FIELDS = ['city', 'tenure_years', 'items_sold', 'items_listed', 'positive_rate', 'reply_rate_24h', 'last_active'] as const;
// goofish renders anonymous pages as a coin flip: the same URL comes back fully rendered or as an empty
// shell. Retry a few times before calling it a failure. Reloads are cache-busted with a nonce, since a
// cached empty shell is exactly the failure to escape.
const RENDER_ATTEMPTS = 5, RENDER_SETTLE_MS = 3500;
const SEARCH_ATTEMPTS = 4, MAX_SEARCH_ATTEMPTS = 10;
// The pager only ever renders boxes 1..10 (`1 2 ... 10 ... 50`), so 10 pages is as deep as this
// route goes without clicking the ellipsis: 300 listings, against the 50 a comparison needs.
const MAX_SEARCH_PAGES = 10, MAX_SEARCH_DETAIL = 50;
// How many extra pages a walk may take when the ones it was asked for leave fewer than `limit`
// matches. It is named here rather than inside the walk because the cache fast path has to know the
// deepest page a call could reach before it can decide whether it can answer without a browser at all.
const SEARCH_TOPUP_PAGES = 2;
// The whole pager: ten numbered boxes at 30 listings a page. That is the most a walk can collect,
// and it is also the bound a huge walk has to respect alongside the wall clock.
const MAX_SEARCH_ITEMS = MAX_SEARCH_PAGES * 30, DEFAULT_SEARCH_ITEMS = 120;
// How long item_view waits for the page's own detail call before it calls the listing dead. The reply
// lands with the render that uses it, so this is the same window the old DOM poll needed (32s) and no
// more: a reply that never comes is a dead listing, not a slow one, and a 90s budget that has to cover
// two minutes of reloads was buying nothing.
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
// so a missing input in the first ten seconds is normal and gets polled, not judged.
const SEARCH_INPUT_WAIT_MS = 15_000, SEARCH_RESULT_WAIT_MS = 32_000, SEARCH_TYPED_ATTEMPTS = 3;
// A result set is believable only if a *fraction* of the page's cards really match. One title
// containing the query proves nothing: a 40-card rail with 12 incidental hits and one match both pass a
// `hits > 0` test. 20% of the cards on the page, and never less than one.
const MIN_MATCH_FRACTION = 0.2;
// Ret strings that mean "goofish will not serve this to you", as opposed to a bug.
const GATE_MARKERS = ['mini_login', 'RGV587', 'FAIL_SYS_SESSION_EXPIRED', 'FAIL_SYS_TOKEN', 'ILLEGAL_ACCESS', 'TIMEOUT', '非法访问', '令牌过期'];
// The narrower list, for the one gate that means something specific: `session_state` is the point of
// `capabilities`, and a rate limit (RGV587) or a TIMEOUT says nothing about whether a session exists.
// Reporting either as proof of anonymity is how a throttled probe reads as a verified fact.
const NO_SESSION_MARKERS = ['SESSION_EXPIRED', 'TOKEN', '令牌过期'];

// ---------------------------------------------------------------- pure helpers
const clamp = (value: unknown, low: number, high: number): number => { const n = Number(value); return Number.isFinite(n) ? Math.max(low, Math.min(Math.trunc(n), high)) : low; };
const itemIdFromUrl = (url: unknown): string => String(url ?? '').match(/[?&]id=(\d+)/)?.[1] ?? '';
/** Accept a bare item id or a goofish item URL and return the bare digits. */
const normalizeItemId = (value: unknown): string => { const s = String(value ?? '').trim(); return itemIdFromUrl(s) || (/^\d+$/.test(s) ? s : ''); };
/** Accept a bare seller id or a goofish /personal?userId= URL and return the bare digits.
 *
 *  Strictly digits, like `normalizeItemId`, and for a sharper reason: this is a value read out of
 *  goofish's own payload rather than typed by a caller, so anything else is a mistake rather than a
 *  formatting to forgive. Measured -- `kcUserId` in the profile payload and `sellerId` in a detail
 *  reply's `sellerDO` are the same plain integer ("2214350705775"), which is also what the /personal
 *  route takes. The *encrypted* id a search card carries (`clickParam.args.seller_id`,
 *  "jRM3w0UnqSvHrFFMpqPdsQ==") is a different value, and `page.head` refuses it. */
const normalizeUserId = (value: unknown): string => { const s = String(value ?? '').trim(); const url = s.match(/[?&]userId=(\d+)/)?.[1] ?? ''; return url || (/^\d+$/.test(s) ? s : ''); };
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
/** "Non-empty" presence: an array is truthy in JS, so a gallery that never loaded must not be reported as if it were there. */
const present = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : Boolean(v));
/** Wall-clock budget for one best-effort tool's retry *loop*, overridable via XIANYU_<NAME>_BUDGET_S,
 *  floored at 5s and capped at 600s: a floor keeps the tools usable, a ceiling keeps the override from
 *  restoring the multi-minute hang the function exists to prevent. It does not bound the call -- a page
 *  load costs 10-25s on a slow link and one already in flight runs to completion. Read per call, so a
 *  script can change it. */
export const budget = (name: string, defaultS: number): number => { const raw = process.env[`XIANYU_${name}_BUDGET_S`]; const n = Number(raw); return raw?.trim() && Number.isInteger(n) ? clamp(n, 5, 600) : defaultS; };
/** The runtime ceiling on one search_items call, overridable via XIANYU_SEARCH_MAX_ITEMS and read
 *  per call like `budget`. It clamps both `limit` and how deep the pager walk goes (one page per
 *  30 listings), so even "pages: 10, limit: 500" stops at this many results. The ceiling exists so a
 *  capped walk still fits inside the XIANYU_SEARCH_BUDGET_S wall clock: the deeper the walk, the more
 *  serial page loads it spends on the one shared dom page. The default answers the whole pager, and
 *  the floor keeps a typo'd override from silently neutering search. */
export const searchCap = (): number => { const raw = process.env.XIANYU_SEARCH_MAX_ITEMS; const n = Number(raw); return raw?.trim() && Number.isInteger(n) ? clamp(n, 30, MAX_SEARCH_ITEMS) : MAX_SEARCH_ITEMS; };
/** The one way this file reads the DOM. `Session.open` checks the allowlist on the URL it landed on,
 *  but that is point-in-time: `search_items` then polls for up to 32s and `item_view` for up to 32s
 *  before either reads anything, and the page can be moved off goofish in that window. So the check
 *  runs again on the URL that is live *now*, in the same statement as the read, and every scraper goes
 *  through here. `timeoutS` is for the cheap probes, which must not inherit the 90s an in-page read is
 *  allowed. */
const scrape = (page: Page, fn: any, arg: any, what: string, timeoutS?: number): Promise<any> => { ensureGoofishUrl(page.url()); return evaluate(page, fn, arg, what, timeoutS); };
/** Every listing this server publishes goes through here: the flat fields the normalisers produced,
 *  plus `typed` (the same values as numbers, ISO timestamps and structured objects) and `missing` (the
 *  paths inside `typed` the site did not render). One function rather than four because the shape a
 *  caller reads must not depend on which route answered. A feed card, a search card, a DOM-scraped
 *  card and the detail API each fill a different subset of the same block and all four publish the
 *  same keys, so "which of these is absent" is a question about the answer, not about the plumbing.
 *
 *  It only ever *adds*. The flat fields keep the site's own strings -- `price` stays `"366"` next to
 *  `typed.price_amount: 366` -- because a field that changes type under an existing caller is a
 *  breaking change wearing a version number. The block beside it is what removes the reason to parse
 *  anything. See `enrichListing` in extract.ts for the values and the missing-field rule.
 *
 *  It runs here, in Node, rather than inside `FEED_NORMALIZE_JS`, for the same reason the rail markers
 *  are passed into the scrapers: an in-page script is serialised alone with its one argument, so a
 *  second copy of these rules inside it would be a second copy to drift. */
const withTyped = <T extends Record<string, any>>(items: T[] | null | undefined): any[] => (items ?? []).map((i) => enrichListing(i));
// -------------------------------------------------------------------- the tools
/** Page through goofish's public homepage feed. The feed is personalised-by-anonymity rather than by
 *  keyword: each pageNumber returns a different slice of live inventory. Verified 8 pages / 157 unique
 *  listings, 0 duplicates, no rate limiting. */
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
    // Nothing came back. A gate on every page is a refusal; anything else is more likely a shape change,
    // and the two call for different advice.
    const gated = pageReports.find((r) => isGated(r.ret));
    if (gated) throw new GatedError(`goofish refused the anonymous feed on every page of [${wanted}]: ${gated.ret}. It may be rate limiting this IP; wait a minute and retry.`);
    throw new ParseError(`feed returned no cards for pages [${wanted}]: ${JSON.stringify(pageReports)}. The card shape may have changed.`);
  }
  const normalized = await evaluate(page, FEED_NORMALIZE_JS, { rows: rows.map((r) => r?.cardData || r) }, 'feed normalization');
  const items = withTyped(dedupe((normalized || []).filter((i: any) => i.item_id)));
  if (!items.length) throw new ParseError(`feed returned cards but none had an item id -- the response shape likely changed. First card keys: ${Object.keys(rows[0] || {}).sort().slice(0, 12)}`);
  const ranked = rankItems(items, clamp(limit, 1, MAX_LIMIT));
  return { source: 'homepage_feed', account_required: false, requested_pages: wanted, page_reports: pageReports, raw_cards: rows.length, unique_items: items.length, count: ranked.length, items: ranked };
};

/** How many listings match a keyword. Uses the filter-counter endpoint the search page itself calls to
 *  populate its result count: it takes the same payload as search but is a different endpoint, so unlike
 *  search it is not subject to goofish's per-page-load declines. */
const searchCount = async ({ query }: CountArgs): Promise<Data> => {
  const q = requireQuery(query);
  const session = getSession();
  await session.ensureReady();
  const entry = (await session.call([['hitnum', HITNUM_API, { pageNumber: 1, keyword: q, rowsPerPage: 30, searchReqFromPage: 'pcSearch', extraFilterValue: '{}', userPositionJson: '{}', customDistance: '', customGps: '', gps: '' }]]))?.hitnum || {};
  if (!entry.ok) throw new GatedError(`goofish refused the match counter for ${JSON.stringify(q)}: ${entry.ret}`);
  const raw = entry.data?.hitnum, count = raw == null || raw === '' ? NaN : Number(raw);
  // A count that cannot be read is not a count of zero. A missing, null, 'oops' or '1,234' hitnum is a
  // shape change, and "no matches" is the one reply this tool must never give to "I don't know".
  if (!(count >= 0)) throw new ParseError(`match counter returned an unreadable hitnum for ${JSON.stringify(q)}: ${JSON.stringify(raw)}. data keys=${Object.keys(entry.data ?? {}).sort().slice(0, 10)}`);
  return { query: q, match_count: Math.trunc(count), has_matches: count > 0, account_required: false, source: 'filter_hitnum' };
};

/** goofish's own search-box autocomplete: turns "x220" into "x220笔记本" and friends, and is a cheap
 *  signal that a term is understood at all. */
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

/** Listings goofish recommends for a given item ("more like this"), or its generic recommendation set
 *  when item_id is omitted -- which is what the page itself requests. The cards are the same shapes the
 *  homepage feed returns, so they go through the same normalizer. */
const relatedItems = async ({ item_id, limit = 30, page = 1 }: RelatedArgs): Promise<Data> => {
  const iid = item_id ? normalizeItemId(item_id) : '';
  const session = getSession(), pg = await session.ensureReady();
  const entry = (await session.call([['rec', RECOMMEND_API, { itemId: iid || RECOMMEND_SEED_ITEM_ID, categoryId: '', pageNum: clamp(page, 1, MAX_PAGE_NUMBER), pageSize: RECOMMEND_PAGE_SIZE, reqFrom: 'xianyuweb' }]]))?.rec || {};
  if (!entry.ok) throw new GatedError(`goofish refused the recommendation endpoint: ${entry.ret}`);
  const payload = entry.data || {}, cards = Array.isArray(payload.cardList) ? payload.cardList : [];
  if (!cards.length) throw new ParseError(`recommendation endpoint returned no cards for item ${iid || '(generic)'}: keys=${Object.keys(payload).sort().slice(0, 10)}`);
  const normalized = await evaluate(pg, FEED_NORMALIZE_JS, { rows: cards.map((c: any) => c?.cardData || c) }, 'recommendation normalizer');
  const items = withTyped(dedupe((normalized || []).filter((i: any) => i.item_id)));
  if (!items.length) throw new ParseError('recommendation cards had no item ids; the payload shape likely changed');
  const ranked = rankItems(items, clamp(limit, 1, MAX_LIMIT));
  return { item_id: iid || null, page: clamp(page, 1, MAX_PAGE_NUMBER), account_required: false, source: 'item_web_recommend', raw_cards: cards.length, unique_items: items.length, has_more: Boolean(payload.hasMore), count: ranked.length, items: ranked };
};

/** Which seller a call is about, and what it cost to find out.
 *
 *  The two arguments are alternatives, not a pair. `user_id` names the seller outright and costs
 *  nothing beyond the mtop call that follows; `item_id` means "whoever is selling this listing" and
 *  has to be resolved first. Passing both is refused rather than letting one quietly win, because a
 *  caller who passes both and gets the wrong one cannot tell from the envelope that their `item_id`
 *  was dropped -- the failure this server keeps making elsewhere and keeps paying for.
 *
 *  The resolution hop is the one part of a seller tool that is not mtop-only, and it cannot be.
 *  `mtop.taobao.idle.pc.detail` re-issued through the page's own client answers `TIMEOUT::接口超时`
 *  -- verified again while building this, on the same page and the same client that answer every
 *  other call here -- because goofish stamps the requests its own bundle originates. So the item page
 *  is loaded and its own detail reply is read off the wire: the route `item_view` takes, on the shared
 *  dom page, under the shared lock.
 *
 *  The lock covers that hop and nothing else, and the mtop calls that follow run outside it. Holding
 *  it for the whole tool, which is what wrapping these in `locked()` would do, would queue two plain
 *  mtop tools behind every 70s search and give back the one latency property the two-page session
 *  exists for. */
const resolveSeller = async ({ user_id, item_id }: SellerArgs): Promise<{ user_id: string; item_id: string; listing: any | null }> => {
  const uid = normalizeUserId(user_id), item = item_id === undefined || item_id === null || item_id === '' ? '' : normalizeItemId(item_id);
  if (user_id && !uid) throw new XianyuError(`user_id must be digits or a goofish /personal?userId= URL, got ${JSON.stringify(user_id)}`);
  if (item_id && !item) throw new XianyuError(`item_id must be digits or a goofish item URL, got ${JSON.stringify(item_id)}`);
  if (uid && item) throw new XianyuError('give user_id or item_id, not both: user_id names a seller outright and item_id means "the seller of this listing", and guessing which one you meant would answer a question you did not ask');
  if (uid) return { user_id: uid, item_id: '', listing: null };
  if (!item) throw new XianyuError('give user_id (the seller id seller_profile reports) or item_id (a listing, to find its seller)');
  const session = getSession();
  // The clock starts before the load, for the same reason item_view's does: the load is the slowest step
  // in the hop and a budget that ignores it is not a budget. This one is overridable under its own name
  // because it is a different call from item_view's -- a caller walking 20 listings wants 20 short
  // budgets, not one long one -- and a direct user_id lookup runs no loop, so it spends none of it.
  const started = Date.now(), deadline = started + budget('SELLER_PROFILE', 90) * 1000;
  const read = await exclusive(() => readListing(session, item, deadline));
  const found = normalizeUserId(read.listing?.seller_id);
  if (!found) {
    throw new DetailUnavailableError(`item ${item} has no readable seller on it after ${read.tries} page load(s) in ${Math.round((Date.now() - started) / 1000)}s, so there is nothing to look up. The listing is usually sold or removed; pass user_id directly if you already have one.`);
  }
  return { user_id: found, item_id: item, listing: read.listing };
};

/** The standing numbers a seller's city, tenure and sales history come from, read out of a detail
 *  payload's `sellerDO`, and the only ones in `SELLER_ITEM_PAGE_FIELDS` that cost a page load. Taken
 *  raw rather than through `detailListing`, because that needs the payload and `detailListing` has
 *  already reduced it to a listing. */
const sellerStanding = (listing: any | null): Data => {
  const s = listing ?? {};
  return { city: asText(s.seller_city), tenure_years: asText(s.seller_tenure_years), items_sold: asText(s.seller_items_sold), items_listed: asText(s.seller_items_listed), positive_rate: asText(s.seller_positive_rate), reply_rate_24h: asText(s.seller_reply_rate_24h), last_active: asText(s.seller_last_active) };
};

/** One seller's public profile, logged out: who they are and how they stand.
 *
 *  Two hops, and only one of them costs anything. Given a `user_id` this is a single call to the
 *  endpoint the /personal page uses, issued through that page's own mtop client from a page that never
 *  makes it -- the only way to reach it, and it works because goofish stamps only the calls its own
 *  bundle originates (see `SELLER_HEAD_API`). Given an `item_id` the seller is found first, off the
 *  item page's own detail reply, and that hop also yields the seven fields the profile endpoint has no
 *  answer for at all: city, tenure, sales, listings, positive rate, reply rate and last active. The
 *  profile's own `module.base.ipLocation` is deliberately not published as the city -- it is where
 *  goofish thinks the *request* came from, and it measured 上海市 for a seller whose own record says
 *  北京. See `sellerProfileOf`.
 *
 *  What a caller passed shows up in the envelope rather than in a null. The two halves are named in
 *  `SELLER_PROFILE_FIELDS` and `SELLER_ITEM_PAGE_FIELDS`, so a caller that passed `user_id` sees the
 *  standing fields and the rest explicitly null and listed in `missing`, instead of an empty-looking
 *  profile that reads as "this seller has no history". `verified_*` are the exception: a tag that is
 *  absent and a tag that is false both publish `false`, because both mean the same thing. */
const sellerProfile = async (args: SellerArgs): Promise<Data> => {
  const { user_id: uid, item_id: item, listing } = await resolveSeller(args);
  const session = getSession();
  await session.ensureReady();
  const entry = (await session.call([['head', SELLER_HEAD_API, { userId: uid }]]))?.head || {};
  if (!entry.ok) {
    // A seller that does not exist is the one refusal here with a definite meaning, and it is the same
    // shape as item_view's dead listing: the thing asked for is not there rather than the call having
    // been declined. Anything else -- a throttle, a token, a timeout -- is a plain gate.
    if (/USER_NOT_FOUND/.test(String(entry.ret))) throw new DetailUnavailableError(`goofish has no seller ${uid}: ${entry.ret}. The id is wrong, or the account has been closed. Pass item_id instead to ask about the seller of a live listing.`);
    throw new GatedError(`goofish refused the seller profile for ${uid}: ${entry.ret}`);
  }
  const profile = sellerProfileOf(entry.data);
  if (normalizeUserId(profile.user_id) !== uid) throw new ParseError(`asked goofish for seller ${uid} and its profile payload reports ${profile.user_id || '(no user id)'}; refusing to report one seller's standing as another's`);
  const standing = sellerStanding(listing);
  const data = { ...profile, ...standing, user_id: uid, profile_url: `${HOME}personal?userId=${uid}`, item_id: item || null, account_required: false };
  return { ...data, source: item ? 'item_detail+idle_user_page_head' : 'idle_user_page_head',
    // Spelled out rather than left for the reader to infer from nulls: the difference is the cost of the
    // call, and an agent deciding whether to re-run it with an item_id has to see it.
    note: item ? 'the city, tenure, sales and rating below came from this listing\'s detail record; the standing came from the seller profile endpoint.' : 'pass item_id as well for this seller\'s city, tenure, sales count and positive rate -- those live on a listing\'s detail record, not on the profile, so they are missing rather than blank.',
    fields_present: SELLER_PROFILE_FIELDS.filter((f) => present(data[f])), fields_missing: SELLER_PROFILE_FIELDS.filter((f) => !present(data[f])) };
};

/** The listings one seller currently has up, logged out. The 宝贝 tab of the same /personal page, from
 *  the endpoint that tab calls for itself.
 *
 *  This is the gap that made the profile worth having: nothing else in this server can answer "what
 *  else does this seller have", and on a site with no ratings and no feedback threads that question is
 *  the whole of due diligence. The cards carry a price, a category, a photo and the label strip, and
 *  they go through `sellerListings` rather than the feed normaliser because this endpoint's title field
 *  is not the feed's title field and its `detailUrl` is an app deep link.
 *
 *  `has_more` comes from the payload's own `nextPage`, checked against a real second page rather
 *  than assumed: at `pageSize: 2` against a seller with six listings it went true, and page 2 returned
 *  the next two ids. `totalCount` is in the payload, is always 0, and is not published.
 *
 *  Two things this endpoint does that the others do not, both found by a live run rather than by
 *  reading its payload. It omits `cardList` entirely on a page past the end -- a `SUCCESS` with no
 *  listings in it -- so a missing card list is `count: 0`, not a `ParseError`; and a page past 50 is
 *  refused with `FAIL_BIZ_FORBIDDEN`, which is why `page` is bounded here rather than at the shared
 *  10,000. It also answers `FAIL_BIZ_NOT_FOUND::||对方账号不存在` for a seller that is not there, which
 *  is the same fact `page.head` reports as `FAIL_BIZ_USER_NOT_FOUND`, so both tools name it the same
 *  way. */
const sellerItems = async ({ user_id, item_id, limit = SELLER_PAGE_SIZE, page = 1 }: Args<typeof SELLER_ITEMS_ARGS>): Promise<Data> => {
  const { user_id: uid, item_id: item } = await resolveSeller({ user_id, item_id });
  const wanted = clamp(page, 1, MAX_SELLER_PAGE), cap = clamp(limit, 1, MAX_LIMIT);
  const session = getSession();
  await session.ensureReady();
  const entry = (await session.call([['items', SELLER_ITEMS_API, { needGroupInfo: true, pageNumber: wanted, userId: uid, pageSize: SELLER_PAGE_SIZE }]]))?.items || {};
  if (!entry.ok) {
    if (/NOT_FOUND/.test(String(entry.ret))) throw new DetailUnavailableError(`goofish has no seller ${uid}: ${entry.ret}. The id is wrong, or the account has been closed. Pass item_id instead to ask about the seller of a live listing.`);
    if (/FORBIDDEN/.test(String(entry.ret))) throw new GatedError(`goofish refused page ${wanted} of seller ${uid}: ${entry.ret}. The endpoint serves at most ${MAX_SELLER_PAGE} pages of ${SELLER_PAGE_SIZE}, and walks \`has_more\` rather than asking for a page number up front.`);
    throw new GatedError(`goofish refused the listing list for seller ${uid}: ${entry.ret}`);
  }
  const payload = entry.data || {};
  const cards = sellerListings(payload);
  // No cards is an answer, not a failure: an empty cardList and an absent cardList both mean this
  // seller has nothing on this page. A payload that does not look like this endpoint's at all is not an
  // answer, which is why the check is for its always-present keys rather than for the one that can
  // go missing.
  if (!cards.length && !payloadKeys.some((k) => k in payload)) throw new ParseError(`the seller listing endpoint returned a payload for ${uid} carrying none of its own keys (${payloadKeys.join(', ')}): got ${Object.keys(payload).sort().slice(0, 10)}. The payload shape may have changed.`);
  const items = dedupe(cards).slice(0, cap).map((it: any, i: number) => ({ ...it, rank: i + 1 }));
  return { user_id: uid, profile_url: `${HOME}personal?userId=${uid}`, item_id: item || null, page: wanted, account_required: false, source: 'idle_xyh_item_list', raw_cards: cards.length, has_more: Boolean(payload.nextPage), count: items.length, items };
};

/** Scrape goofish's 猜你喜欢 / 为你推荐 rails for an anonymous visitor. Renders are flaky, so this
 *  retries under a clock, like the other two best-effort tools: five renders with a reload between each
 *  is five minutes of somebody's timeout at the 60s navigation timeout. When the DOM never cooperates it
 *  falls back to the feed API and says so in `source`, rather than returning an empty list. */
const recommendations = async ({ limit = 30, url }: RecoArgs): Promise<Data> => {
  const cap = clamp(limit, 1, MAX_LIMIT), target = url || HOME;
  // The clock starts before the load, for the same reason item_view's does: a budget that ignores the
  // slowest step in the call is not a budget. The elapsed time in `fallback_reason` was understating
  // itself by one page load.
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
  const items = rankItems(withTyped(dedupe(payload.items)), cap);
  return { source: 'dom_recommendation', rail: payload.rail || '', page_url: page.url(), account_required: false, attempts: attemptNo, says_no_results_for_query: Boolean(payload.says_no_results), risk_control_page: Boolean(payload.blocked), count: items.length, items };
};

/** Type `query` into goofish's own header search input and press Enter, then wait for the router to
 *  land on /search. Returns the attempt log's verdict rather than throwing, because every way this
 *  can go wrong is retryable and the retry is the caller's decision. Three waits, in order: (1) the
 *  input, which the homepage does not have for the first 8-14s while the app mounts, so a miss is
 *  polled rather than concluded; (2) the keys, sent with `keyboard.type` because the SPA owns the
 *  input's value and a DOM assignment React never sees would submit an empty keyword; (3) the route,
 *  which needs ~12s after Enter and during which the SPA destroys the execution context out from
 *  under the poll -- a lost context is waited out, since that is the navigation landing rather than a
 *  failure. Nothing is clicked: the login dialog's ant-modal-mask sits over the header and
 *  Playwright's click actionability check times out against it. */
const typeSearch = async (page: Page, query: string, deadline: number): Promise<any> => {
  let box: any = { found: false };
  for (let until = Date.now() + Math.min(SEARCH_INPUT_WAIT_MS, Math.max(0, deadline - Date.now())); Date.now() < until;) {
    box = await scrape(page, SEARCH_INPUT_JS, SEARCH_MARK, 'search input lookup');
    if (box?.found) break;
    await settle(page, 400);
  }
  if (!box?.found) return { retryable: 'no-search-input-on-homepage', inputs_on_page: box?.inputs ?? 0, page_chars: box?.chars ?? 0, home_path: box?.path || '' };
  // Type, then read back what the input actually holds. goofish's SPA re-renders the search input under
  // the cursor, and a `keyboard.type` burst that spans a re-render is silently truncated: measured,
  // "thinkpad x220" landing as "th". That submits an empty-ish keyword, brings back the rail, and used
  // to be reported as a refusal. The input is refocused and the missing tail re-sent until it holds the
  // whole query, so a lost keystroke costs a retry rather than a wrong answer. A cleared field is typed
  // from the start: the SPA discarded the prefix, not just the tail.
  for (let tries = 0; tries < 4; tries++) {
    const held = String(box?.value ?? '');
    if (held === query) break;
    if (held && query.startsWith(held)) { await page.keyboard.type(query.slice(held.length), { delay: 60 }); }
    else {
      // The input holds something that is not a prefix of this query, which is the *normal* state on a warm
      // page: it still holds the previous search. Typing over it appends, and "thinkpad x220" + "ipad
      // air" submits as one nonsense keyword that legitimately finds nothing. Select-all and type
      // replaces the selection with real key events, which the SPA's own controlled input sees;
      // assigning `.value` would not, because React never hears it.
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
 *  Two things make it fast. Both are new.
 *
 *  1. The answer is the page's own `mtop.taobao.idlemtopsearch.pc.search` reply, read off the wire:
 *     30 structured results in the same card shape the homepage feed returns, so the same normaliser
 *     reads it. The DOM scrape saw a title, a price and a city; a want count, a seller and an image
 *     per listing are simply not in the DOM card, and all three are here.
 *  2. A warm page is reused. Retyping into the header input of the page already showing results is an
 *     SPA route change: measured 4-12s against 15-41s for a cold load, and a cold load is what every
 *     attempt used to pay. The homepage is reloaded only when there is no page, when the input is not
 *     there, or when a page load has failed.
 *
 *  The relevance guard runs over real titles: a *fraction* of the results has to really match, so a
 *  rail can never be published as results.
 *
 *  Nothing here clicks anything, and that is measured rather than a style choice. goofish's anonymous
 *  login dialog puts an ant-modal-mask over the header; the listings render *underneath* it, so a read
 *  works through the mask and needs no dismissal. Measured headed, same URL, one fresh context per
 *  arm: with nothing dismissed the cards were in the DOM by t+12s under the mask, while dismissing at
 *  t+6s or t+12s clicked four close controls and the result list then never rendered at any later
 *  sample, serving the 猜你喜欢 rail instead. The searchbox flow also has to `focus()` rather than
 *  click, because Playwright's click actionability check times out against that mask (measured:
 *  element resolved, never receiving the event) while `focus()` needs no pointer. */
const searchItems = async ({ query, limit = DEFAULT_SEARCH_ITEMS, attempts = SEARCH_ATTEMPTS, pages = 1, detail = 0 }: SearchArgs): Promise<Data> => {
  const q = requireQuery(query), maxAttempts = clamp(attempts, 1, MAX_SEARCH_ATTEMPTS), cap = clamp(limit, 1, searchCap()), pagesWanted = clamp(pages, 1, Math.max(1, Math.min(MAX_SEARCH_PAGES, Math.ceil(searchCap() / 30))));
  const session = getSession(), log: any[] = [];
  let payload: any = {};
  // The budget has to fit what was asked for. Depth is a page load per listing at ~8s, so
  // `detail: 50` needs minutes, and the flat 90s default would have refused most of
  // them: the 8-deep case measured 0/8 answered before this.
  const started = Date.now(), deadline = started + budget('SEARCH', detail > 0 ? Math.min(600, 60 + detail * 10) : 90) * 1000;
  // The deepest page this call could reach, needed before the walk starts: it is the last page the
  // cache fast path has to find before it can answer with no page in the process at all.
  const deepLimit = Math.min(MAX_SEARCH_PAGES, pagesWanted + SEARCH_TOPUP_PAGES);
  // The whole call can end here. Every page this search asked for is already in the cache, so there is
  // nothing to ask goofish: no page load, no keystroke, no mtop call, and no chance of being declined
  // by a site that declines some loads. The pooled pages face the same relevance guard a live walk
  // faces (`finishSearch`), and normalising them needs no page -- FEED_NORMALIZE_JS is a pure
  // function over cards we already hold, which is why it is the one in-page script allowed to run
  // without the URL re-check.
  const cachedLines: { page: number; hit: boolean; age_s: number | null }[] = [], pooled: any[] = [];
  for (let pn = 1; pn <= pagesWanted; pn++) {
    const warm = getSearchPage(q, pn);
    if (!warm) { pooled.length = 0; break; }
    pooled.push(warm.value);
    cachedLines.push({ page: pn, hit: true, age_s: warm.verdict.age_s });
  }
  if (pooled.length === pagesWanted) {
    const found = await finishSearch(pooled, q, cap, (rows) => FEED_NORMALIZE_JS({ rows }));
    // A cached pool that no longer passes the guard is not an answer, and neither is a short one: a
    // caller who asked for three pages does not get two and a note. Both cases fall through to the
    // live search rather than publish a set this code would have refused a moment ago.
    if (found) {
      log.push({ via: 'cache', pages: pooled.length, results: found.scanned, note: `every page this search asked for was already cached, so goofish was not asked at all; ages are in the cache block below` });
      return publishSearch(session, q, found, detail, deadline, { query: q, source: 'search_api', via: 'cache', account_required: false, attempts: 0, attempt_log: log, cache: pageReport(cachedLines), ...found });
    }
  }
  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    // A failed page load is a declined attempt, not a fatal error. This network throws
    // ERR_INSUFFICIENT_RESOURCES / ERR_ADDRESS_UNREACHABLE often enough that aborting the whole call
    // would make search useless. The clock is checked at the foot of the loop either way, so ten failed
    // loads cannot outrun the budget.
    payload = {};
    const via = attemptNo <= SEARCH_TYPED_ATTEMPTS ? 'searchbox' : 'direct_url';
    // The warm path. `session.open` is skipped when the page already holds a usable input, so the
    // second and later searches of a session are SPA route changes rather than fresh loads. A page
    // that is off goofish, has no input, or is mid-flight with no results is what forces a load.
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
        // throws away a good answer to go looking for a DOM fallback.
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
        // page's own pager is the only way deeper, and it is much cheaper than a fresh load.
        const replies = [reply.data], pageLines: { page: number; hit: boolean; age_s: number | null }[] = [{ page: 1, hit: false, age_s: null }];
        // The page was just asked, so page 1 is live whatever was cached under it -- and it refreshes
        // the entry. A fresh answer is never discarded in favour of one this process already had.
        putSearchPage(q, 1, reply.data);
        // Walking the pager is not deterministic: page 3 sometimes returns items already seen on
        // pages 1-2, and a degraded page can match far fewer than its 30. Measured across three
        // sessions, `pages: 2` yielded 25, 28 and 55 matches out of 60 scanned. To a caller who asked
        // for `limit` listings that is a silent shortfall, so the walk tops up, bounded so a
        // genuinely thin market cannot turn a cheap call into an expensive one.
        const seen = () => new Set(replies.flatMap((d) => searchListings(d).map((c) => c?.detailParams?.itemId).filter(Boolean))).size;
        for (let want = 2; want <= deepLimit; want++) {
          if (want > pagesWanted && seen() >= cap) break;
          if (Date.now() >= deadline) { log.push({ stopped: `time budget reached at page ${want}` }); break; }
          // A page this process already walked costs nothing to re-read, against the 5-9.5s the pager click it
          // would otherwise take. It is pooled with the live pages and judged by the same guard, and
          // its age is published per page in the `cache` block: pages in one walk are read at
          // different moments all the time, and a single age for the whole set would be a claim about
          // a set that does not exist.
          const warm = getSearchPage(q, want);
          if (warm) { replies.push(warm.value); pageLines.push({ page: want, hit: true, age_s: warm.verdict.age_s }); log.push({ pager: want, cache: 'hit', age_s: warm.verdict.age_s, items: searchListings(warm.value).length }); continue; }
          // The reply arrives a moment before the pager finishes rebuilding itself, and a click in
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
          pageLines.push({ page: want, hit: false, age_s: null });
          putSearchPage(q, want, next.data);
          log.push({ pager: want, ok: true, items: n });
        }
        const found = await finishSearch(replies, q, cap, (rows) => evaluate(page, FEED_NORMALIZE_JS, { rows }, 'search normalization'));
        if (found) {
          log.push({ attempt: attemptNo, via, source: 'search_api', pages: replies.length, results: found.scanned });
          const out = { query: q, source: 'search_api', via, account_required: false, attempts: attemptNo, attempt_log: log, cache: pageReport(pageLines), ...found };
          return publishSearch(session, q, found, detail, deadline, out);
        }
      }
      if (reply && !reply.ok) log.push({ attempt: attemptNo, via, search_api_ret: reply.ret });
      for (let until = Date.now() + SEARCH_RESULT_WAIT_MS; Date.now() < until && Date.now() < deadline;) {
        await settle(page, 1000);
        // Over-ask, then filter. The scraper stops collecting at `limit` but counts to the end of the page,
        // and the filter below runs over what it *collected*, so truncating at `limit` first let a few
        // leading non-matching cards empty the result set and report a successful, self-contradicting
        // answer next to `query_hits: 195`.
        payload = (await scrape(page, SCRAPE_CARDS_JS, { query: q, terms: queryTerms(q), limit: Math.max(cap, 200), rails: RAIL_MARKERS }, 'search-page scrape')) ?? {};
        if (payload?.rendered) break;
      }
      // The fraction is over every card on the page, not the `limit` we kept, and it counts on the
      // looser of the two relevance rules -- all the query's terms, in any order -- for the reason
      // the API route does: goofish titles are not in the searcher's word order.
      const cards = Number(payload.cards_scanned) || 0, hits = Number(payload.query_hits) || 0, tokenHits = Number(payload.token_hits) || 0;
      const minHits = Math.max(1, Math.ceil(cards * MIN_MATCH_FRACTION)), accepted = Math.max(hits, tokenHits);
      const declined = !payload.rendered || Boolean(payload.rail) || Boolean(payload.says_no_results) || Boolean(payload.blocked) || accepted < minHits;
      log.push({ attempt: attemptNo, via, rendered: Boolean(payload.rendered), scraped_cards: cards, query_hits: hits, token_hits: tokenHits, accepted_hits: accepted, min_query_hits: minHits, rail: payload.rail || '', says_no_results: Boolean(payload.says_no_results), blocked: Boolean(payload.blocked) });
      if (!declined) {
        // Only the matches, so `count` and every item agree with each other and with the query.
        const items = rankItems(withTyped(dedupe(payload.items.filter((i: any) => i.matches_query))), cap);
        for (const it of items) rememberCard(it);
        return { query: q, source: 'search_page_dom', via, account_required: false, attempts: attemptNo, attempt_log: log, cache: notCached('this page of results', searchTtl()), query_hits: hits, token_hits: tokenHits, matched_by: hits === tokenHits ? 'phrase' : 'all_terms', min_query_hits: minHits, scraped_cards: cards, non_matching_count: Math.max(0, cards - tokenHits), count: items.length, items };
      }
    }
    if (Date.now() >= deadline) { log.push({ attempt: attemptNo, stopped: 'time budget reached' }); break; }
  }
  // Count distinct attempts, not log entries. A searchbox attempt logs twice -- the typing step and
  // then the scrape -- so counting entries reported "6 attempt(s)" for a call that made 3, and counted
  // the typed attempts the same way. Somebody reading a refusal to decide whether to raise
  // `attempts` or the budget needs the real number.
  const attemptsMade = new Set(log.filter((e) => e.attempt).map((e) => e.attempt)).size;
  const typed = new Set(log.filter((e) => e.via === 'searchbox' && e.attempt).map((e) => e.attempt)).size;
  const last = log.filter((e) => e.scraped_cards !== undefined || e.error || e.retryable || e.search_api_ret).pop() || {};
  throw new SearchUnavailableError(`goofish never served a usable result set for ${JSON.stringify(q)} in ${Math.round((Date.now() - started) / 1000)}s, over ${attemptsMade} attempt(s) of which ${typed} typed the query into the search box. `
    + 'Search here is a keystroke, not a URL: navigating to /search?q= is measured to serve the 猜你喜欢 rail instead of results (20 cards, zero query hits), so the query is typed into the header input and submitted. Typed attempts fail in four ways, all retried, and the counts say which: `no-search-input-on-homepage` means the page came back as a footer-only shell with no input at all, `incomplete-keystrokes` means the SPA re-rendered the input mid-typing and swallowed part of the query (`typed` is what actually landed, `wanted` the full query; the input is refocused and the tail re-sent before this is reported), `enter-did-not-submit` means the keys landed (`typed`) but the router never moved off `/`, and a `blocked: true` attempt is goofish serving its "非法访问 / 请使用正常浏览器" page instead of the app, which is server-side and lifts after a pause. A `search_api_ret` is goofish\'s own refusal of the search call itself, most often RGV587 ("被挤爆啦") when the anonymous IP is being throttled. A `token_hits` above `query_hits` means the page held matches that contain every word of the query but not the query as one substring.\n  stopped on: '
    + `${log.find((e) => e.stopped)?.stopped || 'the attempt count'}\n  last attempt: ${JSON.stringify(last)}\n  page text: ${JSON.stringify(String(payload.text_preview || '').slice(0, 140))}\n  the wall-clock budget XIANYU_SEARCH_BUDGET_S (90s default) is what bounds the retries, and one attempt is a page load only when the page is cold -- a warm page re-searches in seconds. browse_feed, search_count and search_suggest are unaffected, do not drive a browser page, and always work.`);
};

/** Publish a pooled search answer, deepening it when the caller asked for `detail`.
 *
 *  One function for both routes into a pooled answer -- off the wire, and out of the cache -- because
 *  the two must not be able to differ in what they honour. The cache fast path was written first and
 *  returned the pool as it stood, so a `detail: 1` call answered from the cache with plain cards and
 *  no `detail_report` at all: a silent downgrade wearing the same envelope. The depth still costs what
 *  it costs -- a listing this process has not read in full is read now, and `detail_report` says which
 *  ones came from the cache. */
const publishSearch = async (session: any, q: string, found: any, detail: number, deadline: number, out: any): Promise<Data> => {
  if (detail < 1) return out;
  const deep = await enrichDetails(session, found.items, detail, deadline, out.items);
  return { ...out, items: deep.items, detail_requested: deep.report.requested, detailed: deep.report.ok, detail_ms: deep.report.ms_total,
    // Per-listing outcomes: which of the fifty arrived in full and which are still cards. A caller
    // should not have to infer that from a missing field.
    detail_report: deep.report.per_listing };
};

/** Is the dom page already sitting somewhere with a usable search input, so a search can be typed
 *  into it instead of paying for a fresh page load? A page that is still loading, that is showing the
 *  risk-control notice, or that has been moved off goofish all answer no -- and a `no` is safe, because
 *  the caller then does a real `open`, which re-checks the allowlist properly. The read goes through
 *  `scrape` so the URL is re-checked in the same statement, like every other DOM read. */
const warmInputUsable = async (session: any): Promise<boolean> => {
  try {
    const page = await session.domReady();
    if (page.isClosed()) return false;
    return Boolean((await scrape(page, SEARCH_INPUT_JS, SEARCH_MARK, 'warm input check', 5))?.found);
  } catch { return false; }
};

/** Turn a captured search reply into ranked, deduped, filtered listings -- or null if it is not a
 *  believable result set for this query. Same relevance guard as the DOM path: a *fraction* of the
 *  results has to really carry the query, so a rail can never be published as results. A result
 *  carries it by containing the phrase, or by containing every term of it in any order -- see
 *  `queryTerms`, which is the difference between this working on this site and returning nothing.
 *
 *  The normaliser is passed in rather than reached for through a page, because the same pooled
 *  payloads are judged twice: once when they arrive off the wire, and once when every page of them
 *  came from the cache and there is no page in the process at all. Passing the function rather than
 *  duplicating the call keeps one guard and one normaliser, and that is what keeps a cached answer
 *  from being a laxer one. */
const finishSearch = async (payloads: any[], q: string, cap: number, normalize: (rows: any[]) => any[] | Promise<any[]>): Promise<any | null> => {
  // Every page walked contributes its 30 listings, and they are pooled before the guard runs: the
  // fraction has to be over the whole result set, or page 2 could be judged on 30 cards while the
  // answer claims a hundred.
  const cards: any[] = [];
  for (const d of payloads) cards.push(...searchListings(d));
  if (!cards.length) return null;
  const normalized = await normalize(cards);
  const low = q.toLowerCase(), terms = queryTerms(q);
  const all = withTyped(dedupe((normalized || []).filter((i: any) => i.item_id)));
  if (!all.length) return null;
  const titleOf = (i: any) => String(i.title || '').toLowerCase();
  const phrases = all.filter((i: any) => low && titleOf(i).includes(low));
  const matches = all.filter((i: any) => hasAllTerms(i.title, terms));
  const scanned = all.length;
  const minHits = Math.max(1, Math.ceil(scanned * MIN_MATCH_FRACTION));
  // Fewer than a fifth of the results really matching is what a declined search looks like from
  // the API side too, so the same refusal applies; a short page of real matches still passes on the
  // floor of one.
  if (matches.length < minHits) return null;
  const items = rankItems(matches, cap);
  for (const it of items) rememberCard(it);
  return { query_hits: phrases.length, token_hits: matches.length, min_query_hits: minHits, scraped_cards: scanned, pages_fetched: payloads.length,
    // Which rule actually admitted the set, so a caller can see that a result came from the looser
    // term match rather than the exact phrase. `phrase` means the two agreed.
    matched_by: matches.length === phrases.length ? 'phrase' : 'all_terms',
    non_matching_count: Math.max(0, scanned - matches.length), count: items.length, items };
};

/** Wait until the results pager reports `want` as its active page. Bounded. A false `settled` is not
 *  an error: it means the next click is being made on a pager that has not caught up, and the click
 *  reports that itself. */
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
 *  This is the expensive half. One full page load per listing, measured warm at a median of 13.4s
 *  (n=8, 8/8 answered): the document itself is 4.5s to `domcontentloaded` and goofish's own detail
 *  call lands 9-17s after that. 20 listings is about 4.5 minutes, and the 50 a side-by-side
 *  comparison wants is about 11.
 *
 *  Two ways to do better were measured, and neither is what this loop wanted. An SPA route change is
 *  not available at all (0/8 answered in 32s -- goofish's item page is an ICE micro-frontend with no
 *  reachable router and no item links to click, probe8), so the load cannot be skipped. Four pages
 *  loading four listings at once does cut the batch's wall clock, 27.1s for 4 against 66.3s serially,
 *  at the price of each listing's own latency roughly doubling (11.4s -> 20.5s) and a 32s serial
 *  stall that the parallel run did not pay. That is 2.4x on the wall clock rather than 4x, and it
 *  is not free: four DOM pages instead of one, which is exactly the invariant the shared navigating
 *  page exists to keep. Measured, not assumed -- and not built, because the fan-out is this loop
 *  and a second page does not belong in it.
 *
 *  A listing that will not answer is reported as such and left as a card, never dropped. A partial
 *  answer is what a caller can reason about; a silently shorter list is not. */
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
      // Per-listing cache state, so a `detail: 50` run that answered half of them from the cache says
      // which half and how old it is, instead of looking like 50 equally fresh page loads.
      if (read.listing) { Object.assign(card, read.listing, { detail_source: read.listing.source, detailed: true, cached: read.cache.hit, cache_age_s: read.cache.age_s }); report.push({ item_id: t.item_id, ok: true, ms: Date.now() - t0, source: read.listing.source, cached: read.cache.hit, cache_age_s: read.cache.age_s }); }
      else { card.detailed = false; report.push({ item_id: t.item_id, ok: false, why: read.payload?.api_ret || read.payload?.site_error ? `goofish said: ${read.payload.api_ret || 'its own error page'}` : 'the page would not answer' }); }
    } catch (e: any) { report.push({ item_id: t.item_id, ok: false, why: `${e?.error_type ?? 'Error'}: ${String(e?.message ?? e).slice(0, 80)}` }); }
  }
  return { items: all, report: { requested: targets.length, ok: report.filter((r) => r.ok).length,
    // What the depth cost, so a caller can decide whether to ask for more without timing it themselves.
    ms_total: report.reduce((a, b) => a + (b.ms ?? 0), 0), per_listing: report } };
};

/** Ids search has already returned this process, newest last. `search_items` fills it and item_view
 *  checks it first: searching for a term and then viewing a result is the ordinary sequence, and
 *  there the listing is already in hand, so a search card answers without a page load. A card is only
 *  ever a *fallback* -- the detail API has everything and the card has five fields -- so this is the
 *  exception, not the rule. Bounded, so a long-lived server does not accumulate every listing it has
 *  ever seen. */
const seenIds = new Map<string, any>();
const rememberCard = (it: any): void => { if (it?.item_id) { seenIds.delete(String(it.item_id)); seenIds.set(String(it.item_id), it); if (seenIds.size > 500) seenIds.delete(seenIds.keys().next().value as string); } };
/** Forget every remembered card. Module state outlives a single call, and a test that has seeded it
 *  with one listing would otherwise have its next `item_view` answered from the cache. */
export const resetCardCache = (): void => { seenIds.clear(); };

/** One listing by id. The page is loaded and its own detail reply is what answers -- measured 4-10s,
 *  and about fifteen fields a search card does not have. A card this process already returned from a
 *  search is the *fallback*, for a listing the item page will not serve. It used to be the first
 *  choice, because "search, then open a result" is the ordinary sequence, but the detail call is
 *  cheap and there is no reason to short-circuit on it and throw those fields away. The fallback it
 *  replaced ran up to eight whole keyword searches, each a fresh 10-25s page load. */
const itemView = async ({ item_id }: ItemArgs): Promise<Data> => {
  const item = normalizeItemId(item_id);
  if (!item) throw new XianyuError(`item_id must be digits or a goofish item URL, got ${JSON.stringify(item_id)}`);
  // The clock starts before the load, not after it: a budget that ignores the slowest step in the
  // call is not a budget. The detail reply lands with the render that uses it, so the wait is one
  // window rather than a load plus a poll -- measured, 4-6s warm and about 10s cold.
  const started = Date.now(), deadline = started + budget('ITEM_VIEW', 90) * 1000;
  // The item page is loaded on the DOM page and its own `mtop.taobao.idle.pc.detail` reply is what the
  // answer is built from. That call is not ours to make: re-issued through the same client with the
  // same payload it times out, because goofish stamps the requests the page originates with a per-call
  // anti-bot blob. So the page makes the call and we read the reply off the wire.
  //
  // This replaces a premise the tool was built on. Three separate comments and the tool description
  // used to say that "goofish does not serve item pages to logged-out visitors" and that the answer
  // had to come from a search sweep. Measured against the live site, that is wrong: the detail block
  // renders, and the detail API answers SUCCESS anonymously with the title, the full gallery, the
  // description and the seller's statistics. So the old code spent its budget reloading a page that
  // was never going to answer, and the sweep behind it -- up to eight keyword searches, each a fresh
  // page load -- was dead weight on a path that almost never ran.
  const session = getSession(), read = await readListing(session, item, deadline);
  if (read.listing) {
    const l = read.listing;
    // `item_id` is added here rather than in `readListing` because the two routes return different
    // shapes -- the API route has it in the payload, the DOM route as `page_item_id` -- and the
    // envelope has to be the same whichever one answered.
    return { ...l, item_id: item, page_item_id: item, url: `${HOME}item?id=${item}`, account_required: false,
      attempts: read.tries, wants: asCount(l.want_count), browses: asCount(l.browse_count),
      reco_anchors: 0, image_candidates: (l.image_urls || []).length,
      // The cache decision travels with the answer, always. `attempts: 0` beside `cache.hit: true`
      // means no page was loaded and goofish was never asked: a ~0s repeat view, publishable as one
      // only because it cannot be mistaken for a live read.
      cache: read.cache,
      fields_present: ITEM_FIELDS.filter((f) => present(l[f])), fields_missing: ITEM_FIELDS.filter((f) => !present(l[f])) };
  }
  // Nothing to report. Name the cause rather than the symptom.
  const payload = read.payload;
  const why = payload?.api_ret ? `goofish's own detail API refused it: ${payload.api_ret}`
    : payload?.declined ? `goofish served its ${payload.declined === 'site_error' ? 'own "网络不见了" error page' : '"非法访问" risk-control page'} instead of the app`
    : payload?.api_item_id ? `the page answered about item ${payload.api_item_id} instead of ${item}`
    : payload?.site_error ? 'goofish served its own "网络不见了" error page on every attempt'
    : payload?.rail_only ? 'every load mounted the app and held only recommendation cards, with no listing in it'
    : 'the page stayed an empty shell';
  throw new DetailUnavailableError(
    `item ${item} could not be read for this anonymous visitor after ${read.tries} page load(s) in ${Math.round((Date.now() - started) / 1000)}s: ${why}. Most often this id is sold, removed, or too old to still be live -- goofish answers a dead id with no listing rather than an error. `
    + `Page text: ${JSON.stringify(String(payload?.head_preview || '').slice(0, 160))}`);
};

/** The core of `item_view`, shared with `search_items`' `detail` argument: load the item page, read
 *  the call it makes for itself, and return the listing. Never throws -- a caller reading 20 listings
 *  wants "this one would not answer", not an exception that abandons the other nineteen.
 *
 *  It owns the navigation as well as the read, because the reply it wants only exists once the page
 *  has loaded. The first version of the `detail` argument reused this function without the load and
 *  quietly produced zero details for every listing: a page sitting on a search results page never
 *  issues a detail call. The envelope does not show that unless you ask, which is why `search_items`
 *  publishes `detail_report`.
 *
 *  It is also the one seam the listing cache sits on, which is why it is here rather than in
 *  `item_view`: `item_view`, the `detail` argument and `resolveSeller`'s hop all come through this
 *  function, so one check covers all three and none of them can grow a private one. The check runs
 *  *before* the navigation, because that is the whole saving -- an item page load is 4-10s measured
 *  -- and every return carries the `cache` verdict, which is what keeps a repeat view from reading as
 *  a live one. A hit returns `page: null` because it opened nothing. No caller of this function reads
 *  `page` (they read `listing`, `tries` and `payload`), so that is safe. */
const readListing = async (session: any, item: string, deadline: number): Promise<{ listing: any | null; payload: any; tries: number; page: Page | null; cache: CacheVerdict }> => {
  const warm = getItem(item);
  if (warm) return { listing: warm.value, payload: {}, tries: 0, page: null, cache: warm.verdict };
  // Published on every miss as well as every hit, so the envelope's shape does not depend on where
  // the answer came from -- the same rule the typed/missing block follows per listing route.
  const live = (): CacheVerdict => missed(itemKey(item), itemTtl(), 'this listing');
  const page = await session.open(`${HOME}item?id=${item}`);
  let payload: any = {}, tries = 0;
  for (tries = 1; tries <= RENDER_ATTEMPTS; tries++) {
    // The API reply and the DOM are read in the same loop rather than one after the other: the detail
    // block paints from that same reply, so waiting for one tells you about the other, and two serial
    // waits would double the call for nothing.
    const reply = await session.domTap.take(DETAIL_API, Math.min(ITEM_READY_WAIT_MS, Math.max(0, deadline - Date.now())));
    if (reply) {
      if (reply.ok) {
        // The richest route by a long way, and the only one that fills most of the typed block: the
        // detail payload carries the seller's province and city, the transport fee, the create and
        // modify epochs and the 成色 attribute. A card has none of those.
        const listing = detailListing(reply.data, item);
        if (listing) {
          const full = { ...enrichListing(listing), source: 'item_detail_api' };
          putItem(item, full);
          return { listing: full, payload, tries, page, cache: live() };
        }
        // It answered with a different listing, or with none. That is a page that is not the one
        // that was asked for, and the id check below would refuse it -- but saying so now is
        // cheaper than waiting out a poll that cannot change.
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
    // A third kind of "answered", and the only one this loop cannot see for itself: goofish declined
    // the load outright and served its risk-control page or its own error notice instead of the app.
    // That is in the page text from the first paint and in no mtop call at all, so browser.ts reads it
    // at the load (`Session.lastLoad`) and this is where it is acted on -- one load instead of five, and
    // a named cause instead of "the page stayed an empty shell" after a minute and a half.
    if (session.lastLoad?.declined) { payload = { ...payload, declined: session.lastLoad.declined }; break; }
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
    // than left looking read. This route is deliberately NOT stored in the TTL cache: a five-field
    // card held for its TTL would turn one degraded read into a window of them, and a cache is only
    // worth having when what it holds is something goofish read in full.
    const cached = seenIds.get(item);
    if (cached) {
      // Unless this same process already read it in full. `search_items`'s `detail` argument merges
      // the detail fields into the very card object the cache holds, so a listing deepened earlier in
      // this session comes back with a description and a seller's statistics, and blanking those here
      // would throw away data we are holding. The blanking is for the plain-card case only, and is
      // exactly the set of fields a card cannot have.
      const blank = cached.detailed ? {} : { description: '', want_count: '', browse_count: '', seller: '', seller_tenure_years: '', seller_items_sold: '', seller_positive_rate: '' };
      const fields = { ...cached, ...blank, item_id: item, page_item_id: item };
      return { listing: { ...enrichListing(fields), source: 'search_card_cache', attempts: tries, page_attempts: tries,
        note: `the item page did not answer for this listing (${payload?.api_ret || payload?.site_error ? 'refused' : 'rendered no detail block'}), so this is the listing as an earlier ${cached.detailed ? 'detail read' : 'search'} in this session published it${cached.detailed ? '' : '. The description, the want and browse counts and the seller\'s statistics live on the item page and are reported missing rather than guessed'}.`,
        ...Object.fromEntries(ITEM_FIELDS.map((f) => [f, fields[f] ?? (f === 'image_urls' ? [] : '')])) }, payload, tries, page, cache: live() };
    }
    return { listing: null, payload, tries, page, cache: live() };
  }
  // Unconditional: a page that renders the detail block but has no `?id=` in its URL is a redirect or
  // a challenge page, not the listing. Skipping the check when `served` is empty is what let an
  // off-site page's fields be reported as this item's.
  const served = String(payload.page_item_id ?? '');
  if (served !== item) throw new ParseError(`asked goofish for item ${item} but the page it served reports item ${served || '(no ?id= in its URL)'}; refusing to report one listing's fields as another's.`);
  // The rendered page yields ten fields and no epoch, no province and no fee, so most of the typed block
  // is null here and `missing` says so by name. That is the answer this route can give, and the keys
  // are the same either way, so a caller can tell which route answered.
  const rendered = Object.fromEntries(ITEM_FIELDS.map((f) => [f, payload[f] ?? (f === 'image_urls' ? [] : '')]));
  const listing = { ...enrichListing(rendered), source: 'item_page_dom' };
  putItem(item, listing);
  return { listing, payload, tries, page, cache: live() };
};

/** What this server can and cannot do right now, verified against the live site. A diagnostic must
 *  never be the thing that crashes, so every probe is guarded and reported as status rather than
 *  raised -- including a browser that has gone away. */
const capabilities = async (): Promise<Data> => {
  const session = getSession();
  const status: any = {
    requires_xianyu_account: false, session_state: 'unknown', login_probe_ret: '', feed_reachable: false,
    // The deployment's own address, up top: which commit is answering, whether it is
    // behind main. `stale: null` means it could not be measured, which is not the same as
    // `false` -- a build nobody can place is unverified, and reporting it as current is exactly
    // what let a nine-commit-old dist keep serving a town full of agents. `npm run check:deploy`
    // runs the same rules from the command line, and it fetches first, because a cached remote-tracking
    // ref is itself a thing that goes stale. See src/build-info.ts.
    build: {
      note: 'the commit below is what is answering your calls right now; `npm run check:deploy` is the same comparison run deliberately, and it fetches before counting',
      ...buildBlock(),
    },
    // The cache is reported here rather than only inside a `cache` block on an answer, so an agent can
    // find out it exists before it has relied on one -- and so "this listing may be up to 45s old" is
    // something a caller chose rather than something that happened to it.
    cache: cacheStats(),
    works_without_account: [
      'browse_feed: paged homepage feed, 20 listings/page, live inventory',
      'search_count / search_suggest: match counter and autocomplete, both undeclined',
      'related_items: more-like-this for an item, or goofish\'s generic set',
      'search_items: keyword search with real depth -- pages walks the result pager for 30 listings a page (up to 10 pages, measured 4 to 81-82 matches in 19-36s, and it tops up by two pages if the pool comes up short of limit), and detail reads the top N in full (one page load each at 7.5-10s; measured 50 full listings, 39 fields, ~246 photos, 0 failures, in 410-550s). Retried because goofish declines some page loads.',
      'item_view: title, price, want/browse counts, description, seller with city/tenure/sales/rating, brand, condition and every photo, from the detail call the item page makes for itself',
      'seller_profile: one seller\'s standing -- credit tier, shop level and score, praise ratio, review count, followers, listing count, real-name/real-person/芝麻 status -- from the endpoint the /personal page uses, which answers anonymously and is unreachable by interception. Handed a listing instead of a seller id, it also returns their city, tenure, sales and positive rate.',
      'seller_items: the listings one seller currently has up, 20 a page, with nextPage telling you whether to walk. Handed a listing instead of a seller id, it means that listing\'s seller, for the price of one item page load.',
    ],
    anonymous_flakiness: [
      'search_items works logged out, but goofish declines on some page loads: the search call is not even made and the page renders the 猜你喜欢 rail instead. It retries, and only accepts a reply or a page when a fraction of the listing titles really contain the query.',
      'The three DOM tools (search_items, item_view, recommendations) can also be served goofish\'s risk-control page instead of the app, which renders zero cards and no rail. That is named as risk_control_page in the output, and it clears after a pause; the mtop-only tools keep working throughout because they need only the mtop client.',
      'Anonymous page rendering is throttled per IP and degrades to an empty shell with no error; the DOM-scraping tools retry and then report what they got.',
    ],
    notes: [
      'goofish puts a dismissible login dialog over anonymous pages. It does not gate anything and it does not need closing: the listing cards are already in the DOM underneath its ant-modal-mask, and clicking its close controls was measured to stop the result list from rendering. This server never clicks it.',
      'The feed is not keyword-filterable and ignores cCatId, so it samples inventory rather than answering queries. Verified while building the seller tools: two identical `{pageNumber: 1}` calls return completely disjoint inventory, and adding cCatId does not narrow it -- so there is no category filter to expose, and one is not faked.',
      'There is no location filter either. The match counter takes a `userPositionJson`, and five spellings of it (city only, city+lat/lon, ipLocation, a far-away city) all returned the identical hitnum. The keyword search endpoint does take a position, but it cannot be issued by this server at all -- see the next note.',
      'Item detail is read from the call the page makes for itself rather than one this server issues: the same API with the same payload, re-issued through the page\'s own mtop client, answers TIMEOUT::接口超时, because goofish attaches a per-call anti-bot blob to the requests its own bundle originates. Letting the page ask and reading the reply is both the only route that works and the richer one.',
      'The mtop-only tools run on a separate page from the three that drive a browsing page, so a slow search does not hold up a fast feed call. seller_profile and seller_items are on that page too, and take the shared lock only for the item-page hop when given an item_id instead of a user_id.',
      'An mtop endpoint the current page never happens to use CAN be issued through that page\'s own client and answers normally -- goofish stamps only the calls its own bundle originates. That is the whole route to a seller profile, and it is why these two endpoints exist here at all: response interception can only report a call the page already decided to make.',
      'Chromium on a network with broken IPv6 can fail to connect at all (ERR_ADDRESS_UNREACHABLE) where curl succeeds, which looks like an empty page -- see the cause list below.',
    ],
    // These measurements used to live inside the tool descriptions, where every agent paid for them on
    // every session whether it searched or not. They are here instead: fetched once, on demand, by the
    // agent that is about to pay the latency and does need to know what it costs.
    measured_latency: {
      'cold browser launch': '~5s, once per session; the session is then reused',
      'item page load': 'a full page load per listing, warm: median 13.4s (n=8, 8/8 answered) -- 4.5s to domcontentloaded, then goofish\'s own detail call lands 9-17s after that. item_view cannot skip the load: an SPA route change answered 0/8 in 32s, because the item page is a micro-frontend with no reachable router and no item links (measured, xi-x8x). 20 listings is about 4.5 minutes, 50 is about 11',
      'four listings at once': '27.1s of wall clock for 4 against 66.3s serially -- 2.4x, not 4x, and each listing\'s own latency roughly doubles (11.4s -> 20.5s). Measured but not built: it needs four DOM pages, which is the invariant the shared navigating page exists to keep, and the fan-out loop is search_items\' own',
      'cold start': 'the session\'s first load is paid in the background at boot rather than on your first call; see cold_start_warm for whether it got there',
      'search, warm page': '4-12s (an SPA route change -- search does route, unlike the item page); the first search of a session used to pay 15-41s for a cold load, which the boot warm-up now pays instead',
      'search pager walk': '30 listings a page at 5-9.5s each, against 13-25s for a fresh page load',
      'how many of a page match': 'varies a lot -- across three sessions `pages: 2` gave 25, 28 and 55 matches of 60 scanned, and `pages: 4` gave 81 of 90. Read `count`; do not assume 30 a page',
      'deep comparison, measured': '`pages: 2, limit: 50, detail: 50` returned 50 full listings, 39 fields and 247 photos, no failures, in 410s',
      'the mtop-only tools': 'browse_feed / search_count / search_suggest / related_items / seller_profile / seller_items take no page load at all beyond the boot URL, and do not queue behind a search',
    },
    // The known causes, in the order they were actually observed; static, so it survives a dead browser.
    note: 'goofish did not serve a usable page. Known causes, in the order actually observed: (1) the network resolves goofish to IPv6 but has no working IPv6 route, so Chromium gets ERR_ADDRESS_UNREACHABLE where curl over v4 returns 200; (2) resource exhaustion, ERR_INSUFFICIENT_RESOURCES, usually a small /tmp; (3) goofish answering with its risk-control page instead of the app -- a 200 whose whole body reads "非法访问 ... 请使用正常浏览器访问闲鱼" -- which is the state to check for first, because it is indistinguishable from "no results" unless it is named, and it is server-side so it lifts after a pause; (4) a footer-only shell as a successful 200. The mtop-only tools need only the mtop client, which comes up even on (3) and (4), so they survive every one of these.',
  };
  // Each probe is guarded on its own and reports under its own key: merged into one try, a throwing
  // loginuser probe skipped the feed probe and its verdict, and both looked like a dead browser. The
  // per-probe keys are what separate "not logged in" from "not reachable".
  const probe = async (key: string, run: () => Promise<void>): Promise<void> => { try { await run(); } catch (e: unknown) { const d = describe(e); status[`${key}_error`] = `${d.error_type}: ${d.message}`; } };
  await probe('browser', async () => { await session.ensureReady(); });
  // loginuser.get proves the session is logged out, never acts as one. Only a session- or token-shaped ret
  // is proof; anything else leaves session_state 'unknown' rather than reading as anonymity.
  await probe('login', async () => { const me = (await session.call([['me', LOGINUSER_API, {}]]))?.me || {}; status.login_probe_ret = String(me.ret || ''); status.session_state = me.ok ? 'unexpectedly_logged_in' : hasMarker(me.ret, NO_SESSION_MARKERS) ? 'logged_out' : 'unknown'; });
  await probe('feed', async () => { status.feed_reachable = Boolean((await session.call([['f', FEED_API, { pageNumber: 1 }]]))?.f?.ok); });
  // read after the probes, so a browser that had to be relaunched shows up
  status.browser_launches = session.launches;
  // Which build is running, and whether it is current. It is here rather than in a separate check
  // because the deployment that motivated it went stale silently: opencode.json pointed at a dist built
  // nine commits behind main, every tool answered plausibly, and nothing said so. A tool every agent
  // is told to call first is the one place that cannot be skipped.
  //
  // `buildBlock` cannot raise: src/build-info.ts wraps every git call and every filesystem read and
  // returns '' on failure, so a machine with no git, no dist/, or no checkout still gets an answer.
  // That is a property of that module, not of this call site -- `readFileSync` inside it is the only
  // way this could throw, and it is guarded there. The per-probe keys above exist for the same reason
  // and do not cover this one, so the guarantee rests on build-info.ts holding its line.
  //
  // What the boot warm-up managed, so a caller can tell a session that has already paid its first load
  // from one that is about to make them pay it. `pending` is normal for a session's first few seconds
  // and `failed` costs nothing: every tool that needs a page still loads one for itself, exactly as before.
  status.cold_start_warm = { ...session.warm };
  return status;
};

// -------------------------------------------------------- the published contract
// The zod shape IS the published argument contract, and each handler's argument type is inferred from
// that same shape, so a renamed or retyped argument is a type error rather than a silent drift between
// schema and implementation. `Partial` because the defaults live in the schema; the destructuring
// defaults in each handler are what a direct call (tests, one-off scripts) gets, and only browse_feed's
// are asserted behaviourally.
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
// Both seller tools take the same two alternatives, and neither is required in the schema: which one is
// missing is the question, and a schema that made one of them required would push the "give exactly one
// of these, and here is a message that says so" into every caller's error handling. `resolveSeller` asks.
// `item_id` is the looser of the two validators on purpose -- an empty string is how a caller spells
// "not this one", and turning that into a validation error would be a worse answer than the message
// `resolveSeller` already writes.
const SELLER_ARGS = { user_id: z.string().optional(), item_id: z.string().optional() };
const SELLER_ITEMS_ARGS = { ...SELLER_ARGS, limit: z.number().int().min(1).max(MAX_LIMIT).default(SELLER_PAGE_SIZE), page: z.number().int().min(1).max(MAX_SELLER_PAGE).default(1) };
type FeedArgs = Args<typeof FEED_ARGS>; type CountArgs = Args<typeof COUNT_ARGS>; type SuggestArgs = Args<typeof SUGGEST_ARGS>;
type SearchArgs = Args<typeof SEARCH_ARGS>; type RelatedArgs = Args<typeof RELATED_ARGS>; type ItemArgs = Args<typeof ITEM_ARGS>; type RecoArgs = Args<typeof RECO_ARGS>;
type SellerArgs = Args<typeof SELLER_ARGS>;

type ToolDef = { name: string; description: string; schema: z.ZodRawShape; run: (args: any) => Promise<Data> };
/** Wrap a tool so it takes the one lock that matters. The three DOM tools read and navigate the single
 *  shared `domPage`, so two of them at once would navigate it out from under each other and one would
 *  report the other's page as its own data. The mtop-only tools and `capabilities` are deliberately
 *  left out: they never touch `domPage`, so making them queue behind a 70s search bought latency and
 *  nothing else. The lock lives here, on the tools that need it, rather than in the entry point where
 *  it would apply to all eight. */
const locked = (run: (args: any) => Promise<Data>): ((args: any) => Promise<Data>) => (args: any) => exclusive(() => run(args));
const tool = <S extends z.ZodRawShape>(def: { name: string; description: string; schema: S; run: (args: Args<S>) => Promise<Data> }): ToolDef => def as ToolDef;
const NO_ACCOUNT = ' No Xianyu account, cookie or login is required or used. Read-only: this server cannot publish, message, or change anything.';
export const TOOLS: ToolDef[] = [
  tool({ name: 'capabilities', description: 'Report what this server can do without a Xianyu account right now, probing the live site: session_state, feed_reachable, the split between what works and what is flaky, the measured cost of each call, the known failure causes, and `build` -- which commit is answering your calls and whether it is behind main. Read `build` first if you are measuring performance or trusting a result against the documentation: a deployment can be many commits and a whole release behind and still answer every call plausibly. Start here if you are unsure whether a call will work, what it will cost, or what a refusal means. Never raises, not even if the browser is gone. Args: none.' + NO_ACCOUNT, schema: {}, run: capabilities }),
  tool({ name: 'browse_feed', description: 'Page through goofish\'s public homepage feed: live listings with item_id, title, price, city, seller, want_count and image_urls. Not keyword-filterable, so use it to sample inventory, not to answer a query. Args: page_number (1-10000, default 1), pages (1-25, default 1), limit (max items, default 60).' + NO_ACCOUNT, schema: FEED_ARGS, run: browseFeed }),
  tool({ name: 'search_count', description: 'How many goofish listings match a keyword, and whether there are any. Unlike search_items this is not subject to goofish\'s per-page-load declines -- verified returning about 28,800 for "x220" and 0 for a nonsense string anonymously. Args: query (str).' + NO_ACCOUNT, schema: COUNT_ARGS, run: searchCount }),
  tool({ name: 'search_suggest', description: 'goofish\'s own search-box autocomplete: keyword suggestions for a prefix, plus the total suggestion count. Args: query (str), limit (default 20).' + NO_ACCOUNT, schema: SUGGEST_ARGS, run: searchSuggest }),
  tool({ name: 'search_items', description: 'Search goofish listings by keyword, logged out. Depth is two arguments. `pages` (1-10, default 1) walks the result pager for 30 listings a page; it is a floor, not a ceiling -- if the pages walked leave fewer than `limit` matches, up to two more are walked. Read `count` rather than assuming 30 a page. `detail` (0-50, default 0) reads that many of the top-ranked results in full -- description, every photo, and the seller with their city, tenure, sales count, rating, reply rate and signature -- one page load each that does not parallelise, so budget roughly a minute per 8; `detail_report` names which answered and what goofish said about the ones that did not. Cards already carry price, want count, city, seller, avatar, photo and tags, so ask for `detail` only on a shortlist. `items` holds just the listings whose titles really carry the query -- as the phrase, or as every term in any order, which is what makes Chinese work (`机械硬盘4t` has 70,000+ listings; the titles read 西数4T机械硬盘). `matched_by` says which rule admitted the set. The recommendation rail is never returned as results; goofish declines some page loads outright, so this retries and may raise `SearchUnavailableError`. A search whose (query, page) set this process has already walked answers from the cache with no page load at all -- `via: \'cache\'`, `attempts: 0` -- and a deeper walk reuses the pages it already has instead of clicking the pager again (5-9.5s a page); `cache` reports every page, whether it was a hit and how old it is, and read a listing before relying on its price. For measured costs, call capabilities. Args: query (str), limit (default 120, capped by XIANYU_SEARCH_MAX_ITEMS), attempts (1-10, default 4; the first 3 type into the search box, the last is a direct-URL fallback), pages (1-10, default 1), detail (0-50, default 0).' + NO_ACCOUNT, schema: SEARCH_ARGS, run: locked(searchItems) }),
  tool({ name: 'related_items', description: 'Listings goofish recommends for a given item ("more like this"), or its generic recommendation set when item_id is omitted. Returns real listings with titles, prices and cities. Args: item_id (optional digits or item URL), limit (default 30), page (1-10000, default 1).' + NO_ACCOUNT, schema: RELATED_ARGS, run: relatedItems }),
  tool({ name: 'seller_profile', description: 'One seller\'s public profile, logged out: display name, avatar, signature, credit tier (卖家信用极好), shop level and score, praise ratio, review count, follower and listing counts, and whether they have passed real-name, real-person and 芝麻 checks. Pass `user_id` (the id item_view and this tool report, or the one in a goofish /personal?userId= URL) for a direct mtop call, or `item_id` to mean "whoever is selling this listing" -- which first loads the listing\'s page -- one page load, and on the loads goofish declines item_view\'s own retry loop absorbs the cost -- and additionally returns their city, tenure, sales count and positive rate, the four facts the profile endpoint does not carry. Exactly one of the two; passing both is refused rather than guessed. Fields the call could not fill come back null and are named in `fields_missing` rather than blank. Args: user_id (optional digits), item_id (optional digits or item URL).' + NO_ACCOUNT, schema: SELLER_ARGS, run: sellerProfile }),
  tool({ name: 'seller_items', description: 'The listings one seller currently has up, logged out -- the 宝贝 tab of their goofish profile, with title, price, category, photo, want count and the label strip. On a site with no ratings and no feedback threads this is the whole of due diligence, and nothing else here can answer it. Pass `user_id` for a direct mtop call, or `item_id` to mean that listing\'s seller (which costs one item page load). `has_more` comes from goofish\'s own `nextPage`; walk `page` rather than assuming 20 a page. Args: user_id (optional digits), item_id (optional digits or item URL), limit (default 20), page (1-50, default 1 -- goofish serves at most 50 pages of 20 here, so walk `has_more` rather than asking for a page number up front).' + NO_ACCOUNT, schema: SELLER_ITEMS_ARGS, run: sellerItems }),
  tool({ name: 'item_view', description: 'Read one listing, logged out -- title, price, want and browse counts, the description, the seller with their city, tenure, sales and rating, the brand and condition, and every photo. `source` says which route answered -- `item_detail_api` is the full listing, `item_page_dom` is the rendered page, `search_card_cache` is an earlier search result in this session and is missing the description and the seller statistics, which `fields_missing` names rather than guessing. Most often an id that cannot be read has been sold or removed; that raises `DetailUnavailableError`. A listing this process has already read in full is served again from its own cache in ~0s instead of 4-10s, and says so: `cache.hit`, `cache.age_s` and `cache.ttl_s` are on every answer, hit or not, because a listing read 40s ago may since have been sold or repriced -- `XIANYU_CACHE=0` turns the cache off for a live read. Args: item_id (digits or item URL).' + NO_ACCOUNT, schema: ITEM_ARGS, run: locked(itemView) }),
  tool({ name: 'recommendations', description: 'Scrape goofish\'s recommendation rails (猜你喜欢 / 为你推荐) for an anonymous visitor from any goofish page. Falls back to live feed listings if the DOM will not cooperate, and says so in `source` and `fallback_reason`. Args: limit (default 30), url (optional goofish page to load, default the homepage).' + NO_ACCOUNT, schema: RECO_ARGS, run: locked(recommendations) }),
];
