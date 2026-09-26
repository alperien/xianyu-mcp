"""MCP stdio entry point.

Register with an MCP client:

    {
      "mcpServers": {
        "xianyu": { "command": "xianyu-mcp" }
      }
    }

No Xianyu account, no cookies, no stored credentials, no write tools. The server
launches its own Chromium and reads goofish the way an anonymous visitor's browser
does. See README.md for the capability split and why search is refused.
"""
from __future__ import annotations

import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

try:  # mcp >= 2.0 renamed FastMCP -> MCPServer; both expose .tool/.run the same way
    from mcp.server.mcpserver import MCPServer as _Server
except ModuleNotFoundError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server  # type: ignore[no-redef]

from . import ops
from .session import exclusive, get_session


@asynccontextmanager
async def _lifespan(_server: Any) -> AsyncIterator[None]:
    """Own the browser session's lifetime inside the server's event loop."""
    try:
        yield
    finally:
        await get_session().close()


mcp = _Server(
    "xianyu",
    lifespan=_lifespan,
    instructions=(
        "Read-only access to Xianyu/Goofish with NO Xianyu account required. "
        "search_items, search_count, search_suggest, browse_feed, related_items, item_view "
        "and recommendations all work logged out. "
        "Anonymous search is declined by goofish on some page loads, so search_items retries; "
        "call capabilities for the current verified picture."
    ),
)

NO_ACCOUNT = (
    "\n\nNo Xianyu account, cookie or login is required or used. Read-only: this server "
    "cannot publish, message, or change anything."
)


def _guard(coro: Any) -> Any:
    """Run an op, converting our typed errors into structured tool results.

    Calls are serialised: the session is one browser and one page, so two tools in
    flight at once would navigate it out from under each other and one of them would
    report the other's page as its own data. Anything unexpected is reported under its
    own exception type rather than being allowed to kill the MCP call.
    """
    async def handler(**kwargs: Any) -> dict[str, Any]:
        try:
            async with exclusive():
                return {"ok": True, "data": await coro(**kwargs)}
        except Exception as e:  # noqa: BLE001 -- our own errors are XianyuError subclasses
            return {"ok": False, "error_type": type(e).__name__, "message": str(e)}

    return handler


@mcp.tool(
    name="capabilities",
    description="Report what this server can do without a Xianyu account right now, "
    "probing the live site. Start here if you are unsure whether a call will work."
    + NO_ACCOUNT,
)
async def capabilities() -> dict[str, Any]:
    return await _guard(ops.capabilities)()


@mcp.tool(
    name="browse_feed",
    description="Page through goofish's public homepage feed: live listings with item_id, "
    "title, price, city, seller, want-count and image URLs. No account needed, and it is "
    "NOT keyword-filterable, so use it to sample inventory, not to answer a query. "
    f"Args: page_number (first page, 1-{ops.MAX_PAGE_NUMBER}, default 1), "
    f"pages (how many, 1-{ops.MAX_PAGES}, default 1), "
    f"limit (max items, default 60)." + NO_ACCOUNT,
)
async def browse_feed(page_number: int = 1, pages: int = 1, limit: int = 60) -> dict[str, Any]:
    return await _guard(ops.browse_feed)(page_number=page_number, pages=pages, limit=limit)


@mcp.tool(
    name="recommendations",
    description="Scrape goofish's recommendation rails (猜你喜欢 / 为你推荐) for an anonymous "
    "visitor from any goofish page. No account needed. Args: limit (default 30), "
    "url (optional goofish page to load, default the homepage)." + NO_ACCOUNT,
)
async def recommendations(limit: int = 30, url: str | None = None) -> dict[str, Any]:
    return await _guard(ops.recommendations)(limit=limit, url=url)


@mcp.tool(
    name="search_items",
    description="Search goofish listings by keyword. No Xianyu account needed -- verified "
    "against the live site, returning real matches for a query. goofish decides per page load "
    "whether to serve results, and when it declines it renders the 猜你喜欢 rail instead, so "
    "this retries with fresh loads (raise `attempts` if it declines repeatedly) and refuses to "
    "return rail items as matches: results are only accepted when a card title actually contains "
    "the query. Args: query (str), limit (default 30), attempts (1-10, default 4)." + NO_ACCOUNT,
)
async def search_items(query: str, limit: int = 30, attempts: int = 4) -> dict[str, Any]:
    return await _guard(ops.search_items)(query=query, limit=limit, attempts=attempts)


@mcp.tool(
    name="item_view",
    description="Read one listing from its goofish item page as a logged-out visitor: price, "
    "want/browse counts, description, seller stats and photos. No account needed. The detail "
    "API is closed to anonymous callers, so this reads the rendered page, which goofish "
    "sometimes serves as an empty shell -- the tool retries and reports fields_present / "
    "fields_missing rather than guessing. Args: item_id (digits or item URL)." + NO_ACCOUNT,
)
async def item_view(item_id: str) -> dict[str, Any]:
    return await _guard(ops.item_view)(item_id=item_id)


@mcp.tool(
    name="search_count",
    description="How many goofish listings match a keyword. No Xianyu account required, and "
    "unlike search_items this is not subject to goofish's per-page-load declines -- verified "
    "returning 28791 for 'x220' and 0 for a nonsense string anonymously. Args: query (str)."
    + NO_ACCOUNT,
)
async def search_count(query: str) -> dict[str, Any]:
    return await _guard(ops.search_count)(query=query)


@mcp.tool(
    name="search_suggest",
    description="goofish's own search-box autocomplete: keyword suggestions for a prefix, plus "
    "the total suggestion count. No Xianyu account required. Args: query (str), limit (default 20)."
    + NO_ACCOUNT,
)
async def search_suggest(query: str, limit: int = 20) -> dict[str, Any]:
    return await _guard(ops.search_suggest)(query=query, limit=limit)


@mcp.tool(
    name="related_items",
    description="Listings goofish recommends for a given item ('more like this'), or its generic "
    "recommendation set when item_id is omitted. No Xianyu account required; returns ~60 real "
    "listings per call with titles, prices and cities. Args: item_id (optional digits or item URL), "
    "limit (default 30), page (default 1)." + NO_ACCOUNT,
)
async def related_items(item_id: str | None = None, limit: int = 30, page: int = 1) -> dict[str, Any]:
    return await _guard(ops.related_items)(item_id=item_id, limit=limit, page=page)



def main() -> None:
    if sys.stdin.isatty():
        print(
            "xianyu-mcp is an MCP stdio server and cannot be used interactively.\n"
            "Configure it in an MCP client instead (see README.md).",
            file=sys.stderr,
        )
        raise SystemExit(2)
    mcp.run()


__all__ = ["mcp", "main", "capabilities", "browse_feed", "recommendations",
           "search_items", "search_count", "search_suggest", "related_items", "item_view"]
