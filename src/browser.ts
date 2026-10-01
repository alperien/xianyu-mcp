/**
 * The browser session. One throwaway Chromium, launched lazily and reused across tool calls (a cold launch costs ~5s, and these calls are cheap once the page is up). The context is brand new every time: no profile directory, no stored state, no account, and this package never reads cookies -- goofish sets its own anonymous ones when the page loads and we never look at them. Only https://goofish.com is ever loaded, and every navigation goes through `load` after `ensureGoofishUrl` has checked host *and* scheme.
 *
 * Two pages, not one. `apiPage` is parked on `BOOT_URL` and never navigates again: it exists only to
 * give the four mtop tools a live client, and a tool call that needs nothing but mtop must not queue
 * behind a 70s search. `domPage` is the one that navigates, so the DOM-scraping tools still serialise
 * against each other and still cannot be read out from under one another. Measured: with a single page
 * a `search_items` call that takes 70s blocks `browse_feed`, which does 1.5s of real work.
 *
 * Both pages have an mtop response tap on them. The page's own calls succeed where ours time out --
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
// Playwright's page.evaluate has NO timeout: an in-page promise that never settles (an mtop request that hangs, a page that stops responding) would hang the tool call forever, and that actually happened. Every evaluate goes through a bounded race.
const EVALUATE_TIMEOUT_S = 90;
// A batched mtop call carries its own ~20s server-side timeout per API, so a multi-page feed legitimately needs longer.
const MTOP_TIMEOUT_S = 240;
const MTOP_READY_MS = 6000, PROBE_TIMEOUT_S = 5;   // how long `call` gives the mtop client to come up, and the ceiling on one readiness probe -- a hung evaluate (90s by default) inside a 6s wait is not a 6s wait
// Playwright failures that race with the page's own navigation rather than being a real failure, so they are worth one more try. A dead target is not in here: that needs a relaunch, not a retry.
const TRANSIENT = ['execution context', 'cannot find context', 'while navigating'];
const LAUNCH_HINT = 'This server needs a Chromium it can launch itself. Try:\n  npx playwright install chromium\nor point XIANYU_BROWSER_PATH at an existing Chrome/Chromium binary.\nIt launches windowed because goofish serves headless Chromium its risk-control page ("非法访问") instead of the app, which leaves the three DOM tools with nothing to read; that needs a display, so set XIANYU_HEADLESS=1 to run it headless if you have to -- the four mtop tools work either way.';

// The API name is the path segment after /h5/ on any mtop host. Every response we tap is matched on
// that rather than on the host, so a bundle, a beacon or a different service on the page is ignored
// whichever of goofish's hosts it came from.
const MTOP_PATH = /\/h5\/(mtop\.[^/]+)\/\d/;
const apiOf = (url: string): string => { try { return new URL(url).pathname.match(MTOP_PATH)?.[1] ?? ''; } catch { return ''; } };

/** One tapped mtop response: goofish's own `ret`, and its `data` when there is any. */
export type MtopReply = { api: string; ret: string; ok: boolean; data: any };

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
async function load(page: Page, url: string): Promise<void> {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); }
  catch (e) { throw new BrowserError(`could not load ${url}: ${e}`); }
}
/** Cache-busted reload, so a cached empty shell does not stick. The second of the two navigation sites, and like `open` it re-checks the allowlist -- on the URL that actually landed, which is not something we chose. That NavigationError is deliberately not swallowed: `search_items`, `item_view` and `recommendations` all scrape whatever is here next, so a bounce off-site must stop them. Load failures still fall through to a plain reload, and a dead browser is retyped by the next evaluate. */
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
    // cards and 35 bytes of text. So the three DOM tools need a display. The four mtop tools do not:
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
    if (!browser) { this.context = this.browser = this.apiPage = this.domPage = null; this.apiTap.clear(); this.domTap.clear(); return; }
    this.context = this.browser = this.apiPage = this.domPage = null;
    this.apiTap.clear(); this.domTap.clear();
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

  /** The page that never navigates: everything the four mtop-only tools need, and nothing else. */
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

  /** Load a goofish URL into the DOM page and wait for mtop. The allowlist is checked before
   *  navigating and again afterwards, and once more on the way out: goto follows redirects, so goofish
   *  itself (a risk-control bounce, say) could otherwise land us somewhere we would then scrape as if
   *  it were a listing -- and the settle and mtop wait below are tens of seconds of following the page
   *  around, so the last check is the one that is actually current when the caller scrapes. Nothing here
   *  clicks the login dialog: it is an overlay over content that is already in the DOM, and closing it
   *  measurably *stopped* the result list from rendering. */
  async open(url: string): Promise<Page> {
    const target = ensureGoofishUrl(url);
    const page = await this.domReady();
    this.domTap.clear();   // replies from the page we are leaving are not answers about the new one
    await load(page, target);
    ensureGoofishUrl(page.url());
    // 800ms so the page has begun painting; callers then poll for the content they actually need, which beats a longer fixed sleep.
    await settle(page, 800);
    await waitForMtop(page);
    ensureGoofishUrl(page.url());
    return page;
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
