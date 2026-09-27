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
import { FEED_NORMALIZE_JS, ITEM_SCRAPE_JS, MTOP_READY_JS, SCRAPE_CARDS_JS, SEARCH_INPUT_JS, SEARCH_STATE_JS } from '../src/extract.ts';
import { budget, TOOLS } from '../src/tools.ts';

const run = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `no tool named ${name}`);
  return t.run;
};

/** Payloads are keyed by in-page script. `sleepMs` makes the fake's waits cost real time, and `hijack`
 *  moves the page off goofish to that URL: at `hijackAfter: 'open'`, on the first tick after `open`
 *  resolves -- after `open`'s own allowlist check, before the caller's first read, the window the
 *  reviewer read a lookalike host off-site in. At `'read'`, on the first wait *after* a read, which is
 *  item_view's 6s readiness poll and the second read site. */
const makeSession = (payloads: { cards?: any[]; item?: any[]; scrape?: any[]; search?: any; swallow?: number } = {}, raw: any = {}, sleepMs = 0, hijack = '', hijackAfter: 'open' | 'read' = 'open') => {
  const queues: Record<any, any[]> = { [FEED_NORMALIZE_JS as any]: [...(payloads.cards ?? [])], [ITEM_SCRAPE_JS as any]: [...(payloads.item ?? [])], [SCRAPE_CARDS_JS as any]: [...(payloads.scrape ?? [])] };
  // The searchbox, as a real page holds it: mounted or not, with the keys that have landed so far.
  const search = { mounted: 'search' in payloads ? payloads.search !== null : true, value: '' };
  let at = HOME, reads = 0;
  const page: any = {
    url: () => { reads++; return at; },
    waitForTimeout: async (ms: number) => { if (hijack && hijackAfter === 'read' && reads > 0) at = hijack; if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs)); },
    goto: async (u: string) => { at = u; search.value = ''; },
    // Only what typeSearch needs: the two in-page reads and the two key actions. `keyboard.type`
    // truncates at `swallow` characters to reproduce the SPA eating a burst across a re-render.
    keyboard: {
      type: async (text: string) => { search.value = payloads.swallow ? text.slice(0, payloads.swallow) : text; },
      press: async (key: string) => { if (key === 'Enter' && search.value) at = `${HOME}search?q=${encodeURIComponent(search.value)}`; },
    },
    evaluate: async (fn: any) => {
      if (fn === MTOP_READY_JS) return 'ready';
      if (fn === SEARCH_INPUT_JS) return search.mounted
        ? { found: true, focused: true, value: search.value, inputs: 1, chars: 1200, path: '/' }
        : { found: false, inputs: 0, chars: 512, path: '/', value: '' };
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
    launches: 0, opened: [] as string[], specs: [] as any[][], raw, search,
    ensureReady: async () => page,
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
  const s: any = { launches: 0, opened: [] as string[], specs: [] as any[][], raw: {}, ensureReady: async () => page, open: async (u: string) => { s.opened.push(u); here = u; input.value = ''; return page; }, call: async () => ({}), clicks };
  return use(s);
};

/** A real Session with a fake page bolted in, so `Session.open` -- and the allowlist check it runs
 *  around every goto -- is the thing under test. No Chromium is launched. */
const realSession = (opts: Parameters<typeof drivenPage>[0] = {}) => {
  const s = new Session(), page = drivenPage(opts);
  (s as any).page = page;
  use(s);
  return { s, page };
};
test.afterEach(() => { setSession(null); for (const g of ['document', 'location', 'window']) delete (globalThis as any)[g]; for (const k of ['SEARCH', 'ITEM_VIEW', 'RECOMMENDATIONS']) delete process.env[`XIANYU_${k}_BUDGET_S`]; });

const cards = (ids: string[]) => ({ ok: true, ret: 'SUCCESS::调用成功', data: { cardList: ids.map((id) => ({ cardData: { itemId: id, title: `t${id}`, soldPrice: '5' } })) } });
const listed = (ids: string[]) => ids.map((id) => ({ item_id: id, title: `t${id}`, price: '5', city: '杭州', seller: 'a', want_count: '1', image_urls: [], url: `https://www.goofish.com/item?id=${id}` }));

const RENDERED = { detail_rendered: true, page_item_id: '42', title: '男士羊毛呢大衣', price: '1999', want_count: '2', browse_count: '110', description: '专柜入手。', seller: '汴梁', seller_tenure_years: '4', seller_items_sold: '27', seller_positive_rate: '100', image_urls: ['https://img.alicdn.com/x.jpg'], head_preview: '...', reco_anchors: 30, image_candidates: 4 };
const UNRENDERED = { detail_rendered: false, head_preview: '阿里巴巴集团 淘宝 天猫' };
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
  const page = { rendered: true, cards_scanned: 4, rail: '', says_no_results: false, text_preview: 'x220', query_hits: 3, items: [
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

  // A multi-word query whose words all appear but never as one substring is still refused -- the
  // strict guard stands -- but the looser count is published, so the refusal is diagnosable rather
  // than a bare "no results", and the card count is on the failure path too.
  domSession(Array.from({ length: 8 }, (_, i) => `联想 X220 键盘 ${i}`));
  await assert.rejects(run('search_items')({ query: '键盘 x220 联想', attempts: 1 }), (e: any) => e instanceof SearchUnavailableError
    && /"query_hits":0/.test(e.message) && /"token_hits":8/.test(e.message) && /"scraped_cards":8/.test(e.message) && /\b1 attempt\(s\)/.test(e.message));
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
    await s.currentPage();
    // one assertion, because the recorded goto already implies the URL: it re-navigated to the boot
    // page, and that was the only navigation
    assert.deepEqual(page.calls, [BOOT_URL], `${lookalike} was treated as goofish, or was not re-parked`);
  }
  // if it will not settle on goofish, that is a refusal rather than a page to scrape
  const stuck = realSession({ start: 'https://www.goofish.computer/', land: () => 'https://www.goofish.computer/' });
  await assert.rejects(stuck.s.currentPage(), (e: any) => e.constructor.name === 'NavigationError');
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
