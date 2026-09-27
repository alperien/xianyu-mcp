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
  return { found: true, focused: document.activeElement === el, inputs: document.querySelectorAll('input').length, chars: (document.body?.innerText || '').length, path: location.pathname };
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

/** Normalize a cardList into flat listing dicts. The feed mixes two card layouts and neither is guaranteed: A) detailParams {itemId, title, soldPrice, picUrl, userNick} + attributeMap, and B) itemId + titleSummary.text + priceInfo.price + images[].url + user.userNick. So every field is read through a fallback chain across both shapes. Measured on 60 live cards: 58 A, 2 B. */
export const FEED_NORMALIZE_JS = (spec: { rows: any[] }): any[] => {
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const pick = (...vals: any[]) => { for (const v of vals) { const s = clean(v); if (s) return s; } return ''; };
  const out: any[] = [];
  for (const row of spec.rows) {
    const card = row?.cardData || row || {};
    const am = card.attributeMap || {}, dp = card.detailParams || {};
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
      is_video: pick(dp.isVideo, am.isVideo) === 'true' || Boolean(card.videoInfo),
      category_id: pick(card.categoryId, dp.categoryId),
      image_urls: imageUrls,
      url: 'https://www.goofish.com/item?id=' + itemId,
    });
  }
  return out;
};

/** Scrape the item page's own detail block, as a logged-out visitor sees it. Two things learned the hard way: (1) the detail block sits ABOVE the recommendation rail, so we cut the page text at the rail marker and parse only the head -- parsing the whole body reports a rail card's price and title as if they were the listing's; (2) class names are hashed build-to-build (main-title--sMrtWSJa), so we match on substrings and accept a candidate only if its text really occurs in the detail head. Rejecting by "lives inside a card list" is not enough -- the detail block and the rail can share one container, and that threw away the real description and seller. */
export const ITEM_SCRAPE_JS = (spec: { item_id: string; rails: string[] }): any => {
  const { document, location } = globalThis as any;
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
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
  // Photos. Two hard-won facts, both from live item pages: (1) every recommendation-card picture sits inside an item anchor, so excluding anchor images is what separates the listing's photos from the rail's -- host does NOT do it, on an item page all 33 /bao/uploaded images belong to cards and the listing's own gallery is on a different CDN host; (2) what is left is mostly avatars and badges, so require a real width, since an undecoded image reports naturalWidth 0.
  const railImages = new Set<string>();
  const anchors = document.querySelectorAll("a[href*='/item?id=']");
  for (const a of anchors) for (const img of a.querySelectorAll('img')) if (img.src) railImages.add(img.src);
  const imageUrls: string[] = [];
  let wideOutsideCards = 0;
  for (const img of document.querySelectorAll('img')) {
    if (img.naturalWidth < 200 || !img.src || railImages.has(img.src)) continue;
    if (!/\.(alicdn|taobaocdn|alibabacorp|aliyuncs|tbcdn)\./.test(img.src)) continue;
    wideOutsideCards++;
    if (!imageUrls.includes(img.src)) imageUrls.push(img.src);
  }
  const stats = headCompact.match(/来闲鱼\s*([\d.]+)\s*年[^ ]*\s*卖出\s*([\d]+)\s*件宝贝?\s*好评率\s*([\d.]+)%/);
  return {
    requested_item_id: String(spec.item_id),
    // The page's own id, so the caller can check it got the listing it asked for instead of a redirect, a challenge page, or a different item.
    page_item_id: (location?.search?.match(/[?&]id=([0-9]+)/) || location?.pathname?.match(/\/item\/([0-9]+)/) || [])[1] || '',
    detail_rendered: /人想要|浏览|立即购买/.test(headCompact),
    title: firstInDetail(['[class*="main-title"]', '[class*="item-title"]', '[class*="detail-title"]', 'h1']),
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
export const SCRAPE_CARDS_JS = (spec: { query: string; limit: number; rails: string[] }): any => {
  const { document } = globalThis as any;
  const clean = (v: any) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const sel = { card: 'a[href*="/item?id="]', title: '[class*="row1-wrap-title"], [class*="main-title"]', attrs: '[class*="row2-wrap-cpv"] span[class*="cpv--"]', priceWrap: '[class*="price-wrap"]', priceNum: '[class*="number"]', priceDec: '[class*="decimal"]', sellerWrap: '[class*="row4-wrap-seller"]', sellerText: '[class*="seller-text"]' };
  const q = String(spec.query || '').toLowerCase(), tokens = q.split(' ').filter(Boolean);
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
    const low = title.toLowerCase(), matches_query = Boolean(q) && low.includes(q);
    if (matches_query) queryHits++;
    if (tokens.length > 0 && tokens.every((t) => low.includes(t))) tokenHits++;   // every word, any order: a superset of the substring hits, published rather than accepted, and equal to them for a one-word query
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
      matches_query,
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
