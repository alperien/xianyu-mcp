/**
 * The server's central promises, as invariants over the source: no Xianyu account, no
 * credentials, no write capability, navigation confined to goofish.com, and no invented
 * data. These are cheap and they are the tests that would catch a bad change nobody
 * thought about -- so they scan the whole tree rather than asserting on one function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BOOT_URL, ensureGoofishUrl, HOME } from '../src/browser.ts';
import { ITEM_SCRAPE_JS, RAIL_MARKERS } from '../src/extract.ts';
import { BrowserError, DetailUnavailableError, describe, GatedError, NavigationError, ParseError, PUBLISHED_ERROR_TYPES, SearchUnavailableError, XianyuError } from '../src/errors.ts';
import { TOOLS } from '../src/tools.ts';
import { z } from 'zod';

const ROOT = join(import.meta.dirname, '..');
const sources = ['src', 'test'].flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true })
  .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
  .map((f) => join(ROOT, dir, f)));
// Read once at module scope: four tests scan the same files, and re-reading and re-splitting them
// per test is the only thing that made this suite slow.
const SRC: Record<string, string> = Object.fromEntries(sources.map((p) => [p, readFileSync(p, 'utf8')]));
const read = (p: string) => SRC[p] ?? readFileSync(p, 'utf8');

/** A line that is only naming the needle (this file's own lists) or narrating it. */
const isJustNamingIt = (line: string) => /^['"`/*-]/.test(line.trim());
/** `!` and `?.` sit between the object and the call, so a real `context.cookies()`
 *  read is usually written `context!.cookies()`. Normalise them away first. */
const deAsserted = (line: string) => line.replace(/[!?]+\./g, '.');
const flat = (line: string) => deAsserted(line).replace(/\s+/g, '');

test('no credential access anywhere in the tree', () => {
  // The tree is pinned by name, not by a count: a scan that silently stops covering a file -- or one
  // that silently starts covering a sixth source file -- is the failure mode here, not a raw credential.
  assert.deepEqual(sources.map((p) => p.replace(`${ROOT}/`, '')).sort(), ['src/browser.ts', 'src/errors.ts', 'src/extract.ts', 'src/index.ts', 'src/tools.ts', 'test/extract.test.ts', 'test/invariants.test.ts', 'test/tools.test.ts']);
  // `.cookies(` rather than `context.cookies(`, and matched with the whitespace stripped: matching
  // the literal missed `page.context().cookies()` and any call split across lines.
  const forbidden = [
    '.cookies(', 'storageState', 'launchPersistentContext', 'userDataDir',
    'cookie2', 'sgcookie', 'x5sec', '_m_h5_tk', 'addCookies', 'localStorage', 'sessionStorage',
  ];
  const offenders: string[] = [];
  for (const p of sources) {
    read(p).split('\n').forEach((line, i) => {
      const flat = deAsserted(line).replace(/\s+/g, '');
      for (const needle of forbidden) if (flat.includes(needle) && !isJustNamingIt(line)) offenders.push(`${p}:${i + 1} ${needle}`);
    });
  }
  assert.deepEqual(offenders, []);
  // and the scan really does catch that shape, which is what a credential read looks like
  assert.equal(flat(['page.context()', '  .' + 'cookies()'].join('\n')).includes('.' + 'cookies('), true);
});

test('only the five read-only mtop APIs are named anywhere: a closed list, so a new one cannot slip in', () => {
  const readApis = [
    'mtop.taobao.idlehome.home.webpc.feed',
    'mtop.taobao.idle.filter.hitnum.pc.get',
    'mtop.taobao.idlemtopsearch.pc.search.suggest',
    'mtop.taobao.idle.item.web.recommend.list',
    'mtop.taobao.idlemessage.pc.loginuser.get',
  ];
  assert.equal(readApis.length, 5);
  // `window.lib.mtop.request` is the page's own client method -- the one call this server is built
  // on -- not an API name. Everything else shaped like `mtop.<something>` is an API and is closed.
  const notAnApi = 'mtop.request';
  const seen = new Set<string>();
  const offenders: string[] = [];
  for (const p of sources) {
    read(p).split('\n').forEach((line, i) => {
      if (isJustNamingIt(line)) return;
      for (const api of deAsserted(line).match(/mtop\.[A-Za-z0-9_.]+/g) ?? []) {
        if (api === notAnApi) continue;
        seen.add(api);
        if (!readApis.includes(api)) offenders.push(`${p}:${i + 1} ${api}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
  // every one of the five is actually reached, not just allowed
  assert.deepEqual([...seen].sort(), [...readApis].sort());
  // and the pattern really is closed over the whole namespace, which the old two-namespace version
  // was not: a write API outside taobao/idle would have passed it. (Built by concatenation so that
  // this line does not flag itself -- the scan reads this file too.)
  const write = 'mtop.' + 'commerce.item.publish';
  assert.deepEqual(write.match(/mtop\.[A-Za-z0-9_.]+/g), [write]);
});

test('exactly the eight read-only tools exist, and none of them can change state', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['browse_feed', 'capabilities', 'item_view', 'recommendations', 'related_items', 'search_count', 'search_items', 'search_suggest']);
  for (const t of TOOLS) {
    assert.equal(/publish|delete|remove|message|send|upload|comment|order|buy|checkout|follow|favou?rite/i.test(t.name), false, `${t.name} looks like a write tool`);
  }
});

test('every tool says that no account is required, and that it is read-only', () => {
  for (const t of TOOLS) {
    assert.match(t.description, /No Xianyu account/, t.name);
    assert.match(t.description, /Read-only/, t.name);
    assert.ok(t.description.length > 80, `${t.name} needs a description an agent can act on`);
  }
});

test('the published argument names and defaults are exactly these', () => {
  const shape = (t: (typeof TOOLS)[number]) => Object.fromEntries(Object.entries(t.schema).map(([k, v]: [string, any]) => {
    const parsed = v.safeParse(undefined);
    if (!parsed.success) return [k, '<required>'];
    return [k, parsed.data === undefined ? '<optional>' : parsed.data];
  }));
  const published: Record<string, any> = {
    capabilities: {},
    browse_feed: { page_number: 1, pages: 1, limit: 60 },
    search_count: { query: '<required>' },
    search_suggest: { query: '<required>', limit: 20 },
    search_items: { query: '<required>', limit: 30, attempts: 4 },
    related_items: { item_id: '<optional>', limit: 30, page: 1 },
    item_view: { item_id: '<required>' },
    recommendations: { limit: 30, url: '<optional>' },
  };
  assert.deepEqual(Object.fromEntries(TOOLS.map((t) => [t.name, shape(t)])), published);
  // and bounded where the agent can see it. `related_items.page` was the one number in the contract
  // with no ceiling at all, so the served JSON Schema invited page 1e9.
  for (const t of TOOLS) {
    const json: any = z.toJSONSchema(z.object(t.schema), { io: 'input' });
    for (const [k, v] of Object.entries<any>(json.properties ?? {})) {
      if (v.type !== 'number' && v.type !== 'integer') continue;
      // zod fills an unbounded number in with JSON Schema's own limits, so "has a maximum" is not the
      // question -- "has a bound somebody chose" is, and only a stricter one counts.
      assert.ok(v.minimum > -Number.MAX_SAFE_INTEGER && v.maximum < Number.MAX_SAFE_INTEGER, `${t.name}.${k} is unbounded in the published schema`);
    }
  }
});

test('every navigation goes through browser.ts, so there is exactly one place to audit', () => {
  for (const p of sources.filter((f) => f.includes('src') && !f.endsWith('browser.ts'))) {
    const hits = read(p).split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => l.includes('.goto(') || l.includes('.reload('));
    assert.deepEqual(hits, [], `${p} navigates outside browser.ts`);
  }
});

test('both navigation sites re-check the URL, before and after the redirect', () => {
  const src = read(join(ROOT, 'src', 'browser.ts'));
  const [load] = src.match(/async function load\([\s\S]*?\n}/) ?? [];
  assert.ok(load && load.includes('page.goto('), 'the one place a chosen URL is loaded from');
  // open() validates the target before goto, then the URL goofish itself landed on after it
  const open = src.match(/async open\([\s\S]*?\n  }/)?.[0] ?? '';
  // before the goto, after it, and once more on the way out: the settle and the mtop wait after the
  // second check can take tens of seconds, so the check that is still current when the caller scrapes
  // is the last.
  assert.ok((open.match(/ensureGoofishUrl\(/g) ?? []).length >= 2, open);
  assert.ok(open.indexOf('ensureGoofishUrl(url)') < open.indexOf('load(page, target)'));
  assert.ok(open.indexOf('load(page, target)') < open.indexOf('ensureGoofishUrl(page.url())'));
  assert.ok(open.lastIndexOf('ensureGoofishUrl(page.url())') > open.indexOf('waitForMtop(page)'), open);
  // reloadFresh re-validates wherever the page ended up, which is not something we chose, and it
  // does not swallow that refusal: its three callers scrape whatever is on the page next.
  const fresh = src.match(/async function reloadFresh\([\s\S]*?\n}/)?.[0] ?? '';
  assert.match(fresh, /ensureGoofishUrl\(page\.url\(\)/);
  assert.equal(fresh.trim().split('\n').pop(), '}', 'the allowlist check has to be the last thing it does');
  // currentPage, the third navigation site, decides with the same check rather than a prefix test
  assert.match(src.match(/private parkedOnGoofish[\s\S]*?\n}/)?.[0] ?? '', /ensureGoofishUrl\(this\.page!\.url\(\)\)/);
  assert.equal(/\.url\(\)\.startsWith\(/.test(src), false, 'the startsWith check that let www.goofish.computer through is back');
  // Those checks are all point-in-time, and every caller then polls for seconds before it reads the
  // DOM. So tools.ts reads the DOM through one helper that re-checks the URL that is live *now*, in
  // the same statement as the read, and no scraper may reach `evaluate` around it.
  const tools = read(join(ROOT, 'src', 'tools.ts'));
  const helper = tools.match(/const scrape = .*/)?.[0] ?? '';
  assert.match(helper, /ensureGoofishUrl\(page\.url\(\)\); return evaluate\(/, 'the re-check has to be the statement immediately before the read');
  for (const js of ['SCRAPE_CARDS_JS', 'ITEM_SCRAPE_JS']) {
    assert.ok(tools.includes(`scrape(page, ${js}`), `${js} never goes through the re-checking helper`);
    assert.equal(new RegExp(`evaluate\\(page, ${js}`).test(tools), false, `${js} bypasses the re-check`);
  }
  // What is left calling `evaluate` with a page must be the scripts that read no page data: the feed
  // normalizer (a pure function over cards we already hold) and the gallery nudge (a scrollTo).
  const direct = [...tools.matchAll(/evaluate\(page, (\w+)/g)].map((m) => m[1]).filter((n) => n !== 'fn');
  assert.deepEqual([...new Set(direct)].sort(), ['FEED_NORMALIZE_JS', 'SCROLL_TO_JS'], 'a script that reads the DOM may not skip the re-check');
});

test('navigation is confined to https goofish.com, by exact parsed host and scheme', () => {
  for (const url of [HOME, BOOT_URL, 'https://www.goofish.com/search?q=x220', 'https://goofish.com/item?id=1']) {
    assert.equal(ensureGoofishUrl(url), url);
  }
  for (const url of [
    'file://www.goofish.com/item?id=1',                       // right host, wrong scheme
    'https://www.goofish.com@evil.com/',                    // userinfo trick
    'http://www.goofish.com/',                              // not https
    'https://evil.com/?id=1',
    'https://www.goofish.com.evil.com/',
    'https://sub.www.goofish.com/',
    'http://',                                              // unparseable
    'not a url',
  ]) {
    assert.throws(() => ensureGoofishUrl(url), (e: any) => e instanceof NavigationError, url);
  }
});

test('the two refusals are GatedErrors, and each class name is the published error_type', () => {
  assert.ok(new SearchUnavailableError('') instanceof GatedError);
  assert.ok(new DetailUnavailableError('') instanceof GatedError);
  assert.ok(new GatedError('') instanceof XianyuError);
  // no minified or anonymous class names leak into error_type
  assert.deepEqual([BrowserError, GatedError, SearchUnavailableError, DetailUnavailableError, ParseError, NavigationError].map((c) => c.name),
    ['BrowserError', 'GatedError', 'SearchUnavailableError', 'DetailUnavailableError', 'ParseError', 'NavigationError']);
  // the published list is every class this server can raise, plus `Error` for everything else -- and
  // it is the *whole* list, so the README's error_type sentence is exhaustive rather than a sample
  assert.deepEqual(PUBLISHED_ERROR_TYPES, [...[BrowserError, GatedError, SearchUnavailableError, DetailUnavailableError, ParseError, NavigationError, XianyuError].map((c) => c.name), 'Error']);
  assert.equal(describe(new XianyuError('x')).error_type, 'XianyuError');
  // describe runs on the failure path, so a throw whose own message/toString/constructor throws must
  // still produce an envelope: it used to rethrow a TypeError from inside the error reporter
  for (const evil of [Object.create(null), { toString() { throw new Error('no'); } }, { get message(): string { throw new Error('no'); } }, { get constructor(): any { throw new Error('no'); } }]) {
    const d = describe(evil);
    assert.equal(d.error_type, 'Error', `error_type escaped the taxonomy for ${Object.prototype.toString.call(evil)}`);
    assert.equal(typeof d.message, 'string');
  }
  // and a non-Error throw is `Error`, not `String`/`Number`/`Object`/`Symbol`
  for (const thrown of ['boom', 42, { a: 1 }, Symbol('x'), ['a']]) assert.equal(describe(thrown).error_type, 'Error', `error_type for a ${typeof thrown} throw`);
});

test('item_view reads the rendered page, never a closed API, and item ids are normalised', () => {
  const tools = read(join(ROOT, 'src', 'tools.ts'));
  const view = tools.match(/const itemView = async[\s\S]*?\n};/)?.[0] ?? '';
  assert.ok(view.includes('ITEM_SCRAPE_JS'), 'the DOM is the source of the listing');
  assert.ok(view.includes('detail_rendered'), 'and an unrendered page is a typed refusal, not empty data');
  assert.ok(view.includes('page_item_id'), 'a page serving a different listing is refused');
  assert.ok(view.indexOf('ITEM_SCRAPE_JS') < view.indexOf('page_item_id'), 'the id check comes after the read');
  // the rail markers reach both scrapers as an argument, so the pattern is built from the list
  assert.match(ITEM_SCRAPE_JS.toString(), /new RegExp\(spec\.rails\.join\('\|'\)\)/, 'the item scraper must cut the page at the rail markers it is handed');
  assert.deepEqual(RAIL_MARKERS, ['为你推荐', '猜你喜欢', '猜你想看']);
});

test('the read path never clicks the page: the login dialog is left alone, on every path', () => {
  // Measured, headed, same URL, one fresh context per arm: with no dismissal the result cards are in
  // the DOM by t+12s (30 anchors, 5KB of text) *underneath* the ant-modal-mask and the passport login
  // iframe; clicking the close controls (4 of them) put the page into a state where the result list
  // never rendered at all and the 猜你喜欢 rail was served instead, at t+18s and t+24s. So the premise
  // this whole file used to encode -- "it must be closed or the page renders zero cards" -- was
  // backwards, and every retry built on it was retrying a self-inflicted failure.
  // Re-measured later the same day, when goofish was declining every load: the two arms came out the
  // same (20 cards, 2306 vs 2308 bytes, 猜你喜欢, "nothing found", zero query hits) and the only
  // difference was which pixels the mask covered. So the click has never been measured to buy
  // anything, and it is the only thing here with a measured downside.
  //
  // Both scrapers read `querySelectorAll` and `innerText`, which see straight through an overlay, so
  // no path needs the dialog closed. The guard is structural rather than behavioural on purpose: it
  // is the one change that must not be able to come back quietly, and no live page load can be part
  // of a unit test.
  for (const p of sources) {
    // `.click(` is the whole surface: nothing in this server simulates a pointer, by construction.
    const hits = read(p).split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /[^\w.]click\s*\(/.test(l) && !/isJustNamingIt/.test(l));
    assert.deepEqual(hits, [], `${p} clicks something in the page; the read path is not allowed to`);
  }
  // the selectors the dismisser used are gone with it, not left behind as dead machinery
  const extract = read(join(ROOT, 'src', 'extract.ts')), browser = read(join(ROOT, 'src', 'browser.ts'));
  for (const gone of ['DISMISS_LOGIN_JS', 'dismissLogin', 'baxia-dialog', 'closeIcon', 'modal-close', 'dialog-close']) {
    assert.equal(extract.includes(gone) || browser.includes(gone), false, `${gone} is back`);
  }
  // and the two entry points that used to call it -- Session.open, which every scraper goes through,
  // and search_items' own poll loop -- are the two that would reintroduce it
  const open = browser.match(/async open\([\s\S]*?\n  }/)?.[0] ?? '';
  const toolsSrc = read(join(ROOT, 'src', 'tools.ts'));
  const search = toolsSrc.match(/const searchItems = async[\s\S]*?\n};/)?.[0] ?? '';
  assert.ok(search.includes('SCRAPE_CARDS_JS'));
  assert.match(search, /settle\(page, 700\);\s*\n\s*\/\/ Over-ask/, 'the poll loop must go straight from waiting to reading');
  assert.equal(/\bdismiss[A-Za-z]*\(/.test(open + search), false);
  // the measurement is written down where the next reader of this function will actually see it: on
  // the doc comment above it, not only in this test file
  const why = toolsSrc.slice(0, toolsSrc.indexOf('const searchItems')).split('/**').pop() ?? '';
  assert.match(why, /closes? its close controls was measured|never rendered|left alone/i, 'say why the dialog is left alone');
});

test('the browser launches windowed by default, because headless is served the risk-control page', () => {
  const src = read(join(ROOT, 'src', 'browser.ts'));
  // Measured: headed serves the app (20 cards, 2.3KB, the real filter bar); headless serves the same
  // URL as "非法访问" for 128s straight -- zero cards, 35 bytes -- so the three DOM tools need a display.
  assert.match(src, /headless: process\.env\.XIANYU_HEADLESS !== '1'/);
  assert.match(src, /risk-control/, 'the reason for the default has to be written down next to it');
  assert.match(src, /mtop tools work either way|does not:\s*\n?\s*\*?\s*the page's own client boots on the risk-control page/);
});
