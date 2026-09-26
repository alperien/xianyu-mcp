"""The browser session.

One throwaway Chromium, launched lazily and reused across tool calls (a cold
launch costs ~8s, and these calls are cheap once the page is up). The context is
brand new every time: no profile directory, no stored state, no account, and the
server never reads cookies -- goofish sets its own anonymous `tfstk` when the page
loads, and we never look at it.

Only https://goofish.com is ever loaded. `ensure_goofish_url` enforces host *and*
scheme, and every `page.goto` in this package goes through one of the two helpers
below, which re-check that. Tool calls are serialised by `exclusive()`: there is
one page, so two at once would navigate it out from under each other.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

from .errors import BrowserError, NavigationError
from .extract import DISMISS_LOGIN_JS, MTOP_CALL_JS, MTOP_READY_JS

ALLOWED_HOSTS = {"www.goofish.com", "goofish.com"}
ALLOWED_SCHEMES = {"https"}
HOME = "https://www.goofish.com/"

# The page used purely to get the mtop client up. The homepage works for that, but it
# is a heavy document: measured 20.2s to domcontentloaded on a slow link, against 3.5s
# for an item page, and mtop is already live at domcontentloaded either way. So we boot
# on the cheap page and every mtop-only tool works from there -- verified: the feed and
# the match counter both return normal data from an item-page context.
BOOT_URL = "https://www.goofish.com/item?id=1045171414271"

# Navigation timeout, shared by every load in this package.
NAV_TIMEOUT_MS = 60_000

# Playwright's page.evaluate has NO timeout: if an in-page promise never settles (an
# mtop request that hangs, a page that stops responding), the await blocks forever and
# the MCP call never returns. Every evaluate goes through a bounded wait instead.
EVALUATE_TIMEOUT_S = 90
# A batched mtop call carries its own 20s server-side timeout per API, so a multi-page
# feed legitimately needs longer.
MTOP_TIMEOUT_S = 240

# Playwright failures that are a race with the page's own navigation rather than a
# real failure, and so are worth one more try. A dead target is not in here: that
# needs a relaunch, not a retry.
TRANSIENT_PW_ERRORS = (
    "execution context",
    "cannot find context",
    "while navigating",
)

LAUNCH_HINT = (
    "This server needs a Chromium it can launch itself. Try:\n"
    "  python -m playwright install chromium\n"
    "or point XIANYU_BROWSER_PATH at an existing Chrome/Chromium binary.\n"
    "Set XIANYU_HEADLESS=0 to run it windowed (not required -- browsing works headless)."
)


def ensure_goofish_url(url: str) -> str:
    """Return `url` if it is an https goofish page, else refuse to navigate at all.

    Host and scheme are both checked, by exact comparison: once parsed,
    `https://www.goofish.com@evil.com/` is evil.com and `file://www.goofish.com/x`
    is not https, and there is no normalisation step that could be got wrong. A URL
    urlparse cannot even read (an unterminated IPv6 literal, say) is refused too, as
    a NavigationError rather than a bare ValueError.
    """
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except ValueError as e:
        raise NavigationError(f"refusing to load {url!r}: unparseable URL ({e})") from e
    if parsed.scheme.lower() not in ALLOWED_SCHEMES or host not in ALLOWED_HOSTS:
        raise NavigationError(
            f"refusing to load {parsed.scheme or 'no-scheme'}://{host or url}: this server "
            f"only opens https://{', '.join(sorted(ALLOWED_HOSTS))}"
        )
    return url


def headless() -> bool:
    return os.environ.get("XIANYU_HEADLESS", "1") != "0"


def browser_path() -> str | None:
    return os.environ.get("XIANYU_BROWSER_PATH") or None


async def evaluate(
    page: Any,
    js: str,
    arg: Any = None,
    *,
    what: str = "in-page script",
    timeout: float = EVALUATE_TIMEOUT_S,
) -> Any:
    """`page.evaluate`, bounded in time and with exceptions turned into typed errors.

    Two things matter here. First, a timeout: Playwright does not impose one, so an
    in-page promise that never settles would hang the tool call indefinitely. Second,
    goofish's SPA can destroy the execution context by navigating out from under an
    in-flight evaluate; that is a race rather than a failure, so it gets one more try.
    Everything else becomes a BrowserError the caller can act on, instead of a raw
    Playwright exception escaping a tool call.
    """
    last: Exception | None = None
    for attempt in range(2):
        try:
            coro = page.evaluate(js) if arg is None else page.evaluate(js, arg)
            return await asyncio.wait_for(coro, timeout=timeout)
        except TimeoutError as e:
            last = e
            break
        except Exception as e:  # noqa: BLE001 -- playwright raises its own hierarchy
            last = e
            if attempt or not any(m in str(e).lower() for m in TRANSIENT_PW_ERRORS):
                break
            with contextlib.suppress(Exception):
                await page.wait_for_timeout(500)
    if isinstance(last, TimeoutError):
        raise BrowserError(
            f"{what} timed out after {timeout:.0f}s. goofish did not answer; the page is "
            "most likely serving an empty shell or the network is dropping the request. "
            "Retry, or use browse_feed, which only needs the mtop client once."
        ) from last
    raise BrowserError(
        f"{what} failed: {last}. The page may have been navigated away or the browser "
        "closed; retry the call."
    ) from last


async def settle(page: Any, ms: int) -> None:
    """`page.wait_for_timeout`, with a dead browser reported as a typed error."""
    try:
        await page.wait_for_timeout(ms)
    except Exception as e:  # noqa: BLE001
        raise BrowserError(f"the browser went away while waiting: {e}") from e


async def _goto(page: Any, url: str) -> None:
    """The only place a URL we chose is loaded from."""
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    except Exception as e:  # noqa: BLE001
        raise BrowserError(f"could not load {url}: {e}") from e


async def reload_fresh(page: Any) -> None:
    """Cache-busted reload, so a cached empty shell does not stick.

    The URL is re-checked against the allowlist: this is wherever the page ended up,
    not something we chose. Navigation failures are not fatal here -- the caller
    re-scrapes either way, and if the browser really is gone the next evaluate says
    so in our own error vocabulary.
    """
    base = HOME
    with contextlib.suppress(Exception):
        base = ensure_goofish_url(page.url.split("#")[0])
    joiner = "&" if "?" in base else "?"
    try:
        await page.goto(f"{base}{joiner}_r{int(time.time() * 1000)}",
                        wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        return
    except Exception:  # noqa: BLE001
        pass
    with contextlib.suppress(Exception):
        await page.reload(wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)


class Session:
    """Lazily-launched, reused, logged-out browser session."""

    def __init__(self) -> None:
        self._pw: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._page: Any = None
        self._lock = asyncio.Lock()
        self.launches = 0

    async def _launch(self) -> None:
        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        kwargs: dict[str, Any] = {
            "headless": headless(),
            "args": [
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
            ],
        }
        path = browser_path()
        if path:
            kwargs["executable_path"] = path
        try:
            self._browser = await self._pw.chromium.launch(**kwargs)
        except Exception as e:  # noqa: BLE001
            await self._hard_stop()
            raise BrowserError(f"could not launch Chromium: {e}\n{LAUNCH_HINT}") from e

        try:
            self._context = await self._browser.new_context(
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
                viewport={"width": 1440, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/146.0.0.0 Safari/537.36"
                ),
            )
            # A brand-new context every time: no profile directory, nothing persisted.
            self._page = await self._context.new_page()
        except Exception as e:  # noqa: BLE001 -- do not leave a browser process running
            await self._hard_stop()
            raise BrowserError(f"could not open a fresh browser context: {e}") from e
        self.launches += 1

    async def _hard_stop(self) -> None:
        for closer in (getattr(self._context, "close", None), getattr(self._browser, "close", None)):
            if closer is None:
                continue
            with contextlib.suppress(Exception):
                await closer()
        if self._pw is not None:
            with contextlib.suppress(Exception):
                await self._pw.stop()
        self._pw = self._browser = self._context = self._page = None

    async def close(self) -> None:
        async with self._lock:
            await self._hard_stop()

    async def page(self) -> Any:
        """Return a live page parked on goofish, relaunching the browser if it died."""
        async with self._lock:
            if self._page is None or self._page.is_closed():
                await self._hard_stop()
                await self._launch()
            if not self._page.url.startswith("https://www.goofish.com"):
                await _goto(self._page, BOOT_URL)
            return self._page

    async def ensure_ready(self) -> Any:
        """Return a page whose mtop client is live, navigating only if it has to.

        The mtop-only endpoints (feed, hitnum, suggest, recommend) need the page's own
        client and nothing else. Navigating to the homepage on every call threw away
        10-25s per call on a slow link for no reason -- the page is almost always
        already parked on goofish with the client booted. So: only navigate when there
        is no page, it is off-site, or the client is not up.
        """
        page = await self.page()
        if await wait_for_mtop(page, timeout_ms=2500):
            return page
        # Not ready: a reload usually fixes a shell that never finished booting.
        await reload_fresh(page)
        if not await wait_for_mtop(page, timeout_ms=MTOP_TIMEOUT_S * 1000 / 4):
            raise BrowserError(
                "goofish's mtop client is not available on the current page after a reload. "
                "The site is probably serving an empty shell; wait a little and retry."
            )
        return page

    async def open(self, url: str) -> Any:
        """Load a goofish URL, dismiss the login popup, and wait for mtop.

        The allowlist is checked before navigating and again afterwards: goto follows
        redirects, so goofish itself (a risk-control bounce, say) could otherwise
        land us somewhere we would then scrape as if it were a listing.
        """
        target = ensure_goofish_url(url)
        page = await self.page()
        await _goto(page, target)
        ensure_goofish_url(page.url)
        # 800ms is enough for the dialog to exist to be clicked; callers then poll for
        # the content they actually need, which beats a longer fixed sleep.
        await settle(page, 800)
        await dismiss_login(page)
        await wait_for_mtop(page)
        return page

    async def call(self, spec: list[list[Any]]) -> dict[str, Any]:
        """Run a batch of mtop calls through the page's own client.

        Retries with a cache-busted reload: when goofish throttles an IP the page
        comes back as an empty shell whose bundle never finishes booting, and a
        second load often gets through.
        """
        last = "not attempted"
        what = f"mtop call {spec[0][1]}" if spec else "mtop call"
        for attempt in range(3):
            page = await self.page()
            for _ in range(20):
                if await evaluate(page, MTOP_READY_JS, what="mtop readiness check") == "ready":
                    break
                await settle(page, 300)
            result = await evaluate(page, MTOP_CALL_JS, {"calls": spec}, what=what,
                                   timeout=MTOP_TIMEOUT_S)
            if isinstance(result, dict) and result.get("fatal") == "mtop-not-ready":
                last = "mtop-not-ready"
            else:
                return result
            if attempt < 2:
                await reload_fresh(page)
                await settle(page, 2000)
        raise BrowserError(
            f"goofish's mtop client never became ready after 3 page loads ({last}). "
            "Anonymous page rendering is throttled per IP and degrades to an empty shell "
            "under sustained use; wait several minutes and retry. browse_feed is the least "
            "affected tool, because it needs the mtop client but no rendered listing page."
        )


async def dismiss_login(page: Any) -> int:
    """Close the anonymous-visitor login dialog. Returns how many controls were hit."""
    try:
        n = await evaluate(page, DISMISS_LOGIN_JS, what="login-dialog dismissal")
    except BrowserError:
        return 0   # no dialog, or no page; either way there is nothing to dismiss
    return int(n or 0)


async def wait_for_mtop(page: Any, timeout_ms: int = 15_000) -> bool:
    """Wait for the page's own mtop client to appear. False means it never did."""
    waited = 0
    while waited < timeout_ms:
        if await evaluate(page, MTOP_READY_JS, what="mtop readiness check") == "ready":
            return True
        await settle(page, 300)
        waited += 300
    return False


# One browser, one page: two tool calls in flight would navigate it out from under
# each other, and one of them would report the other's page as its own data.
_TOOL_LOCK = asyncio.Lock()


@asynccontextmanager
async def exclusive() -> AsyncIterator[None]:
    """Hold the browser for one tool call at a time."""
    async with _TOOL_LOCK:
        yield


_SESSION: Session | None = None


def get_session() -> Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = Session()
    return _SESSION
