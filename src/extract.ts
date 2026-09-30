/** In-page JavaScript. These run inside a throwaway Chromium page that has never had an account, so they use the page's own mtop client (`window.lib.mtop.request`) instead of re-implementing token minting, request signing or fingerprint spoofing -- the site does that work itself, which is the whole reason this server drives a browser at all. Exported as functions rather than strings so the tests can run them against a synthetic document: node strips the type annotations before Playwright serialises the function, and the page globals are read off `globalThis` because there is no DOM lib here and the boundary is the point. Each function must also be self-contained, because Playwright serialises the function *and its single argument* and nothing else: so a fact two of them share -- the rail markers, `RAIL_MARKERS` -- arrives as an argument rather than as a closed-over constant, or the two copies would drift. */

/** The one list of "this is a recommendation rail, not results" markers. Both scrapers below cut on it and `tools.ts` passes it in, so the two cannot drift; it was a real bug once: the item scraper knew 猜你想看 and the card scraper did not, and a page headed 猜你想看 was accepted as search results. It is also two jobs in one list -- the card scraper's *detection* set and the item scraper's *truncation* point -- so a marker added to close a detection gap also moves where the item scrape cuts; split them if that coupling bites. */
export const RAIL_MARKERS = ['为你推荐', '猜你喜欢', '猜你想看'];

/** The one attribute the two search scripts agree on, so the second can find what the first marked. It
 *  is exported and passed as each script's single argument rather than closed over, for the same
 *  reason `RAIL_MARKERS` is: Playwright serialises the function and its argument and nothing else, so
 *  a module-level constant read inside the page is a `ReferenceError` at run time that `tsc` cannot
 *  see (the page has the name in scope as far as the type is concerned). It was a live bug -- every
 *  search attempt died with `SEARCH_MARK is not defined` and 0/4 searches returned anything. A
 *  leftover marker is harmless: the finder overwrites it. */
export const SEARCH_MARK = 'data-xianyu-search';

/**
 * Split a query into the terms a listing title has to contain, in any order.
 *
 * This is the difference between a search tool that works and one that only works in English. goofish
 * titles are in whatever word order the seller typed, and Chinese has no spaces to learn word
 * boundaries from, so an exact-substring test rejects almost everything on this site: a search for
 * `机械硬盘4t` -- 70,146 listings by goofish's own counter -- returned nothing at all, because the
 * titles say `西数4T机械硬盘`. Splitting at the CJK/Latin boundary as well as at whitespace turns
 * that one query into `机械硬盘` + `4t`, and the recommendation rail still fails it, because a rail
 * full of bicycles is not going to contain both.
 *
 * Deliberately not a sub-sequence match: `机械硬盘4t` is not a sub-sequence of `西数4T机械硬盘`
 * (the `4t` comes first), and a fuzzy rule that loose would let the rail back in.
 */
export const queryTerms = (query: string): string[] => {
  const q = String(query ?? '').toLowerCase().trim();
  if (!q) return [];
  const CJK = '\\u3400-\\u9fff';
  // whitespace, and every CJK<->Latin boundary, so `i350网卡` is `i350` + `网卡`
  const runs = q.split(new RegExp(`[\\s\\u3000]+|(?<=[a-z0-9])(?=[${CJK}])|(?<=[${CJK}])(?=[a-z0-9])`, 'g'))
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  // A bare number and the unit stuck to it are one quantity, not two terms: `显示器24寸` is
  // `显示器` + `24寸`, not `显示器` + `24` + `寸`. Otherwise every listing has to carry the unit
  // separately, and splitting `24寸` is also what let an unrelated title qualify on the `寸` alone.
  const terms: string[] = [];
  for (const run of runs) {
    const prev = terms[terms.length - 1];
    const isUnit = new RegExp(`^[${CJK}]{1,2}$`).test(run);
    if (prev && /^[0-9]+$/.test(prev) && isUnit) terms[terms.length - 1] = prev + run;
    else terms.push(run);
  }
  return [...new Set(terms)];
};
/** Does this title carry every term of the query, in any order? A one-word query is an exact match,
 *  so the two rules only ever differ for multi-term ones. */
export const hasAllTerms = (title: string, terms: string[]): boolean => {
  const t = String(title ?? '').toLowerCase();
  return terms.every((x) => t.includes(x));
};
/** Step 1 of search: find the SPA's own search input, mark it, and focus it. Measured over 12 loads:
 *  the homepage is a 512-character footer-only shell for 8-14s and the real app then mounts, so
 *  "there is no input yet" is the normal state for the first ten seconds and the caller polls rather
 *  than concluding anything from one miss. Selection is by geometry, not by class name -- the classes
 *  are hashed per build (search-input--WY2l9QD3) and no placeholder is set at all, so an <input> at
 *  least 100px wide within the top 400px of the viewport is the input, and it is the only one there.
 *  It is *focused* rather than clicked, and that is not a style choice: goofish's login dialog puts an
 *  ant-modal-mask over the header, and Playwright's click actionability check times out against it
 *  (measured, 10s timeout, element resolved but never receiving the event). `focus()` needs no
 *  pointer, and the keys that follow are what the SPA's form actually listens for. */
export const SEARCH_INPUT_JS = (mark: string): any => {
  const { document, window, location } = globalThis as any;
  const cands = [...document.querySelectorAll('input')].filter((el: any) => {
    const r = el.getBoundingClientRect();
    return r.width >= 100 && r.height >= 20 && r.top < Math.min(400, window.innerHeight);
  });
  const el = cands.sort((a: any, b: any) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  if (!el) return { found: false, inputs: document.querySelectorAll('input').length, chars: (document.body?.innerText || '').length, path: location.pathname };
  el.setAttribute(mark, '1');
  el.focus();
  // `value` is read from the live element the caller is about to type into, so the caller can confirm
  // the keys arrived instead of assuming they did. The SPA re-renders this input under the cursor, and
  // a keystroke burst that spans a re-render splits: measured, "thinkpad x220" arriving as "th".
  return { found: true, focused: document.activeElement === el, value: String(el.value ?? ''), inputs: document.querySelectorAll('input').length, chars: (document.body?.innerText || '').length, path: location.pathname };
};

/** Step 3 of search: everything the submit poll needs, in one round-trip. `typed` is read from the
 *  same element step 1 marked, so "the keys never reached the input" is distinguishable from "Enter
 *  did not submit" -- two different retries, and the measured log has both. A destroyed execution
 *  context (the SPA swaps it on navigation) throws rather than answers; that is the poll's problem,
 *  not a failure, and the caller keeps waiting. */
export const SEARCH_STATE_JS = (mark: string): any => {
  const { document, location } = globalThis as any;
  const el = document.querySelector(`[${mark}]`) as any;
  return {
    typed: el?.value ?? '',
    path: location.pathname,
    on_search: location.pathname.includes('/search'),
    cards: document.querySelectorAll('a[href*="/item?id="]').length,
  };
};

/** Is the page's own mtop client up yet? */
export const MTOP_READY_JS = (): string => {
  const { window } = globalThis as any;
  return window?.lib?.mtop?.request ? 'ready' : 'pending';
};

export const SCROLL_TO_JS = (y: number): void => { (globalThis as any).scrollTo(0, y); };   // item_view scrolls down and back so lazy gallery photos decode first: the scraper filters on naturalWidth, and an undecoded image reports 0

/** Generic mtop call through the page's own client. `spec.calls` is a list of [label, api, data] so one round-trip can fetch a batch of feed pages. They are issued concurrently: sequential, `pages: 25` at ~10s each blew the 240s evaluate bound even though every call had succeeded. `out` is keyed by label and every caller reads it by label, so concurrency is a drop-in. */
export const MTOP_CALL_JS = async (spec: { calls: [string, string, any][] }): Promise<any> => {
  const { window } = globalThis as any;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !window?.lib?.mtop?.request; i++) await wait(150);
  if (!window?.lib?.mtop?.request) return { fatal: 'mtop-not-ready' };
  const one = async ([label, api, data]: [string, string, any]): Promise<[string, any]> => {
    try {
      const res = await window.lib.mtop.request({ api, data, type: 'POST', v: '1.0', dataType: 'json', needLogin: false, needLoginPC: false, sessionOption: 'AutoLoginOnly', ecode: 0 });
      const ret = Array.isArray(res?.ret) ? res.ret.join(' | ') : String(res?.ret ?? '');
      return [label, { ret, ok: ret.includes('SUCCESS'), data: res?.data ?? null }];
    } catch (e) {
      // A rejected mtop call still carries goofish's own code on `ret`; that is the diagnostic, and the JS error message would throw it away.
      const ret = (e as any)?.ret;
      return [label, { ret: Array.isArray(ret) ? ret.join(' | ') : String(ret ?? (e as any)?.message ?? e), ok: false, data: null }];
    }
  };
  return Object.fromEntries(await Promise.all(spec.calls.map(one)));
};

// ---- payload normalisers. These are NOT in-page scripts: they run here, in Node, on a response the
// page already produced. They are the reason this server stopped scraping the DOM for the two things
// the DOM could not answer properly. Written as plain functions because nothing here touches a global.

const asText = (v: any): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const firstText = (...vals: any[]): string => { for (const v of vals) { const s = asText(v); if (s) return s; } return ''; };
/** goofish reports counts as 0 when it genuinely has none and as 0 when it has nothing to report; both
 *  read the same, so a count of 0 is published as a number and a missing key as an empty string. */
const countOf = (v: any): string => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? String(Math.trunc(n)) : ''; };

/** One listing out of the captured `mtop.taobao.idle.pc.detail` payload, or null when the payload is
 *  not a listing at all.
 *
 *  This is the whole reason item_view is honest now. The DOM could not be made to yield a title: the
 *  detail block renders the price, the description and the seller, but the title is not in the page's
 *  text at all -- measured, 6 live listings, `title` empty every time -- and the image selector
 *  returned goofish's promo banners rather than the seller's photos. The API's `itemDO` has both, exact,
 *  plus about fifteen fields the DOM never exposed: the seller's signature, reply rate, item count and
 *  avatar, the 品牌/成色/已用年限 attribute block, favourites, quantity and shipping.
 *
 *  `wanted` is the id the caller asked for, and it is checked here rather than trusted: the page
 *  decides which listing to render, and a page that served a different one must not be reported as
 *  the answer to this question. */
export const detailListing = (data: any, wanted: string): any | null => {
  const item = data?.itemDO, seller = data?.sellerDO || data?.b2cSellerDO || {};
  const id = asText(item?.itemId);
  if (!id) return null;
  if (wanted && id !== String(wanted)) return null;
  const images: string[] = [];
  for (const info of Array.isArray(item.imageInfos) ? item.imageInfos : []) {
    const u = asText(info?.url).replace(/^http:\/\//, 'https://');
    if (u && !images.includes(u)) images.push(u);
  }
  // cpvLabels is the 品牌 / 成色 / 已用年限 / 功能状态 block the detail page prints one label per line.
  const attributes: Record<string, string> = {};
  for (const l of Array.isArray(item.cpvLabels) ? item.cpvLabels : []) {
    const k = asText(l?.propertyName), v = asText(l?.valueName);
    if (k && v) attributes[k] = v;
  }
  const tenure = Number(seller.userRegDay);
  return {
    item_id: id,
    title: asText(item.title),
    price: firstText(item.soldPrice, item.defaultPrice, item.originalPrice),
    original_price: Number(item.originalPrice) > 0 ? asText(item.originalPrice) : '',
    description: firstText(item.desc, item.richTextDesc),
    want_count: countOf(item.wantCnt),
    browse_count: countOf(item.browseCnt),
    collect_count: countOf(item.collectCnt),
    quantity: countOf(item.quantity),
    item_status: asText(item.itemStatusStr),
    shipping_fee: firstText(item.transportFee),
    seller: asText(seller.nick),
    seller_city: firstText(seller.city, seller.publishCity),
    seller_tenure_years: Number.isFinite(tenure) && tenure > 0 ? String(Math.floor(tenure / 365)) : '',
    seller_items_sold: countOf(seller.hasSoldNumInteger),
    seller_items_listed: countOf(seller.itemCount),
    seller_positive_rate: asText(seller.newGoodRatioRate).replace('%', ''),
    seller_reply_rate_24h: asText(seller.replyRatio24h).replace('%', ''),
    seller_signature: asText(seller.signature),
    seller_avatar: asText(seller.portraitUrl).replace(/^http:\/\//, 'https://'),
    seller_last_active: asText(seller.lastVisitTime),
    seller_zhima_verified: seller.zhimaAuth === true,
    brand: asText(attributes['品牌']),
    condition: asText(attributes['成色']),
    used_years: asText(attributes['已用年限']),
    attributes,
    image_urls: images,
  };
};

/** The listings out of a captured `mtop.taobao.idlemtopsearch.pc.search` payload.
 *
 *  The search result and the homepage feed card are the *same* shape underneath -- `detailParams` with
 *  itemId, title, soldPrice, picUrl, userNick -- so the same normaliser reads both. What was not
 *  available before is what the DOM scrape threw away: a want count, a city, a seller, the seller's
 *  avatar, and the tag strip, all of which are in the reply. */
export const searchListings = (data: any): any[] => {
  const list = Array.isArray(data?.resultList) ? data.resultList : [];
  const cards: any[] = [];
  for (const entry of list) {
    const main = entry?.data?.item?.main;
    const ex = main?.exContent;
    if (!ex) continue;
    const dp = ex.detailParams || {};
    const args = main.clickParam?.args || {};
    // The id is in three places and they do not all survive a shape change: `detailParams.itemId` is
    // the one that is normally there, `exContent.itemId` and `clickParam.args.item_id` are the
    // fallbacks. Without them a card whose `detailParams` is empty or renamed comes out of the
    // normaliser with no id at all and is dropped silently -- which is how a result set gets shorter
    // than it should with nothing in the envelope saying so.
    const itemId = asText(dp.itemId) || asText(ex.itemId) || asText(args.item_id);
    // Rebuilt into the *feed's* card shape -- `{ detailParams, attributeMap, city }` -- so that the one
    // normaliser reads a search result and a feed listing alike, rather than two near-identical
    // shapes drifting apart. The price is the trap in doing this by hand: a search card's
    // `detailParams` carries no `soldPrice` at all, it lives in `clickParam.args.price`, so a search
    // that copies `detailParams` across verbatim returns items with an empty price and looks like
    // listings that are free.
    const soldPrice = asText(dp.soldPrice) || asText(args.price);
    const image = asText(dp.picUrl) || asText(ex.picUrl);
    // The seller is here and was being thrown away: the search card's `userNick` does not exist, the
    // name is `exContent.userNickName`, so search results came back with an empty seller.
    const seller = asText(ex.userNickName) || asText(dp.userNick);
    cards.push({
      detailParams: { ...dp, ...(itemId ? { itemId } : {}), ...(image ? { picUrl: image } : {}), ...(soldPrice ? { soldPrice } : {}), ...(seller ? { userNick: seller } : {}) },
      attributeMap: { wantNum: asText(ex.want) || asText(args.wantNum), cCatId: args.cCatId, categoryId: args.catId },
      city: asText(ex.area),
      // Not normaliser fields: the search card's own extra, carried through so one reply answers more
      // than a title and a price. All of it is free -- it is in the reply we already have.
      _ex: {
        seller_avatar: asText(ex.userAvatarUrl).replace(/^http:\/\//, 'https://'),
        seller_shop: Boolean(ex.userFishShopLabel) || asText(args.userIsUseFishShopCard) === 'true',
        is_video: Boolean(ex.showVideoIcon || dp.isVideo === 'true' || ex.isVideo === true),
        is_auction: Boolean(ex.isAuction),
        publish_time: asText(args.publishTime),
        // fishTags.r1..r4 is the strip under the title: free shipping, a price drop, seller credit.
        // Reading the `content` of each tag is the only way to get it, and it is genuinely useful for
        // triage -- "卖家信用极好" and "18天内降价" change how a listing reads.
        tags: tagContents(ex.fishTags),
        page: asText(args.page),
      },
    });
  }
  return cards;
};

/** The text of every tag in a card's `fishTags` block, de-duplicated in document order. */
const tagContents = (fishTags: any): string[] => {
  const out: string[] = [];
  for (const group of Object.values(fishTags ?? {})) {
    for (const t of (group as any)?.tagList ?? []) {
      const c = asText(t?.data?.content);
      // `content` is sometimes an icon name rather than text (freeShippingIcon); an icon is not a fact.
      if (c && !/Icon$/.test(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
};

/**
 * Click the Nth box of the search results pager.
 *
 * This is the only way to get past 30 results, and it is the one click in this server. Two things make
 * it safe. It is a DOM `click()` rather than a Playwright pointer click, so the anonymous login
 * dialog's `ant-modal-mask` cannot intercept it -- which is the same reason nothing else here clicks
 * anything, and the reason those four close controls are not touched. And it is the search page's own
 * pagination control, not a dismissal: the page then issues its own `idlemtopsearch.pc.search` for the
 * next page, and the answer is read off the wire exactly as the first page's was.
 *
 * Measured: 30 new items per click, 5–9.5s, zero overlap with the page before, against 13–25s for a
 * fresh page load. Four tabs doing this concurrently gained nothing -- 8.2s per listing either way --
 * because goofish throttles per IP, so this is walked serially on the one dom page.
 *
 * Only boxes 1..10 are always rendered (the pager shows `1 2 3 4 5 6 7 8 9 10 ... 50`), which is why
 * `search_items` caps `pages` at 10. That is 300 listings, well past the 50 a comparison needs.
 */
export const PAGER_CLICK_JS = (spec: { page: string }): any => {
  const { document } = globalThis as any;
  const want = String(spec.page);
  const boxes = Array.from(document.querySelectorAll('[class*="search-pagination-page-box"]'));
  const active = boxes.find((b: any) => String(b.className).includes('active'));
  const el = boxes.find((b: any) => String((b as any).innerText ?? '').trim() === want);
  if (!el) return { ok: false, why: 'no such page box', on_page: String((active as any)?.innerText ?? '').trim(), have: boxes.map((b: any) => String((b as any).innerText ?? '').trim()).filter(Boolean).slice(0, 14) };
  if (el === active) return { ok: true, already: true, on_page: want };
  (el as any).click();
  return { ok: true, on_page: want };
};

/** What the pager currently offers, so a caller can tell "there are no more pages" from "it went
 *  wrong" without guessing from a timeout. */
export const PAGER_STATE_JS = (): any => {
  const { document } = globalThis as any;
  const boxes = Array.from(document.querySelectorAll('[class*="search-pagination-page-box"]'))
    .map((b: any) => String((b as any).innerText ?? '').trim()).filter(Boolean);
  const active = Array.from(document.querySelectorAll('[class*="search-pagination-page-box"]'))
    .find((b: any) => String((b as any).className).includes('active'));
  return { pages_visible: boxes, on_page: String((active as any)?.innerText ?? '').trim() };
};


/** Normalize a cardList into flat listing dicts. The feed mixes two card layouts and neither is guaranteed: A) detailParams {itemId, title, soldPrice, picUrl, userNick} + attributeMap, and B) itemId + titleSummary.text + priceInfo.price + images[].url + user.userNick. So every field is read through a fallback chain across both shapes. Measured on 60 live cards: 58 A, 2 B. */
export const FEED_NORMALIZE_JS = (spec: { rows: any[] }): any[] => {
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const pick = (...vals: any[]) => { for (const v of vals) { const s = clean(v); if (s) return s; } return ''; };
  const out: any[] = [];
  for (const row of spec.rows) {
    const card = row?.cardData || row || {};
    const am = card.attributeMap || {}, dp = card.detailParams || {}, ex = card._ex || {};
    const itemId = pick(dp.itemId, card.itemId, am.itemId, am.uniqueCode);
    if (!itemId) continue;
    const imageUrls: string[] = [];
    const addImage = (u: any) => { const s = clean(u); if (s && !imageUrls.includes(s)) imageUrls.push(s); };
    addImage(pick(dp.picUrl, card.picUrl, am.picUrl, card.mainPicInfo?.url));
    for (const arr of [dp.imageList, card.imageList, am.imageList, card.images]) {
      if (Array.isArray(arr)) for (const e of arr) addImage(typeof e === 'string' ? e : (e?.url || e?.picUrl || e?.src || ''));
    }
    // hotPoint.text looks like "26人想要"; attributeMap.wantNum is the raw number.
    const hot = clean(card.hotPoint?.text).match(/([\d.]+)\s*(万)?\s*人想要/);
    out.push({
      item_id: itemId,
      title: pick(dp.title, card.titleSummary?.text, card.title, am.title, card.titleText),
      price: pick(dp.soldPrice, am.soldPrice, am.firstPrice, card.priceInfo?.price, card.price),
      original_price: pick(am.originalPrice, dp.originalPrice, card.priceInfo?.oriPrice),
      city: pick(card.city, dp.city, am.city),
      want_count: pick(am.wantNum, dp.wantNum, hot ? String(hot[2] ? Math.round(parseFloat(hot[1]) * 10000) : Math.round(parseFloat(hot[1]))) : ''),
      image_count: String(imageUrls.length || am.image_count || ''),
      seller: pick(dp.userNick, card.user?.userNick, am.userNick),
      // `ex.showVideoIcon` is how a search card says it; the feed card has no such field, hence the
      // three-way read rather than a replacement.
      is_video: pick(dp.isVideo, am.isVideo) === 'true' || Boolean(card.videoInfo) || Boolean(ex.is_video),
      category_id: pick(card.categoryId, dp.categoryId),
      image_urls: imageUrls,
      // Search cards carry more than the homepage feed card, and it is all already in hand: the seller's
      // avatar, the tag strip under the title (free shipping, a price drop, seller credit), when it was
      // listed, and which result page it came from. The feed cards simply have none of these, so they
      // come back empty rather than guessed.
      tags: Array.isArray(ex.tags) ? ex.tags : [],
      seller_avatar: pick(ex.seller_avatar),
      seller_shop: Boolean(ex.seller_shop),
      publish_time: pick(ex.publish_time),
      url: 'https://www.goofish.com/item?id=' + itemId,
    });
  }
  return out;
};

/** Scrape the item page's own detail block, as a logged-out visitor sees it. Two things learned the hard way: (1) the detail block sits ABOVE the recommendation rail, so we cut the page text at the rail marker and parse only the head -- parsing the whole body reports a rail card's price and title as if they were the listing's; (2) class names are hashed build-to-build (main-title--sMrtWSJa), so we match on substrings and accept a candidate only if its text really occurs in the detail head. Rejecting by "lives inside a card list" is not enough -- the detail block and the rail can share one container, and that threw away the real description and seller. */
export const ITEM_SCRAPE_JS = (spec: { item_id: string; rails: string[] }): any => {
  const { document, location } = globalThis as any;
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  // goofish puts the listing's name in the document title with a `_闲鱼` suffix, and truncates it.
  const asTitleText = (t: any) => clean(String(t ?? '').replace(/_闲鱼$/, ''));
  // `.../photo.jpg_2`, `.../photo.jpg_Q`, `.../photo.jpg_110x10000Q90.jpg_.webp` are all the same
  // photo as `.../photo.jpg`, so the size descriptor is dropped and the gallery collapses to one
  // entry per photo instead of listing each one three times.
  const bareImageUrl = (u: string) => (u.match(/^(.*?\.(?:jpe?g|png|webp))(?:_[^/]*)?$/i) || [null, u])[1] || '';
  const full = document?.body?.innerText || '';
  const cut = full.search(new RegExp(spec.rails.join('|')));   // spec.rails, not a second list of our own: see RAIL_MARKERS
  const head = cut >= 0 ? full.slice(0, cut) : full;
  const headCompact = head.replace(/\s+/g, ' ');
  const inDetail = (el: any) => { const t = clean(el.textContent); return Boolean(t) && t.length <= 200 && headCompact.includes(t); };
  // A "description" of "3人想要" is a want-counter that happens to sit in a class containing "desc", not the seller's description.
  const isCounter = (s: string) => /^[\d.,]+\s*(人想要|浏览|人付款|人浏览)$/.test(clean(s));
  const firstInDetail = (sels: string[]) => {
    for (const s of sels) for (const el of document.querySelectorAll(s)) if (inDetail(el)) return clean(el.textContent);
    return '';
  };
  const money = (re: RegExp) => { const m = headCompact.match(re); if (!m) return ''; const n = parseFloat(m[1].replace(/,/g, '')); return Number.isNaN(n) ? '' : String(m[2] ? Math.round(n * 10000) : Math.round(n)); };
  const priceMatch = headCompact.match(/¥\s*([\d,]+(?:\.\d+)?)/);
  // The title is not in the page's text. Measured over 6 live listings: the detail block prints the
  // price, the counts, the description, the seller and the attribute block, and the title is nowhere
  // in `innerText` -- so a class-name search for it finds only recommendation cards further down the
  // page, and the one that had a class match came back empty every time. It is in the document title,
  // with a `_闲鱼` suffix. Used only when the class search finds nothing in the detail head, so a page
  // that does render a title element still wins.
  const docTitle = asTitleText(document?.title);
  // Photos. The old rule -- "big, on a known CDN, not inside a card" -- returned goofish's own promo
  // banners (measured: four `gw.alicdn.com/imgextra/...-tps-242-150.png` strips on a page whose
  // listing was a nail gun), because a banner is also big and also on a known CDN. Every photo a
  // seller uploaded is on `/bao/uploaded/`, and a banner or an avatar is not, so that path is the
  // discriminator. The thumbnail strip and the full-size preview are the same photo at two sizes, so
  // the size suffix is stripped and the two collapse to one URL.
  const railImages = new Set<string>();
  const anchors = document.querySelectorAll("a[href*='/item?id=']");
  for (const a of anchors) for (const img of a.querySelectorAll('img')) if (img.src) railImages.add(img.src);
  const imageUrls: string[] = [];
  let wideOutsideCards = 0;
  for (const img of document.querySelectorAll('img')) {
    if (!img.src || railImages.has(img.src)) continue;
    if (!/\/bao\/uploaded\//.test(img.src)) continue;
    if (img.naturalWidth < 100) continue;   // an undecoded image reports 0, which is "not loaded yet", not "not a photo"
    const bare = bareImageUrl(img.src);
    if (bare && !imageUrls.includes(bare)) imageUrls.push(bare);
    wideOutsideCards++;
  }

  const stats = headCompact.match(/来闲鱼\s*([\d.]+)\s*年[^ ]*\s*卖出\s*([\d]+)\s*件宝贝?\s*好评率\s*([\d.]+)%/);
  return {
    requested_item_id: String(spec.item_id),
    // The page's own id, so the caller can check it got the listing it asked for instead of a redirect, a challenge page, or a different item.
    page_item_id: (location?.search?.match(/[?&]id=([0-9]+)/) || location?.pathname?.match(/\/item\/([0-9]+)/) || [])[1] || '',
    detail_rendered: /人想要|浏览|立即购买/.test(headCompact),
    // Two pages look like "not ready yet" and are not. goofish serves a "网络不见了" notice when its
    // own edge fails, and a cached shell can hold nothing but rail cards under a `为你推荐` heading in
    // the first few characters -- which cut the head to 3 chars and made a real listing look empty.
    // Both are instant and retryable, so both are named rather than polled for another 32s.
    site_error: /网络不见了|服务异常|页面不存在|网络异常/.test(full),
    rail_only: cut >= 0 && cut < 120,
    title: firstInDetail(['[class*="main-title"]', '[class*="item-title"]', '[class*="detail-title"]', 'h1']) || docTitle,
    price: priceMatch ? priceMatch[1].replace(/,/g, '') : '',
    want_count: money(/([\d.]+)\s*(万)?\s*人想要/),
    browse_count: money(/([\d.]+)\s*(万)?\s*浏览/),
    description: (() => {
      for (const s of ['[class*="desc--"]', '[class*="item-desc"]', '[class*="detail-desc"]', '[class*="main-desc"]']) {
        for (const el of document.querySelectorAll(s)) {
          if (!inDetail(el)) continue;
          const txt = clean(el.textContent);
          if (!isCounter(txt) && txt.length >= 4) return txt;
        }
      }
      return '';
    })(),
    seller: firstInDetail(['[class*="nick"]', '[class*="user-name"]']),
    seller_tenure_years: stats ? stats[1] : '',
    seller_items_sold: stats ? stats[2] : '',
    seller_positive_rate: stats ? stats[3] : '',
    image_urls: imageUrls,
    // diagnostic: how many large non-card images the page had at all, so an empty image_urls is distinguishable from "the gallery never loaded"
    image_candidates: wideOutsideCards,
    head_preview: headCompact.slice(0, 220),
    reco_anchors: anchors.length,
  };
};

/** Scrape the `a[href*="/item?id="]` cards off a rendered page, with the evidence a caller needs to decide whether the page served what it asked for. Two consumers, one parser: search_items (keyword, needs `query_hits` / `cards_scanned` and the rail / nothing-found signals) and recommendations (any page, needs the rail label). `query_hits` is the guard that matters -- a declined anonymous search renders the 猜你喜欢 rail, full of unrelated cards, so a result set is only believable if a *fraction* of the page's titles really contain the query. Hits are therefore counted over every card on the page, while `items` stops at `limit`; `cards_scanned` is the full denominator the caller needs for that fraction. `token_hits` is a second, looser count -- titles containing every word of the query in any order -- published so a multi-word query that matches nothing as one substring is visible to the caller instead of looking like a rail; the caller keeps its strict guard on `query_hits`. The selector table has to live inside the function body, because Playwright serialises the function alone and it cannot close over anything in this module. Reading the cards needs no click anywhere: both this and the item scraper work off `querySelectorAll` and `innerText`, which see straight through the login dialog's `ant-modal-mask`, so nothing has to be dismissed for a read to succeed. */
export const SCRAPE_CARDS_JS = (spec: { query: string; terms: string[]; limit: number; rails: string[] }): any => {
  const { document } = globalThis as any;
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const sel = { card: 'a[href*="/item?id="]', title: '[class*="row1-wrap-title"], [class*="main-title"]', attrs: '[class*="row2-wrap-cpv"] span[class*="cpv--"]', priceWrap: '[class*="price-wrap"]', priceNum: '[class*="number"]', priceDec: '[class*="decimal"]', sellerWrap: '[class*="row4-wrap-seller"]', sellerText: '[class*="seller-text"]' };
  // `spec.terms`, not a tokenizer of its own: Playwright serialises the function and its argument
  // and nothing else, so the one rule that decides what counts as a match has to be handed in --
  // otherwise the page and the caller can disagree about what a query means, and did.
  const q = String(spec.query || '').toLowerCase(), terms = (spec.terms || []).map((t: any) => String(t).toLowerCase());
  const seen = new Set<string>();
  const items: any[] = [];
  let queryHits = 0, tokenHits = 0, cards = 0;
  for (const card of document.querySelectorAll(sel.card)) {
    const href = card.href || card.getAttribute('href') || '';
    const id = (href.match(/[?&]id=([0-9]+)/) || [])[1];
    if (!id || seen.has(id)) continue;
    const title = clean(card.querySelector(sel.title)?.textContent) || clean(card.innerText).slice(0, 90);
    if (!title) continue;
    seen.add(id);
    cards++;
    const low = title.toLowerCase();
    // Two different questions, and the difference is the whole search: does the title contain the
    // query as one phrase, and does it contain every term of the query in any order. On this site the
    // second is the one that matches real listings, because sellers do not use the searcher's word order.
    const has_phrase = Boolean(q) && low.includes(q);
    const has_terms = terms.length > 0 && terms.every((t: string) => low.includes(t));
    if (has_phrase) queryHits++;
    if (has_terms) tokenHits++;
    if (items.length >= spec.limit) continue;   // keep counting, stop collecting: the fraction needs the whole page
    const priceWrap = card.querySelector(sel.priceWrap);
    const attrs = Array.from(card.querySelectorAll(sel.attrs)).map((n: any) => clean(n.textContent)).filter(Boolean);
    // No per-item `source`: a card is a match or it is not, and the envelope's `source` says where the set came from. Labelling every card "dom_recommendation" once made search results claim to be recommendations.
    items.push({
      item_id: id,
      title,
      price: clean('¥' + clean(priceWrap?.querySelector(sel.priceNum)?.textContent) + clean(priceWrap?.querySelector(sel.priceDec)?.textContent)).replace(/^¥\s*$/, ''),
      condition: attrs[0] || '',
      brand: attrs[1] || '',
      city: clean(card.querySelector(sel.sellerWrap)?.querySelector(sel.sellerText)?.textContent),
      url: href,
      matches_query: has_phrase || has_terms,
      matches_phrase: has_phrase,
    });
  }
  const text = document?.body?.innerText || '';
  return {
    items,
    query_hits: queryHits,
    token_hits: tokenHits,
    cards_scanned: cards,
    rail: spec.rails.find((m) => text.includes(m)) || '',
    says_no_results: /没有找到你想要的宝贝|未找到相关宝贝|没有找到相关/.test(text),
    // Measured, not guessed: goofish answers this client with a whole-page risk-control notice instead
    // of the app -- "非法访问 ... 请使用正常浏览器访问闲鱼" -- a 200 that renders no listing at all. The
    // mtop client still comes up on it, so the four API tools keep working while every DOM tool sees
    // zero cards, which reads exactly like "no results found" unless it is named.
    blocked: /非法访问|使用正常浏览器|访问闲鱼/.test(text),
    rendered: items.length > 0,
    text_preview: text.slice(0, 200),
  };
};
