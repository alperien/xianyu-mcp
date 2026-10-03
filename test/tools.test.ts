/**
 * The tools, driven by a fake session. No network, no browser.
 *
 * The fake is duck-typed and dispatches on which in-page script was passed to
 * `evaluate`, keyed per script, so a test cannot satisfy one tool with another's payload.
 * What is pinned here is behaviour an invariant scan cannot see: the rail is never
 * returned as results, the budgets stop, and a wrong listing is refused rather than
 * reported. The two navigation tests at the bottom are the exception to all of that --
 * they drop the fake session and drive the real `Session` against a fake Page, because a
 * fake that calls `ensureGoofishUrl` itself only proves the fake is careful.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_URL, exclusive, HOME, reloadFresh, Session, setSession } from '../src/browser.ts';
import { BrowserError, DetailUnavailableError, GatedError, NavigationError, ParseError, SearchUnavailableError, XianyuError } from '../src/errors.ts';
import { FEED_NORMALIZE_JS, ITEM_SCRAPE_JS, MTOP_READY_JS, PAGER_CLICK_JS, SCRAPE_CARDS_JS, SEARCH_INPUT_JS, SEARCH_STATE_JS } from '../src/extract.ts';
import { budget, resetCardCache, TOOLS } from '../src/tools.ts';

const run = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `no tool named ${name}`);
  return t.run;
};

/** A stand-in for the network tap on a page. `feed` hands back each reply once, in order, so a test
 *  can drive the two tools that now read the page's own mtop replies -- `mtop: { detail: {...} }`
 *  makes item_view answer from `mtop.taobao.idle.pc.detail`, `mtop: { search: {...} }` does the same
 *  for search_items -- and can hand back a refusal (`{ ret: 'RGV587_ERROR' }`) as readily as a result. */
const makeTap = (feed: Record<string, any[]> = {}) => {
  const left: Record<string, any[]> = { ...feed };
  return {
    record: () => {},
    // No-op on purpose. The seed models a reply the page is about to make, not a backlog of ones it
    // has already made, and the code calls `clear()` immediately before it provokes the next call --
    // so clearing here would throw away the reply the test is trying to hand over.
    clear: () => {},
    peek: (api: string) => { const l = left[api] ?? []; return l.length ? l[l.length - 1] : null; },
    take: async (api: string) => { const l = left[api] ?? []; return l.length ? l.shift() : null; },
  };
};
const ok = (data: any) => ({ ret: 'SUCCESS::调用成功', ok: true, data });
const refused = (ret: string) => ({ ret, ok: false, data: null });

/** Payloads are keyed by in-page script. `sleepMs` makes the fake's waits cost real time, and `hijack`
 *  moves the page off goofish to that URL: at `hijackAfter: 'open'`, on the first tick after `open`
 *  resolves -- after `open`'s own allowlist check, before the caller's first read, the window the
 *  reviewer read a lookalike host off-site in. At `'read'`, on the first wait *after* a read, which is
 *  item_view's 6s readiness poll and the second read site. */
const makeSession = (payloads: { cards?: any[]; item?: any[]; scrape?: any[]; search?: any; swallow?: number; mtop?: Record<string, any[]> } = {}, raw: any = {}, sleepMs = 0, hijack = '', hijackAfter: 'open' | 'read' = 'open') => {
  const queues: Record<any, any[]> = { [FEED_NORMALIZE_JS as any]: [...(payloads.cards ?? [])], [ITEM_SCRAPE_JS as any]: [...(payloads.item ?? [])], [SCRAPE_CARDS_JS as any]: [...(payloads.scrape ?? [])] };
  // The searchbox, as a real page holds it: mounted or not, with the keys that have landed so far.
  const search = { mounted: 'search' in payloads ? payloads.search !== null : true, value: '' };
  let at = HOME, reads = 0;
  const page: any = {
    url: () => { reads++; return at; },
    waitForTimeout: async () => { if (hijack && hijackAfter === 'read' && reads > 0) at = hijack; if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs)); },
    goto: async (u: string) => { at = u; search.value = ''; },
    // Only what typeSearch needs: the two in-page reads and the two key actions. `keyboard.type`
    // truncates at `swallow` characters to reproduce the SPA eating a burst across a re-render.
    keyboard: {
      type: async (text: string) => { search.value = payloads.swallow ? text.slice(0, payloads.swallow) : text; },
      press: async (key: string) => { if (key === 'Enter' && search.value) at = `${HOME}search?q=${encodeURIComponent(search.value)}`; },
    },
    evaluate: async (fn: any, arg: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      if (fn === SEARCH_INPUT_JS) return search.mounted
        ? { found: true, focused: true, value: search.value, inputs: 1, chars: 1200, path: '/' }
        : { found: false, inputs: 0, chars: 512, path: '/', value: '' };
      if (fn === PAGER_CLICK_JS) { s.pagers.push(String(arg.page)); return { ok: s.max_page >= Number(arg.page), on_page: arg.page }; }
      // The real normaliser, on the rows the tool actually passed. A canned queue cannot express this:
      // how many cards come out of the pool depends on how many pages were walked, which is the thing
      // under test.
      if (fn === FEED_NORMALIZE_JS && s.runRealNormalizer) return FEED_NORMALIZE_JS(arg);
      if (fn === SEARCH_STATE_JS) {
        const onSearch = at.includes('/search');
        return { typed: search.value, path: onSearch ? '/search' : '/', on_search: onSearch, cards: onSearch ? 30 : 0 };
      }
      const q = queues[fn];
      if (!q) return null;   // the gallery nudge, and anything not a scraper
      return q.length > 1 ? q.shift() : q[0];
    },
  };
  const s: any = {
    launches: 0, opened: [] as string[], specs: [] as any[][], raw, search, pagers: [] as string[], max_page: 99, runRealNormalizer: false,
    ensureReady: async () => page,
    domReady: async () => page,
    // The dom page is a separate page from the api page, so the four mtop-only tools never wait on a
    // search; the fake keeps one `page` for both because nothing under test depends on them differing.
    apiTap: makeTap(), domTap: makeTap(payloads.mtop),
    // NOT the real guard: this stand-in records what a tool asked for and loads it, nothing more.
    // The real `Session.open`, and the `ensureGoofishUrl` it runs before and after every goto, is
    // exercised for real in the two navigation tests below, against a fake Page.
    open: async (u: string) => { s.opened.push(u); at = u; search.value = ''; if (hijack && hijackAfter === 'open') queueMicrotask(() => { at = hijack; }); return page; },
    call: async (spec: any) => { s.specs.push(spec); return s.raw; },
  };
  return s;
};

/**
 * A Page fake for the *real* Session, which does touch everything on this object: url, goto,
 * reload, isClosed, waitForTimeout and evaluate. `land` is where a navigation actually ends up, so a
 * redirect off goofish can be simulated, and `start` is what the page is parked on beforehand.
 */
const drivenPage = (opts: { land?: (u: string) => string; start?: string; queues?: Record<any, any[]> } = {}) => {
  let at = opts.start ?? HOME;
  const page: any = {
    url: () => at,
    isClosed: () => false,
    reload: async () => {},
    waitForTimeout: async () => {},
    goto: async (u: string) => { page.calls.push(u); at = opts.land ? opts.land(u) : u; },
    evaluate: async (fn: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      const q = opts.queues?.[fn];
      return q ? (q.length > 1 ? q.shift() : q[0]) : null;
    },
    calls: [] as string[],
  };
  return page;
};
const use = (s: any) => { setSession(s as Session); return s; };

/** A session whose *real* card scraper runs, against a synthetic document. How many cards a tool asks
 *  that scraper for is invisible to a canned payload -- the fake hands over the same handful whatever
 *  the limit is -- so the over-ask fix can only be pinned by executing it. `dialog` puts goofish's
 *  anonymous login overlay on that document: a mask, the passport iframe, and four close controls
 *  wired to a tripwire, so a test can tell whether a read clicked its way out of it. */
const domSession = (titles: string[], at = HOME, dialog = false) => {
  const g = globalThis as any;
  const clicks: string[] = [];
  const close = (label: string) => ({ getBoundingClientRect: () => ({ width: 20, height: 20 }), click: () => clicks.push(label) });
  const overlay: Record<string, any[]> = dialog
    ? { '#baxia-dialog-close': [close('close')], '[class*="closeIcon"]': [close('icon')], '[class*="closeIconBg"]': [close('iconBg')], '[class*="dialog-close"]': [close('dclose')], '[class*="modal-close"]': [close('mclose')], '.ant-modal-mask': [{ getBoundingClientRect: () => ({ width: 1440, height: 900 }) }], 'iframe': [{ src: 'https://passport.goofish.com/iframe' }] }
    : {};
  // A real <input>, so SEARCH_INPUT_JS -- the one in-page function that finds, marks and focuses it --
  // runs for real here rather than being mocked past. The geometry it selects on is >=100px wide in
  // the top 400px, so the fixture has to be the right size or the test measures a search tool aimed at
  // a document with no search box.
  const input: any = { value: '', attrs: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 320, height: 40, top: 60 }), setAttribute(this: any, k: string, v: string) { this.attrs[k] = v; }, focus: () => {}, getAttribute(this: any, k: string) { return this.attrs[k] ?? null; } };
  const cardEls: any[] = titles.map((t, i) => ({
    href: `https://www.goofish.com/item?id=${100 + i}`, innerText: `${t} ¥9`, getAttribute: () => null,
    // the price and seller cells are one level deeper than the title cell, as they are in a real card
    querySelector: (sel: string) => (sel.includes('price') || sel.includes('seller') ? { querySelector: () => ({ textContent: '' }) } : { textContent: t }),
    querySelectorAll: () => [],
  }));
  g.document = {
    body: { innerText: dialog ? '区域 1/50  登录后可查看更多\n联想 X220' : '' },
    activeElement: input,
    querySelector: (s: string): any => (s === 'input' ? input : overlay[s]?.[0] ?? (input.attrs['data-xianyu-search'] ? input : null)),
    querySelectorAll: (sel: string) => (sel === 'input' ? [input] : overlay[sel] ?? (sel === 'a[href*="/item?id="]' ? cardEls : [])),
  };
  // The in-page scripts read `location` and `window` off globalThis and throw without them; a missing
  // global is a TypeError that reads like a product bug, which is how a real one hides.
  g.window = { innerHeight: 900, innerWidth: 1440 };
  let here = at;
  g.location = { get pathname() { return new URL(here).pathname; }, get search() { return new URL(here).search; }, href: here };
  // The typed query really navigates, so SEARCH_STATE_JS answers on_search: true -- otherwise the tool
  // would report a refusal and the test would be measuring the wrong thing entirely.
  const page: any = {
    url: () => here,
    waitForTimeout: async () => {},
    evaluate: async (fn: any, arg: any) => fn(arg),
    keyboard: { type: async (t: string) => { input.value += t; }, press: async (k: string) => { if (k === 'Enter' && input.value) here = `${HOME}search?q=${encodeURIComponent(input.value)}`; } },
  };
  const s: any = { launches: 0, opened: [] as string[], specs: [] as any[][], raw: {}, ensureReady: async () => page, domReady: async () => page,
    apiTap: makeTap(), domTap: makeTap(), open: async (u: string) => { s.opened.push(u); here = u; input.value = ''; return page; }, call: async () => ({}), clicks };
  return use(s);
};

/** A real Session with a fake page bolted in, so `Session.open` -- and the allowlist check it runs
 *  around every goto -- is the thing under test. No Chromium is launched. */
const realSession = (opts: Parameters<typeof drivenPage>[0] = {}) => {
  const s = new Session(), page = drivenPage(opts);
  (s as any).apiPage = page; (s as any).domPage = page;
  use(s);
  return { s, page };
};
// The search-card cache is module state that outlives a call, so it is cleared between tests the same
// way the env budget is: a test that seeds it would otherwise have the next item_view answered from it.
test.afterEach(() => { setSession(null); resetCardCache(); for (const g of ['document', 'location', 'window']) delete (globalThis as any)[g]; for (const k of ['SEARCH', 'ITEM_VIEW', 'RECOMMENDATIONS']) delete process.env[`XIANYU_${k}_BUDGET_S`]; delete process.env.XIANYU_SEARCH_MAX_ITEMS; });

const cards = (ids: string[]) => ({ ok: true, ret: 'SUCCESS::调用成功', data: { cardList: ids.map((id) => ({ cardData: { itemId: id, title: `t${id}`, soldPrice: '5' } })) } });
const listed = (ids: string[]) => ids.map((id) => ({ item_id: id, title: `t${id}`, price: '5', city: '杭州', seller: 'a', want_count: '1', image_urls: [], url: `https://www.goofish.com/item?id=${id}` }));

const RENDERED = { detail_rendered: true, page_item_id: '42', title: '男士羊毛呢大衣', price: '1999', want_count: '2', browse_count: '110', description: '专柜入手。', seller: '汴梁', seller_tenure_years: '4', seller_items_sold: '27', seller_positive_rate: '100', image_urls: ['https://img.alicdn.com/x.jpg'], head_preview: '...', reco_anchors: 30, image_candidates: 4 };
const UNRENDERED = { detail_rendered: false, head_preview: '阿里巴巴集团 淘宝 天猫' };
/** A `mtop.taobao.idlemtopsearch.pc.search` reply, in the shape the page's own call returns: each
 *  result's card is split between `clickParam.args` (the price, the want count, the ids) and
 *  `exContent` (the title, the picture, the city). `cards` is [title, itemId, price, city, wantNum].
 *
 *  `searchCase` returns that payload together with the rows the *real* feed normaliser produces from
 *  it, so a test's `cards:` fake and its mtop reply describe the same thirty listings rather than two
 *  fixtures that happen to agree. */
const searchReply = (keyword: string, cards: string[][]) => ({
  resultList: cards.map(([title, itemId, price, area, wantNum], i) => ({
    data: { item: { main: {
      clickParam: { args: { item_id: itemId, price, wantNum, keyword, index: String(i), page: '1', cCatId: '126854525', catId: '50025387', seller_id: 'jRM3w0UnqSvHrFFMpqPdsQ==', publishTime: '1784640276000' } },
      exContent: { area, detailParams: { itemId, title, soldPrice: price, userNick: '卖家' + i, picUrl: `https://img.alicdn.com/bao/uploaded/i1/${itemId}.jpg`, isVideo: 'false' } },
    } } },
    style: 'card', type: 'item',
  })),
});
const searchCase = (keyword: string, cards: string[][]) => ({
  mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [ok(searchReply(keyword, cards))] },
  rows: cards.map(([title, itemId, price, area, wantNum]) => ({
    item_id: itemId, title, price, city: area, want_count: wantNum, seller: '卖家', image_urls: [`https://img.alicdn.com/bao/uploaded/i1/${itemId}.jpg`],
    url: `https://www.goofish.com/item?id=${itemId}`,
  })),
});
const NEVER_RENDERED = { rendered: false, query_hits: 0, cards_scanned: 0, rail: '', says_no_results: false, blocked: false, text_preview: '阿里巴巴集团 淘宝 天猫', items: [] };
// What goofish serves when it declines: unrelated cards under the 猜你喜欢 rail.
const SEARCH_RAIL = { rendered: true, query_hits: 0, cards_scanned: 40, rail: '猜你喜欢', says_no_results: true, text_preview: '小闲鱼没有找到你想要的宝贝~ 猜你喜欢', items: [{ item_id: '900', title: '木瓜丝广西特产', price: '9', condition: '', brand: '', city: '南宁', url: 'https://www.goofish.com/item?id=900', matches_query: false }] };

test('browse_feed returns ranked, deduped, trimmed listings and an honest per-page report', async () => {
  const s = use(makeSession({ cards: [listed(['1', '2', '3'])] }, { p1: cards(['1', '2']), p2: cards(['2', '3']) }));
  const out = await run('browse_feed')({ pages: 2, limit: 2 });
  assert.equal(s.opened.length, 0, 'the mtop-only path must not navigate');
  assert.deepEqual(out.requested_pages, [1, 2]);
  assert.deepEqual(out.page_reports, [{ page: 1, ok: true, cards: 2 }, { page: 2, ok: true, cards: 2 }]);
  assert.equal(out.account_required, false);
  assert.equal(out.unique_items, 3);
  assert.equal(out.count, 2);
  assert.deepEqual(out.items.map((i: any) => [i.item_id, i.rank]), [['1', 1], ['2', 2]]);
  // the feed call carries a page number and nothing that could be a credential
  assert.deepEqual(s.specs[0][0], ['p1', 'mtop.taobao.idlehome.home.webpc.feed', { pageNumber: 1 }]);
});

test('browse_feed called directly clamps a garbage page number to 1 and pages to the default of 1', async () => {
  const s = use(makeSession({ cards: [listed(['1'])] }, { p1: cards(['1']) }));
  const out = await run('browse_feed')({ page_number: 'abc' as any, pages: -5 as any });
  assert.deepEqual(out.requested_pages, [1]);
  assert.deepEqual(s.specs[0][0][2], { pageNumber: 1 });
  assert.equal(s.specs[0].length, 1, 'pages defaulted to 1');
});

test('a feed refusal is a GatedError naming the real ret; a shape change is a ParseError naming the keys', async () => {
  use(makeSession({ cards: [[]] }, { p1: { ok: false, ret: 'RGV587_ERROR::SM::挤爆啦' } }));
  await assert.rejects(run('browse_feed')({}), (e: any) => e instanceof GatedError && /RGV587/.test(e.message));
  use(makeSession({ cards: [[]] }, { p1: { ok: true, ret: 'SUCCESS', data: { cardList: [{ brandNew: 1 }] } } }));
  await assert.rejects(run('browse_feed')({}), (e: any) => e instanceof ParseError && /brandNew/.test(e.message));
  // one refused page does not throw away the others, and it all went out in one mtop batch
  // a non-list `cardList` used to escape as a raw TypeError from the spread, published as an
  // error_type outside the taxonomy; the empty-list path already says what went wrong
  use(makeSession({ cards: [[]] }, { p1: { ok: true, ret: 'SUCCESS', data: { cardList: { 0: { brandNew: 1 } } } } }));
  await assert.rejects(run('browse_feed')({}), (e: any) => e.constructor.name === 'ParseError' && !/cardList may not be/.test(e.message));
  const s = use(makeSession({ cards: [listed(['1'])] }, { p1: cards(['1']), p2: { ok: false, ret: 'RGV587_ERROR' } }));
  const out = await run('browse_feed')({ pages: 2 });
  assert.equal(out.unique_items, 1);
  assert.deepEqual(out.page_reports[1], { page: 2, ok: false, ret: 'RGV587_ERROR' });
  assert.equal(s.specs.length, 1);
});

test('search_items never hands back the recommendation rail as results', async () => {
  const s = use(makeSession({ scrape: [SEARCH_RAIL, SEARCH_RAIL, SEARCH_RAIL] }));
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 3 }), (e: any) => {
    assert.ok(e instanceof SearchUnavailableError);
    assert.equal(e.message.includes('木瓜丝'), false, 'a rail card title leaked into the refusal');
    // The refusal must name the rail and the evidence, not the mechanism that produced it. The old
    // wording ("declined per page load") described direct-URL navigation, which the searchbox rewrite
    // replaced; what still has to be true is that the rail was seen, and refused.
    assert.match(e.message, /"rail":"猜你喜欢"/);
    return true;
  });
  assert.equal(s.opened.length, 3, 'it retried with fresh loads before giving up');
  await assert.rejects(run('search_items')({ query: '   ' }), XianyuError);

  // A markerless page of 40 cards with a short numeric query, where one title contains "1" by
  // accident: `hits > 0` accepted that, so an agent was told "40 results for 1". The denominator is
  // every card on the page, not the cards we kept, and 20% of 40 is 8. (A *dense* incidental hit
  // count -- 12 of 40 -- still passes a fraction test; what catches that one is the rail marker it
  // was under, which is why both scrapers now take the same marker list.)
  const railish = (hits: number, cards: number) => ({ rendered: true, cards_scanned: cards, rail: '', says_no_results: false, text_preview: '小闲鱼', query_hits: hits, items: Array.from({ length: cards }, (_, i) => ({ item_id: String(900 + i), title: i < hits ? 'iPhone 15 Pro 1TB' : '木瓜丝 广西特产', price: '9', condition: '', brand: '', city: '南宁', url: 'u', matches_query: i < hits })) });
  const weak = use(makeSession({ scrape: [railish(1, 40)] }));
  await assert.rejects(run('search_items')({ query: '1', attempts: 1 }), (e: any) => e instanceof SearchUnavailableError && /"min_query_hits":8/.test(e.message));
  assert.equal(weak.opened.length, 1);
  // and the same page is accepted once enough of it really matches
  const strong = use(makeSession({ scrape: [railish(20, 40)] }));
  assert.equal((await run('search_items')({ query: '1', attempts: 1 })).count, 20);
  assert.equal(strong.opened.length, 1);
});

test('search_items accepts a later load that serves real matches, counts only the matches, and logs the decline that came first', async () => {
  // 3 of 4 cards on this page carry the query; the fourth is a card that merely got scraped.
  const page = { rendered: true, cards_scanned: 4, rail: '', says_no_results: false, text_preview: 'x220', query_hits: 3, token_hits: 3, items: [
    { item_id: '1', title: '联想X220 电池', price: '300', condition: '', brand: '', city: '北京', url: 'u1', matches_query: true },
    { item_id: '2', title: 'X220 屏幕总成', price: '200', condition: '', brand: '', city: '北京', url: 'u2', matches_query: true },
    { item_id: '3', title: 'x220 主板 2620m', price: '180', condition: '', brand: '', city: '上海', url: 'u3', matches_query: true },
    { item_id: '4', title: 'ThinkPad 键盘', price: '50', condition: '', brand: '', city: '广州', url: 'u4', matches_query: false }] };
  use(makeSession({ scrape: [SEARCH_RAIL, page] }));
  const out = await run('search_items')({ query: 'x220', attempts: 2 });
  assert.equal(out.source, 'search_page_dom');
  // count is a match count, so an agent cannot report "4 X220 listings" for 3
  assert.deepEqual([out.count, out.query_hits, out.items.length], [3, 3, 3]);
  assert.deepEqual([out.scraped_cards, out.non_matching_count, out.min_query_hits], [4, 1, 1]);
  assert.ok(out.items.every((i: any) => i.matches_query));
  // and no card calls itself a recommendation
  assert.equal('source' in out.items[0], false);
  // The declined first attempt is in the log. Index 0 is the typed-search step rather than the
  // scrape, since the searchbox path logs that too; the scrape entry is the one carrying `rendered`.
  const declined = out.attempt_log.find((e: any) => 'rendered' in e);
  assert.deepEqual({ rendered: declined.rendered, rail: declined.rail, query_hits: declined.query_hits }, { rendered: true, rail: '猜你喜欢', query_hits: 0 });
  assert.equal(out.attempt_log[0].via, 'searchbox', 'the first attempt typed the query rather than navigating to a URL');
});

test('search_items over-asks the scraper, so leading non-matching cards cannot fake an empty result set', async () => {
  // 200 cards, the first five unrelated, limit 5. The collector used to stop at `limit` and the tool
  // then filtered to matches, so every collected card was discarded and the tool reported a
  // successful, empty, self-contradicting answer next to query_hits 195 and scraped_cards 200.
  const mixed = (n: number, lead: number) => Array.from({ length: n }, (_, i) => (i < lead ? '木瓜丝广西特产' : `联想 X220 键盘 ${i}`));
  domSession(mixed(200, 5));
  const out = await run('search_items')({ query: 'x220', limit: 5, attempts: 1 });
  assert.deepEqual([out.count, out.items.length, out.query_hits, out.scraped_cards, out.min_query_hits], [5, 5, 195, 200, 40]);
  assert.ok(out.items.every((i: any) => i.matches_query && /X220/.test(i.title)), 'only real matches came back');
  assert.deepEqual(out.items.map((i: any) => i.rank), [1, 2, 3, 4, 5]);
  // limit 1 on a mildly mixed page, which the same bug emptied
  domSession(mixed(12, 3));
  assert.deepEqual(Object.values(await run('search_items')({ query: 'x220', limit: 1, attempts: 1 })).filter((v) => typeof v === 'number').includes(1), true);

  // A pasted query with a double space matched nothing at all before the query was whitespace-
  // collapsed, which is a refusal on a page full of real matches.
  domSession(Array.from({ length: 10 }, (_, i) => `联想 X220 键盘 ${i}`));
  const spaced = await run('search_items')({ query: 'x220  键盘', limit: 3, attempts: 1 });
  assert.deepEqual([spaced.count, spaced.query], [3, 'x220 键盘']);

  // A multi-word query whose words all appear but never as one substring. This used to be refused --
  // "the strict guard stands" -- and refusing it is what made the tool useless on this site, where a
  // search for `机械硬盘4t` has 70,146 listings by goofish's own counter and the titles read
  // `西数4T机械硬盘`. All the terms are there; only the searcher's word order is not. Accepted now,
  // and `matched_by` says which rule did it so a caller is not left guessing.
  domSession(Array.from({ length: 8 }, (_, i) => `联想 X220 键盘 ${i}`));
  const reordered = await run('search_items')({ query: '键盘 x220 联想', attempts: 1 });
  assert.equal(reordered.count, 8);
  assert.equal(reordered.query_hits, 0, 'no title carries the phrase');
  assert.equal(reordered.token_hits, 8, 'all eight carry every term');
  assert.equal(reordered.matched_by, 'all_terms', 'and the envelope says the phrase was not the match');

  // ...and the guard still has teeth: a page carrying only some of the terms is a rail, not results.
  domSession(Array.from({ length: 8 }, (_, i) => `机械硬盘 台式机内存条 ${i}`));
  await assert.rejects(run('search_items')({ query: '机械硬盘4t', attempts: 1 }), (e: any) => e instanceof SearchUnavailableError
    && /"query_hits":0/.test(e.message) && /"token_hits":0/.test(e.message) && /"scraped_cards":8/.test(e.message) && /\b1 attempt\(s\)/.test(e.message));
});

test('every DOM read re-checks the URL first, so a page moved off goofish mid-call is refused', async () => {
  // The reviewer's exploit: `open` checks the URL it landed on, then the tool polls for seconds before
  // it reads anything, and the page can be moved off-site in that window. These payloads are all
  // individually acceptable, so only the host can refuse them.
  const EVIL = { rendered: true, cards_scanned: 1, query_hits: 1, token_hits: 1, rail: '', says_no_results: false, text_preview: 'evil', items: [{ item_id: '666', title: '数据来自 evil.com', price: '1', condition: '', brand: '', city: '', url: 'u', matches_query: true }] };
  use(makeSession({ scrape: [EVIL] }));
  assert.equal((await run('search_items')({ query: 'evil', attempts: 1 })).items[0].item_id, '666', 'the payload itself is fine -- it is the host that is not, so the test is not vacuous');
  for (const host of ['https://www.goofish.com.evil.com/', 'https://www.goofish.computer/', 'https://www.goofish.com@evil.com/']) {
    use(makeSession({ scrape: [EVIL] }, {}, 0, host));
    await assert.rejects(run('search_items')({ query: 'evil', attempts: 1 }), (e: any) => e instanceof NavigationError, host);
    // RENDERED on purpose: the page would otherwise be accepted, so only the host can be refusing
    use(makeSession({ item: [RENDERED] }, {}, 0, host));
    await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof NavigationError, host);
    // and the second read site: item_view polls for up to 6s between reads, so the swap lands in there
    use(makeSession({ item: [UNRENDERED] }, {}, 0, host, 'read'));
    await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof NavigationError, host);
  }
});

test('the budget arithmetic: 45s default, overridable, floored at 5 and capped at 600, garbage falls back', () => {
  assert.equal(budget('SEARCH', 45), 45);
  // anything that is not a whole number of seconds falls back rather than raising, and the ceiling
  // is what stops XIANYU_SEARCH_BUDGET_S=86400 from restoring the hang this function exists to stop
  for (const [raw, want] of [['12', 12], ['1', 5], ['900', 600], ['86400', 600], ['1e3', 600], ['nonsense', 45], ['', 45], ['  ', 45], ['12.5', 45]] as const) {
    process.env.XIANYU_SEARCH_BUDGET_S = raw;
    assert.equal(budget('SEARCH', 45), want, `XIANYU_SEARCH_BUDGET_S=${JSON.stringify(raw)}`);
  }
});

test('search_items reads results out from under the login dialog, and never clicks to get them', async () => {
  // The bug this pins. Measured headed, same URL, one fresh context per arm: with nothing dismissed
  // the cards were in the DOM by t+12s (30 anchors, real X220 matches) *under* the ant-modal-mask and the
  // passport iframe; dismissing at t+6s or t+12s clicked 4 close controls and the result list then
  // never rendered at all, at any subsequent sample, and the 猜你喜欢 rail was served instead. The
  // comment in the source claimed the opposite ("must be closed or the page renders zero cards"), the
  // whole retry design was built on it, and search declined on ~100% of attempts because of it.
  //
  // The dialog is here, with its four close controls wired to a tripwire. The read has to succeed and
  // the tripwire has to stay quiet -- either half alone would miss the failure mode, since a page
  // that clicked its way out is a page whose results we can no longer trust.
  const titles = Array.from({ length: 12 }, (_, i) => `联想 ThinkPad X220 ${i}`);
  const s = domSession(titles, HOME, true);
  const out = await run('search_items')({ query: 'x220', limit: 5, attempts: 1 });
  assert.deepEqual([out.count, out.query_hits, out.scraped_cards], [5, 12, 12]);
  assert.ok(out.items.every((i: any) => i.matches_query && /X220/.test(i.title)), 'the matches came out of the page, not out of a rail');
  assert.equal(out.attempt_log.find((e: any) => 'rendered' in e).blocked, false, 'a page under the dialog is not a risk-control page');
  assert.deepEqual(s.clicks, [], 'the read path clicked the dialog -- the state it used to trigger');

  // The tripwire has teeth: a document whose close controls are the only way its cards appear cannot
  // be satisfied by reading, so a passing result above is not the fixture agreeing with itself.
  assert.equal(domSession([], HOME, true).clicks.length, 0, 'nothing in the fixture clicks by itself');

  // And the same page *is* accepted when there is no dialog at all -- so the dialog is genuinely
  // irrelevant to the outcome, rather than the test passing for some other reason.
  const bare = domSession(titles, HOME, false);
  assert.equal((await run('search_items')({ query: 'x220', limit: 5, attempts: 1 })).count, 5);
  assert.equal(bare.clicks.length, 0);
});

test('a wall-clock budget stops search_items instead of letting it hold the caller', async () => {
  // This one really waits: the page never renders, so the tool polls until its 5s budget
  // (the floor) is spent and then gives up rather than reloading again.
  const s = use(makeSession({ scrape: [NEVER_RENDERED] }, {}, 700));
  process.env.XIANYU_SEARCH_BUDGET_S = '5';
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 10 }), (e: any) => {
    assert.ok(e instanceof SearchUnavailableError);
    // and it does not claim zero attempts after a real page load, which is what the clock-break used
    // to do: it pushed a marker with no `attempt` on it and the count filtered on that field
    // The count and the clock are asserted separately. The old regex ran them together
    // ("1 attempt(s) in 6s"), which only ever held because the elapsed time was interpolated
    // between the two words -- an assertion about message layout, not about the budget stopping it.
    assert.match(e.message, /\b1 attempt\(s\)/);
    assert.match(e.message, /in \d+s/);
    assert.match(e.message, /stopped on: time budget reached/);
    return true;
  });
  assert.equal(s.opened.length, 1, 'it stopped on the clock, not on the attempt count');

  // The same clock has to bind the *page load* failure path. A `continue` past the deadline check
  // meant a network that cannot reach goofish at all ran all ten attempts, and at the real 60s nav
  // timeout that is minutes against a 45s promise.
  const dead = use(makeSession({ scrape: [NEVER_RENDERED] }));
  let opens = 0;
  dead.open = async () => { opens++; await new Promise((r) => setTimeout(r, 700)); throw new BrowserError('net::ERR_ADDRESS_UNREACHABLE'); };
  process.env.XIANYU_SEARCH_BUDGET_S = '5';
  const began = Date.now();
  await assert.rejects(run('search_items')({ query: 'x220', attempts: 10 }), (e: any) => e instanceof SearchUnavailableError && /ERR_ADDRESS_UNREACHABLE/.test(e.message));
  const spent = Date.now() - began;
  assert.ok(opens < 10 && spent < 9000, `${opens} page loads in ${spent}ms: the budget did not bind the load-failure path`);
});

test('item_view answers from the page\'s own detail reply, with the fields the DOM could not reach', async () => {
  // This is the reply `mtop.taobao.idle.pc.detail` returns when the *page* makes the call, captured
  // off the wire. The DOM route could not produce a title at all (measured: empty on 6 of 6 live
  // listings) and returned goofish's promo banners as the gallery.
  const s = use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({
    itemDO: {
      itemId: '42', title: '腾亚40C瓦斯钉抢，功能正常使用', soldPrice: '366', originalPrice: '0',
      desc: '刚保养清洗干净，收到就可以用', wantCnt: 1, browseCnt: 34, collectCnt: 2, quantity: 1,
      itemStatusStr: '在线', transportFee: '0.00',
      imageInfos: [{ url: 'http://img.alicdn.com/bao/uploaded/i1/4197327154/a.jpg' }, { url: 'http://img.alicdn.com/bao/uploaded/i1/4197327154/b.jpg' }],
      cpvLabels: [{ propertyName: '品牌', valueName: 'Toua/腾亚' }, { propertyName: '成色', valueName: '明显使用痕迹' }, { propertyName: '已用年限', valueName: '1年(含)-3年(不含)' }],
    },
    sellerDO: { nick: '今生有缘xy', city: '台州', userRegDay: 2256, hasSoldNumInteger: 369, itemCount: 655, newGoodRatioRate: '80%', replyRatio24h: '97%', signature: '二手电动工具，', zhimaAuth: true, portraitUrl: 'http://gtms03.alicdn.com/a.png', lastVisitTime: '3小时前来过' },
  })] } }));
  const out = await run('item_view')({ item_id: '42' });
  assert.equal(out.source, 'item_detail_api');
  assert.equal(out.title, '腾亚40C瓦斯钉抢，功能正常使用', 'the field the DOM could never fill');
  assert.equal(out.price, '366');
  assert.equal(out.want_count, '1'); assert.equal(out.browse_count, '34');
  assert.equal(out.description, '刚保养清洗干净，收到就可以用');
  assert.equal(out.seller, '今生有缘xy');
  assert.equal(out.seller_tenure_years, '6', 'userRegDay is in days: 2256 days is 6 years');
  assert.equal(out.seller_items_sold, '369');
  assert.equal(out.seller_positive_rate, '80');
  assert.deepEqual(out.fields_missing, [], 'every promised field is present on this payload');
  // the seller's own photos, https-normalised, not a promo banner
  assert.deepEqual(out.image_urls, ['https://img.alicdn.com/bao/uploaded/i1/4197327154/a.jpg', 'https://img.alicdn.com/bao/uploaded/i1/4197327154/b.jpg']);
  // and the fifteen-odd fields the DOM never exposed
  assert.equal(out.brand, 'Toua/腾亚');
  assert.equal(out.condition, '明显使用痕迹');
  assert.equal(out.used_years, '1年(含)-3年(不含)');
  assert.equal(out.seller_city, '台州');
  assert.equal(out.seller_signature, '二手电动工具，');
  assert.equal(out.seller_reply_rate_24h, '97');
  assert.equal(out.seller_items_listed, '655');
  assert.equal(out.collect_count, '2');
  assert.equal(out.seller_zhima_verified, true);
  assert.equal(out.seller_avatar, 'https://gtms03.alicdn.com/a.png');
  assert.equal(out.item_status, '在线');
  assert.deepEqual(Object.entries(out.attributes).map(([k, v]) => `${k}=${v}`), ['品牌=Toua/腾亚', '成色=明显使用痕迹', '已用年限=1年(含)-3年(不含)']);
  // the page was still loaded: that is where the call comes from
  assert.deepEqual(s.opened, ['https://www.goofish.com/item?id=42']);
});

test('item_view refuses a detail reply about a different listing, and reports a refusal as a refusal', async () => {
  // The page decides which listing to render. An answer about another id is not a partial success.
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({ itemDO: { itemId: '999', title: '别人的东西', soldPrice: '1' }, sellerDO: {} })] } }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof DetailUnavailableError && /instead of 42/.test(e.message));
  // goofish's own code is quoted rather than summarised: RGV587 is an IP throttle and says nothing
  // about whether the listing exists, and a reader cannot tell those apart without it.
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [refused('RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!')] } }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof DetailUnavailableError && /RGV587/.test(e.message));
});

test('a browser close that hangs is bounded and escalated, and never orphans the process', async () => {
  // This runs on the way out of the server, and a `close()` that hangs -- an evaluate in flight
  // against a page that has stopped answering -- used to leave a windowed Chromium running after the
  // process had exited, invisible to the client that had already gone. Measured: one to two orphaned
  // browser processes per session.
  const s = new Session();
  const killed: string[] = [];
  const browser: any = {
    close: () => new Promise(() => {}),                    // never settles
    process: () => ({ exitCode: null, killed: false, kill: (sig: string) => killed.push(sig) }),
  };
  (s as any).browser = browser;
  (s as any).context = { close: async () => { throw new Error('target closed'); } };
  const began = Date.now();
  await s.close();
  const spent = Date.now() - began;
  assert.ok(spent < 8000, `close() took ${spent}ms: a hung close holds the process open`);
  assert.deepEqual(killed, ['SIGKILL'], 'a browser that would not close is killed, not left running');
  // and it is idempotent: the signal path and the exit path can both reach it
  await s.close();
  assert.equal(killed.length, 1, 'the second close did not kill an already-closed browser again');
  // `killBrowser` is the synchronous half, for the paths where there is no event loop left to await:
  // a `process.on('exit')` hook, and a teardown that was cut short. It must tolerate a browser that is
  // already gone rather than throwing on the way out of the process.
  const gone = new Session();
  (gone as any).browser = { process: () => { throw new Error('the connection is already closed'); } };
  assert.doesNotThrow(() => gone.killBrowser());
  assert.equal(gone.browserProcess(), null);
});

test('concurrent mtop calls launch and park the browser once, and never navigate it twice at once', async () => {
  // The mtop-only tools stopped queueing behind the DOM tools, so they now genuinely arrive together
  // -- and two `page.goto`s on one page abort each other, which is a `net::ERR_ABORTED` out of a
  // perfectly healthy browser. This drives the real `Session` against a fake page that throws if it
  // is navigated while a navigation is still in flight, which is exactly what two racing callers did.
  const s = new Session();
  const inFlight: string[] = [];
  const page: any = {
    url: () => (inFlight.length ? '' : 'https://www.goofish.com/x'),
    isClosed: () => false,
    reload: async () => {},
    waitForTimeout: async () => {},
    goto: async (u: string) => {
      if (inFlight.length) throw new Error(`ERR_ABORTED: navigated while ${inFlight[0]} was still loading`);
      inFlight.push(u);
      await new Promise((r) => setTimeout(r, 20));
      inFlight.pop();
    },
    evaluate: async (fn: any, arg: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      // answer whatever was asked for, so the tools under test see a working client
      if (Array.isArray(arg?.calls)) return Object.fromEntries(arg.calls.map(([label, api]: any) => [label, { ret: 'SUCCESS', ok: true, data: api.includes('hitnum') ? { hitnum: 28800 } : api.includes('suggest') ? { items: [], totalCount: 0 } : { cardList: [] } }]));
      return {};
    },
  };
  (s as any).apiPage = page; (s as any).domPage = page;
  use(s);
  const [a, b, c] = await Promise.all([
    run('search_count')({ query: 'x220' }),
    run('search_count')({ query: 'ipad' }),
    run('search_suggest')({ query: 'thinkpad' }),
  ]);
  // none of them raised, and none of them navigated while another was in flight
  assert.equal(a.match_count + b.match_count + c.total_count >= 0, true);
  assert.deepEqual(inFlight, []);
});

test('item_view reads the page for a listing a search already returned, and falls back to the card', async () => {
  // Searching and then opening a result is the ordinary sequence. The page is still read, because
  // the detail call is 4-10s and carries a dozen fields the card does not -- short-circuiting on the
  // cache would have bought nothing and thrown them away. The card is what is left when the page
  // will not answer, which is what a sold or removed listing looks like.
  const c = searchCase('x220', [['联想Thinkpad X220 笔记本电脑', '856961429564', '329', '北京', '5']]);
  use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  // the search itself seeds the card cache, which is the state under test here
  const found = await run('search_items')({ query: 'x220', limit: 5 });
  assert.equal(found.source, 'search_api');
  assert.equal(found.items[0].item_id, '856961429564');
  assert.equal(found.items[0].want_count, '5', 'the search reply carries a want count the DOM card never showed');
  assert.equal(found.items[0].city, '北京', 'and the city, and the image');
  assert.ok(found.items[0].image_urls.length, 'and an image');

  // the page answers, and the answer is the detail block, not the card
  use(makeSession({ item: [UNRENDERED], mtop: { 'mtop.taobao.idle.pc.detail': [ok({ itemDO: { itemId: '856961429564', title: '联想Thinkpad X220 笔记本电脑', soldPrice: '329', wantCnt: 5, browseCnt: 900, desc: '成色好' }, sellerDO: { nick: '卖家', city: '北京', hasSoldNumInteger: 12, userRegDay: 730, newGoodRatioRate: '99%' } })] } }));
  const out = await run('item_view')({ item_id: '856961429564' });
  assert.equal(out.source, 'item_detail_api');
  assert.equal(out.seller, '卖家');
  assert.equal(out.browse_count, '900');

  // the page will not answer: then, and only then, the card this process already holds answers
  use(makeSession({ item: [UNRENDERED, UNRENDERED, UNRENDERED] }));
  const fallback = await run('item_view')({ item_id: '856961429564' });
  assert.equal(fallback.source, 'search_card_cache');
  assert.equal(fallback.title, '联想Thinkpad X220 笔记本电脑');
  assert.ok(fallback.page_attempts > 0, 'the page really was tried first');
  // a card is not a detail block, and does not pretend to be one
  assert.ok(fallback.fields_missing.includes('description'));
  assert.ok(fallback.fields_missing.includes('browse_count'));
  assert.match(fallback.note, /earlier search in this session/);
});

test('search_items answers from the page\'s own search reply, and holds it to the same relevance guard', async () => {
  // 30 results, 26 of which really contain the query.
  const cards = Array.from({ length: 30 }, (_, i) => [`联想Thinkpad X220 笔记本 ${i}`, String(856961429564 + i), String(100 + i), '北京', '3']);
  cards.push(['完全无关的自行车', '999', '1', '上海', '0']);
  const c = searchCase('thinkpad x220', cards);
  const s = use(makeSession({ cards: [c.rows], mtop: c.mtop }));
  const out = await run('search_items')({ query: 'thinkpad x220', limit: 10 });
  assert.equal(out.source, 'search_api');
  assert.equal(out.count, 10, 'limit still applies to a 30-result reply');
  assert.equal(out.scraped_cards, 31, 'the guard is over every result, not the ten kept');
  assert.equal(out.query_hits, 30);
  assert.equal(out.non_matching_count, 1);
  assert.ok(out.items.every((i: any) => /X220/.test(i.title)), 'only real matches came back');
  assert.ok(out.items.every((i: any) => i.want_count && i.city && i.image_urls.length), 'and each carries the card fields the DOM scrape lost');
  assert.equal(out.attempts, 1);
  assert.deepEqual(s.opened, ['https://www.goofish.com/'], 'one page load: the reply answers it');
});

test('search_items refuses a search reply that is really the recommendation rail', async () => {
  // A declined anonymous search answers SUCCESS with 30 recommendations and no matches. A `hits > 0`
  // test would pass that; a fraction over the whole reply does not, and the DOM fallback still runs.
  const cards = Array.from({ length: 30 }, (_, i) => [`推荐商品 ${i}`, String(1000 + i), '5', '北京', '0']);
  const c = searchCase('thinkpad x220', cards);
  use(makeSession({ cards: [c.rows], scrape: [{ items: [], cards_scanned: 0, rendered: false, rail: '猜你喜欢' }], mtop: c.mtop }));
  await assert.rejects(run('search_items')({ query: 'thinkpad x220', attempts: 1, limit: 5 }), (e: any) => e instanceof SearchUnavailableError);
});

test('the four mtop-only tools do not queue behind a search on the shared page', async () => {
  // One page meant a 70s search held up a feed call that does 1.5s of work. The api page and the dom
  // page are separate, and only the dom tools take the exclusive lock.
  //
  // This used to call `run('search_items')` inside its own `exclusive()` and assert the lock, which
  // proved nothing about the shipped server: the entry point wrapped every tool in `exclusive()`, so
  // the four mtop tools queued behind a search anyway, and this test never saw it. The lock now lives
  // on the tools themselves, so the calls below go through `TOOLS[i].run` exactly as index.ts invokes
  // them -- no hand-wrapping -- and still do not queue.
  const c = searchCase('x220', [['联想 X220 笔记本电脑', '4242', '99', '北京', '1']]);
  const s = use(makeSession({ cards: [c.rows], mtop: c.mtop }, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 28800 } } }));
  let searchDone = false;
  // `search_items` is registered locked, so this call takes the lock itself -- exactly as the entry
  // point now does, because index.ts no longer wraps anything.
  const searching = run('search_items')({ query: 'x220', limit: 1 }).then(() => { searchDone = true; });
  // not locked: this is the point -- an mtop-only call does not take the lock at all
  const counted = await run('search_count')({ query: 'x220' });
  assert.equal(counted.match_count, 28800);
  assert.equal(searchDone, false, 'the search is still running, and the count did not wait for it');
  await searching;
  assert.equal(searchDone, true);
  // and two DOM tools at once still serialise, because they share the one navigating page
  let order: string[] = [];
  const slow = exclusive(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end'); });
  const fast = exclusive(async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  assert.equal(s.launches, 0);
});

test('the lock is on the three DOM tools and nowhere else, through the registered tool table', async () => {
  // The regression guard for the defect above, stated about the tool table itself rather than about
  // one hand-wrapped call. Which tools take the shared-page lock is a contract with index.ts -- it
  // must not wrap them again, or the four fast tools queue behind every slow one -- so assert it here.
  const LOCKED = ['search_items', 'item_view', 'recommendations'];
  const free = TOOLS.filter((t) => !LOCKED.includes(t.name)).map((t) => t.name);
  assert.deepEqual(free.sort(), ['browse_feed', 'capabilities', 'related_items', 'search_count', 'search_suggest']);
  // `capabilities` is deliberately free: it only reads, never navigates, and it is the tool an agent
  // calls when something else is stuck -- queueing it behind the stuck search would be perverse.
  // Proof by behaviour: an mtop call in flight while a DOM call holds the lock still answers.
  const c = searchCase('x220', [['联想 X220 笔记本电脑', '4242', '99', '北京', '1']]);
  const s = use(makeSession({ cards: [c.rows], mtop: c.mtop }, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 28800 } } }));
  let released = false;
  const domHeld = exclusive(async () => { await new Promise((r) => setTimeout(r, 25)); released = true; });
  const count = await run('search_count')({ query: 'x220' });   // must not wait for the held lock
  assert.equal(released, false, 'the count answered while the lock was held -- it does not queue');
  assert.equal(count.match_count, 28800);
  await domHeld;
  assert.equal(released, true);
});

test('search_items walks the pager for more pages, and the guard runs over the whole pooled set', async () => {
  // One reply is 30 listings and the search API cannot be re-issued, so the page's own pager is the
  // only way deeper. Three replies of 10, pooled, and the guard has to judge all thirty at once --
  // judging page 3 on its own could throw away two good pages.
  const page = (n: number, titles: string[]) => ok(searchReply('x220', titles.map((t, i) => [t, String(n * 100 + i), '50', '北京', '1'])));
  const t1 = Array.from({ length: 10 }, (_, i) => `联想 X220 键盘 ${i}`);
  const t2 = Array.from({ length: 10 }, (_, i) => `ThinkPad X220 笔记本 ${i}`);
  const t3 = Array.from({ length: 10 }, (_, i) => `X220 屏幕 ${i}`);
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [page(1, t1), page(2, t2), page(3, t3)] } }));
  s.runRealNormalizer = true;
  // `limit` 100 against 30 available listings: the pool is short, so the walk tops up past the three
  // pages asked for, and stops when the pager runs out of replies. Measured live, this is what makes
  // `pages: 2` return 55 matches one run and 25 the next without either being a silent shortfall.
  const deep = await run('search_items')({ query: 'x220', pages: 3, limit: 100, attempts: 1 });
  assert.equal(deep.source, 'search_api');
  assert.equal(deep.pages_fetched, 3, 'three pages were pooled, not one');
  assert.equal(deep.scraped_cards, 30, 'and the guard saw all thirty');
  assert.deepEqual(s.pagers, ['2', '3', '4'], 'the third page left the pool short of limit, so it walked one more');
  assert.ok(deep.count > 0);

  // And the other half: a pool that already satisfies `limit` does not walk past what was asked for.
  const s2 = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [page(1, t1), page(2, t2), page(3, t3)] } }));
  s2.runRealNormalizer = true;
  const exact = await run('search_items')({ query: 'x220', pages: 2, limit: 10, attempts: 1 });
  assert.equal(exact.pages_fetched, 2);
  assert.deepEqual(s2.pagers, ['2'], 'ten of the first page\'s ten was enough, so no top-up');
});

test('search_items stops walking when the pager has no such page, and says why', async () => {
  // A real pager runs out at page 10 (`1..10 ... 50`) and a declined one may not be there at all.
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [ok(searchReply('x220', Array.from({ length: 12 }, (_, i) => [`联想 X220 ${i}`, String(i), '50', '北京', '1'])))] } }));
  s.runRealNormalizer = true;
  s.max_page = 1;   // the page offers nothing beyond what we have
  const out = await run('search_items')({ query: 'x220', pages: 5, limit: 20, attempts: 1 });
  assert.equal(out.pages_fetched, 1, 'one page, and the walk did not invent the rest');
  assert.deepEqual(s.pagers, ['2']);
  const stopped = out.attempt_log.find((e: any) => e.pager && e.ok === false);
  assert.equal(stopped.pager, 2, 'and the refusal is in the log, with the page it stopped on');
});

test('the deeper walk stops at XIANYU_SEARCH_MAX_ITEMS, and the rail is still never returned as results', async () => {
  // Full-depth pages on offer (99), and a call that asks for everything: pages 10, limit 300.
  // With XIANYU_SEARCH_MAX_ITEMS=60 the walk must stop after two pages -- one page of 30 per 30 of
  // the cap -- rather than climbing to ten, and it must do so without another page load: one warm
  // search, then pager clicks only.
  const pgs = (n: number) => ok(searchReply('x220', Array.from({ length: 30 }, (_, i) => [`联想 X220 ${n}-${i}`, String(n * 100 + i), '50', '北京', '1'])));
  process.env.XIANYU_SEARCH_MAX_ITEMS = '60';
  const s = use(makeSession({ mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [pgs(1), pgs(2), pgs(3), pgs(4)] } }));
  s.runRealNormalizer = true;
  const capped = await run('search_items')({ query: 'x220', pages: 10, limit: 300, attempts: 1 });
  assert.deepEqual(s.pagers, ['2'], 'the walk stopped at the cap, not at the pager');
  assert.equal(capped.pages_fetched, 2);
  assert.equal(capped.scraped_cards, 60, 'the guard pooled exactly the two capped pages');
  assert.ok(capped.count <= 60, 'limit itself is clamped by the cap');
  assert.equal(s.opened.length, 1, 'one page load; the deeper walk rides the shared page, no extra launches');

  // The cap does not weaken the relevance guard: a search reply that is really the recommendation
  // rail is still refused as results, end to end, through the same walk.
  delete process.env.XIANYU_SEARCH_MAX_ITEMS;
  const railReply = ok(searchReply('x220', Array.from({ length: 30 }, (_, i) => [`推荐商品 ${i}`, String(2000 + i), '5', '北京', '0'])));
  const railDom = { rendered: true, query_hits: 0, cards_scanned: 40, rail: '猜你喜欢', says_no_results: true, text_preview: '猜你喜欢', items: [] };
  use(makeSession({ scrape: [railDom], mtop: { 'mtop.taobao.idlemtopsearch.pc.search': [railReply, railReply] } }));
  await assert.rejects(run('search_items')({ query: 'x220', pages: 3, attempts: 1 }), (e: any) => e instanceof SearchUnavailableError && /"rail":"猜你喜欢"/.test(e.message));
});

test('the `detail` argument reads the top N in full, and reports which ones it could not', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => [`联想 X220 ${i}`, String(300 + i), String(100 + i * 10), '北京', '2']);
  const c = searchCase('x220', rows);
  // the detail reply comes back for three of the four requested, and the fourth is refused
  const detail = (id: string) => ok({ itemDO: { itemId: id, title: `详情 ${id}`, soldPrice: '123', wantCnt: 4, browseCnt: 900, desc: '成色好，功能正常' }, sellerDO: { nick: '卖家', city: '北京', hasSoldNumInteger: 12, userRegDay: 730, newGoodRatioRate: '99%' } });
  // one tap for both: the search reply that produces the cards, and the detail replies that deepen them
  use(makeSession({ cards: [c.rows], mtop: {
    'mtop.taobao.idlemtopsearch.pc.search': c.mtop['mtop.taobao.idlemtopsearch.pc.search'],
    'mtop.taobao.idle.pc.detail': [detail('300'), detail('301'), detail('302'), refused('RGV587_ERROR::SM::哎哟喂')],
  } }));
  const out = await run('search_items')({ query: 'x220', detail: 4, limit: 8, attempts: 1 });
  assert.equal(out.detail_requested, 4);
  assert.equal(out.detail_report.length, 4);
  // The fourth was refused by goofish, so it falls back to the search card this same call just
  // returned -- a real listing, but a card. It is reported as what it answered from rather than
  // dropped, which is the difference between a shorter list and a dishonest one.
  const fourthReport = out.detail_report.find((r: any) => r.item_id === '303');
  assert.equal(fourthReport.ok, true);
  assert.equal(fourthReport.source, 'search_card_cache');
  assert.equal(out.detail_report.filter((r: any) => r.source === 'item_detail_api').length, 3);
  // `detail_ms` is what the depth cost, so a caller can price the next call. Assert the field is
  // present and is the sum of the per-listing costs -- not that it is nonzero. The fake session
  // answers with no delay, so three reads can legitimately total 0ms; a wall-clock assertion here
  // passes on a fast machine and fails on a loaded one, which is how it reached CI green-then-red.
  assert.equal(typeof out.detail_ms, 'number');
  assert.equal(out.detail_ms, out.detail_report.reduce((a: number, r: any) => a + (r.ms ?? 0), 0));
  // the three that worked carry the detail fields; the fourth is still a card
  const first = out.items.find((i: any) => i.item_id === '300');
  assert.equal(first.description, '成色好，功能正常');
  assert.equal(first.seller, '卖家');
  assert.equal(first.seller_items_sold, '12');
  assert.equal(first.detailed, true);
  const fourth = out.items.find((i: any) => i.item_id === '303');
  assert.equal(fourth.detailed, true, 'it came back, from the search card rather than the page');
  assert.equal(fourth.detail_source, 'search_card_cache', 'and says so');
  assert.equal(fourth.description, '', 'so nothing pretends the description was read');
  assert.equal(out.items.length, 8, 'and the other four are untouched');
});

test('a search card carries the seller, tags, avatar and publish time, not just a title and a price', async () => {
  // All of it is in the reply we already had. The seller was the visible gap: a search card's name is
  // `exContent.userNickName`, and reading `userNick` -- which does not exist on a search card -- left
  // every search result with an empty seller while the feed cards had one.
  const reply = searchReply('thinkpad x220', [['联想Thinkpad X220 笔记本', '1', '329', '北京', '5']]);
  const main = reply.resultList[0].data.item.main;
  main.exContent.detailParams = { ...main.exContent.detailParams, itemId: '1', title: '联想Thinkpad X220 笔记本', soldPrice: '329', picUrl: 'https://img.alicdn.com/bao/uploaded/i1/1.jpg' };
  Object.assign(main.exContent, { userNickName: '松花江逃跑的香蕉', userAvatarUrl: 'http://img.alicdn.com/bao/uploaded/i1/avatar.jpg', userFishShopLabel: { config: { x: 1 } }, showVideoIcon: true, want: '5',
    fishTags: { r2: { tagList: [{ data: { content: '18天内降价' } }] }, r4: { tagList: [{ data: { content: '卖家信用极好' } }] }, r1: { tagList: [{ data: { content: 'freeShippingIcon' } }] } } });
  main.clickParam.args.publishTime = '1784640276000';
  const { FEED_NORMALIZE_JS, searchListings } = await import('../src/extract.ts');
  const row = FEED_NORMALIZE_JS({ rows: searchListings(reply) })[0];
  assert.equal(row.seller, '松花江逃跑的香蕉', 'the seller name lives in userNickName');
  assert.equal(row.seller_avatar, 'https://img.alicdn.com/bao/uploaded/i1/avatar.jpg');
  assert.equal(row.seller_shop, true);
  assert.equal(row.is_video, true);
  assert.equal(row.want_count, '5');
  assert.equal(row.publish_time, '1784640276000');
  assert.deepEqual(row.tags, ['18天内降价', '卖家信用极好'], 'the tag strip, minus the icon placeholder');
  assert.equal(row.price, '329');
});

test('item_view reports every promised field, and missing ones as missing rather than filled in', async () => {
  use(makeSession({ item: [{ ...RENDERED, description: '', image_urls: [] }] }));
  const out = await run('item_view')({ item_id: '42' });
  assert.equal(out.price, '1999');
  assert.equal(out.page_item_id, '42', 'the id the page actually served is the evidence for that');
  assert.equal(out.seller, '汴梁');
  assert.deepEqual(out.image_urls, []);
  // an empty gallery is *not* a present field, and nothing is invented to fill the gap
  assert.deepEqual(out.fields_missing, ['description', 'image_urls']);
  assert.deepEqual([...out.fields_present, ...out.fields_missing].sort(), ['browse_count', 'description', 'image_urls', 'price', 'seller', 'seller_items_sold', 'seller_positive_rate', 'seller_tenure_years', 'title', 'want_count']);
  assert.equal(out.account_required, false);
  // a gallery that is absent entirely is an empty list, not a string: the field is promised as a list
  use(makeSession({ item: [{ ...RENDERED, image_urls: undefined }] }));
  const gone = await run('item_view')({ item_id: '42' });
  assert.deepEqual(gone.image_urls, []);
  assert.ok(gone.fields_missing.includes('image_urls'));
});

test('item_view accepts a pasted item URL, and refuses garbage before touching the browser', async () => {
  const s = use(makeSession({ item: [{ ...RENDERED, requested_item_id: '777', page_item_id: '777' }] }));
  assert.equal((await run('item_view')({ item_id: 'https://www.goofish.com/item?id=777#detail&spm=a1z10.3' })).item_id, '777');
  assert.deepEqual(s.opened, ['https://www.goofish.com/item?id=777']);
  // a pasted URL contributes its id and nothing else, even from another host
  use(makeSession({ item: [RENDERED] }));
  assert.equal((await run('item_view')({ item_id: 'https://evil.com/steal?id=42' })).url, 'https://www.goofish.com/item?id=42');
  for (const bad of ['not-an-id', '42; DROP TABLE', '0x2a', '']) {
    const s3 = use(makeSession({ item: [RENDERED] }));
    await assert.rejects(run('item_view')({ item_id: bad }), XianyuError);
    assert.deepEqual(s3.opened, [], `the browser was touched for ${JSON.stringify(bad)}`);
  }
});

test('item_view refuses to report a different listing\'s fields -- or no listing at all -- and quotes the page text when it will not render', async () => {
  use(makeSession({ item: [{ ...RENDERED, page_item_id: '999' }] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof ParseError && /999/.test(e.message));
  // A page that renders the detail block but has no `?id=` anywhere is a redirect or a challenge
  // page, not this listing. The check used to be skipped whenever the served id was empty, which is
  // exactly what an off-site page looks like.
  use(makeSession({ item: [{ ...RENDERED, page_item_id: '' }] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => e instanceof ParseError && /no \?id=/.test(e.message));
  use(makeSession({ item: [UNRENDERED, UNRENDERED, UNRENDERED] }));
  await assert.rejects(run('item_view')({ item_id: '42' }), (e: any) => {
    assert.ok(e instanceof DetailUnavailableError);
    // The wording changed when the cause was pinned down -- the page is login-gated, not slow -- so
    // the count and the clock are asserted separately rather than as one interpolated phrase.
    assert.match(e.message, /\b\d+ page load\(s\) in \d+s/);
    assert.match(e.message, /阿里巴巴/, 'the page text it actually saw must be quoted');
    return true;
  });
});

test('recommendations reads the DOM rail, and says why it fell back to the feed', async () => {
  use(makeSession({ scrape: [{ items: [{ item_id: '1', title: '相机', price: '¥1200', url: 'u' }], rail: '为你推荐', says_no_results: false, blocked: false }] }));
  const dom = await run('recommendations')({ limit: 10 });
  assert.equal(dom.source, 'dom_recommendation');
  assert.equal(dom.rail, '为你推荐');
  assert.equal(dom.risk_control_page, false);
  assert.equal(dom.items[0].rank, 1);
  use(makeSession({ scrape: [{ items: [] }], cards: [listed(['9'])] }, { p1: cards(['9']) }));
  const out = await run('recommendations')({ limit: 5 });
  assert.equal(out.source, 'homepage_feed');
  assert.match(out.fallback_reason, /empty shell/);
  assert.equal(out.requested_url, HOME);
  assert.equal(out.count, 1);

  // The budget and the elapsed time quoted here both start before the page load, as item_view's do.
  // A clock started after `open` ignored the slowest step in the call and undercounted it by one load.
  const slow = use(makeSession({ scrape: [{ items: [] }], cards: [listed(['7'])] }, { p1: cards(['7']) }));
  slow.open = async () => { await new Promise((r) => setTimeout(r, 1200)); return slow.ensureReady(); };
  const late = await run('recommendations')({ limit: 5 });
  assert.match(late.fallback_reason, /after 5 attempt\(s\) in [1-9]\d*s/, 'the page load is inside the budget and inside the reported elapsed time');
  assert.equal(late.count, 1);
});

test('navigation is confined to goofish by the real Session, at both sites and after the redirect', async () => {
  // The fake session's `open` is a stand-in; this drives `Session.open` itself, so the check that
  // matters is the real `ensureGoofishUrl` rather than a copy of it sitting in the test double.
  const { page } = realSession({ queues: { [SCRAPE_CARDS_JS as any]: [{ items: [], rail: '为你推荐' }] } });
  await assert.rejects(run('recommendations')({ url: 'https://evil.com/steal?_r=1' }), (e: any) => e.constructor.name === 'NavigationError');
  assert.deepEqual(page.calls, [], 'an off-site target is refused before the browser is moved');
  // and a navigation that lands off-site -- goofish bouncing us, or anything in the page -- is caught
  // on the way back, before the DOM is read
  const bounced = realSession({ land: () => 'https://www.goofish.com.evil.com/', queues: { [SCRAPE_CARDS_JS as any]: [{ items: [{ item_id: '1', title: 'x', url: 'u' }] }] } });
  await assert.rejects(run('recommendations')({}), (e: any) => e.constructor.name === 'NavigationError');
  assert.equal(bounced.page.calls.length, 1, 'it tried the target, and stopped there');
});

test('a page parked on a lookalike host is re-parked, and reloadFresh refuses to leave goofish', async () => {
  // currentPage() used to gate on `url().startsWith('https://www.goofish.com')`, which every one of
  // these passes and none of them is: the allowlist check everything else runs was simply missing
  // here, so ensureReady and call ran our JS on whatever the page was.
  for (const lookalike of ['https://www.goofish.com.evil.com/', 'https://www.goofish.com@evil.com/', 'https://www.goofish.computer/', 'https://www.goofish.com.attacker.tld/', 'https://sub.www.goofish.com/']) {
    const { s, page } = realSession({ start: lookalike });
    await s.ensureReady();
    // one assertion, because the recorded goto already implies the URL: it re-navigated to the boot
    // page, and that was the only navigation
    assert.deepEqual(page.calls, [BOOT_URL], `${lookalike} was treated as goofish, or was not re-parked`);
  }
  // if it will not settle on goofish, that is a refusal rather than a page to scrape
  const stuck = realSession({ start: 'https://www.goofish.computer/', land: () => 'https://www.goofish.computer/' });
  await assert.rejects(stuck.s.ensureReady(), (e: any) => e.constructor.name === 'NavigationError');
  // reloadFresh is the second goto site and re-checks where the redirect landed: it is called from
  // search_items, item_view and recommendations, which scrape whatever is here next.
  await assert.rejects(reloadFresh(drivenPage({ land: () => 'https://evil.com/steal' })), (e: any) => e.constructor.name === 'NavigationError');
  const onSite = drivenPage();
  await reloadFresh(onSite);
  assert.match(onSite.url(), /^https:\/\/www\.goofish\.com\/.+_r\d+$/);
  // reloading a page that already carries a nonce must replace it, not stack another one on: `base`
  // used to be read from the already-busted url(), so the query grew `&_r=1&_r=2&_r=3`
  await reloadFresh(onSite);
  await reloadFresh(onSite);
  assert.equal((onSite.url().match(/_r/g) ?? []).length, 1, `the cache-buster accumulated: ${onSite.url()}`);
});

test('related_items sends goofish\'s own seed id and pageSize, and applies limit client-side', async () => {
  const s = use(makeSession({ cards: [listed(['111', '222', '333'])] }, { rec: { ok: true, ret: 'SUCCESS', data: { hasMore: true, cardList: ['111', '222', '333'].map((id) => ({ cardData: { itemId: id } })) } } }));
  const out = await run('related_items')({ limit: 2 });
  assert.deepEqual(s.specs[0][0][2], { itemId: '809806779491', categoryId: '', pageNum: 1, pageSize: 30, reqFrom: 'xianyuweb' });
  assert.equal(out.item_id, null);
  assert.equal(out.unique_items, 3);
  assert.equal(out.count, 2);
  assert.equal(out.has_more, true);
  assert.deepEqual(s.opened, [], 'the mtop-only path must not navigate');
  const s2 = use(makeSession({ cards: [listed(['9'])] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { itemId: '9' } }] } } }));
  await run('related_items')({ item_id: 'https://www.goofish.com/item?id=777&x=1' });
  assert.equal(s2.specs[0][0][2].itemId, '777');
  use(makeSession({ cards: [[]] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: [] } } }));
  await assert.rejects(run('related_items')({}), ParseError);
  // a non-list cardList, the shape browse_feed used to spread into a raw TypeError
  use(makeSession({ cards: [[]] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: 'nope' } } }));
  await assert.rejects(run('related_items')({}), (e: any) => e.constructor.name === 'ParseError');
  // `page` is bounded like every other number in the contract, and the bound is what gets sent
  const s3 = use(makeSession({ cards: [listed(['9'])] }, { rec: { ok: true, ret: 'SUCCESS', data: { cardList: [{ cardData: { itemId: '9' } }] } } }));
  assert.equal((await run('related_items')({ page: 9e9 as any })).page, 10_000);
  assert.equal(s3.specs[0][0][2].pageNum, 10_000);
});

test('search_count reads the match counter, and zero matches is an answer, not an error', async () => {
  const s = use(makeSession({}, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 28791 } } }));
  const out = await run('search_count')({ query: 'x220' });
  assert.deepEqual([out.match_count, out.has_matches], [28791, true]);
  assert.equal(s.specs[0][0][2].searchReqFromPage, 'pcSearch');
  assert.equal(s.specs[0][0][2].keyword, 'x220');
  assert.deepEqual(s.opened, []);
  use(makeSession({}, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum: 0 } } }));
  assert.deepEqual([(await run('search_count')({ query: 'asdkjhqwezzz' })).match_count, (await run('search_count')({ query: 'z' })).has_matches], [0, false]);
  use(makeSession({}, { hitnum: { ok: false, ret: 'RGV587_ERROR::x', data: null } }));
  await assert.rejects(run('search_count')({ query: 'x220' }), GatedError);
  await assert.rejects(run('search_count')({ query: ' ' }), XianyuError);
  // "zero is an answer" is only true when the site said zero. A count that cannot be read -- moved,
  // null, a string, a thousands separator -- is a shape change, and answering "no matches" to "I
  // don't know" is the one reply this tool must never make.
  for (const hitnum of [{ total: 5 }, null, 'oops', '1,234', undefined, ''] as any[]) {
    use(makeSession({}, { hitnum: { ok: true, ret: 'SUCCESS', data: { hitnum } } }));
    await assert.rejects(run('search_count')({ query: 'x220' }), (e: any) => e instanceof ParseError && /unreadable hitnum/.test(e.message), JSON.stringify(hitnum));
  }
});

test('search_suggest normalises, dedupes and respects the default limit of 20', async () => {
  const items: any[] = Array.from({ length: 25 }, (_, i) => ({ suggest: `x220-${i}`, bucketNum: 30 }));
  items.push({ suggest: 'x220-0' }, { suggest: '' }, 'not-a-dict');
  const s = use(makeSession({}, { sug: { ok: true, ret: 'SUCCESS', data: { totalCount: 1234, items } } }));
  const out = await run('search_suggest')({ query: 'x220' });
  assert.equal(out.total_count, 1234);
  assert.equal(out.count, 20, 'the published default limit');
  assert.deepEqual(out.suggestions[0], { text: 'x220-0', bucket_num: 30 });
  assert.deepEqual(s.specs[0][0][2], { inputWords: 'x220', searchReqFromPage: 'xyPcHome', bucketId: 30, type: 0 });
  assert.equal((await run('search_suggest')({ query: 'x220', limit: 3 })).count, 3);
  use(makeSession({}, { sug: { ok: false, ret: 'RGV587_ERROR', data: null } }));
  await assert.rejects(run('search_suggest')({ query: 'x220' }), GatedError);
  // a non-list `items` used to escape as a raw TypeError published as error_type "TypeError"
  use(makeSession({}, { sug: { ok: true, ret: 'SUCCESS', data: { totalCount: 3, items: { 0: { suggest: 'x220-0' } } } } }));
  await assert.rejects(run('search_suggest')({ query: 'x220' }), (e: any) => e instanceof ParseError && /non-list `items`/.test(e.message));
});

test('capabilities never throws, not even when the browser is gone, and a failed probe does not hide the others', async () => {
  const s = use(makeSession({}, { me: { ok: false, ret: 'FAIL_SYS_SESSION_EXPIRED::x' }, f: { ok: true } }));
  const ok = await run('capabilities')({});
  assert.equal(ok.requires_xianyu_account, false);
  assert.equal(ok.session_state, 'logged_out');
  assert.equal(ok.login_probe_ret, 'FAIL_SYS_SESSION_EXPIRED::x');
  assert.equal(ok.feed_reachable, true);
  // every tool it names in works_without_account is a tool that exists
  for (const line of ok.works_without_account) {
    for (const word of line.split(/[^a-z_]+/)) if (word.includes('_')) assert.ok(TOOLS.some((t) => t.name === word), `works_without_account names ${word}, which is not a tool`);
  }
  assert.ok(ok.anonymous_flakiness.length > 0 && ok.notes.length > 0 && ok.note);
  // merged into one try, a throwing loginuser probe skipped the feed probe and its verdict, and the
  // whole thing looked like a dead browser; each probe now reports under its own key
  s.call = async () => { throw new BrowserError('mtop is not up'); };
  const partial = await run('capabilities')({});
  assert.equal(partial.session_state, 'unknown');
  assert.equal(partial.feed_reachable, false);
  assert.equal(partial.login_error, 'BrowserError: mtop is not up');
  assert.equal(partial.feed_error, 'BrowserError: mtop is not up');
  assert.equal(partial.browser_error, undefined, 'the browser was fine; only the calls failed');
  s.ensureReady = async () => { throw new BrowserError('chromium is gone'); };
  const broken = await run('capabilities')({});
  assert.equal(broken.session_state, 'unknown');
  assert.equal(broken.browser_error, 'BrowserError: chromium is gone');
  assert.ok(broken.notes.length > 0, 'the lists are still there when the probes fail');
  // even a null throw is reported rather than rethrown: `(e as Error).constructor.name` is a TypeError
  s.ensureReady = async () => { throw null; };
  assert.match(String((await run('capabilities')({})).browser_error), /^(Error|TypeError):/);
  s.ensureReady = async () => { throw new Error('something unexpected'); };
  assert.ok(await run('capabilities')({}));
  // session_state is the conclusion this tool exists to draw, so it is not drawn from "the probe
  // failed": a rate limit and a timeout say nothing about whether a session exists.
  for (const [ret, want] of [['RGV587_ERROR::挤爆啦', 'unknown'], ['FAIL_SYS_COMMON::TIMEOUT', 'unknown'], ['', 'unknown'], ['FAIL_SYS_TOKEN_EXPIRED::x', 'logged_out'], ['SUCCESS::调用成功', 'unexpectedly_logged_in']] as const) {
    use(makeSession({}, { me: { ok: ret.startsWith('SUCCESS'), ret }, f: { ok: true } }));
    assert.equal((await run('capabilities')({})).session_state, want, ret || '(empty ret)');
  }
});

test('tool calls are serialised, so two in flight cannot navigate one page out from under the other', async () => {
  const order: string[] = [];
  const slow = (tag: string, ms: number) => exclusive(async () => { order.push(`${tag}:in`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}:out`); return tag; });
  assert.deepEqual(await Promise.all([slow('a', 20), slow('b', 1)]), ['a', 'b']);
  assert.deepEqual(order, ['a:in', 'a:out', 'b:in', 'b:out']);
  // a rejected tool releases the lock rather than wedging every call after it
  await assert.rejects(exclusive(async () => { throw new XianyuError('boom'); }), XianyuError);
  assert.equal(await exclusive(async () => 'after'), 'after');
});
