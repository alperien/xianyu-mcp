"""Tool implementations.

Capability split, all of it measured rather than assumed:

  browse_feed                    works with no Xianyu account at all
  item_view                      works with no Xianyu account, from the item *page*
  recommendations                works with no Xianyu account at all
  search_items                   refuses: goofish gates keyword search behind login
  capabilities                   never raises, even when the browser is gone

The search refusal is deliberate. goofish answers an anonymous search with its
recommendation rail instead of results, so a tool that scraped the page and
returned those cards would look like it had searched and had not. Better to fail
loudly and say why.

Everything that touches the page goes through `session.evaluate` / `settle` /
`reload_fresh`, so a Playwright failure arrives as a typed XianyuError rather than
an exception escaping a tool call.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any
from urllib.parse import quote

from .errors import (
    DetailUnavailableError,
    GatedError,
    ParseError,
    SearchUnavailableError,
    XianyuError,
)
from .extract import CARD_SCRAPE_JS, FEED_NORMALIZE_JS, ITEM_SCRAPE_JS, SEARCH_RESULTS_JS
from .session import HOME, dismiss_login, evaluate, get_session, reload_fresh, settle

FEED_API = "mtop.taobao.idlehome.home.webpc.feed"
SEARCH_API = "mtop.taobao.idlemtopsearch.pc.search"
DETAIL_API = "mtop.taobao.idle.pc.detail"
LOGINUSER_API = "mtop.taobao.idlemessage.pc.loginuser.get"

# Found by reading goofish's own JS bundles (idle-pc/xy-site) rather than guessing.
# The filter counter is the useful one: the page calls it with the same payload shape
# as the real search and reads `data.hitnum`, so it answers "how many items match this
# keyword" for a logged-out visitor even on the page loads where search is declined.
HITNUM_API = "mtop.taobao.idle.filter.hitnum.pc.get"
SUGGEST_API = "mtop.taobao.idlemtopsearch.pc.search.suggest"
RECOMMEND_API = "mtop.taobao.idle.item.web.recommend.list"
# hardcoded in goofish's bundle; the endpoint rejects other values
RECOMMEND_PAGE_SIZE = 30
# goofish's own seed item: its bundle substitutes this when no itemId is given, and the
# endpoint rejects the request outright if itemId is missing entirely. This is what
# powers 为你推荐 on a page with no item context.
RECOMMEND_SEED_ITEM_ID = "809806779491"

MAX_PAGES = 25
MAX_LIMIT = 500
# goofish's own feed runs out of pages long before this; the bound only exists so a
# nonsense page_number cannot turn into a nonsense request.
MAX_PAGE_NUMBER = 10_000

# Every field item_view reports. Kept in one place so the honesty contract
# (fields_present / fields_missing) and the scraper cannot drift apart.
ITEM_FIELDS = (
    "title", "price", "want_count", "browse_count", "description",
    "seller", "seller_tenure_years", "seller_items_sold",
    "seller_positive_rate", "image_urls",
)

# goofish renders anonymous pages as a coin flip: the same URL comes back fully
# rendered or as an empty shell. Retry a few times before calling it a failure.
# Reloads are cache-busted with a nonce, since a cached empty shell is exactly
# the failure we are trying to escape.
RENDER_ATTEMPTS = 5
RENDER_SETTLE_MS = 3500
# 6s of readiness polling, spent once per item_view call rather than once per attempt.
ITEM_READY_POLLS = 24


def _budget(name: str, default: int) -> int:
    """Wall-clock ceiling for a best-effort tool, overridable via the environment.

    These tools retry page loads that goofish may decline outright, and a page load
    costs 10-25s on a slow link. Without a ceiling, five declined loads turned one
    item_view call into 95 seconds of waiting. It is better to stop early and say the
    page never rendered than to hold a caller for a minute and a half.
    """
    try:
        return max(5, int(os.environ.get(f"XIANYU_{name}_BUDGET_S", default)))
    except ValueError:
        return default


ITEM_VIEW_BUDGET_S = _budget("ITEM_VIEW", 45)
SEARCH_BUDGET_S = _budget("SEARCH", 45)

# Anonymous search is declined per page load. Real browsers rarely see it; an automated
# client sees it often, so search retries with fresh page loads before giving up.
SEARCH_ATTEMPTS = 4
MAX_SEARCH_ATTEMPTS = 10
SEARCH_SETTLE_S = 14

# Ret strings that mean "goofish will not serve this to you", as opposed to a bug.
GATE_MARKERS = (
    "mini_login",
    "RGV587",
    "FAIL_SYS_SESSION_EXPIRED",
    "FAIL_SYS_TOKEN",
    "ILLEGAL_ACCESS",
    "TIMEOUT",
    "非法访问",
    "令牌过期",
)


# ---------------------------------------------------------------- pure helpers


def clamp(value: Any, low: int, high: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return low
    return max(low, min(n, high))


def normalize_item_id(value: Any) -> str:
    """Accept a bare item id or a goofish item URL and return the bare digits."""
    s = str(value or "").strip()
    bare = re.fullmatch(r"[0-9]+", s)
    return item_id_from_url(s) or (bare.group(0) if bare else "")


def item_id_from_url(url: str) -> str:
    m = re.search(r"[?&]id=([0-9]+)", url or "")
    return m.group(1) if m else ""


def build_search_url(query: str) -> str:
    q = str(query or "").strip()
    if not q:
        raise XianyuError("query must not be empty")
    return f"{HOME}search?q={quote(q)}"


def is_gated(ret: str) -> bool:
    return any(marker in (ret or "") for marker in GATE_MARKERS)


def dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in items:
        key = it.get("item_id") or item_id_from_url(it.get("url", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def rank_items(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    trimmed = items[:limit]
    for i, it in enumerate(trimmed, start=1):
        it["rank"] = i
    return trimmed


# ------------------------------------------------------------------- browsing


async def browse_feed(page_number: int = 1, pages: int = 1, limit: int = 60) -> dict[str, Any]:
    """Page through goofish's public homepage feed. No account, no login.

    The feed is personalised-by-anonymity rather than by keyword: each pageNumber
    returns a different slice of live inventory. Verified 8 pages / 157 unique
    listings, no duplicates, no rate limiting.
    """
    start = clamp(page_number, 1, MAX_PAGE_NUMBER)
    pages = clamp(pages, 1, MAX_PAGES)
    limit = clamp(limit, 1, MAX_LIMIT)
    wanted = [start + i for i in range(pages)]

    session = get_session()
    page = await session.ensure_ready()
    spec = [[f"p{pn}", FEED_API, {"pageNumber": pn}] for pn in wanted]
    raw = await session.call(spec)

    rows: list[dict[str, Any]] = []
    page_reports: list[dict[str, Any]] = []
    for pn in wanted:
        entry = raw.get(f"p{pn}") or {}
        ret = str(entry.get("ret") or "")
        if not entry.get("ok"):
            page_reports.append({"page": pn, "ok": False, "ret": ret})
            continue
        data = entry.get("data") or {}
        cards = data.get("cardList") or []
        page_reports.append({"page": pn, "ok": True, "cards": len(cards)})
        rows.extend(cards)

    if not rows:
        # Nothing came back. A gate across every page is a refusal; anything else is
        # more likely a shape change, and the two need different advice.
        gated = [r for r in page_reports if is_gated(str(r.get("ret") or ""))]
        if gated:
            raise GatedError(
                f"goofish refused the anonymous feed on every page of {wanted}: "
                f"{gated[0]['ret']}. It may be rate limiting this IP; wait a minute "
                "and retry."
            )
        raise ParseError(
            f"feed returned no cards for pages {wanted}: {page_reports}. "
            "The card shape may have changed."
        )

    items = await evaluate(
        page, FEED_NORMALIZE_JS, {"rows": [r.get("cardData") or r for r in rows]},
        what="feed normalization",
    )
    items = dedupe([i for i in items if i.get("item_id")])
    if not items:
        raise ParseError(
            "feed returned cards but none had an item id -- the response shape likely changed. "
            f"First card keys: {sorted((rows[0] or {}).keys())[:12]}"
        )
    ranked = rank_items(items, limit)
    return {
        "source": "homepage_feed",
        "account_required": False,
        "requested_pages": wanted,
        "page_reports": page_reports,
        "raw_cards": len(rows),
        "unique_items": len(items),
        "count": len(ranked),
        "items": ranked,
    }


async def recommendations(limit: int = 30, url: str | None = None) -> dict[str, Any]:
    """Scrape goofish's recommendation rails for an anonymous visitor.

    Renders are flaky (the same URL comes back fully rendered or as an empty
    shell), so retry, and if the DOM never cooperates fall back to the feed API
    and say so in `source` rather than returning an empty list.
    """
    limit = clamp(limit, 1, MAX_LIMIT)
    target = url or HOME
    session = get_session()
    page = await session.open(target)
    payload: dict[str, Any] = {}
    for attempt in range(RENDER_ATTEMPTS):
        payload = await evaluate(page, CARD_SCRAPE_JS, limit, what="recommendation scrape")
        if isinstance(payload, dict) and payload.get("items"):
            break
        if attempt + 1 < RENDER_ATTEMPTS:
            await reload_fresh(page)
            await settle(page, RENDER_SETTLE_MS)

    if isinstance(payload, dict) and payload.get("items"):
        items = dedupe(payload["items"])
        ranked = rank_items(items, limit)
        return {
            "source": "dom_recommendation",
            "rail": payload.get("rail", ""),
            "page_url": page.url,
            "account_required": False,
            "attempts": attempt + 1,
            "says_no_results_for_query": bool(payload.get("saysNoResults")),
            "login_wall_still_up": bool(payload.get("loginWallUp")),
            "count": len(ranked),
            "items": ranked,
        }

    feed = await browse_feed(pages=1, limit=limit)
    feed["source"] = "homepage_feed"
    feed["fallback_reason"] = (
        f"the DOM at {page.url} rendered no cards after {RENDER_ATTEMPTS} attempts "
        "(goofish serves anonymous visitors an empty shell part of the time); "
        "returned live feed listings instead"
    )
    feed["requested_url"] = target
    return feed


# ------------------------------------------------------- deliberately refused


async def search_items(
    query: str,
    limit: int = 30,
    attempts: int = SEARCH_ATTEMPTS,
) -> dict[str, Any]:
    """Search goofish as a logged-out visitor.

    Anonymous search genuinely works -- verified against the live site, returning
    real matches for a query with no account. But goofish decides *per page load*
    whether to serve results, and on a declined load it does not even call the search
    API: the page just renders "nothing found" plus the 猜你喜欢 rail. From an
    automated client that decline is common, so this retries with fresh loads and
    treats the rail as a failure, never as results.

    Every returned item carries `matches_query`, and a result set is only accepted when
    at least one card title actually contains the query. That check is what stops the
    recommendation rail from being passed off as matches.
    """
    q = str(query or "").strip()
    if not q:
        raise XianyuError("query must not be empty")
    limit = clamp(limit, 1, MAX_LIMIT)
    attempts = clamp(attempts, 1, MAX_SEARCH_ATTEMPTS)

    session = get_session()
    log: list[dict[str, Any]] = []
    payload: dict[str, Any] = {}
    started = time.monotonic()
    for attempt in range(1, attempts + 1):
        # A failed page load is a declined attempt, not a fatal error: this network
        # throws ERR_INSUFFICIENT_RESOURCES / ERR_ADDRESS_UNREACHABLE often enough
        # that aborting the whole call would make search useless.
        try:
            page = await session.open(build_search_url(q))
        except XianyuError as e:
            log.append({"attempt": attempt, "error": f"{type(e).__name__}: {str(e)[:120]}"})
            continue
        payload = {}
        deadline = asyncio.get_event_loop().time() + SEARCH_SETTLE_S
        while asyncio.get_event_loop().time() < deadline:
            await page.wait_for_timeout(700)
            await dismiss_login(page)
            payload = await evaluate(page, SEARCH_RESULTS_JS, {"query": q, "limit": limit},
                                    what="search-page scrape")
            if isinstance(payload, dict) and payload.get("rendered"):
                break
        payload = payload if isinstance(payload, dict) else {}
        hits = int(payload.get("query_hits") or 0)
        declined = (
            not payload.get("rendered")
            or bool(payload.get("guess_rail"))
            or bool(payload.get("says_no_results"))
            or hits == 0
        )
        log.append({
            "attempt": attempt,
            "rendered": bool(payload.get("rendered")),
            "cards": len(payload.get("items") or []),
            "query_hits": hits,
            "guess_rail": bool(payload.get("guess_rail")),
            "says_no_results": bool(payload.get("says_no_results")),
        })
        if not declined:
            items = rank_items(dedupe(payload["items"]), limit)
            return {
                "query": q,
                "source": "search_page_dom",
                "account_required": False,
                "attempts": attempt,
                "attempt_log": log,
                "query_hits": hits,
                "count": len(items),
                "items": items,
            }
        if attempt < attempts:
            if time.monotonic() - started >= SEARCH_BUDGET_S:
                log.append({"stopped": "time budget reached"})
                break
            await reload_fresh(page)

    last = log[-1] if log else {}
    raise SearchUnavailableError(
        f"goofish served the recommendation rail instead of results for {q!r} on "
        f"{len([e for e in log if e.get('attempt')])} attempt(s) in "
        f"{time.monotonic() - started:.0f}s. Anonymous search does work here -- it is declined "
        f"per page load, and an automated client gets declined far more often than a "
        f"real browser does.\n"
        f"  last attempt: {last}\n"
        f"  page text: {(payload.get('text_preview') or '')[:140]!r}\n"
        f"  retry with a higher `attempts`, or search from a real browser. "
        f"browse_feed() is unaffected and always available."
    )


async def item_view(item_id: str) -> dict[str, Any]:
    """Read one listing from its own page, as a logged-out visitor sees it.

    The `mtop.taobao.idle.pc.detail` API is not available to anonymous visitors
    (it times out), but the item *page* does render the detail block -- price,
    want/browse counts, description, seller, photos. Rendering is flaky, so retry,
    and report which fields actually came back instead of inventing any.
    """
    item = normalize_item_id(item_id)
    if not item:
        raise XianyuError(f"item_id must be digits or a goofish item URL, got {item_id!r}")

    session = get_session()
    page = await session.open(f"{HOME}item?id={item}")
    payload: dict[str, Any] = {}
    started = time.monotonic()
    attempts_made = 0
    for attempt in range(RENDER_ATTEMPTS):
        attempts_made = attempt + 1
        payload = await evaluate(page, ITEM_SCRAPE_JS, item, what="item-page scrape")
        if isinstance(payload, dict) and payload.get("detail_rendered"):
            break
        spent = time.monotonic() - started
        if spent >= ITEM_VIEW_BUDGET_S or attempt + 1 >= RENDER_ATTEMPTS:
            if spent >= ITEM_VIEW_BUDGET_S:
                break
            # Only the first load gets a readiness wait. If the listing has not painted
            # within it, the page is a shell and reloading is the only thing that helps
            # -- polling again on every retry just multiplies the wait by the attempt
            # count, which is how this ended up taking a minute.
            if attempt == 0:
                for _ in range(ITEM_READY_POLLS):
                    await settle(page, 250)
                    payload = await evaluate(page, ITEM_SCRAPE_JS, item,
                                             what="item-page scrape")
                    if isinstance(payload, dict) and payload.get("detail_rendered"):
                        break
            # Nudge the gallery so lazily-loaded photos decode; the scraper filters on
            # naturalWidth and an undecoded image reports 0.
            await evaluate(page, "window.scrollTo(0, 400)", what="gallery nudge")
            await settle(page, 400)
            await evaluate(page, "window.scrollTo(0, 0)", what="gallery nudge")
            await reload_fresh(page)
            await settle(page, RENDER_SETTLE_MS)

    if not isinstance(payload, dict) or not payload.get("detail_rendered"):
        api_ret = await _probe_ret(DETAIL_API, {"itemId": item})
        raise DetailUnavailableError(
            f"item {item} would not render for this anonymous visitor after "
            f"{attempts_made} attempt(s) in {time.monotonic() - started:.0f}s, and the "
            f"detail API is not open to logged-out "
            f"callers (live probe: {api_ret or 'no data'}). goofish serves anonymous "
            "visitors an empty shell for this page part of the time; retry, or pull the "
            "listing from browse_feed instead. Page text: "
            f"{(payload or {}).get('head_preview', '')[:160]!r}"
        )

    served = str(payload.get("page_item_id") or "")
    if served and served != str(payload.get("requested_item_id") or item):
        raise ParseError(
            f"asked goofish for item {item} but the page it served is item {served}; "
            "refusing to report one listing's fields as another's."
        )

    return {
        "item_id": item,
        "url": f"{HOME}item?id={item}",
        "source": "item_page_dom",
        "account_required": False,
        "attempts": attempt + 1,
        "fields_present": [f for f in ITEM_FIELDS if payload.get(f)],
        "fields_missing": [f for f in ITEM_FIELDS if not payload.get(f)],
        "reco_anchors": payload.get("reco_anchors", 0),
        # diagnostic: how many large non-card images the page had at all, so an empty
        # image_urls is distinguishable from "the gallery never loaded"
        "image_candidates": payload.get("image_candidates", 0),
        **{f: payload.get(f, "") for f in ITEM_FIELDS},
    }


async def _probe_ret(api: str, data: dict[str, Any]) -> str:
    """Best-effort live probe, so the refusal message carries real evidence."""
    try:
        session = get_session()
        await session.ensure_ready()
        raw = await session.call([["probe", api, data]])
        entry = raw.get("probe") or {}
        return str(entry.get("ret") or "").strip()
    except XianyuError:
        return ""



async def search_count(query: str) -> dict[str, Any]:
    """How many listings match a keyword. No Xianyu account required.

    Uses the filter-counter endpoint the search page itself calls to populate its result
    count. It takes the same payload as search but is a different endpoint, so unlike
    search it is not subject to goofish's per-page-load decline -- verified returning
    28791 for "x220" and 0 for a nonsense string, both anonymously.
    """
    q = str(query or "").strip()
    if not q:
        raise XianyuError("query must not be empty")
    session = get_session()
    await session.ensure_ready()
    raw = await session.call([["hitnum", HITNUM_API, {
        "pageNumber": 1,
        "keyword": q,
        "rowsPerPage": 30,
        "searchReqFromPage": "pcSearch",
        "extraFilterValue": "{}",
        "userPositionJson": "{}",
        "customDistance": "",
        "customGps": "",
        "gps": "",
    }]])
    entry = raw.get("hitnum") or {}
    ret = str(entry.get("ret") or "")
    if not entry.get("ok"):
        raise GatedError(f"goofish refused the match counter for {q!r}: {ret}")
    data = entry.get("data") or {}
    count = data.get("hitnum")
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = None
    return {
        "query": q,
        "match_count": count,
        "has_matches": bool(count),
        "account_required": False,
        "source": "filter_hitnum",
    }


async def search_suggest(query: str, limit: int = 20) -> dict[str, Any]:
    """Keyword suggestions for a query prefix. No Xianyu account required.

    goofish's own search-box autocomplete endpoint. Useful for turning "x220" into
    "x220笔记本" and friends, and as a cheap signal that a term is understood at all.
    """
    q = str(query or "").strip()
    if not q:
        raise XianyuError("query must not be empty")
    limit = clamp(limit, 1, MAX_LIMIT)
    session = get_session()
    await session.ensure_ready()
    raw = await session.call([["sug", SUGGEST_API, {
        "inputWords": q,
        "searchReqFromPage": "xyPcHome",
        "bucketId": 30,
        "type": 0,
    }]])
    entry = raw.get("sug") or {}
    ret = str(entry.get("ret") or "")
    if not entry.get("ok"):
        raise GatedError(f"goofish refused the suggestion endpoint for {q!r}: {ret}")
    data = entry.get("data") or {}
    raw_items = data.get("items") or []
    suggestions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        text = str(it.get("suggest") or it.get("title") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        suggestions.append({"text": text, "bucket_num": it.get("bucketNum")})
    suggestions = suggestions[:limit]
    total = data.get("totalCount")
    return {
        "query": q,
        "account_required": False,
        "source": "search_suggest",
        "total_count": total if isinstance(total, int) else None,
        "count": len(suggestions),
        "suggestions": suggestions,
    }


async def related_items(item_id: str | None = None, limit: int = 30, page: int = 1) -> dict[str, Any]:
    """Listings goofish recommends for a given item ("more like this"). No account needed.

    Omit `item_id` for goofish's generic recommendation set, which is what the page
    itself requests (recommendations for its seed item). Answered anonymously with
    ~60 real listings per call, titles and prices included. The card payloads are the
    same shapes the homepage feed returns, so they go through the same normalizer.
    """
    limit = clamp(limit, 1, MAX_LIMIT)
    page = max(1, int(page or 1))
    iid = normalize_item_id(item_id) if item_id else ""
    # Both of these are required exactly as the page sends them. pageSize is hardcoded
    # to 30 in goofish's bundle and the endpoint rejects anything else with
    # FAIL_BIZ_COMMON_PARAM_ILLEGAL, so `limit` is applied client-side after the call.
    data: dict[str, Any] = {"pageNum": page, "pageSize": RECOMMEND_PAGE_SIZE,
                            "reqFrom": "xianyuweb", "categoryId": "",
                            "itemId": iid or RECOMMEND_SEED_ITEM_ID}
    session = get_session()
    await session.ensure_ready()
    raw = await session.call([["rec", RECOMMEND_API, data]])
    entry = raw.get("rec") or {}
    ret = str(entry.get("ret") or "")
    if not entry.get("ok"):
        raise GatedError(f"goofish refused the recommendation endpoint: {ret}")
    payload = entry.get("data") or {}
    cards = payload.get("cardList") or []
    if not cards:
        raise ParseError(
            f"recommendation endpoint returned no cards for item {iid or '(generic)'}: "
            f"keys={sorted(payload.keys())[:10]}"
        )
    pg = await session.page()
    items = await evaluate(
        pg, FEED_NORMALIZE_JS, {"rows": [c.get("cardData") or c for c in cards]},
        what="recommendation normalizer",
    )
    items = dedupe([i for i in items if i.get("item_id")])
    if not items:
        raise ParseError("recommendation cards had no item ids; the payload shape likely changed")
    return {
        "item_id": iid or None,
        "page": page,
        "account_required": False,
        "source": "item_web_recommend",
        "raw_cards": len(cards),
        "unique_items": len(items),
        "has_more": bool(payload.get("hasMore")),
        "count": len(rank_items(items, limit)),
        "items": rank_items(items, limit),
    }


# ------------------------------------------------------------------ reporting


async def capabilities() -> dict[str, Any]:
    """What this server can and cannot do right now, verified against the live site.

    A diagnostic must never be the thing that crashes, so every probe is guarded and
    reported as status rather than raised -- including a browser that has gone away.
    """
    session = get_session()
    status: dict[str, Any] = {
        "requires_xianyu_account": False,
        "session_state": "unknown",
        "login_probe_ret": "",
        "feed_reachable": False,
    }
    try:
        await _probe_capabilities(session, status)
    except Exception as e:  # noqa: BLE001 -- the last line of defence for a diagnostic
        status["error"] = f"{type(e).__name__}: {e}"
    # read after the probes, so a browser that had to be relaunched shows up
    status["browser_launches"] = session.launches
    return status


async def _probe_capabilities(session: Any, status: dict[str, Any]) -> None:
    """Fill `status` in place. Anything that goes wrong is recorded, not raised."""
    try:
        await session.ensure_ready()
    except XianyuError as e:
        status["error"] = f"{type(e).__name__}: {e}"
        status["note"] = (
            "goofish did not serve a usable page. Known causes, in the order we have "
            "actually observed them: (1) the network resolves goofish to IPv6 but has no "
            "working IPv6 route, so Chromium gets ERR_ADDRESS_UNREACHABLE where curl over "
            "v4 returns 200 -- pin the host to IPv4 or fix the route; (2) resource "
            "exhaustion after many browser launches, ERR_INSUFFICIENT_RESOURCES; (3) "
            "goofish serving a footer-only shell as a successful 200, which is a "
            "server-side risk decision and does lift after a pause. The feed API needs "
            "only the mtop client once and survives (1) and (2)."
        )
        return

    try:
        login = await session.call([["me", LOGINUSER_API, {}]])
        entry = login.get("me") or {}
        status["login_probe_ret"] = str(entry.get("ret") or "")
        status["session_state"] = "logged_out" if not entry.get("ok") else "unexpectedly_logged_in"
    except XianyuError as e:
        status["login_probe_error"] = f"{type(e).__name__}: {e}"

    try:
        feed = await session.call([["f", FEED_API, {"pageNumber": 1}]])
        status["feed_reachable"] = bool((feed.get("f") or {}).get("ok"))
    except XianyuError as e:
        status["feed_probe_error"] = f"{type(e).__name__}: {e}"

    status.update({
        "works_without_account": [
            "browse_feed: paged homepage feed, 20 listings/page, live inventory",
            "search_items: keyword search, retried because goofish declines some page loads",
            "recommendations: 猜你喜欢 / 为你推荐 rails, with a live-feed fallback",
            "item_view: price, want/browse counts, description, seller and stats from the "
            "rendered item page (throttled per IP, so it retries and then reports)",
        ],
        "anonymous_flakiness": [
            "search_items works logged out, but goofish declines on some page loads: the "
            "search API is not even called and the page renders the 猜你喜欢 rail instead. "
            "search_items retries and only accepts results whose titles match the query.",
        ],
        "notes": [
            "goofish shows anonymous visitors a dismissible login dialog; it does not gate "
            "browsing, but it must be closed or the page renders zero cards.",
            "The feed is not keyword-filterable and ignores cCatId, so it samples inventory "
            "rather than answering queries.",
            "The item-detail API (mtop.taobao.idle.pc.detail) times out for anonymous "
            "callers; item_view reads the rendered page instead.",
            "Chromium on a network with broken IPv6 can fail to connect at all "
            "(ERR_ADDRESS_UNREACHABLE) where curl succeeds, which looks like an empty page.",
        ],
    })
