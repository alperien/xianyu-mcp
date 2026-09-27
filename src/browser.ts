/**
 * The browser session. One throwaway Chromium, launched lazily and reused across tool calls (a cold launch costs ~5s, and these calls are cheap once the page is up). The context is brand new every time: no profile directory, no stored state, no account, and this package never reads cookies -- goofish sets its own anonymous ones when the page loads and we never look at them. Only https://goofish.com is ever loaded, and every navigation goes through `load` after `ensureGoofishUrl` has checked host *and* scheme. Tool calls are serialised by `exclusive`: there is one page, so two at once would navigate it out from under each other and one would report the other's page as its own data.
 */
import { chromium } from 'playwright';
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

/** Lazily-launched, reused, logged-out browser session. */
export class Session {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  launches = 0;

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
    try { this.browser = await chromium.launch(opts); }
    catch (e) { await this.close(); throw new BrowserError(`could not launch Chromium: ${e}\n${LAUNCH_HINT}`); }
    try {   // a brand-new context every time: no profile directory, nothing persisted
      this.context = await this.browser!.newContext({
        locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      });
      this.page = await this.context.newPage();
    } catch (e) { await this.close(); throw new BrowserError(`could not open a fresh browser context: ${e}`); }   // do not leave a browser process running
    this.launches++;
  }

  /** Tear the whole thing down -- context, browser, page. The next call relaunches, which is the point. */
  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = this.browser = this.page = null;
  }

  /** Is the page on a host the allowlist accepts? `ensureGoofishUrl` is the only thing that gets a say: a hostname that merely *starts* with www.goofish.com -- www.goofish.computer, www.goofish.com.evil.com, www.goofish.com@evil.com -- is not goofish, and a check that skipped the parse let all four through to `ensureReady`, which then ran our JS on whatever was there. */
  private parkedOnGoofish(): boolean { try { ensureGoofishUrl(this.page!.url()); return true; } catch { return false; } }

  /** Return a live page parked on goofish, relaunching the browser if it died. */
  async currentPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) { await this.close(); await this.launch(); }
    if (!this.parkedOnGoofish()) { await load(this.page!, BOOT_URL); if (!this.parkedOnGoofish()) throw new NavigationError(`the browser would not settle on goofish: it landed on ${this.page!.url()}`); }
    return this.page!;
  }
  /** Return a page whose mtop client is live, navigating only if it has to. The mtop-only endpoints (feed, hitnum, suggest, recommend) need the page's own client and nothing else. Navigating to the homepage on every call threw away 10-25s per call on a slow link for no reason, so: only navigate when there is no page, it is off-site, or the client is not up. */
  async ensureReady(): Promise<Page> {
    const page = await this.currentPage();
    if (await waitForMtop(page, 2500)) return page;
    await reloadFresh(page);   // a reload usually fixes a shell that never finished booting
    if (!(await waitForMtop(page, (MTOP_TIMEOUT_S * 1000) / 4))) {
      throw new BrowserError("goofish's mtop client is not available on the current page after a reload. The site is probably serving an empty shell; wait a little and retry.");
    }
    return page;
  }
  /** Load a goofish URL and wait for mtop. The allowlist is checked before navigating and again afterwards, and once more on the way out: goto follows redirects, so goofish itself (a risk-control bounce, say) could otherwise land us somewhere we would then scrape as if it were a listing -- and the settle and mtop wait below are tens of seconds of following the page around, so the last check is the one that is actually current when the caller scrapes. Nothing here clicks the login dialog: it is an overlay over content that is already in the DOM, and closing it measurably *stopped* the result list from rendering. */
  async open(url: string): Promise<Page> {
    const target = ensureGoofishUrl(url);
    const page = await this.currentPage();
    await load(page, target);
    ensureGoofishUrl(page.url());
    // 800ms so the page has begun painting; callers then poll for the content they actually need, which beats a longer fixed sleep.
    await settle(page, 800);
    await waitForMtop(page);
    ensureGoofishUrl(page.url());
    return page;
  }
  /** Run a batch of mtop calls through the page's own client. Retries with a cache-busted reload: when goofish throttles an IP the page comes back as an empty shell whose bundle never finishes booting, and a second load often gets through. */
  async call(spec: [string, string, any][]): Promise<any> {
    let last = 'not attempted';
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await this.currentPage();
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
