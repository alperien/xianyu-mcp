/**
 * The browser session. One throwaway Chromium, launched lazily and reused across tool calls (a cold launch costs ~5s, and these calls are cheap once the page is up). The context is brand new every time: no profile directory, no stored state, no account, and this package never reads cookies -- goofish sets its own anonymous ones when the page loads and we never look at them. Only https://goofish.com is ever loaded, and every navigation goes through `load` after `ensureGoofishUrl` has checked host *and* scheme.
 *
 * Two pages that matter, not one. `apiPage` is parked on `BOOT_URL` and never navigates again: it exists only to
 * give the mtop tools a live client, and a tool call that needs nothing but mtop must not queue
 * behind a 70s search. `domPage` is the one that navigates, so the DOM-scraping tools still serialise
 * against each other and still cannot be read out from under one another. Measured: with a single page
 * a `search_items` call that takes 70s blocks `browse_feed`, which does 1.5s of real work.
 *
 * A bounded handful more, for one job: the detail fan-out (`Session.fanoutSurface`). Those are leased
 * by whoever holds the shared lock and are invisible to everything else, so the invariant above is
 * untouched -- still one page the DOM tools read, still one lock -- while `detail: 50` gets to load two
 * listings at a time instead of one. What a fan-out *cannot* have is an unbounded pool: see
 * `DETAIL_POOL_MAX` for why the ceiling is structural rather than a matter of taste.
 *
 * A third page exists only while the boot warm-up runs, on purpose, and is closed before it returns --
 * see `warmUp`. It is the only navigation this server makes before a tool has asked for one.
 *
 * Both of the pages that matter have an mtop response tap on them. The page's own calls succeed where ours time out --
 * goofish attaches a per-request anti-bot blob the mtop client adds for calls it originates -- so the
 * honest way to read item detail or search results is to let the page make the call and read what
 * comes back, rather than to re-issue it and get a TIMEOUT. See `observe`.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { BrowserError, NavigationError } from './errors.ts';
import { MTOP_CALL_JS, MTOP_READY_JS } from './extract.ts';
const ALLOWED_HOSTS = ['www.goofish.com', 'goofish.com'];

// The values here are URL parts, so they carry their separators ('https:').
const ALLOWED_SCHEMES = ['https:'];
export const HOME = 'https://www.goofish.com/';
// The page used purely to get the mtop client up. The homepage works for that, but it is a heavy document: measured 20.2s to domcontentloaded on a slow link, against 3.5s for an item page, and mtop is already live at domcontentloaded either way. So we boot on the cheap page and every mtop-only tool works from there -- verified: the feed and the match counter both return normal data from an item-page context.
export const BOOT_URL = 'https://www.goofish.com/item?id=1045171414271';

const NAV_TIMEOUT_MS = 60_000;
// The one navigation budget that is not a caller's. The boot warm-up pays the session's first load,
// and it is the only reason this server touches goofish before anybody asks: measured, that first load
// is 12.4s for an item page and the mayor measured 15-41s for the first search, while every call after
// it is warm. Bounded, because a warm-up nobody asked for must not outlive its usefulness.
const WARM_NAV_TIMEOUT_MS = 45_000;
// A page with less than this much text on it is a refusal or an error notice, not an app: the
// risk-control page measured 35 bytes. The bound is what keeps the marker test honest -- a real
// listing mentions none of these strings, but a real listing also has thousands of characters.
const DECLINE_LIMIT_CHARS = 800;
// Playwright's page.evaluate has NO timeout: an in-page promise that never settles (an mtop request that hangs, a page that stops responding) would hang the tool call forever, and that actually happened. Every evaluate goes through a bounded race.
const EVALUATE_TIMEOUT_S = 90;
// A batched mtop call carries its own ~20s server-side timeout per API, so a multi-page feed legitimately needs longer.
const MTOP_TIMEOUT_S = 240;
const MTOP_READY_MS = 6000, PROBE_TIMEOUT_S = 5;   // how long `call` gives the mtop client to come up, and the ceiling on one readiness probe -- a hung evaluate (90s by default) inside a 6s wait is not a 6s wait
// Playwright failures that race with the page's own navigation rather than being a real failure, so they are worth one more try. A dead target is not in here: that needs a relaunch, not a retry.
const TRANSIENT = ['execution context', 'cannot find context', 'while navigating'];
const LAUNCH_HINT = 'This server needs a Chromium it can launch itself. Try:\n  npx playwright install chromium\nor point XIANYU_BROWSER_PATH at an existing Chrome/Chromium binary.\nIt launches windowed because goofish serves headless Chromium its risk-control page ("非法访问") instead of the app, which leaves the three DOM tools with nothing to read; that needs a display, so set XIANYU_HEADLESS=1 to run it headless if you have to -- the mtop tools work either way.';

// The API name is the path segment after /h5/ on any mtop host. Every response we tap is matched on
// that rather than on the host, so a bundle, a beacon or a different service on the page is ignored
// whichever of goofish's hosts it came from.
const MTOP_PATH = /\/h5\/(mtop\.[^/]+)\/\d/;
const apiOf = (url: string): string => { try { return new URL(url).pathname.match(MTOP_PATH)?.[1] ?? ''; } catch { return ''; } };

/** One tapped mtop response: goofish's own `ret`, and its `data` when there is any. */
export type MtopReply = { api: string; ret: string; ok: boolean; data: any };

/** The most extra DOM pages a session will ever hold open at once, whatever a caller asks for.
 *
 *  Four is not a round number chosen here: it is the width the fan-out was measured at, and four is
 *  where each listing's own latency stopped improving (11.4s -> 20.5s at four) while the wall clock
 *  kept falling (2.4x). Above that the measurement says nothing, and a fan-out whose width was never
 *  measured is a fan-out that can be turned up by a typo and answer with zero listings. So the bound
 *  lives here rather than in the caller: `fanoutSurface` refuses a slot outside it, and the width the
 *  detail walk asks for is clamped to it before it asks. */
export const DETAIL_POOL_MAX = 4;

/** One leased DOM page: the page, the tap on the mtop replies its own bundle produced, and the
 *  verdict on the load that put it there.
 *
 *  All three travel together rather than the last two living on the session, because a fan-out has
 *  two of these in flight at once and a shared `Session.lastLoad` can only name whichever load
 *  finished last -- which is how a decline would get attached to the wrong listing. */
export type DomSurface = { page: Page; tap: MtopTap; load: { url: string; declined: string; ms: number } };

/** A bounded collector for the mtop responses a page makes on our behalf.
 *
 *  `want` names the API to wait for; `take` returns what arrived and forgets it, so a second wait for
 *  the same API cannot be answered by a reply left over from an earlier call. `note` drops a reply that
 *  is already known to be a failure (an RGV587 throttle, a session error) so a later wait is not
 *  handed it, and a `seen` reply -- one this collector has already handed out -- is likewise never
 *  returned twice. */
export class MtopTap {
  private readonly replies = new Map<string, MtopReply[]>();
  private readonly waiters = new Map<string, ((r: MtopReply) => void)[]>();
  private readonly onReply?: (r: MtopReply) => void;
  constructor(onReply?: (r: MtopReply) => void) { this.onReply = onReply; }
  record(r: MtopReply): void {
    const list = this.replies.get(r.api) ?? [];
    list.push(r);
    // Bounded: a long-lived page fires these on every scroll and every feed rail, and an unbounded
    // array of full search payloads is a memory leak with a 70s search attached to it.
    while (list.length > 8) list.shift();
    this.replies.set(r.api, list);
    this.onReply?.(r);
    for (const resolve of this.waiters.get(r.api) ?? []) resolve(r);
    this.waiters.delete(r.api);
  }
  /** Take the next unclaimed reply for `api`, or wait up to `timeoutMs` for one. null means none came. */
  async take(api: string, timeoutMs: number): Promise<MtopReply | null> {
    const pending = this.replies.get(api) ?? [];
    if (pending.length) return pending.shift()!;
    if (!(timeoutMs > 0)) return null;
    return new Promise<MtopReply | null>((resolve) => {
      const list = this.waiters.get(api) ?? [];
      const timer = setTimeout(() => {
        this.waiters.set(api, (this.waiters.get(api) ?? []).filter((w) => w !== done));
        resolve(null);
      }, timeoutMs);
      const done = (r: MtopReply): void => { clearTimeout(timer); resolve(r); };
      list.push(done);
      this.waiters.set(api, list);
    });
  }
  /** Forget everything, so the next navigation's replies are never confused with the last page's. */
  clear(): void { this.replies.clear(); }
}

/** Return `url` if it is an https goofish page, else refuse to navigate at all. Host and scheme are both checked, by exact comparison against the parsed parts, so there is no normalisation step that could be got wrong: once parsed, `https://www.goofish.com@evil.com/` is evil.com and `file://www.goofish.com/x` is not https. A URL the parser cannot even read is refused too, as a NavigationError. */
export function ensureGoofishUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(String(url)); } catch (e) { throw new NavigationError(`refusing to load ${JSON.stringify(url)}: unparseable URL (${e})`); }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol) || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new NavigationError(`refusing to load ${parsed.protocol}//${parsed.hostname || url}: this server only opens https://${ALLOWED_HOSTS.join(', ')}`);
  }
  return url;
}
let queue: Promise<unknown> = Promise.resolve();
/** Serialise the calls that share the one navigating page. Only the DOM tools need this: they read
 *  whatever is currently in `domPage`, so two at once would navigate it out from under each other and
 *  one would report the other's page as its own data. The mtop-only tools run on `apiPage` and do not
 *  take this lock, so a 70s search no longer blocks a 1.5s feed call. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}
const EVAL_TIMEOUT = Symbol('evaluate-timeout');
async function race<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(EVAL_TIMEOUT), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}
/** `page.evaluate`, bounded in time and with exceptions turned into typed errors. goofish's SPA can destroy the execution context by navigating out from under an in-flight evaluate; that is a race rather than a failure, so it gets one more try. Everything else becomes a BrowserError the caller can act on, instead of a raw Playwright exception escaping a tool call. */
export async function evaluate<T = any>(page: Page, fn: any, arg?: any, what = 'in-page script', timeoutS = EVALUATE_TIMEOUT_S): Promise<T> {
  let last: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await race<T>(page.evaluate(fn, arg), timeoutS * 1000); }
    catch (e) {
      last = e;
      if (attempt || !TRANSIENT.some((m) => String(last).toLowerCase().includes(m))) break;
      await settle(page, 500);
    }
  }
  if (last === EVAL_TIMEOUT) {
    throw new BrowserError(`${what} timed out after ${timeoutS}s. goofish did not answer; the page is most likely serving an empty shell or the network is dropping the request. Retry, or use browse_feed, which only needs the mtop client once.`);
  }
  throw new BrowserError(`${what} failed: ${last}. The page may have been navigated away or the browser closed; retry the call.`);
}

export async function settle(page: Page, ms: number): Promise<void> {
  try { await page.waitForTimeout(ms); } catch (e) { throw new BrowserError(`the browser went away while waiting: ${e}`); }
}
/** The only place a URL we chose is loaded from. */
async function load(page: Page, url: string, timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
  catch (e) { throw new BrowserError(`could not load ${url}: ${e}`); }
}

/** Has goofish served its whole-page refusal instead of the app? `'risk_control'`, `'site_error'`, or
 *  `''` for a page that may still be booting.
 *
 *  Both are 200s that render nothing, and both used to be discovered by running out the clock: the
 *  risk-control page never grows an mtop client, so `waitForMtop` sat on it for its full 15s, and the
 *  detail call the item page makes for itself is never made on it either, so the caller's own poll ran
 *  to the end as well. Measured on the item page: a declined load issues no `mtop.taobao.idle.pc.detail`
 *  request at all, so the page text is the only evidence there is -- and it is there from the first
 *  paint.
 *
 *  The marker test alone would be wrong in the other direction: `非法访问` can appear in a healthy page's
 *  payload. So the marker has to come with the emptiness, which is the part goofish actually
 *  guarantees. `textContent` rather than `innerText`, because this runs on every load and `innerText`
 *  forces a layout the answer does not need. */
const DECLINE_JS = () => {
  const { document } = globalThis as any;
  const text = String(document?.body?.textContent ?? '');
  return {
    chars: text.length,
    risk_control: /非法访问|使用正常浏览器访问闲鱼/.test(text),
    site_error: /网络不见了|服务异常|页面不存在|网络异常/.test(text),
  };
};
/** One bounded, non-throwing read of `DECLINE_JS`. A probe that errors is "not a refusal", because a
 *  page still booting is a reason to keep waiting, never a reason to name a decline. */
async function probeDecline(page: Page): Promise<string> {
  try {
    const v = await evaluate<{ chars: number; risk_control: boolean; site_error: boolean }>(page, DECLINE_JS, undefined, 'decline check', PROBE_TIMEOUT_S);
    if (!v || v.chars >= DECLINE_LIMIT_CHARS) return '';
    return v.risk_control ? 'risk_control' : v.site_error ? 'site_error' : '';
  } catch { return ''; }
}
/** Cache-busted reload, so a cached empty shell does not stick. The second of the two navigation sites, and like `open` it re-checks the allowlist -- on the URL that actually landed, which is not something we chose. That NavigationError is deliberately not swallowed: `search_items`, `item_view` and `recommendations` all scrape whatever is here next, so a bounce off-site must stop them. Load failures still fall through to a plain reload, and a dead browser is retyped by the next evaluate.
 *
 *  The nonce looked like the wrong way round and was measured to be the right way round (probe10, n=7
 *  a side, alternating, same URL): a plain `page.reload()` of a document this session already has
 *  measured a median of 6.3s to `domcontentloaded` (3.4-12.9, 6 of 7 answered), where the
 *  cache-busted load measured 3.9s (3.0-12.0, 7 of 7). The spread overlaps, so the honest reading is
 *  "the cache bust is not the cold load it looks like" rather than "reload is slower" -- Chromium
 *  revalidates the document either way, and what a nonce actually buys is escaping a *cached* empty
 *  shell, which is the failure this exists for. The retry that genuinely re-pays a cold load is the
 *  session's first one, and that is paid at boot now; see `warmUp`. */
export async function reloadFresh(page: Page): Promise<void> {
  let base = HOME;
  try { base = ensureGoofishUrl(page.url().split('#')[0].replace(/[?&]_r\d+/, '')); } catch { /* off-site: use HOME */ }
  try { await load(page, `${base}${base.includes('?') ? '&' : '?'}_r${Date.now()}`); }
  catch { try { await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch { /* the next evaluate retypes it */ } }
  ensureGoofishUrl(page.url());
}

/** One bounded mtop-readiness probe that cannot throw. `true` ready, `false` not yet. A probe that
 *  errors (timed out, context swapped mid-navigation) is reported as "not ready" rather than raised,
 *  so a page that is still booting is a reason to keep waiting, not to fail the call. */
async function probeMtop(page: Page): Promise<boolean> {
  try { return (await evaluate(page, MTOP_READY_JS, undefined, 'mtop readiness check', PROBE_TIMEOUT_S)) === 'ready'; }
  catch { return false; }
}

/** Wait for the page's own mtop client to appear. False means it never did. Bounded by the clock, not by an iteration count, and each probe carries its own short timeout -- an unbounded evaluate inside a bounded loop is a 75-minute wait wearing a 15-second label. */
export async function waitForMtop(page: Page, timeoutMs = 15_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // A probe that times out is not a verdict: the page is simply not answering yet. That is the
    // normal state of a slow load, and it used to throw out of `open()` and take the whole tool call
    // with it -- a page that was still booting is exactly the page a caller wants to come back to.
    // Only an explicit `false` or an exhausted clock ends the wait.
    if (await probeMtop(page)) return true;
    await settle(page, 300);
  }
  return false;
}

type BrowserProc = { exitCode: number | null; killed: boolean; kill(sig: string): void };
/** A launched Chromium's OS process. Playwright types `process()` off `BrowserServer`, not `Browser`. */
const procOf = (browser: Browser): BrowserProc | null => {
  try { return (browser as unknown as { process?: () => BrowserProc }).process?.() ?? null; } catch { return null; }
};
/** SIGKILL it, if it is still there. Synchronous, and deliberately not awaited by anyone. */
const killProcessOf = (browser: Browser): void => {
  const proc = procOf(browser);
  if (proc && proc.exitCode === null && !proc.killed) { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
};

/** Lazily-launched, reused, logged-out browser session. */
export class Session {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private apiPage: Page | null = null;
  private domPage: Page | null = null;
  launches = 0;
  /** What the last `open` load actually got: where it ended, whether goofish served its refusal
   *  instead of the app, and how long it took. Read by `item_view`'s attempt loop so a decline is named
   *  after one load rather than five, and published by `capabilities`. A page that is merely slow says
   *  nothing here, so a caller cannot read a refusal into a slow site.
   *
   *  `domPage`'s loads only, and deliberately: a fan-out has its own pages and its own verdicts, which
   *  travel with the lease (`DomSurface.load`) rather than through here, so two concurrent loads
   *  cannot overwrite each other's. */
  lastLoad: { url: string; declined: string; ms: number } = { url: '', declined: '', ms: 0 };
  /** Extra DOM pages, created on demand by the detail fan-out and by nothing else. Each carries its
   *  own tap, so a reply can never be handed to a page that did not make the call. They are *not* on
   *  the DOM tools' lock because they are not on their page: the fan-out runs inside a lock it already
   *  holds, and no other tool can name slot 0. That is the whole reason the fan-out needed a session
   *  redesign rather than a loop edit -- and it is why the pool is bounded rather than open-ended. */
  private readonly pool: { page: Page; tap: MtopTap }[] = [];
  /** The boot warm-up's outcome, published by `capabilities` so a caller can tell a session that has
   *  already paid its first load from one that is about to make them pay it. `pending` is the normal
   *  answer for the first few seconds of a session, and `failed` costs nothing but the memory it used. */
  readonly warm: { status: 'pending' | 'ready' | 'failed' | 'skipped'; ms: number; detail: string } = { status: 'pending', ms: 0, detail: '' };
  /** The mtop replies each page's own bundle produced, since the page last navigated. */
  readonly apiTap = new MtopTap();
  readonly domTap = new MtopTap();

  private tap(page: Page, tap: MtopTap): void {
    page.on('response', (res) => {
      const api = apiOf(res.url());
      if (!api) return;
      res.json().then((j: any) => {
        const raw = j?.ret;
        const ret = Array.isArray(raw) ? raw.join(' | ') : String(raw ?? '');
        tap.record({ api, ret, ok: ret.includes('SUCCESS'), data: j?.data ?? null });
      }).catch(() => { /* not JSON, or the body is gone: a non-mtop response in the path, nothing to read */ });
    });
  }

  private async launch(): Promise<void> {
    // Windowed by default, and that is a measurement rather than a preference: headed gets goofish's
    // actual app (search page, item pages, 20 cards), headless gets the same URL served as the
    // risk-control page -- "非法访问 ... 请使用正常浏览器访问闲鱼" -- for as long as you watch, with zero
    // cards and 35 bytes of text. So the three DOM tools need a display. The mtop-only tools do not:
    // the page's own client boots on the risk-control page too, which is what they use. XIANYU_HEADLESS=1
    // opts back in, and costs the DOM tools.
    const opts = { headless: process.env.XIANYU_HEADLESS !== '1',
      ...(process.env.XIANYU_BROWSER_PATH ? { executablePath: process.env.XIANYU_BROWSER_PATH } : {}),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-gpu'] };
    // Playwright is loaded here rather than at module scope. It is the heaviest thing this server
    // depends on (measured: 19M of a 73M tree, most of it playwright-core), and a top-level import
    // pays that on every start whether or not a browser is ever launched -- including the four
    // mtop-only tools, which need a page but no Chromium of their own beyond the one they share.
    // Dynamic import also turns "playwright is not installed" into a launch-time message carrying
    // LAUNCH_HINT, instead of a MODULE_NOT_FOUND at startup that says nothing about a browser.
    let chromium;
    try { ({ chromium } = await import('playwright')); }
    catch (e) { throw new BrowserError(`playwright could not be loaded: ${e}\n${LAUNCH_HINT}`); }
    try { this.browser = await chromium.launch(opts); }
    catch (e) { await this.close(); throw new BrowserError(`could not launch Chromium: ${e}\n${LAUNCH_HINT}`); }
    try {   // a brand-new context every time: no profile directory, nothing persisted
      this.context = await this.browser!.newContext({
        locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      });
      this.apiPage = await this.context.newPage();
      this.tap(this.apiPage, this.apiTap);
      this.domPage = await this.context.newPage();
      this.tap(this.domPage, this.domTap);
    } catch (e) { await this.close(); throw new BrowserError(`could not open a fresh browser context: ${e}`); }   // do not leave a browser process running
    this.launches++;
  }

  /** Tear the whole thing down -- context, browser, both pages. The next call relaunches, which is
   *  the point.
   *
   *  This runs on the way out of the process, so it is bounded and it escalates. A `browser.close()`
   *  that hangs -- an evaluate in flight against a page that has stopped answering -- used to leave
   *  the windowed Chromium running after the server had exited: measured, one to two orphaned browser
   *  processes per session, invisible to the client that had already exited. */
  async close(): Promise<void> {
    const context = this.context, browser = this.browser;
    if (!browser) { this.context = this.browser = this.apiPage = this.domPage = null; this.apiTap.clear(); this.domTap.clear(); this.pool.length = 0; return; }
    this.context = this.browser = this.apiPage = this.domPage = null;
    this.apiTap.clear(); this.domTap.clear(); this.pool.length = 0;   // the handles are dead with the context; keeping them would hand a dead page to the next fan-out
    await Promise.race([
      (async () => { await context?.close().catch(() => {}); await browser.close().catch(() => {}); })(),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    // the captured handle, not `this.browser`: it was nulled above so a concurrent caller cannot get
    // a page off a context that is being closed, and that same nulling would leave nothing to kill
    killProcessOf(browser);
  }

  /** The browser's own process, or null. Playwright types `process()` off `BrowserServer` rather than a
   *  launched `Browser`, but a launched Chromium has one at runtime, and it is the only handle that
   *  outlives the node process -- which makes it the only thing that can be used on a synchronous
   *  `process.on('exit')`, where there is no time to await anything. */
  browserProcess(): BrowserProc | null { return this.browser ? procOf(this.browser) : null; }

  /** SIGKILL the browser, synchronously. For the two cases `await close()` cannot cover: a teardown
   *  that was cut short, and an `exit` handler, where the event loop has already stopped. Tolerates a
   *  browser that is already gone, because throwing on the way out of the process helps nobody. */
  killBrowser(): void { if (this.browser) killProcessOf(this.browser); }

  /** Make sure there is a live browser, launching it at most once even if several tools arrive at
   *  once. Two callers used to race here: both saw no page, both closed and relaunched, and the
   *  second close tore the browser out from under the first one's in-flight navigation. The mtop-only
   *  tools no longer queue behind the DOM tools, so they really do arrive together. */
  private booting: Promise<void> | null = null;
  private async ensureLaunched(): Promise<void> {
    // A live page is taken as proof the browser is alive. Treating a missing `Browser` handle as
    // death instead would relaunch on every call that runs before the first launch finishes -- and,
    // worse, the second of two overlapping launches closes the browser the first one is using.
    if ((this.apiPage && !this.apiPage.isClosed()) || (this.domPage && !this.domPage.isClosed())) return;
    this.booting ??= (async () => { await this.close(); await this.launch(); })().finally(() => { this.booting = null; });
    await this.booting;
  }

  /** Serialise everything that *moves* the browser: launching it, parking a page on goofish,
   *  reloading one. Reading a page may be done by several tools at once -- that is the point of two
   *  pages -- but two concurrent navigations on one page abort each other, and that is a
   *  `net::ERR_ABORTED` out of a perfectly healthy browser. Only the mtop-only tools overlap, and
   *  they overlap on the api page, so this is the one place it shows. */
  private moving: Promise<unknown> = Promise.resolve();
  private move<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.moving.then(fn, fn);
    this.moving = run.then(() => {}, () => {});
    return run;
  }

  /** Is `page` on a host the allowlist accepts? `ensureGoofishUrl` is the only thing that gets a say: a hostname that merely *starts* with www.goofish.com -- www.goofish.computer, www.goofish.com.evil.com, www.goofish.com@evil.com -- is not goofish, and a check that skipped the parse let all four through to `ensureReady`, which then ran our JS on whatever was there. */
  private parkedOnGoofish(page: Page | null): boolean { if (!page) return false; try { ensureGoofishUrl(page.url()); return true; } catch { return false; } }

  /** Return a live page parked on goofish, relaunching the browser if it died. The browser is only
   *  relaunched when there is no usable page at all -- a page that is open is proof enough that the
   *  browser behind it is alive, and treating a missing `Browser` handle as death would relaunch on
   *  every call. */
  private async revive(page: Page | null): Promise<Page> {
    if (page && !page.isClosed() && this.parkedOnGoofish(page)) return page;
    return this.move(async () => {
      await this.ensureLaunched();
      if (!this.apiPage || this.apiPage.isClosed()) { const fresh = await this.context!.newPage(); this.tap(fresh, this.apiTap); this.apiPage = fresh; }
      const live = this.apiPage!;
      if (!this.parkedOnGoofish(live)) { await load(live, BOOT_URL); if (!this.parkedOnGoofish(live)) throw new NavigationError(`the browser would not settle on goofish: it landed on ${live.url()}`); }
      return live;
    });
  }

  /** The page that never navigates: everything the mtop-only tools need, and nothing else. */
  async ensureReady(): Promise<Page> {
    const page = await this.revive(this.apiPage);
    if (await waitForMtop(page, 2500)) return page;
    // a reload usually fixes a shell that never finished booting. It moves the page, so it is taken
    // under the same lock -- otherwise two mtop tools that both found a dead shell would reload the
    // page out from under each other.
    await this.move(async () => { await reloadFresh(page); });
    if (!(await waitForMtop(page, (MTOP_TIMEOUT_S * 1000) / 4))) {
      throw new BrowserError("goofish's mtop client is not available on the current page after a reload. The site is probably serving an empty shell; wait a little and retry.");
    }
    return page;
  }

  /** The page the DOM tools share. It is the one that navigates, so it is the one that must be free.
   *  A live page is taken as proof the browser is alive, for the same reason `revive` does: a missing
   *  `Browser` handle alone is not a dead browser, and relaunching on it would cost 5s a call. */
  async domReady(): Promise<Page> {
    if (this.domPage && !this.domPage.isClosed()) return this.domPage;
    return this.move(async () => {
      await this.ensureLaunched();
      if (this.domPage && !this.domPage.isClosed()) return this.domPage;   // another caller won the race
      const page = await this.context!.newPage();
      this.tap(page, this.domTap);
      this.domTap.clear();
      this.domPage = page;
      return page;
    });
  }

  /** Pay the session's first load in the background, at boot, on a page of its own.
   *
   *  Measured against this site: the first item page of a session costs 12.4s (probe9/probe7) and the
   *  mayor measured 15-41s for the first search, while every call after that is warm. None of that is
   *  unavoidable -- it is a cold browser, a cold connection and a cold document cache -- so it is paid
   *  before anyone asks rather than by whoever asks first.
   *
   *  Three properties make it safe to run unasked, and each is load-bearing:
   *  • its own page, never `apiPage` or `domPage`. Warming a shared page means navigating it, and the
   *    only thing that makes those navigations safe is the `move` lock -- so taking that lock for a
   *    background load would queue the user's first call behind a load nobody asked for, which is the
   *    one thing a warm-up must never do. Nothing else can see this page, so nothing can collide.
   *  • the shared context cache is the whole point of it. A `BrowserContext` shares its HTTP cache, so
   *    the document and bundle loaded here are the ones the real pages find warm. `BOOT_URL` is an
   *    item page, so it warms the DOM tools' document as well as the client the mtop tools need.
   *  • it may fail. Every throw is caught and recorded under `warm`; nothing rethrows, nothing retries,
   *    and the next real call behaves exactly as it did before. `XIANYU_NO_WARMUP=1` skips it
   *    entirely, for a session that will only ever ask `capabilities`.
   */
  warmUp(): Promise<void> {
    if (process.env.XIANYU_NO_WARMUP === '1') { this.warm.status = 'skipped'; this.warm.detail = 'XIANYU_NO_WARMUP=1'; return Promise.resolve(); }
    this.warming ??= this.warmNow().finally(() => { this.warming = null; });
    return this.warming;
  }
  private warming: Promise<void> | null = null;
  private async warmNow(): Promise<void> {
    const began = Date.now();
    let page: Page | null = null;
    try {
      // A session that is already warm gets nothing from this and would pay for it twice.
      if (this.parkedOnGoofish(this.apiPage)) { this.warm.status = 'skipped'; this.warm.detail = 'the session was already warm'; return; }
      await this.ensureLaunched();
      page = await this.context!.newPage();
      await load(page, BOOT_URL, WARM_NAV_TIMEOUT_MS);
      this.warm.status = 'ready'; this.warm.detail = '';
    } catch (e: unknown) {
      // Recorded, never raised: a warm-up that throws into the boot path is a server that starts broken.
      this.warm.status = 'failed'; this.warm.detail = String((e as Error)?.message ?? e).slice(0, 200);
    } finally {
      this.warm.ms = Date.now() - began;
      // Closed either way. It has warmed what it shares with the other pages by now; a third page
      // holding a rendered listing is a renderer process this server does not need to keep.
      await page?.close().catch(() => {});
    }
  }

  /** Load a goofish URL into `page`, wait for its mtop client, and hand back the page with its own
   *  tap and the verdict on the load. The one function that navigates a page this caller owns, which
   *  is why `open` and `fanoutSurface` both go through it: a second navigation site is a second place
   *  the allowlist check can be left out, and the check is the only thing between this server and a
   *  scraper aimed at whatever goofish redirected us to.
   *
   *  The allowlist is checked before the load and again afterwards, and once more on the way out:
   *  goto follows redirects, so goofish itself (a risk-control bounce, say) could otherwise land us
   *  somewhere we would then scrape as if it were a listing -- and the settle and mtop wait below are
   *  tens of seconds of following the page around, so the last check is the one that is actually
   *  current when the caller scrapes. Nothing here clicks the login dialog: it is an overlay over
   *  content that is already in the DOM, and closing it measurably *stopped* the result list from
   *  rendering.
   *
   *  The decline check between the settle and the mtop wait is worth its own line: a page goofish has
   *  refused never grows an mtop client, so waiting for one there buys exactly the clock -- up to 15s,
   *  per load, on the loads that are already lost. The verdict travels out with the surface, because
   *  the caller is the only one that can act on it: its attempt loop is what has to stop early, and it
   *  has to stop early for *its* load rather than for whichever one finished last.
   *
   *  Deliberately not taken under `move`: the lock serialises navigations on a page *shared* with
   *  another caller, and each pool page belongs to exactly one fan-out slot. Taking it here would put
   *  two listings' loads back in a queue, which is the entire thing the fan-out is not. */
  private async loadInto(page: Page, tap: MtopTap, url: string): Promise<DomSurface> {
    const target = ensureGoofishUrl(url);
    tap.clear();   // replies from the page we are leaving are not answers about the new one
    const began = Date.now();
    await load(page, target);
    ensureGoofishUrl(page.url());
    // 800ms so the page has begun painting; callers then poll for the content they actually need, which beats a longer fixed sleep.
    await settle(page, 800);
    const declined = await probeDecline(page);
    const verdict = { url: page.url(), declined, ms: Date.now() - began };
    if (!declined) await waitForMtop(page);
    ensureGoofishUrl(page.url());
    return { page, tap, load: verdict };
  }

  /** Load a goofish URL into the DOM page and wait for mtop, for the tools that share it. The verdict
   *  is also published on `lastLoad`, which is how a caller that reached for the shared page reads it. */
  async open(url: string): Promise<Page> {
    const surface = await this.loadInto(await this.domReady(), this.domTap, url);
    this.lastLoad = surface.load;
    return surface.page;
  }

  /** Lease fan-out slot `i` and load `url` into it: the bounded detail fan-out's private page.
   *
   *  Not the shared `domPage`, and that is the point. The caller is inside a `search_items`, and that
   *  page is holding the search results the fan-out exists to deepen -- navigating it away would
   *  throw away the answers for everything past the first batch. So each slot is its own page with
   *  its own tap, invisible to the DOM tools, and the lock the caller already holds is the only thing
   *  standing between two searches' fan-outs: they cannot overlap, because `exclusive()` wraps the
   *  whole tool rather than this lease.
   *
   *  Bounded by `DETAIL_POOL_MAX` because a pool that grows on request is a pool nobody measured. */
  async fanoutSurface(i: number, url: string): Promise<DomSurface> {
    if (!Number.isInteger(i) || i < 0 || i >= DETAIL_POOL_MAX) throw new BrowserError(`detail fan-out slot ${i} does not exist: a session leases at most ${DETAIL_POOL_MAX} extra DOM pages, and slot ${i} is outside that`);
    return this.loadInto(await this.poolSlot(i), this.pool[i].tap, url);
  }

  /** The page behind a fan-out slot, created on first use and then reused -- so a `detail: 50` walk
   *  pays for one page per slot rather than one per listing. Under `move` because opening a page is
   *  browser-wide state, and two slots asked at once must not both decide the browser was dead. */
  private async poolSlot(i: number): Promise<Page> {
    const have = this.pool[i]?.page;
    if (have && !have.isClosed()) return have;
    return this.move(async () => {
      await this.ensureLaunched();
      const again = this.pool[i]?.page;   // another caller may have opened it while this one waited
      if (again && !again.isClosed()) return again;
      const page = await this.context!.newPage();
      const slot = { page, tap: new MtopTap() };
      this.tap(page, slot.tap);
      this.pool[i] = slot;
      return page;
    });
  }

  /** Run a batch of mtop calls through the api page's own client. Retries with a cache-busted reload:
   * when goofish throttles an IP the page comes back as an empty shell whose bundle never finishes
   * booting, and a second load often gets through. */
  async call(spec: [string, string, any][]): Promise<any> {
    let last = 'not attempted';
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await this.ensureReady();
      await waitForMtop(page, MTOP_READY_MS);
      const result = await evaluate(page, MTOP_CALL_JS, { calls: spec }, `mtop call ${spec[0]?.[1] ?? ''}`, MTOP_TIMEOUT_S);
      if (result?.fatal !== 'mtop-not-ready') return result;
      last = 'mtop-not-ready';
      if (attempt < 2) { await reloadFresh(page); await settle(page, 2000); }
    }
    throw new BrowserError(`goofish's mtop client never became ready after 3 page loads (${last}). Anonymous page rendering is throttled per IP and degrades to an empty shell under sustained use; wait several minutes and retry. browse_feed is the least affected tool, because it needs the mtop client but no rendered listing page.`);
  }
}

let session: Session | null = null;
export const getSession = (): Session => (session ??= new Session());
/** Swap the shared session. Exists so tests and one-off scripts can drive the tools. */
export const setSession = (next: Session | null): void => { session = next; };
