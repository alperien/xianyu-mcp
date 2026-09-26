"""Error types. Each one carries a message the model can act on."""
from __future__ import annotations


class XianyuError(Exception):
    """Base for every error this server raises on purpose."""


class BrowserError(XianyuError):
    """Could not launch or attach to the throwaway Chromium."""


class GatedError(XianyuError):
    """Goofish refused the call for this anonymous visitor.

    Covers both the risk-control interstitial and the endpoints that only serve
    logged-in accounts.
    """


class SearchUnavailableError(GatedError):
    """goofish declined this search, on every attempt.

    Anonymous search does work without an account -- that is verified. goofish decides
    per page load whether to serve results, and when it declines it does not call the
    search API at all: the page renders "nothing found" plus the 猜你喜欢 rail instead.
    Real browsers rarely see the decline; automated clients see it often, so the tool
    retries before raising this.

    Raised instead of quietly returning recommendations, which would look like
    search results but are not.
    """


class DetailUnavailableError(GatedError):
    """The item page would not render for this anonymous visitor.

    Not a claim that the listing needs an account: the page renders fine when goofish
    is serving this IP, and the *detail API* is what is closed to logged-out callers.
    This is the typed answer to "the detail block was not in the page", with the page
    text it actually saw attached as evidence.
    """


class ParseError(XianyuError):
    """Page or payload loaded but did not have the shape we expected."""


class NavigationError(XianyuError):
    """Refused to navigate off goofish.com."""
