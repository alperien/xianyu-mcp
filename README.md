# xianyu-mcp

**Read-only Xianyu (闲鱼 / Goofish) MCP server that needs no Xianyu account. No cookies, no
login, no stored credentials, no write tools.**

---

## What "no account" actually gets you

I measured this against the live site rather than assuming, and the answer is not uniform.
Goofish gates some things behind a login and not others:

| Tool | Account needed? | Reality |
|---|---|---|
| `search_count` | **No** | `mtop.taobao.idle.filter.hitnum.pc.get` — the endpoint the search page itself calls to show its result count. Same payload shape as search, different endpoint, so it is **not** subject to the per-load decline. Verified: `x220` → 28791, `thinkpad t480` → 5668, nonsense → 0. |
| `search_suggest` | **No** | `mtop.taobao.idlemtopsearch.pc.search.suggest` — goofish's own search-box autocomplete. `x220` → `x220笔记本`, `x220键盘`, `x220电池`, … |
| `related_items` | **No** | `mtop.taobao.idle.item.web.recommend.list` — "more like this" for an item, or goofish's generic set. ~30-60 real listings per call, titles and prices; recommendations are topically coherent. |
| `browse_feed` | **No** | `mtop.taobao.idlehome.home.webpc.feed` serves logged-out callers. 20 real listings/page with title, price, city, seller, want-count and image URLs. Verified 8 pages / **157 unique listings, 0 duplicates**, no rate limiting. |
| `item_view` | **No** | The detail *API* times out for anonymous callers, but the item *page* renders the listing: price, want/browse counts, description, seller, seller tenure/items-sold/positive-rate, photos. Whether a given call gets a rendered page depends on the throttling below. |
| `recommendations` | **No** | The 猜你喜欢 / 为你推荐 rails render for anonymous visitors. Falls back to live feed listings if the DOM won't cooperate, and says so. |
| `search_items` | **No** | Anonymous keyword search works: verified live, returning real matches (a `x220` query returned the listing "X220笔记本 ThinkPad 主板cpu i7 2620m" at ¥180). But goofish decides **per page load** whether to serve results; when it declines it does not call the search API at all and renders the 猜你喜欢 rail instead. Real browsers rarely see the decline; an automated client often does, so this tool retries with fresh loads. |

`search_items` will not hand back recommendation cards dressed up as search results — an anonymous
search page that declined is full of them, and an agent that scraped it would report "no iPhones
found for sale" when in fact goofish never searched. So a result set is only accepted when at least
one card title actually contains the query (`query_hits > 0`), the rail is absent, and the page does
not say nothing was found. Every item carries `matches_query`. When goofish declines on all attempts
the tool raises `SearchUnavailableError` with the per-attempt log, and says plainly that anonymous
search does work — just not on those loads.

**What actually causes the failures — not this code.** Three distinct causes, all measured:

1. **Broken IPv6.** goofish resolves to both v4 and v6, and on some networks (including the one this
   was developed on) the v6 route is blackholed: `curl -6` returns nothing while `curl -4` returns
   `200` in ~10s. Chromium prefers IPv6 and fails with `ERR_ADDRESS_UNREACHABLE` where curl succeeds.
   This was misread as throttling for a while. Pinning hosts to IPv4 with
   `--host-resolver-rules` fixes navigation but made goofish's *serving* worse in testing, so the
   tool does not do it by default — fix the route instead.
2. **Resource exhaustion, usually a small `/tmp`.** Chromium fails with
   `ERR_INSUFFICIENT_RESOURCES` — on *every* host, not just goofish — when it cannot
   allocate. In a container this is nearly always `/tmp` filling up: Playwright puts each
   browser profile in `/tmp`, and a tmpfs `/tmp` will do it. Check `df -h /tmp`. Page-load
   failures are counted as declined attempts, not fatal, and every in-page call is bounded
   by a timeout so a hung request can never wedge a tool call.
3. **goofish's own degradation.** With `failed_reqs=0, http_errors=0` and a footer-only body, goofish
   serves an empty shell as a successful `200`. That is a server-side risk decision, and it does lift
   after a pause.

### Two things that will bite you

**1. The login dialog must be dismissed.** goofish shows anonymous visitors a full-page login
iframe (baxia). It does *not* gate browsing, but while it is up the page renders **zero cards** —
which is very easy to misread as "no results". The server dismisses it on every page load. This
was the original cause of a wrong conclusion in this project's own development: 0 cards looked
like a login wall, and it wasn't.

**2. Anonymous page rendering is throttled per IP, and degrades silently.** The same URL comes
back fully rendered, or as an empty shell (510 characters of footer, no bundle execution), with no
error. `item_view` and `recommendations` retry with cache-busted reloads and then report exactly
what they got — `fields_present` / `fields_missing`, or a typed `DetailUnavailableError` carrying
the page text. `browse_feed` is the reliable path: it needs the mtop client but no rendered listing
page. Sustained probing gets the *feed* API throttled too, which it answers with `TIMEOUT`; the
tools report that as a `GatedError` with the real code, never as an empty result.

## Install

```bash
cd xianyu-mcp
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m playwright install chromium   # or use XIANYU_BROWSER_PATH
```

Headless is the default and works — no display, no window, no account. Set `XIANYU_HEADLESS=0`
for a windowed run if you want to watch it.

| Env var | Default | Purpose |
|---|---|---|
| `XIANYU_BROWSER_PATH` | playwright's Chromium | use a specific Chrome/Chromium binary |
| `XIANYU_HEADLESS` | `1` | `0` runs windowed |

## MCP client config

```json
{
  "mcpServers": {
    "xianyu": { "command": "/path/to/xianyu-mcp/.venv/bin/xianyu-mcp" }
  }
}
```

## Tools

| Tool | Args | Returns |
|---|---|---|
| `capabilities` | — | what works right now, probed live: `session_state`, `feed_reachable`, plus the split above. Never raises, not even if the browser is gone. |
| `browse_feed` | `page_number` (1–10000), `pages` (1–25), `limit` | `items[]` of rank, item_id, title, price, original_price, city, seller, want_count, image_count, image_urls, is_video, category_id, url; plus `page_reports` and `account_required: false` |
| `item_view` | `item_id` (digits or item URL) | price, want/browse counts, description, seller, seller_tenure_years, seller_items_sold, seller_positive_rate, image_urls, `fields_present`, `fields_missing` |
| `recommendations` | `limit`, `url` | `source` is `dom_recommendation` or `homepage_feed` (with `fallback_reason` when it fell back) |
| `search_items` | `query` | always `ok: false` with a live `RGV587`/login-redirect quote and a pointer to `browse_feed` |

All return `{"ok": true, "data": …}` or `{"ok": false, "error_type": …, "message": …}`.
`error_type` is one of `BrowserError`, `GatedError`, `SearchUnavailableError`,
`DetailUnavailableError`, `ParseError`, `NavigationError`, `XianyuError` — or the name of an
unexpected exception, which is reported the same way rather than being allowed to kill the
call. Nothing is ever returned as data that was not read from goofish: when a page will not
render, the tool raises rather than guessing.

Tool calls are serialised. The session is one browser and one page, so two tools in flight at
once would navigate it out from under each other and one would report the other's page as its
own data.

## Latency

Measured warm, on a link where goofish takes 1.6–17s per response:

| call | latency | why |
|---|---|---|
| `search_suggest` | **0.5–2 s** | one mtop call, no navigation |
| `search_count` | **1–4 s** | one mtop call, no navigation |
| `related_items` | **2–6 s** | one mtop call, no navigation |
| `browse_feed` | **3–13 s** | one batched mtop call, no navigation |
| `recommendations` | 8–17 s | must load a page for the DOM rail |
| `item_view` | 5–9 s when it renders | must load the item page and wait for the SPA to paint |
| cold start | **~23 s, once per session** | Chromium launch (~5s) + first page load |

Two things keep it that fast, and both are pinned by tests:

- **No redundant navigation.** Only the DOM-scraping tools navigate. Everything else calls
  `Session.ensure_ready()`, which navigates *only* if there is no page, it is off-site, or the
  mtop client is not up. Navigating per call cost 10–25s each time for nothing.
- **A cheap boot page.** The mtop client is live at `domcontentloaded`, so there is no reason to
  boot on the homepage — measured 20.2s for the homepage against 3.5s for an item page. The
  session boots on `BOOT_URL` (an item page) instead, and the feed and match counter both work
  normally from there.

### Wall-clock budgets

`item_view` and `search_items` are best-effort: goofish sometimes serves an empty shell instead of
the page, so they retry with fresh loads. A page load costs 10–25s on a slow link, and without a
ceiling one `item_view` call once ran for 95s waiting on five declined loads. Both now stop on a
clock and report how far they got, rather than holding the caller:

| env var | default | effect |
|---|---|---|
| `XIANYU_ITEM_VIEW_BUDGET_S` | 45 | ceiling on `item_view` retries |
| `XIANYU_SEARCH_BUDGET_S` | 45 | ceiling on `search_items` retries |

Raise them if you would rather wait for a render than get a fast refusal.

## Guarantees, enforced by tests

- **No account, ever.** The server launches a brand-new browser context. `loginuser.get` is used
  only to *prove* the session is logged out, and `capabilities()` reports `session_state`.
- **No credentials.** `context.cookies()`, `add_cookies`, `storage_state`, `launch_persistent_context`
  and `user_data_dir` appear nowhere in the source — including `smoke_test.py`; a test fails the
  build if one shows up. The only mtop endpoints named anywhere are the four read-only ones, also
  pinned by a test.
- **Read-only.** No publish, delete, message, upload or account tool exists, and no write mtop
  API is referenced. There is nothing here that can change state on goofish or your account.
- **goofish only, over https.** Every navigation passes a host *and* scheme allowlist, checked
  again against the URL goofish itself landed on, so a prompt-injected tool call cannot walk the
  browser elsewhere (`file://www.goofish.com/…` and `https://www.goofish.com@evil.com/` are both
  refused).
- **No invented data.** Field-level honesty: `fields_missing` is reported rather than filled in,
  and search refuses instead of substituting recommendations. If goofish serves a different
  listing than the one asked for, `item_view` raises rather than report it.

## Development

```bash
.venv/bin/python -m pytest -q     # unit tests, no network
.venv/bin/python -m ruff check src tests smoke_test.py
.venv/bin/python smoke_test.py    # live end-to-end against goofish, no account
```

`smoke_test.py` asserts the contract that matters: a logged-out session, real listings with ids,
titles, prices, cities and images, no duplicates across pages, search refusing with live evidence,
item_view either returning real fields or failing with an explanation, all five tools over real
MCP stdio, and no browser left running.

### Verified / not verified

Verified live (most recent full run, 24/24): anonymous feed paging with both card shapes,
item-page detail extraction including photos, login-dialog dismissal, the recommendation rails,
MCP stdio round-trip, and error classification.

Search is the flaky one, and honestly so: it returned real matches for `x220` — including the
listing "X220笔记本 ThinkPad 主板cpu i7 2620m" — but declines on most page loads from an
automated headless client. A real logged-out browser sees it succeed reliably. `search_items`
therefore retries, and reports a decline as a decline rather than as "no such results exist".

Not verified: keyword search (it needs an account — that is the finding, not a gap), and
steady-state `item_view` reliability under sustained load, because this machine's IP got throttled
for anonymous page rendering during development. That throttling is itself the documented
behaviour, and the code reports it rather than hiding it.

## How the endpoint list was obtained

By reading goofish's own JS bundles (`g.alicdn.com/idle-pc/xy-site/*/js/*.js`, ~3.6 MB) and
extracting every `mtop.*` API name: **51 endpoints**, of which the web client can actually reach
about twenty. Reading the minified call sites gave the exact parameter shapes, which is what made
`search_count`, `search_suggest` and `related_items` work on the first attempt. Two useful negatives
from the same exercise: `idleitem.preget` is a *publish* preflight with empty data (not item detail),
and `kgraph.property.search` is publish-flow category lookup. The `item.web.recommend.list` call site
also revealed two values that are mandatory and undocumented — `pageSize` is hardcoded to 30 and a
missing `itemId` is rejected outright, hence the seed id.

No request signing, token minting or fingerprinting is reimplemented: every call goes through
`window.lib.mtop.request` inside the page, so goofish's own code produces the signature, the token
and the `bx-ua` header. That is also why the login dialog has to be dismissed rather than worked
around.

## How it works

The server drives a real Chromium because that is the only client goofish answers. Anonymous page
loads install goofish's own `window.lib.mtop`, and the server calls through it — no token minting,
no request signing, no reverse-engineered auth. That is also why the login dialog has to go: the
bundle is already there, the dialog is just on top.

The feed mixes two card layouts (`detailParams`-style and `titleSummary`/`priceInfo`-style); the
normalizer reads both, since neither is guaranteed. Item detail is parsed from the text *above* the
recommendation rail, because parsing the whole page returns a recommendation card's price and title
as if they were the listing's.

Failure is part of the contract, not an afterthought. A page that will not render, a dead browser, a
navigation timeout, a Playwright execution context destroyed by goofish's own SPA, or a payload that
changed shape all arrive as a typed `ok: false` with what was actually observed — the page text, the
real `ret` code, the mtop endpoint that came back wrong. None of them invent a listing to fill the
gap.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The in-page JavaScript extractors for search results and item detail were adapted from
[`goofish-cli`](https://github.com/fancyboi999/goofish-cli) (Apache-2.0, © 2026 fancy).
This tool is for lawful, read-only automation of publicly visible listings; no account,
credential or cookie is used or required, and resale as a service aimed at the platform is
disallowed.
