"""In-page JavaScript.

Everything runs inside a throwaway Chromium page that has never had an account,
so it can use the page's own mtop client (`window.lib.mtop.request`) instead of
re-implementing token minting and request signing. That is the whole reason this
server drives a browser at all.
"""
from __future__ import annotations

# The login interstitial. goofish shows a full-page baxia dialog (a passport
# login iframe) to anonymous visitors. It does not gate browsing -- dismissing it
# lets the page finish rendering -- but leaving it up means zero cards, which is
# easy to misread as "no results". Dismiss it on every page load.
DISMISS_LOGIN_JS = r"""
() => {
  const dismiss = (root) => {
    let n = 0;
    const sels = [
      '#baxia-dialog-close', '[class*="closeIcon"]', '[class*="closeIconBg"]',
      '[class*="dialog-close"]', '[class*="modal-close"]',
    ];
    for (const s of sels) {
      for (const el of root.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;   // hidden, not clickable
        try { el.click(); n++; } catch (e) {}
      }
    }
    return n;
  };
  let total = dismiss(document);
  // The dialog body is a cross-origin passport iframe; the close control lives in
  // the parent document, but sweep again after a tick in case it re-renders.
  return new Promise((resolve) => setTimeout(() => resolve(total + dismiss(document)), 400));
}
"""

# Is the page's mtop client up yet?
MTOP_READY_JS = r"""
() => (window.lib?.mtop?.request ? 'ready' : 'pending')
"""

# Generic mtop call through the page's own client. `spec` is a list of
# [label, api, data] so one round-trip can fetch a batch of pages.
MTOP_CALL_JS = r"""
async (spec) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    if (window.lib?.mtop?.request) break;
    await wait(150);
  }
  if (!window.lib?.mtop?.request) return { fatal: 'mtop-not-ready' };

  const out = {};
  for (const [label, api, data] of spec.calls) {
    try {
      const res = await window.lib.mtop.request({
        api,
        data,
        type: 'POST',
        v: '1.0',
        dataType: 'json',
        needLogin: false,
        needLoginPC: false,
        sessionOption: 'AutoLoginOnly',
        ecode: 0,
      });
      const ret = Array.isArray(res?.ret) ? res.ret.join(' | ') : String(res?.ret ?? '');
      out[label] = { ret, ok: ret.includes('SUCCESS'), data: res?.data ?? null };
    } catch (e) {
      // A rejected mtop call still carries goofish's own code on `ret`; that is the
      // diagnostic, and the JS error message would throw it away.
      const ret = e?.ret;
      out[label] = {
        ret: Array.isArray(ret) ? ret.join(' | ') : String(ret ?? e?.message ?? e),
        ok: false,
        data: null,
      };
    }
  }
  return out;
}
"""

# Normalize a feed cardList into flat listing dicts.
#
# The feed mixes two card layouts and neither is guaranteed:
#   A) detailParams: {itemId, title, soldPrice, picUrl, userNick, ...} + attributeMap
#   B) itemId + titleSummary.text + priceInfo.price + images[].url + user.userNick
# So every field is read through a fallback chain across both shapes. Verified on
# 60 live cards: 58 shape A, 2 shape B.
FEED_NORMALIZE_JS = r"""
(spec) => {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const pick = (...vals) => {
    for (const v of vals) {
      const s = clean(v);
      if (s) return s;
    }
    return '';
  };
  const out = [];
  for (const row of spec.rows) {
    const card = row?.cardData || row || {};
    const am = card.attributeMap || {};
    const dp = card.detailParams || {};
    const itemId = pick(dp.itemId, card.itemId, am.itemId, am.uniqueCode);
    if (!itemId) continue;

    const imageUrls = [];
    const addImage = (u) => {
      const s = clean(u);
      if (s && !imageUrls.includes(s)) imageUrls.push(s);
    };
    addImage(pick(dp.picUrl, card.picUrl, am.picUrl, card.mainPicInfo?.url));
    for (const arr of [dp.imageList, card.imageList, am.imageList, card.images]) {
      if (Array.isArray(arr)) {
        for (const e of arr) {
          addImage(typeof e === 'string' ? e : (e?.url || e?.picUrl || e?.src || ''));
        }
      }
    }

    // hotPoint.text looks like "26人想要"; attributeMap.wantNum is the raw number.
    const wantFromHot = clean(card.hotPoint?.text).match(/([\d.]+)\s*(万)?\s*人想要/);
    const want = pick(
      am.wantNum, dp.wantNum,
      wantFromHot ? (wantFromHot[2] ? String(Math.round(parseFloat(wantFromHot[1]) * 10000))
                                       : String(Math.round(parseFloat(wantFromHot[1])))) : ''
    );

    out.push({
      item_id: itemId,
      title: pick(dp.title, card.titleSummary?.text, card.title, am.title, card.titleText),
      price: pick(dp.soldPrice, am.soldPrice, am.firstPrice,
                  card.priceInfo?.price, card.price),
      original_price: pick(am.originalPrice, dp.originalPrice, card.priceInfo?.oriPrice),
      city: pick(card.city, dp.city, am.city),
      want_count: want,
      image_count: String(imageUrls.length || am.image_count || ''),
      seller: pick(dp.userNick, card.user?.userNick, am.userNick),
      is_video: pick(dp.isVideo, am.isVideo) === 'true' || Boolean(card.videoInfo),
      category_id: pick(card.categoryId, dp.categoryId),
      image_urls: imageUrls,
      url: 'https://www.goofish.com/item?id=' + itemId,
    });
  }
  return out;
}
"""

# Scrape the item page's own detail block, as a logged-out visitor sees it.
#
# Two things learned the hard way, both encoded here:
#  1. The detail block sits ABOVE the recommendation rail, so we cut the page text
#     at the rail marker and parse only the head. Parsing the whole body picks up
#     recommendation cards and reports their price/title as the item's.
#  2. Class names are hashed build-to-build (main-title--sMrtWSJa), so we match on
#     substrings and accept a candidate only if its text really occurs in the detail
#     head. Rejecting by "lives inside a card list" is not enough: the detail block
#     and the rail can share one container, and that threw away the real description
#     and seller.
ITEM_SCRAPE_JS = r"""
(itemId) => {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const RAIL = /(为你推荐|猜你喜欢|猜你想看)/;
  const full = document.body?.innerText || '';
  const cut = full.search(RAIL);
  const head = (cut >= 0 ? full.slice(0, cut) : full);
  const headCompact = head.replace(/\s+/g, ' ');

  // A candidate counts only if its own text appears in the detail head, which keeps
  // recommendation cards out without guessing at container structure.
  const inDetail = (el) => {
    const t = clean(el.textContent);
    return Boolean(t) && t.length <= 200 && headCompact.includes(t);
  };
  // A "description" of "3人想要" is a want-counter that happens to sit in a
  // class containing "desc", not the seller's description.
  const isCounter = (s) => /^[\d.,]+\s*(人想要|浏览|人付款|人浏览)$/.test(clean(s));
  const firstOut = (sels) => {
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (inDetail(el)) return clean(el.textContent);
      }
    }
    return '';
  };

  const priceMatch = headCompact.match(/¥\s*([\d,]+(?:\.\d+)?)/);
  const wantMatch = headCompact.match(/([\d.]+)\s*(万)?\s*人想要/);
  const browseMatch = headCompact.match(/([\d.]+)\s*(万)?\s*浏览/);
  const scale = (m) => {
    if (!m) return '';
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(n)) return '';
    return String(m[2] ? Math.round(n * 10000) : Math.round(n));
  };

  // Photos. Two hard-won facts, both from live item pages:
  //  1. Every recommendation-card picture sits inside an item anchor, so excluding
  //     anchor images is what separates the listing's photos from the rail's. Host
  //     does NOT do it: on an item page all 33 /bao/uploaded images belong to cards,
  //     and the listing's own gallery is served from a different CDN host entirely.
  //  2. What is left is mostly avatars and badges, so require a real width.
  const recoImages = new Set();
  for (const a of document.querySelectorAll("a[href*='/item?id=']")) {
    for (const img of a.querySelectorAll('img')) {
      if (img.src) recoImages.add(img.src);
    }
  }
  const imageUrls = [];
  let wideOutsideCards = 0;
  for (const img of document.querySelectorAll('img')) {
    if (img.naturalWidth < 200 || !img.src) continue;
    if (recoImages.has(img.src)) continue;
    if (!/\.(alicdn|taobaocdn|alibabacorp|aliyuncs|tbcdn)\./.test(img.src)) continue;
    wideOutsideCards++;
    if (!imageUrls.includes(img.src)) imageUrls.push(img.src);
  }
  const stats = headCompact.match(/来闲鱼\s*([\d.]+)\s*年[^ ]*\s*卖出\s*([\d]+)\s*件宝贝?\s*好评率\s*([\d.]+)%/);

  return {
    requested_item_id: String(itemId),
    // The page's own id, so the caller can check it got the listing it asked for
    // instead of a redirect, a challenge page, or a different item.
    page_item_id: (location.search.match(/[?&]id=([0-9]+)/) || [])[1] || '',
    detail_rendered: /人想要|浏览|立即购买/.test(headCompact),
    title: firstOut(['[class*="main-title"]', '[class*="item-title"]', '[class*="detail-title"]', 'h1']),
    price: priceMatch ? priceMatch[1].replace(/,/g, '') : '',
    want_count: scale(wantMatch),
    browse_count: scale(browseMatch),
    description: (() => {
      for (const s of ['[class*="desc--"]', '[class*="item-desc"]', '[class*="detail-desc"]',
                       '[class*="main-desc"]']) {
        for (const el of document.querySelectorAll(s)) {
          if (!inDetail(el)) continue;
          const txt = clean(el.textContent);
          if (isCounter(txt) || txt.length < 4) continue;
          return txt;
        }
      }
      return '';
    })(),
    seller: firstOut(['[class*="nick"]', '[class*="user-name"]']),
    seller_tenure_years: stats ? stats[1] : '',
    seller_items_sold: stats ? stats[2] : '',
    seller_positive_rate: stats ? stats[3] : '',
    image_urls: imageUrls,
    image_candidates: wideOutsideCards,
    head_preview: headCompact.slice(0, 220),
    reco_anchors: document.querySelectorAll("a[href*='/item?id=']").length,
  };
}
"""

# Anonymous search. goofish decides per page load whether to serve real results or the
# "nothing found, here are recommendations instead" state, and that decision is not
# visible from the client: on a declined load the search API is never even called, so
# the only honest signals are what rendered.
#
# `query_hits` is the guard that matters. The rail is full of unrelated cards, so a
# result set is only believable if some card titles actually contain the query. Handing
# the rail back as matches is the one failure mode that would make this tool lie, so it
# is checked explicitly rather than inferred.
SEARCH_RESULTS_JS = r"""
({ query, limit }) => {
  const sq = (v) => String(v == null ? '' : v).split('\n').join(' ').replace(/ +/g, ' ').trim();
  const text = sq(document.body ? document.body.innerText : '');
  const sel = {
    card: 'a[href*="/item?id="]',
    title: '[class*="row1-wrap-title"], [class*="main-title"]',
    attrs: '[class*="row2-wrap-cpv"] span[class*="cpv--"]',
    priceWrap: '[class*="price-wrap"]',
    priceNum: '[class*="number"]',
    priceDec: '[class*="decimal"]',
    sellerWrap: '[class*="row4-wrap-seller"]',
    sellerText: '[class*="seller-text"]',
  };
  const q = String(query || '').toLowerCase();
  const seen = new Set();
  const items = [];
  let queryHits = 0;
  for (const card of document.querySelectorAll(sel.card)) {
    if (items.length >= limit) break;
    const href = card.href || card.getAttribute('href') || '';
    const id = (href.match(/[?&]id=([0-9]+)/) || [])[1];
    if (!id || seen.has(id)) continue;
    const title = sq(card.querySelector(sel.title)?.textContent || '')
      || sq(card.innerText).slice(0, 90);
    if (!title) continue;
    seen.add(id);
    if (q && title.toLowerCase().indexOf(q) >= 0) queryHits++;
    const priceWrap = card.querySelector(sel.priceWrap);
    const attrs = Array.from(card.querySelectorAll(sel.attrs))
      .map((n) => sq(n.textContent)).filter(Boolean);
    items.push({
      item_id: id,
      title,
      price: sq('¥' + sq(priceWrap?.querySelector(sel.priceNum)?.textContent || '')
                    + sq(priceWrap?.querySelector(sel.priceDec)?.textContent || ''))
              .replace(/^¥\s*$/, ''),
      condition: attrs[0] || '',
      brand: attrs[1] || '',
      city: sq(card.querySelector(sel.sellerWrap)?.querySelector(sel.sellerText)?.textContent || ''),
      url: href,
      matches_query: Boolean(q) && title.toLowerCase().indexOf(q) >= 0,
    });
  }
  return {
    items,
    query_hits: queryHits,
    guess_rail: text.indexOf('猜你喜欢') >= 0 || text.indexOf('为你推荐') >= 0,
    says_no_results: text.indexOf('没有找到你想要的宝贝') >= 0
                 || text.indexOf('未找到相关宝贝') >= 0,
    login_wall_up: document.querySelector('#baxia-dialog-content') !== null,
    rendered: items.length > 0,
    text_preview: text.slice(0, 200),
  };
}
"""

# Scrape the recommendation rail that goofish renders in the DOM ("猜你喜欢" on
# search pages, "为你推荐" on item pages). Anonymous visitors get these even
# though keyword results are withheld.
CARD_SCRAPE_JS = r"""
(limit) => {
  const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
  const sel = {
    card: 'a[href*="/item?id="]',
    title: '[class*="row1-wrap-title"], [class*="main-title"]',
    attrs: '[class*="row2-wrap-cpv"] span[class*="cpv--"]',
    priceWrap: '[class*="price-wrap"]',
    priceNum: '[class*="number"]',
    priceDec: '[class*="decimal"]',
    sellerWrap: '[class*="row4-wrap-seller"]',
    sellerText: '[class*="seller-text"]',
  };
  const items = [];
  const seen = new Set();
  for (const card of document.querySelectorAll(sel.card)) {
    if (items.length >= limit) break;
    const href = card.href || card.getAttribute('href') || '';
    const id = (href.match(/[?&]id=(\d+)/) || [])[1];
    if (!id || seen.has(id)) continue;
    const title = clean(card.querySelector(sel.title)?.textContent || '')
      || clean(card.innerText || '').slice(0, 80);
    if (!title) continue;
    seen.add(id);
    const priceWrap = card.querySelector(sel.priceWrap);
    const attrs = Array.from(card.querySelectorAll(sel.attrs))
      .map((n) => clean(n.textContent || '')).filter(Boolean);
    items.push({
      item_id: id,
      title,
      price: clean('¥' + clean(priceWrap?.querySelector(sel.priceNum)?.textContent || '')
                        + clean(priceWrap?.querySelector(sel.priceDec)?.textContent || ''))
              .replace(/^¥\s*$/, ''),
      condition: attrs[0] || '',
      brand: attrs[1] || '',
      city: clean(card.querySelector(sel.sellerWrap)?.querySelector(sel.sellerText)?.textContent || ''),
      url: href,
      source: 'dom_recommendation',
    });
  }
  const text = document.body?.innerText || '';
  return {
    items,
    rail: /为你推荐/.test(text) ? '为你推荐' : (/猜你喜欢/.test(text) ? '猜你喜欢' : ''),
    saysNoResults: /没有找到你想要的宝贝|未找到相关宝贝|没有找到相关/.test(text),
    loginWallUp: /扫码登录|立即登录/.test(text) && document.querySelector('#baxia-dialog-content') !== null,
  };
}
"""
