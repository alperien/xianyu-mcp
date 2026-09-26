"""The server's central promise: no Xianyu account, no credentials, read-only.

These tests fail if a credential path or a write tool ever appears.
"""
import asyncio
import inspect
from pathlib import Path

import pytest

import xianyu_mcp
from xianyu_mcp import ops, server, session

SRC = Path(xianyu_mcp.__file__).parent
SOURCES = sorted(SRC.glob("*.py"))
# The whole repository, not just the package: the live smoke test is code too, and it
# is the one place most likely to grow a "let me just check the cookie" line.
REPO_PY = sorted(
    p for p in Path(__file__).resolve().parents[1].rglob("*.py")
    if ".venv" not in p.parts and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts
)

# Anything that would mean we read, write, or persist auth material.
FORBIDDEN = (
    "context.cookies(",
    "add_cookies",
    "storage_state",
    "cookie2",
    "sgcookie",
    "x5sec",
    "_m_h5_tk",
    "launch_persistent_context",
    "user_data_dir",
)
# Anything that could change state on goofish.
FORBIDDEN_WRITES = (
    "publish",
    "delete_item",
    "message/send",
    "mtop.taobao.idle.pc.publish",
    "mtop.idle.pc.delete",
)
READ_ONLY_TOOLS = {
    "browse_feed",
    "capabilities",
    "item_view",
    "recommendations",
    "related_items",
    "search_count",
    "search_items",
    "search_suggest",
}
# Every tool works without a Xianyu account. search_items is account-free too; it can
# fail because goofish declines a given page load, which is a different thing.
ACCOUNT_FREE_TOOLS = {"browse_feed", "capabilities", "item_view", "recommendations",
                      "related_items", "search_count", "search_suggest", "search_items"}
NO_TOOLS_MAY_ALWAYS_FAIL: set[str] = set()


def test_sources_found():
    assert len(SOURCES) >= 5, SOURCES
    assert len(REPO_PY) > len(SOURCES), REPO_PY


@pytest.mark.parametrize("path", REPO_PY, ids=lambda p: str(p.name))
def test_no_credential_access(path):
    text = path.read_text(encoding="utf-8")
    for needle in FORBIDDEN:
        offenders = [
            (i, line.strip())
            for i, line in enumerate(text.splitlines(), start=1)
            if needle in line and not line.lstrip().startswith(("-", "#", '"', "*"))
        ]
        assert not offenders, f"{path.name} references {needle}: {offenders}"


@pytest.mark.parametrize("path", REPO_PY, ids=lambda p: str(p.name))
def test_no_write_apis(path):
    text = path.read_text(encoding="utf-8")
    for needle in FORBIDDEN_WRITES:
        offenders = [
            (i, line.strip())
            for i, line in enumerate(text.splitlines(), start=1)
            if needle in line and not line.lstrip().startswith(("#", '"', "*", "-"))
        ]
        assert not offenders, f"{path.name} references write API {needle}: {offenders}"


def test_exactly_the_five_read_only_tools():
    tools = asyncio.run(server.mcp.list_tools())
    assert {t.name for t in tools} == READ_ONLY_TOOLS


def test_account_free_tools_say_so():
    tools = {t.name: (t.description or "") for t in asyncio.run(server.mcp.list_tools())}
    for name in ACCOUNT_FREE_TOOLS:
        assert "No Xianyu account" in tools[name], name
        assert "ALWAYS FAILS" not in tools[name], name
    for name in NO_TOOLS_MAY_ALWAYS_FAIL:
        assert name not in tools, f"{name} must not exist: it would only ever fail"
    for name, desc in tools.items():
        assert "Read-only" in desc, name


def test_tools_are_wired_to_their_ops():
    src = inspect.getsource(server)
    for name in READ_ONLY_TOOLS:
        assert f'"{name}"' in src
        assert f"ops.{name}" in src, name


def test_refusals_are_typed_gated_errors():
    from xianyu_mcp.errors import DetailUnavailableError, GatedError, SearchUnavailableError

    assert issubclass(SearchUnavailableError, GatedError)
    assert issubclass(DetailUnavailableError, GatedError)


def test_item_view_reads_the_dom_not_the_closed_api():
    """The detail API is closed to anonymous callers; the page is not."""
    from xianyu_mcp import ops

    src = inspect.getsource(ops.item_view)
    assert "ITEM_SCRAPE_JS" in src
    assert "detail_rendered" in src
    # the API is only used as evidence in the failure message, never as the source
    assert src.index("ITEM_SCRAPE_JS") < src.index("_probe_ret")


def test_server_instructions_state_the_split():
    tools = asyncio.run(server.mcp.list_tools())
    assert tools  # sanity
    from xianyu_mcp import server as srv

    assert srv.mcp is not None
    # instructions are exposed on the server object in mcp 2.x
    instructions = getattr(srv.mcp, "instructions", "") or ""
    assert "NO Xianyu account" in instructions


def test_session_only_loads_goofish():
    assert {"www.goofish.com", "goofish.com"} == session.ALLOWED_HOSTS
    assert {"https"} == session.ALLOWED_SCHEMES
    assert session.HOME.startswith("https://www.goofish.com")


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: p.name)
def test_all_navigation_lives_in_the_allowlisted_helpers(path):
    """Every page.goto is centralised, so there is one place to audit.

    The behavioural half of this guarantee is in tests/test_session.py: the helper
    refuses a non-goofish URL, and re-checks the URL goofish itself landed on.
    """
    strays = [
        (i, line.strip())
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if ".goto(" in line and path.name != "session.py"
    ]
    assert not strays, f"{path.name} navigates outside session.py: {strays}"


def test_every_navigation_site_is_allowlist_checked():
    """The two places that call goto, and the guard each of them depends on."""
    src = inspect.getsource(session)
    goto_sites = [line.strip() for line in src.splitlines() if "page.goto(" in line]
    assert len(goto_sites) == 2, goto_sites
    # reload_fresh re-validates wherever the page ended up...
    reload_src = inspect.getsource(session.reload_fresh)
    assert "ensure_goofish_url(page.url" in reload_src, reload_src
    # ...and open() validates the target before goto, then the landing after it.
    open_src = inspect.getsource(session.Session.open)
    assert "target = ensure_goofish_url(url)" in open_src
    assert "ensure_goofish_url(page.url)" in open_src   # goto follows redirects
    # The other goto site only ever gets a hardcoded module constant, and that
    # constant must be on an allowed host. (It is BOOT_URL, not HOME: the homepage is
    # a 20s document, an item page 3.5s, and both boot the mtop client equally well.)
    page_src = inspect.getsource(session.Session.page)
    assert "_goto(self._page, BOOT_URL)" in page_src, page_src
    from urllib.parse import urlparse

    for name in ("HOME", "BOOT_URL"):
        value = getattr(session, name)
        assert urlparse(value).hostname in session.ALLOWED_HOSTS, f"{name}={value!r}"


def test_headless_is_the_default():
    """Browsing works headless, so nothing should require a display."""
    import os

    os.environ.pop("XIANYU_HEADLESS", None)
    assert session.headless() is True
    os.environ["XIANYU_HEADLESS"] = "0"
    try:
        assert session.headless() is False
    finally:
        os.environ.pop("XIANYU_HEADLESS", None)


def test_login_dialog_dismissal_is_wired_in():
    """Without the dismissal, anonymous pages render zero cards."""
    from xianyu_mcp.extract import DISMISS_LOGIN_JS

    assert "baxia-dialog-close" in DISMISS_LOGIN_JS
    assert "closeIcon" in DISMISS_LOGIN_JS
    # Session.open() must be the thing that dismisses it.
    assert "dismiss_login" in inspect.getsource(session.Session.open)
    assert callable(session.dismiss_login)


def test_feed_api_is_the_documented_open_one():
    assert ops.FEED_API == "mtop.taobao.idlehome.home.webpc.feed"
    assert ops.SEARCH_API == "mtop.taobao.idlemtopsearch.pc.search"
    assert ops.DETAIL_API == "mtop.taobao.idle.pc.detail"


# The complete set of mtop endpoints this server is allowed to name. A closed list
# beats a list of forbidden ones: a new write endpoint cannot slip in unnoticed.
READ_APIS = {
    "mtop.taobao.idlehome.home.webpc.feed",
    "mtop.taobao.idlemtopsearch.pc.search",
    "mtop.taobao.idle.pc.detail",
    "mtop.taobao.idlemessage.pc.loginuser.get",
    "mtop.taobao.idle.filter.hitnum.pc.get",
    "mtop.taobao.idlemtopsearch.pc.search.suggest",
    "mtop.taobao.idle.item.web.recommend.list",
}


API_REF = r"mtop\.(?:taobao|idle)\.[A-Za-z0-9_.]+"   # not window.lib.mtop.request


@pytest.mark.parametrize("path", REPO_PY, ids=lambda p: str(p.name))
def test_only_known_read_apis_are_referenced(path):
    import re

    offenders = [
        (i, line.strip())
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if re.search(API_REF, line)
        and not line.lstrip().startswith(("#", '"', "*", "-"))
        and not set(re.findall(API_REF, line)) <= READ_APIS
    ]
    assert not offenders, f"{path.name} names an unexpected mtop API: {offenders}"
