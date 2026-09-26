"""xianyu-mcp: read-only Xianyu (Goofish) MCP server that needs no Xianyu account.

Launches its own logged-out Chromium, dismisses the anonymous login dialog, and
reads goofish through the page's own mtop client. No cookies, no stored
credentials, no write tools.
"""

__version__ = "0.2.0"

from xianyu_mcp.errors import (
    BrowserError,
    DetailUnavailableError,
    GatedError,
    NavigationError,
    ParseError,
    SearchUnavailableError,
    XianyuError,
)
from xianyu_mcp.ops import (
    MAX_LIMIT,
    MAX_PAGE_NUMBER,
    MAX_PAGES,
    build_search_url,
    clamp,
    dedupe,
    is_gated,
    item_id_from_url,
    rank_items,
)
from xianyu_mcp.session import ALLOWED_HOSTS, ensure_goofish_url

__all__ = [
    "ALLOWED_HOSTS",
    "MAX_LIMIT",
    "MAX_PAGE_NUMBER",
    "MAX_PAGES",
    "BrowserError",
    "DetailUnavailableError",
    "GatedError",
    "NavigationError",
    "ParseError",
    "SearchUnavailableError",
    "XianyuError",
    "build_search_url",
    "clamp",
    "dedupe",
    "ensure_goofish_url",
    "is_gated",
    "item_id_from_url",
    "rank_items",
]
