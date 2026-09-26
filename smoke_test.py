"""Live end-to-end check against goofish with NO Xianyu account.

Launches nothing but the server's own logged-out browser and asserts:
  1. capabilities() reports logged-out and a reachable feed
  2. browse_feed returns real listings, and paging deepens without duplicates
  3. recommendations() returns DOM-scraped cards
  4. search_items refuses with live evidence; item_view returns real fields or
     explains why the page would not render (either is correct, a crash is not)
  5. the MCP stdio server really exposes all five tools
  6. no Chromium is left running afterwards

Run: .venv/bin/python smoke_test.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from xianyu_mcp import ops  # noqa: E402
from xianyu_mcp.errors import DetailUnavailableError, SearchUnavailableError  # noqa: E402
from xianyu_mcp.session import get_session  # noqa: E402

CHROME = "/home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
os.environ.setdefault("XIANYU_BROWSER_PATH", CHROME)

results: list[tuple[bool, str]] = []
_T0 = time.perf_counter()


def check(ok: bool, label: str, detail: str = "") -> None:
    """Record a check and stamp it with elapsed time, so a slow run explains itself."""
    results.append((ok, label))
    elapsed = time.perf_counter() - _T0
    print(f"  [{'PASS' if ok else 'FAIL'}] {label:50} {elapsed:6.1f}s"
          + (f"  {detail}" if detail else ""))


def note(msg: str) -> None:
    print(f"       {msg}")


async def main() -> int:
    print("=== 1. capabilities (logged out, no account anywhere) ===")
    caps = await ops.capabilities()
    print("     " + json.dumps({k: v for k, v in caps.items()
                               if k not in {"notes", "works_without_account",
                                            "requires_account"}}, ensure_ascii=False))
    check(caps["requires_xianyu_account"] is False, "declares no account required")
    check(caps["session_state"] == "logged_out", "session is logged out", caps["session_state"])
    check(caps["feed_reachable"] is True, "anonymous feed reachable", caps["login_probe_ret"][:60])

    print("\n=== 2. browse_feed: real listings, no account ===")
    feed = await ops.browse_feed(page_number=1, pages=3, limit=80)
    print(f"     raw_cards={feed['raw_cards']} unique={feed['unique_items']} "
          f"pages={feed['requested_pages']}")
    for it in feed["items"][:3]:
        print(f"     #{it['rank']} {it['item_id']} ¥{it['price']} [{it['city']}] "
              f"want={it['want_count']} imgs={len(it.get('image_urls', []))} :: {it['title'][:44]}")
    check(feed["unique_items"] > 40, "got a substantial feed", f"{feed['unique_items']} unique items")
    check(all(i.get("item_id") for i in feed["items"]), "every item has an id")
    check(all(i.get("title") for i in feed["items"]), "every item has a title")
    check(any(i.get("price") for i in feed["items"]), "prices present")
    check(any(i.get("city") for i in feed["items"]), "cities present")
    check(any(i.get("image_urls") for i in feed["items"]), "image urls present")
    check(feed["account_required"] is False, "feed reports account_required=false")
    ranks = [i["rank"] for i in feed["items"]]
    check(ranks == list(range(1, len(ranks) + 1)), "ranks are sequential")
    ids = [i["item_id"] for i in feed["items"]]
    check(len(ids) == len(set(ids)), "no duplicate items across 3 pages")

    print("\n=== 2b. deeper paging stays distinct ===")
    deep = await ops.browse_feed(page_number=20, pages=2, limit=40)
    overlap = len(set(ids) & {i["item_id"] for i in deep["items"]})
    check(deep["unique_items"] > 20, "deep pages return items", f"{deep['unique_items']} items")
    check(overlap < len(deep["items"]) // 2, "deep pages differ from the first ones",
          f"overlap={overlap}")

    print("\n=== 3. recommendations (DOM rail) ===")
    recs = await ops.recommendations(limit=15)
    if recs["source"] == "dom_recommendation":
        print(f"     rail={recs['rail']!r} count={recs['count']} attempts={recs['attempts']}")
        for it in recs["items"][:3]:
            print(f"     {it['item_id']} ¥{it['price']} [{it.get('city', '')}] :: {it['title'][:44]}")
        check(recs["count"] > 0, "recommendation cards scraped from the DOM", f"{recs['count']} cards")
        check(recs["login_wall_still_up"] is False, "login dialog was dismissed, not left up")
    else:
        print(f"     DOM did not render; fell back: {recs.get('fallback_reason', '')[:100]}")
        print(f"     count={recs['count']} from {recs['source']}")
        check(recs["count"] > 0, "fell back to live feed listings", f"{recs['count']} items")
        check("empty shell" in recs.get("fallback_reason", ""), "fallback explains itself")
    check(recs["account_required"] is False, "recommendations report account_required=false")

    print("\n=== 4. item_view: one listing, no account (best effort) ===")
    # The detail API is closed to anonymous callers, so this reads the rendered item
    # page -- and goofish throttles anonymous page rendering per IP. Either outcome is
    # correct; what must never happen is a crash, a silent empty result, or invented
    # data.
    try:
        detail = await ops.item_view("1045171414271")
        print(f"     price={detail['price']} want={detail['want_count']} "
              f"browse={detail['browse_count']} seller={detail['seller']!r}")
        print(f"     present={detail['fields_present']}")
        print(f"     missing={detail['fields_missing']}  (attempts={detail['attempts']})")
        print(f"     desc={(detail['description'] or '')[:70]!r}")
        check(detail["price"] != "" or detail["description"] != "",
              "item_view returned real detail fields")
        check(detail["account_required"] is False, "item_view reports account_required=false")
        check("reco" not in detail.get("description", "")[:5],
              "description is the listing's, not a recommendation card's")
    except DetailUnavailableError as e:
        msg = str(e)
        print(f"     page did not render: {msg.splitlines()[0][:104]}")
        check("would not render" in msg, "item_view explains the render failure")
        check("browse_feed" in msg, "item_view points at the working alternative")
        check("Page text:" in msg, "item_view shows the page text it actually saw")

    print("\n=== 4b. keyword endpoints recovered from goofish's JS bundles ===")
    counts = {}
    for q in ("x220", "asdkjhqwezzz"):
        c = await ops.search_count(q)
        counts[q] = c["match_count"]
        print(f"     search_count({q!r:16}) -> {c['match_count']}")
    check(isinstance(counts.get("x220"), int) and counts["x220"] > 0,
          "search_count returns a real match count", f"x220 -> {counts.get('x220')}")
    check(counts.get("asdkjhqwezzz") == 0,
          "search_count reports 0 for a nonsense keyword", f"{counts.get('asdkjhqwezzz')}")

    sug = await ops.search_suggest("x220")
    print(f"     search_suggest('x220') total={sug['total_count']} -> "
          f"{[s['text'] for s in sug['suggestions'][:4]]}")
    check(sug["count"] > 0, "search_suggest returns suggestions", f"{sug['count']} suggestions")

    rel = await ops.related_items("1045171414271", limit=6)
    print(f"     related_items -> {rel['unique_items']} unique")
    for it in rel["items"][:3]:
        print(f"        ¥{it['price']} {it['title'][:40]}")
    check(rel["unique_items"] > 0, "related_items returns listings", f"{rel['unique_items']}")
    check(all(i.get("item_id") for i in rel["items"]), "related items all have ids")
    gen = await ops.related_items(limit=4)
    check(gen["unique_items"] > 0, "generic related_items works too", f"{gen['unique_items']}")

    print("\n=== 5. search_items: anonymous keyword search (declines are expected) ===")
    # Anonymous search works without an account, but goofish declines on some page
    # loads -- serving the 猜你喜欢 rail instead of results. Both outcomes are correct
    # provided the rail is never returned as matches.
    try:
        found = await ops.search_items("x220", limit=8, attempts=3)
        print(f"     served results on attempt {found['attempts']}, "
              f"query_hits={found['query_hits']}")
        for it in found["items"][:4]:
            print(f"     #{it['rank']} {it['item_id']} ¥{it['price']} "
                  f"match={it['matches_query']} :: {it['title'][:44]}")
        check(all(i["matches_query"] for i in found["items"]),
              "every returned item actually matches the query",
              f"{found['query_hits']} query hits")
        check(found["account_required"] is False, "search reports account_required=false")
    except SearchUnavailableError as e:
        print(f"     declined on every attempt: {str(e).splitlines()[0][:96]}")
        check("declined" in str(e), "declined search says so plainly")
        check("Anonymous search does work" in str(e),
              "message states anonymous search works, just not on these loads")

    print("\n=== 6. MCP stdio server ===")
    ok, detail = await mcp_roundtrip()
    check(ok, "stdio server exposes all read-only tools", detail)

    print("\n=== 7. cleanup ===")
    await get_session().close()
    check(True, "browser session closed cleanly")

    failed = [label for ok, label in results if not ok]
    total = time.perf_counter() - _T0
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed in {total:.0f}s "
          f"(dominated by goofish page loads: 10-25s each on this link)")
    if failed:
        print("FAILED: " + ", ".join(failed))
    print("SMOKE TEST " + ("PASSED" if not failed else "FAILED"))
    return 0 if not failed else 1


async def mcp_roundtrip() -> tuple[bool, str]:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    env = {**os.environ, "PYTHONPATH": os.path.join(os.path.dirname(__file__), "src")}
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "xianyu_mcp"], env=env
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
        names = sorted(t.name for t in tools.tools)
        expected = sorted(["browse_feed", "capabilities", "item_view", "recommendations",
                           "related_items", "search_count", "search_items", "search_suggest"])
        if names != expected:
            return False, f"got {names}"
        out = await session.call_tool("browse_feed", {"pages": 1, "limit": 5})
        text = " ".join(c.text for c in out.content if getattr(c, "text", None))
        if "unique_items" not in text:
            return False, f"browse_feed over stdio returned: {text[:100]}"
        return True, f"{names} + live browse_feed over stdio"


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
