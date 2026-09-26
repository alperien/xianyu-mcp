"""The browser layer's failure handling, with no browser.

The point of these is the promise that a Playwright failure arrives as a typed
XianyuError instead of an exception escaping a tool call, and that navigation
stays on https://goofish.com even when the page itself tries to lead us off.
"""
import asyncio

import pytest

from xianyu_mcp import session as S
from xianyu_mcp.errors import BrowserError, NavigationError, XianyuError


class FakePage:
    """A goofish page good enough for the session layer."""

    def __init__(self, url="https://www.goofish.com/", evaluate=None, goto_lands=None):
        self.url = url
        self.closed = False
        self.goto_calls = []
        self.reload_calls = 0
        self.waits = []
        self.calls = []          # (js, arg) in order
        self._evaluate = evaluate
        self._goto_lands = goto_lands

    async def goto(self, url, **kwargs):
        self.goto_calls.append(url)
        self.url = self._goto_lands or url

    async def reload(self, **kwargs):
        self.reload_calls += 1

    async def evaluate(self, js, arg=None):
        self.calls.append((js, arg))
        if self._evaluate is None:
            return "ready"
        return self._evaluate(js, arg)

    async def wait_for_timeout(self, ms):
        self.waits.append(ms)

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True


class TestNavigationAllowlist:
    """The guard has to hold for anything a prompt-injected argument can spell."""

    @pytest.mark.parametrize(
        "url",
        [
            "https://evil.com/",
            "https://www.goofish.com.evil.com/",
            "https://taobao.com/",
            "https://passport.goofish.com/mini_login.htm",
            "file:///etc/passwd",
            "file://www.goofish.com/etc/passwd",   # right host, wrong scheme
            "http://www.goofish.com/",               # host allowlist is https-only
            "javascript:alert(document.cookie)",
            "data:text/html,<script>fetch('//evil.com')</script>",
            "//evil.com/x",
            "www.goofish.com",
            "https://[::1]/",                        # IPv6 literal
            "https://[::1",                         # unparseable: must be a NavigationError
            "https://www.goofish.com@evil.com/",    # userinfo
            "https://www.goofish.com:8443@evil.com/",
            "https://www.goofish.com%00.evil.com/",
            "https://www.goofish.com\t.evil.com/",
            "https://％ｗｗｗ.goofish.com/",         # fullwidth IDN lookalike
            "https://www.goofish。com/",             # ideographic full stop
            "https://sub.www.goofish.com/",
            "",
        ],
    )
    def test_blocks_everything_else(self, url):
        with pytest.raises(NavigationError):
            S.ensure_goofish_url(url)

    @pytest.mark.parametrize(
        "url",
        [
            "https://www.goofish.com/search?q=x",
            "https://goofish.com/",
            "https://GOOFISH.COM/item?id=1",        # host compare is case-insensitive
            "https://www.goofish.com:8443/x",       # same host, odd port: still goofish
            "https://www.goofish.com/item?id=1#top",
        ],
    )
    def test_allows_goofish(self, url):
        assert S.ensure_goofish_url(url) == url

    def test_unparseable_url_is_a_typed_error_not_a_valueerror(self):
        with pytest.raises(NavigationError):
            S.ensure_goofish_url("https://[::1")


class TestEvaluate:
    async def test_returns_the_pages_answer(self):
        page = FakePage(evaluate=lambda js, arg: {"ok": True, "arg": arg})
        assert await S.evaluate(page, "js", {"a": 1}, what="thing") == {"ok": True, "arg": {"a": 1}}

    async def test_no_arg_scripts_get_a_single_argument(self):
        page = FakePage(evaluate=lambda js, arg: "ready")
        await S.evaluate(page, "js")
        assert page.calls == [("js", None)]

    async def test_wraps_a_dead_browser(self):
        page = FakePage(evaluate=_raise("Target page, context or browser has been closed"))
        with pytest.raises(BrowserError) as exc:
            await S.evaluate(page, "js", what="item-page scrape")
        assert "item-page scrape" in str(exc.value)
        assert isinstance(exc.value, XianyuError)

    async def test_a_timeout_is_typed_and_not_retried(self):
        page = FakePage(evaluate=_raise("Timeout 60000ms exceeded"))
        with pytest.raises(BrowserError):
            await S.evaluate(page, "js")
        assert len(page.calls) == 1

    async def test_a_destroyed_execution_context_is_retried_once(self):
        # goofish's SPA navigating mid-evaluate destroys the context; that is a race.
        page = FakePage(evaluate=_flaky("Execution context was destroyed, most likely because of a navigation."))
        assert await S.evaluate(page, "js") == "second try"
        assert len(page.calls) == 2

    async def test_gives_up_after_one_retry(self):
        page = FakePage(evaluate=_raise("Execution context was destroyed"))
        with pytest.raises(BrowserError):
            await S.evaluate(page, "js")
        assert len(page.calls) == 2

    async def test_browser_error_says_retry(self):
        page = FakePage(evaluate=_raise("Page crashed!"))
        with pytest.raises(BrowserError, match="retry the call"):
            await S.evaluate(page, "js")


class TestSettle:
    async def test_waits(self):
        page = FakePage()
        await S.settle(page, 3500)
        assert page.waits == [3500]

    async def test_a_dead_browser_is_typed(self):
        page = FakePage()
        page.wait_for_timeout = _raise_async("Target closed")
        with pytest.raises(BrowserError, match="went away"):
            await S.settle(page, 300)


class TestReloadFresh:
    async def test_cache_busts_the_current_goofish_url(self):
        page = FakePage(url="https://www.goofish.com/item?id=7")
        await S.reload_fresh(page)
        assert len(page.goto_calls) == 1
        base, _, nonce = page.goto_calls[0].partition("&_r")
        assert base == "https://www.goofish.com/item?id=7"
        assert nonce.isdigit()
        assert page.reload_calls == 0

    async def test_a_failed_goto_falls_back_to_reload(self):
        page = FakePage()
        page.goto = _raise_async("Timeout 60000ms exceeded")
        await S.reload_fresh(page)
        assert page.reload_calls == 1

    async def test_a_dead_page_is_swallowed_for_the_caller_to_retype(self):
        page = FakePage()
        page.goto = _raise_async("Target closed")
        page.reload = _raise_async("Target closed")
        await S.reload_fresh(page)      # must not raise; the next evaluate reports it

    async def test_wandering_off_site_goes_home_rather_than_reloading_it(self):
        # page.url is wherever the page itself decided, so it is re-checked before we
        # follow it: an off-site page must never be reloaded, let alone scraped.
        page = FakePage(url="https://evil.com/steal?_r=1")
        await S.reload_fresh(page)
        assert [u.split("?")[0] for u in page.goto_calls] == [S.HOME]
        assert "evil.com" not in "".join(page.goto_calls)


class TestOpen:
    async def test_dismisses_the_login_dialog_and_waits_for_mtop(self, monkeypatch):
        page = FakePage()
        sess = S.Session()
        sess._page = page
        monkeypatch.setattr(S, "dismiss_login", _record("dismissed"))
        assert await sess.open("https://www.goofish.com/item?id=1") is page
        assert page.goto_calls == ["https://www.goofish.com/item?id=1"]

    async def test_refuses_off_site_urls_without_navigating(self):
        page = FakePage()
        sess = S.Session()
        sess._page = page
        with pytest.raises(NavigationError):
            await sess.open("file://www.goofish.com/etc/passwd")
        assert page.goto_calls == []

    async def test_refuses_when_goofish_redirects_us_off_site(self):
        # goto follows redirects, so the landed URL has to be re-checked too.
        page = FakePage(goto_lands="https://evil.com/landing")
        sess = S.Session()
        sess._page = page
        with pytest.raises(NavigationError, match="evil.com"):
            await sess.open("https://www.goofish.com/item?id=1")

    async def test_a_load_timeout_is_typed(self):
        page = FakePage()
        page.goto = _raise_async("Timeout 60000ms exceeded")
        sess = S.Session()
        sess._page = page
        with pytest.raises(BrowserError, match="could not load"):
            await sess.open("https://www.goofish.com/item?id=1")


class TestSessionLifecycle:
    async def test_close_releases_everything(self):
        sess = S.Session()
        sess._page = FakePage()
        sess._context = FakePage()
        sess._browser = FakePage()
        await sess.close()
        assert (sess._page, sess._context, sess._browser, sess._pw) == (None, None, None, None)

    async def test_a_closed_page_is_relaunched(self, monkeypatch):
        page = FakePage()
        page.closed = True
        sess = S.Session()
        sess._page = page
        launched = []

        async def fake_launch():
            launched.append(True)
            sess._page = FakePage()

        monkeypatch.setattr(sess, "_launch", fake_launch)
        await sess.page()
        assert launched == [True]
        assert sess._page.closed is False


class TestDismissLoginAndMtop:
    async def test_dismiss_counts_controls(self):
        page = FakePage(evaluate=lambda js, arg: 3)
        assert await S.dismiss_login(page) == 3

    async def test_dismiss_is_zero_when_there_is_no_dialog(self):
        page = FakePage(evaluate=_raise("no such selector"))
        assert await S.dismiss_login(page) == 0

    async def test_dismiss_tolerates_a_dead_page(self):
        page = FakePage(evaluate=_raise("Target closed"))
        assert await S.dismiss_login(page) == 0

    async def test_wait_for_mtop_gives_up_and_says_so(self):
        page = FakePage(evaluate=lambda js, arg: "pending")
        assert await S.wait_for_mtop(page, timeout_ms=600) is False
        assert len(page.calls) == 2
        assert page.waits == [300, 300]

    async def test_wait_for_mtop_returns_as_soon_as_it_is_ready(self):
        page = FakePage(evaluate=lambda js, arg: "ready")
        assert await S.wait_for_mtop(page, timeout_ms=600) is True
        assert len(page.calls) == 1


class TestExclusive:
    async def test_only_one_tool_call_at_a_time(self):
        order = []

        async def critical():
            order.append("in")
            await asyncio.sleep(0.02)
            order.append("out")

        async with S.exclusive():
            task = asyncio.create_task(_locked(critical))
            await asyncio.sleep(0.05)
            assert order == [], "a second caller got the browser while the first held it"
            order.append("first-out")
        await task
        assert order == ["first-out", "in", "out"]

    async def test_the_lock_is_released_when_a_tool_raises(self):
        with pytest.raises(ValueError):
            async with S.exclusive():
                raise ValueError("boom")
        async with S.exclusive():
            pass      # would hang if the failure leaked the lock


def _raise(msg):
    def boom(js, arg=None):
        raise RuntimeError(msg)
    return boom


def _raise_async(msg):
    async def boom(*args, **kwargs):
        raise RuntimeError(msg)
    return boom


def _flaky(msg):
    state = {"n": 0}

    def once(js, arg=None):
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError(msg)
        return "second try"
    return once


def _record(name):
    calls = []

    async def spy(page):
        calls.append(name)
        return 1
    spy.calls = calls
    return spy


async def _locked(coro):
    async with S.exclusive():
        await coro()


class TestEvaluateTimeout:
    """Playwright imposes no timeout on evaluate; an unsettled promise must not hang."""

    async def test_times_out_instead_of_hanging(self):
        import asyncio

        from xianyu_mcp.errors import BrowserError
        from xianyu_mcp.session import evaluate

        class HangingPage:
            async def evaluate(self, js, arg=None):
                await asyncio.sleep(3600)

        with pytest.raises(BrowserError, match="timed out"):
            await evaluate(HangingPage(), "() => 1", what="stuck script", timeout=0.2)

    async def test_timeout_is_reported_as_actionable(self):
        import asyncio

        from xianyu_mcp.errors import BrowserError
        from xianyu_mcp.session import evaluate

        class HangingPage:
            async def evaluate(self, js, arg=None):
                await asyncio.sleep(3600)

        with pytest.raises(BrowserError) as exc:
            await evaluate(HangingPage(), "() => 1", what="stuck script", timeout=0.2)
        msg = str(exc.value)
        assert "stuck script" in msg
        assert "browse_feed" in msg      # points at the path that still works

    async def test_passes_the_argument_through(self):
        from xianyu_mcp.session import evaluate

        seen = {}

        class OkPage:
            async def evaluate(self, js, arg=None):
                seen["js"], seen["arg"] = js, arg
                return {"ok": True}

        assert await evaluate(OkPage(), "x", {"k": 1}) == {"ok": True}
        assert seen["arg"] == {"k": 1}
