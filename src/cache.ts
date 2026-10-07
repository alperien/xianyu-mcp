/** A TTL cache for the two answers that are both expensive to produce and safe to produce again, and
 *  for the rule that a cached answer never gets to look like a live one.
 *
 *  Two things are cached and nothing else: the listing `readListing` produced for an item id, and
 *  the raw `mtop.taobao.idlemtopsearch.pc.search` payload for one (query, page) pair. Both are keyed
 *  on what identifies the answer rather than on how it was asked for, and both are read back through
 *  the same relevance and identity guards a live answer is held to. A cached pool of search pages is
 *  pooled and judged by the same `finishSearch`, and a cached listing is the listing the detail API
 *  was checked to be about. A cache that short-circuited those checks would be a second, laxer
 *  answer path.
 *
 *  The mtop-only tools are not cached (`search_count`, `search_suggest`, `seller_*`), and neither is
 *  the homepage feed. The first three cost 0.4-2.2s and there is nothing to save. The feed is a
 *  different matter: measured, two identical `browse_feed` calls return completely disjoint
 *  inventory, so goofish serves each visitor a randomised slice and a repeat call is a different
 *  answer rather than a stale copy. Caching it would replace a sample of inventory with the same
 *  sample of inventory.
 *
 *  ## Why 45s and 120s
 *
 *  Nobody here has measured how fast an individual Xianyu listing sells, and this file does not
 *  invent a figure. The repo holds two change-rate facts and a set of costs, and the defaults are
 *  chosen against those:
 *
 *    - the market turns over inside one session. goofish's own match counter for "x220" was observed
 *      at 28,791 / 28,804 / 28,810, a live-inventory count drifting ~0.07% within one session's
 *      calls. A listing *set* cached for minutes is describing a market that has measurably moved
 *      under it, which is the argument against a long TTL.
 *    - what the cache replaces is expensive. An item page load is 4-10s (measured, warm and cold), a
 *      `detail` read ~8s a listing, a warm re-search 4-12s, and one page of the result pager
 *      5-9.5s. A TTL under the cost of the read it replaces buys nothing: the entry expires before
 *      the caller comes back for it.
 *    - the two caches carry different risk. A stale *item detail* is a price on a listing that may
 *      since have been sold, which is worse than a slow response, so it takes the shorter window. A
 *      stale *search page* is 30 listings compared against each other, none of which the caller is
 *      transacting, and a detail read re-checks the liveness of any one of them, so it takes the
 *      longer one.
 *
 *  So 45s for an item detail and 120s for a search page: each long enough to cover the loop the
 *  cache exists for (read a result page, open what looks interesting, open it again), each short
 *  enough that a sold listing is at most 45s out of date, and neither claiming a freshness the site
 *  has not promised. Both are overridable per process (`XIANYU_CACHE_ITEM_TTL_S`,
 *  `XIANYU_CACHE_SEARCH_TTL_S`), and `XIANYU_CACHE=0` turns the whole thing off, which is the answer
 *  for a caller who would rather pay the 8s than reason about a TTL. Read per call, like `budget` in
 *  tools.ts, so a script can change it without a restart.
 *
 *  ## Staleness is published, never silent
 *
 *  Every answer that can come from here carries a `CacheVerdict` on its envelope: `hit`, `age_s`,
 *  `stored_at`, `ttl_s`, the `key` it was looked up under, and a sentence saying in plain words
 *  whether goofish was asked at all. A miss publishes the same block with `hit: false` and null ages,
 *  so the shape of the answer does not depend on where it came from, the same rule the
 *  `typed`/`missing` block follows for the routes that answer a listing. Serving cached bytes in the
 *  shape of a live read and hoping nobody asks is the one thing this module exists to prevent.
 *
 *  Only successes are stored. There is no `putFailure` and no way to reach one: a refused or
 *  unparseable answer leaves the cache as it found it. A miss is always safe, a wrong cache is not. */
type Entry = { value: any; stored: number };

/** What every answer this cache touches publishes about itself. `hit` is the contract; the rest lets
 *  a caller see how old the answer is and what it was keyed on. */
export type CacheVerdict = {
  /** true only when this value came out of this process rather than off goofish. */
  hit: boolean;
  /** What it was keyed on, `item:809806779491` or `search:thinkpad x220#2`, so a miss reads as
   *  "a different thing was asked for" rather than "the cache is broken". */
  key: string;
  /** Whole seconds since the value was stored. null on a miss: a miss has no age. */
  age_s: number | null;
  /** ISO 8601, or null on a miss. */
  stored_at: string | null;
  /** The TTL in force for this call, so an answer says how old it was allowed to get. */
  ttl_s: number;
  /** One sentence, always, saying whether goofish was asked. */
  note: string;
};

/** One store per kind rather than one with prefixed keys: a listing is kilobytes and a page of 30 raw
 *  search cards ~100KB, the TTLs differ, and a caller reading `stats` should see the two numbers
 *  separately. */
const items = new Map<string, Entry>(), pages = new Map<string, Entry>();
/** 64 listings holds the 50 a `detail: 50` comparison reads plus room; 16 search pages holds a full
 *  deepest walk (10 pager pages + the 2 top-up pages) with slack. The caps are sized to the largest
 *  answer this server can produce rather than to a round number. */
const MAX_ITEMS = 64, MAX_SEARCH_PAGES = 16;
/** An override is floored at 1s so a typo cannot turn the cache into a no-op that still claims to be
 * on, and capped at 600s so it cannot restore a window no measurement here supports. `0` is how you
 *  ask for the whole thing off -- see `on()`. */
const TTL_FLOOR_S = 1, TTL_CEILING_S = 600;
const DEFAULT_ITEM_TTL_S = 45, DEFAULT_SEARCH_TTL_S = 120;

/** Is the cache on at all? `XIANYU_CACHE=0` is the kill switch, and it is the first thing every read
 *  asks, so switching it off needs no restart and no code change. */
export const on = (): boolean => process.env.XIANYU_CACHE !== '0';
/** Read per call, like `budget`: an integer in seconds, otherwise the default. */
const ttl = (name: string, fallback: number): number => {
  const raw = process.env[name], n = Number(raw);
  return raw?.trim() && Number.isInteger(n) ? Math.max(TTL_FLOOR_S, Math.min(TTL_CEILING_S, n)) : fallback;
};
/** How long a listing read may be served again. See the header for why 45s and why not more. */
export const itemTtl = (): number => ttl('XIANYU_CACHE_ITEM_TTL_S', DEFAULT_ITEM_TTL_S);
/** How long one page of search results may be served again. See the header. */
export const searchTtl = (): number => ttl('XIANYU_CACHE_SEARCH_TTL_S', DEFAULT_SEARCH_TTL_S);

/** Copy on the way in and on the way out. These values are plain data read off a JSON payload, but
 *  callers spread them into their own envelopes and one of them (`enrichDetails`) merges a cached
 *  listing into a card it then publishes, so a live reference into module state would let a later
 *  edit of an answer rewrite the cached copy of it. A microsecond of structuredClone is cheap for
 *  making that impossible. */
const copy = <T>(value: T): T => (value === null || typeof value !== 'object' ? value : structuredClone(value));

/** Insert, then evict the least recently used entry if the store is over its cap. Re-inserting on
 *  read as well as on write is what makes the eviction LRU rather than oldest-written, so re-opening
 *  the listing you are working on keeps its place. */
const store = (into: Map<string, Entry>, key: string, value: any, cap: number): void => {
  into.delete(key);
  into.set(key, { value, stored: Date.now() });
  while (into.size > cap) into.delete(into.keys().next().value as string);
};
/** A live entry for this key, or null. An expired entry is deleted on the way past rather than left
 *  to be counted, so `stats` cannot report a window the cache would not actually serve. */
const load = (from: Map<string, Entry>, key: string, ttlS: number): Entry | null => {
  const hit = from.get(key);
  if (!hit) return null;
  const ageS = (Date.now() - hit.stored) / 1000;
  if (ageS >= ttlS) { from.delete(key); return null; }
  from.delete(key);
  from.set(key, hit);
  return hit;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const seconds = (s: number): number => Math.round(s * 10) / 10;

/** A `hit: true` block: where the value came from, how old it is, and the sentence saying goofish
 *  was not asked. `age_s` is a float because "0" reads as "just now" when it may mean "0.4s ago", and
 *  rounding to whole seconds is what makes a cache look fresher than it is. */
const hit = (key: string, entry: Entry, ttlS: number, what: string): CacheVerdict => {
  const ageS = seconds((Date.now() - entry.stored) / 1000);
  return { hit: true, key, age_s: ageS, stored_at: iso(entry.stored), ttl_s: ttlS,
    note: `${what} was served from this process's own cache, ${ageS}s old (TTL ${ttlS}s): goofish was not asked, so ${/^item:/.test(key) ? 'this listing may have been sold, repriced or edited since' : 'this page of results may no longer be what goofish would return'}. Re-read it with XIANYU_CACHE=0, or after the TTL.` };
};
/** A `hit: false` block, published for the same key so the envelope's shape does not depend on where
 *  the answer came from -- the same rule the `typed`/`missing` block follows per listing route. */
export const missed = (key: string, ttlS: number, what: string): CacheVerdict => ({
  hit: false, key, age_s: null, stored_at: null, ttl_s: ttlS,
  note: on() ? `${what} was not in the cache (or what was there is past its ${ttlS}s TTL), so goofish answered it live just now` : `the cache is off (XIANYU_CACHE=0), so ${what} was answered live just now` });
/** A `hit: false` block for a route that never consults the cache: search_items' rendered-page
 *  fallback, which scrapes the DOM rather than reading the search API's payload. Same shape as every
 *  other verdict so the envelope does not change with the route, and an empty `key` because nothing
 *  was looked up. */
export const notCached = (what: string, ttlS: number): CacheVerdict => ({
  hit: false, key: '', age_s: null, stored_at: null, ttl_s: ttlS,
  note: `${what} was answered live from the rendered page; this route neither reads nor writes the cache, so nothing was looked up and nothing was stored` });

export const itemKey = (itemId: string): string => `item:${itemId}`;
/** The key is the *normalized* query, lowercased, because the relevance guard it will be pooled
 *  through matches titles case-insensitively ("X220" and "x220" are the same search). Keying on the
 *  raw string would store the same page twice and serve half of it never. */
export const searchKey = (query: string, page: number): string => `search:${String(query).trim().toLowerCase()}#${page}`;

/** A listing read earlier in this process, or null. `readListing` asks this before it opens a page,
 *  and that is the whole saving: a repeat view costs nothing instead of 4-10s. */
export const getItem = (itemId: string): { value: any; verdict: CacheVerdict } | null => {
  if (!on()) return null;
  const key = itemKey(itemId), ttlS = itemTtl(), entry = load(items, key, ttlS);
  if (!entry) return null;
  return { value: copy(entry.value), verdict: hit(key, entry, ttlS, 'this listing') };
};
/** Store a listing read just now. Called only with a listing goofish answered in full: the
 *  `search_card_cache` fallback deliberately does not come through here, because pinning a
 *  five-field card for the TTL would turn one degraded read into a window of them. */
export const putItem = (itemId: string, listing: any): void => { if (on() && listing) store(items, itemKey(itemId), copy(listing), MAX_ITEMS); };

/** One page of search results read earlier in this process, or null. */
export const getSearchPage = (query: string, page: number): { value: any; verdict: CacheVerdict } | null => {
  if (!on()) return null;
  const key = searchKey(query, page), ttlS = searchTtl(), entry = load(pages, key, ttlS);
  if (!entry) return null;
  return { value: copy(entry.value), verdict: hit(key, entry, ttlS, 'this page of results') };
};
/** Store one page of search results, keyed on the query and the pager page it was. */
export const putSearchPage = (query: string, page: number, payload: any): void => { if (on() && payload) store(pages, searchKey(query, page), copy(payload), MAX_SEARCH_PAGES); };

/** The `cache` block a pooled search answer publishes: one line per pager page, so which of the
 *  listings behind `count` were read when is visible rather than implied. Pages read at different
 *  moments happen here (page 1 fresh, page 3 ninety seconds old), and one age for the whole set
 *  would be a claim about a set that does not exist. */
export const pageReport = (lines: { page: number; hit: boolean; age_s: number | null }[]): Record<string, any> => {
  const ttlS = searchTtl(), hits = lines.filter((l) => l.hit);
  return { enabled: on(), hits: hits.length, misses: lines.length - hits.length, ttl_s: ttlS, pages: lines,
    note: hits.length === 0
      ? `every page below was read from goofish just now (nothing cached, or the cache is off; TTL ${ttlS}s)`
      : `${hits.length} of ${lines.length} page(s) were served from this process's own cache and the rest were read live just now; a cached page may no longer be what goofish would return, so read a listing before relying on its price (TTL ${ttlS}s)` };
};

/** What `capabilities` reports, so the cache is visible before it is relied on rather than first
 *  discovered inside a `cache` block on a tool answer. */
export const stats = (): Record<string, any> => ({ enabled: on(), item_ttl_s: itemTtl(), search_page_ttl_s: searchTtl(), listings: items.size, search_pages: pages.size,
  note: 'item detail and search pages are cached in this process for the TTLs above, and every answer that can come from the cache says so in a `cache` block. Set XIANYU_CACHE=0 to turn it off; nothing else in this server is cached, and the homepage feed deliberately is not -- goofish serves each visitor a different slice of it, so a repeat call is a different answer rather than a stale copy.' });

/** Forget everything. These stores are module state that outlives a call, so a test that seeded one
 *  would otherwise have the next tool answered from it -- the same reason `resetCardCache` exists. */
export const reset = (): void => { items.clear(); pages.clear(); };