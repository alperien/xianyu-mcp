# xianyu-mcp

**Read-only Xianyu (闲鱼 / Goofish) MCP server that needs no Xianyu account. No cookies, no login, no
stored credentials, no write tools.** TypeScript, run directly by Node — unflagged type stripping
landed in 23.6 and was backported to **22.18**, so that is the floor: on 22.6–22.17 `node src/index.ts`
and `node --test` both fail with `ERR_UNKNOWN_FILE_EXTENSION` unless you add
`--experimental-strip-types`. There is no build step and no dist/.

It drives its own throwaway Chromium with Playwright and reads goofish the way an anonymous visitor's
browser does — including calling goofish's own JS client (`window.lib.mtop.request`) rather than
re-implementing token minting and request signing, which is the whole reason a browser is involved.

It launches **windowed**, and needs a display (`DISPLAY=:0`, or Xvfb) — that is a measurement, not a
preference: [headless gets served goofish's risk-control page](#headless-vs-headed) instead of the app.
It never clicks anything in the page, and [the login dialog is deliberately left alone](#the-login-dialog-is-left-alone-on-purpose).

## Install

```bash
npm install                      # deps: @modelcontextprotocol/sdk, playwright, zod
npx playwright install chromium  # or point XIANYU_BROWSER_PATH at a Chrome/Chromium binary
```

## MCP client config

```json
{
  "mcpServers": {
    "xianyu": { "command": "node", "args": ["/path/to/xianyu-mcp-ts/src/index.ts"] }
  }
}
```

| Env var | Default | Purpose |
|---|---|---|
| `XIANYU_BROWSER_PATH` | Playwright's Chromium | use a specific Chrome/Chromium binary |
| `XIANYU_HEADLESS` | `0` (windowed) | `1` runs headless. Headed is the default because goofish serves headless Chromium its risk-control page instead of the app — see [Headless vs headed](#headless-vs-headed). Needs a display (`DISPLAY=:0`, or Xvfb). |
| `XIANYU_SEARCH_BUDGET_S` | 45 | wall-clock budget for the `search_items` retry loop (5–600s) |
| `XIANYU_ITEM_VIEW_BUDGET_S` | 45 | wall-clock budget for the `item_view` retry loop (5–600s) |
| `XIANYU_RECOMMENDATIONS_BUDGET_S` | 45 | wall-clock budget for the `recommendations` retry loop (5–600s) |

The budget bounds the *loop*, not the call. It is checked between attempts, so a page load already in
flight runs to completion: at the 45s default and a 10–25s load you get two or three attempts, and a
call can overshoot its budget by roughly one page load.

## Tools

Every tool returns `{"ok": true, "data": …}` or `{"ok": false, "error_type": …, "message": …}`.
`error_type` is the class name, and the list is exhaustive: `BrowserError`, `GatedError`,
`SearchUnavailableError`, `DetailUnavailableError`, `ParseError`, `NavigationError` or `XianyuError`,
plus `Error` for a throw that is none of ours (a test pins the list against the classes in `errors.ts`). Calls are serialised —
one browser, one page — so two tools in flight cannot navigate each other out of their own data.

| Tool | Args | Key return fields |
|---|---|---|
| `capabilities` | — | `session_state` (`unexpectedly_logged_in` / `logged_out` / `unknown` — `logged_out` only from a ret that actually names the session or token, so a rate limit or a timeout reads `unknown` rather than proving anonymity), `feed_reachable`, `login_probe_ret`, `works_without_account`, `anonymous_flakiness`, `notes`, `note`, `browser_launches`, and a `browser_error` / `login_error` / `feed_error` per probe. Never raises, not even if the browser is gone. |
| `browse_feed` | `page_number` (1–10000, d1), `pages` (1–25, d1), `limit` (≤500, d60) | `items[]` of `rank, item_id, title, price, original_price, city, seller, want_count, image_count, image_urls, is_video, category_id, url`; `page_reports`, `raw_cards`, `unique_items`, `count`, `source: homepage_feed` |
| `search_count` | `query` | `match_count`, `has_matches`, `source: filter_hitnum`. Zero is an answer, not an error — but only when the site said zero: a `hitnum` that is missing, null, a string or carries a thousands separator is a `ParseError`, never `match_count: 0`. |
| `search_suggest` | `query`, `limit` (d20) | `suggestions[]` of `text, bucket_num`, `total_count`, `count`, `source: search_suggest` |
| `search_items` | `query`, `limit` (d30), `attempts` (1–10, d4) | `items[]` of matches only (`matches_query` always true), `count` (matches), `query_hits` (whole query as a substring), `token_hits` (every word of the query, any order — a looser superset, published so a word-order refusal is diagnosable), `min_query_hits`, `scraped_cards`, `non_matching_count`, `attempt_log` (each entry carries `blocked`, so a risk-control page is distinguishable from a declined search), `source: search_page_dom`. Raises `SearchUnavailableError` rather than returning the rail. |
| `related_items` | `item_id` (optional), `limit` (d30), `page` (1–10000, d1) | `items[]` (feed card shape), `raw_cards`, `unique_items`, `has_more`, `source: item_web_recommend` |
| `item_view` | `item_id` (digits or item URL) | `title, price, want_count, browse_count, description, seller, seller_tenure_years, seller_items_sold, seller_positive_rate, image_urls`, plus `fields_present` / `fields_missing`, `page_item_id`, `reco_anchors`, `image_candidates`, `source: item_page_dom` |
| `recommendations` | `limit` (d30), `url` (optional) | `items[]`, `rail`, `page_url`, `attempts`, `risk_control_page`, `count`, `source: dom_recommendation` — or `source: homepage_feed` with `fallback_reason` when the DOM will not render |

## The login dialog is left alone, on purpose

goofish puts a full-page login dialog in front of anonymous visitors: an `ant-modal-mask` (z-index 1000)
and an `alibaba-login-box` passport iframe. **It does not gate anything, and closing it is not what makes
search work.** This server used to claim the opposite — "it must be closed or the page renders zero
cards" — and to click its close controls after every navigation. That was backwards, and it made
`search_items` decline on essentially every attempt.

An A/B, headed, same URL, one fresh context per arm:

| arm | t+6s | t+12s | t+18s | t+24s |
|---|---|---|---|---|
| no dismissal | 0 cards | **30 cards**, real X220 matches (`联想ThinkPad X220，12.5寸黑色…`) | 30 | 30 |
| dismiss at t+6s | 0 | 0 (4 elements clicked) | 0 | 0 |
| dismiss at t+12s | 0 | 0 | 0 (4 clicked) | 0 |

The cards are in the DOM *underneath* the mask the whole time; clicking the close controls put the page
into a state where the result list never rendered and the 猜你喜欢 rail was served instead.

So nothing here clicks the page at all. Both scrapers work off `querySelectorAll` and `innerText`, which
see straight through an overlay — measured directly: on an item page the `为你推荐` rail rendered and was
read with `ant-modal-mask` still up, and `bottomLead` — the fixed full-width "登录后可以更懂你…
立即登录" bar at z-index 999 — was up in the same samples without changing the card count. It sits at the
bottom of the viewport and would cover the last row for a real user clicking around; it covers nothing
that is read. A test pins this: a search page with the dialog and four clickable close controls wired to
a tripwire still returns its matches, and the tripwire has to stay quiet.

A real logged-out user does see a first popup at ~7s, a second one later, and reports that closing them
makes results appear. That is a real-browser-profile observation and this code is not it, so it is
recorded and not designed around. The one thing measured here is that the click, on this client, is
harmful.

## Headless vs headed

Measured, same URL, one fresh context per run, sampling every 4s for 128–200s:

| | headed | headless |
|---|---|---|
| what goofish serves | the app: filter bar, suggest rail, login dialog, 20 cards, 2.3KB | the risk-control page: `非法访问 为了保障您的体验，请使用正常浏览器访问闲鱼~`, 0 cards, **35 bytes**, for the entire run |
| `mtop` client | up | **up** — it boots on the risk-control page too |
| DOM tools | get the real page | get nothing to read |

So **headed is the default** and the three DOM tools need a display. What headless can still do is
everything that only needs goofish's own JS client — `browse_feed`, `search_count`, `search_suggest`,
`related_items`, and the probes inside `capabilities` — because the mtop client comes up on the
risk-control page as well. That was measured: all four returned normal data headless.

Set `XIANYU_HEADLESS=1` to opt back in; the cost is the DOM tools.

## Latency

Measured live on 2026-09-27, one fresh browser process per tool, on a shared 4-core box running at load
~12 (one goofish page load is 10–25s here, and Chromium launch is ~5s). Headed figures are the range
across two full runs; the box was under different load for each, so treat these as order of magnitude,
not a benchmark. The outcome column is what is stable — the same six tools, and the same two failures,
every run.

| tool | headless | headed | result |
|---|---|---|---|
| `capabilities` | 40.4s | 14.2s / 37.0s | ok — `logged_out`, `feed_reachable: true` |
| `browse_feed` | 19.0s | 13.2s / 55.4s | ok — 10 listings, `homepage_feed` |
| `search_count` | 26.9s | 11.6s / 21.8s | ok — 28,841 / 29,671 / 28,844 for `x220` across runs |
| `search_suggest` | 14.8s | 9.7s / 23.9s | ok — 10 suggestions |
| `related_items` | 14.8s | 14.9s / 65.9s | ok — 10 listings, `item_web_recommend` |
| `recommendations` | 19.9s | 18.6s / 31.3s / 50.9s | ok — 10 real listings; `dom_recommendation` on three runs, `homepage_feed` fallback on a fourth (see below) |
| `search_items` | 45.9s | 45.3s / 47.6s | **`SearchUnavailableError`** — declined by the site, see below |
| `item_view` | 51.3s | 52.6s / 57.3s | **`DetailUnavailableError`** — detail block not served, see below |

Six of eight work in both modes. The two failures are the same failure with or without the login dialog.

On a warm session the mtop tools drop to **~1–2s** — they are one request with no navigation: the four raw
mtop calls measured 319ms (suggest), 646ms (recommend), 768ms (feed) and 9422ms (the match counter, which
is the one the server actually waits on). The figures above are cold-process, so each one also carries a
Chromium launch and usually a page load, and on a loaded box the launch alone dominated the spread.

The budget bounds the *loop*, not the call. It is checked between attempts, so a page load already in
flight runs to completion: at the 45s default and a 10–25s load you get two or three attempts, and a
call can overshoot its budget by roughly one page load. With the 45s default `attempts: 4` is
unreachable — raise `XIANYU_SEARCH_BUDGET_S`, not `attempts`. Note that raising the budget alone does not
help when the site is declining every load: a 280s budget with the default 4 attempts still stopped at
90s on the attempt cap, and 200s of continuous polling on one page load never produced a result.

## What is verified, and what is not

**Verified against the live site, on 2026-09-27.** The mtop endpoints behind `browse_feed`,
`search_count`, `search_suggest` and `related_items` all answer anonymously, in *both* headless and
headed: 8 feed pages / 157 unique listings with 0 duplicates, the match counter at 28,841 and 29,671
for `x220` on consecutive runs (it drifts, so treat the number as a magnitude, not a constant) and 0 for
a nonsense string, autocomplete turning `x220` into `x220笔记本` / `x220键盘` / …, and ~30–60 real
listings per recommendation call. The four raw mtop rets were read directly off the wire:
`SUCCESS::调用成功` for the feed (20 cards), the counter, the suggest list and the recommendation list,
and `FAIL_SYS_SESSION_EXPIRED::Session过期` for `loginuser.get` — so the session really is logged out.
`recommendations` also worked end-to-end off the rendered DOM, 10 real listings, `source:
dom_recommendation`, in both modes, with the login dialog up — on three of four runs; the fourth fell
back to `source: homepage_feed` with a `fallback_reason`, which is the designed behaviour when the rail
will not paint, and is live listings either way. The MCP server itself was driven over
stdio: `initialize`, `tools/list` returning all eight with their schemas and the no-account note on each,
and a live `search_count` returning `{"ok":true,...,"match_count":28846}`.

**Not working, right now, and the reason is the site, not this code.** Two of the eight fail in both
modes on the same day:

- `search_items` — goofish declined the search. The page served the real app shell (filter bar,
  `区域 1/1`, 加载中…) and then 20 cards under the `猜喜欢你` rail with "nothing found" and **zero**
  occurrences of the query anywhere in the page text. It held there for 200s of polling. It is not
  query-specific: `?q=iphone` produced a byte-identical page (2,308 bytes, same rail, same nothing-found).
  With the dialog left alone and with the dialog closed, the outcome was the same (2,308 vs 2,306 bytes,
  20 cards, rail, nothing-found, 0 query hits) — the click changes which pixels are covered, not
  whether results exist. The guard correctly refused to return that rail as results.
- `item_view` — the item page settles at ~2.4KB showing the `为你推荐` rail with real cards but **no
  detail block for the requested listing**: no title, no price, no seller. On the shell page the dialog
  is not even up (`ant-modal-mask` absent), so dismissal is not the missing ingredient. The tool raises
  `DetailUnavailableError` rather than reporting a rail card as the listing.

A third, intermittent state deserves naming because it is otherwise indistinguishable from "no results":
goofish answers with its **risk-control page** instead of the app — a 200 whose entire body reads
`非法访问 为了保障您的体验，请使用正常浏览器访问闲鱼~` with 35 bytes and zero cards. Headless Chromium got
this on every run for 128s straight. Both scrapers now detect it and publish it (`blocked` in the
`attempt_log`, `risk_control_page` on `recommendations`) instead of reporting it as an empty result set.
It is server-side and lifts after a pause.

**Earlier measurements, not re-confirmed today.** The A/B table above (30 real matches at t+12s with no
dismissal, 0 with it) was measured before this pass and could not be reproduced today — the site now
declines the search outright, so no arm produced results. Treat the *direction* (clicking hurts) as
established and the specific 30-card number as historical. The item-page detail extraction including
photos, and 50 pages of search results, come from the same earlier session and are likewise unverified
today.

**Not reliable, by the site's design, not by this code's.** goofish decides *per page load* whether to
serve search results; when it declines it does not call the search API at all and renders "nothing
found" plus the 猜你喜欢 rail instead. Real browsers rarely see it; an automated client sees it much more
often. So `search_items` retries, and a decline is reported as a decline — never as "no such results
exist" and never as a page of recommendations dressed up as matches. A result set is only accepted
when the page has no rail marker, does not say nothing was found, is not the risk-control page, and a
*fraction* of its cards (realistically ≥20%, never fewer than one) have the whole query in the title.
`token_hits` counts titles that hold every *word* of the query in any order; it is published so a
word-order mismatch is diagnosable, but only the substring hits can be accepted. Steady-state
`item_view` reliability is unproven: anonymous page rendering is throttled per IP and degrades to a
footer-only shell with no error, which is why that tool reports `fields_present` / `fields_missing`
rather than filling gaps in.

**One environment note, because it looks exactly like a site failure.** If Chromium dies with
`net::ERR_INSUFFICIENT_RESOURCES` on the *main document*, check the temp filesystem before blaming
goofish: a full `/tmp` quota makes Chromium fail this way, and the network service reports it as a
navigation error. Pointing `TMPDIR` at a filesystem with room (`/dev/shm`) made every failure in this
pass disappear. The known-cause list in `capabilities` names this, and it is genuinely cause #2 — but
note it can be a *quota*, not a size.

## Guarantees, enforced by tests

- **No account, ever.** A brand-new browser context per session. `loginuser.get` is called only to
  *prove* the session is logged out, never to act as one, and `capabilities` reports `session_state`
  from what that probe actually returned — not from the fact that it failed.
- **No credentials.** No cookie, storage-state or persistent-profile API appears anywhere in `src/`
  or `test/`; the test that enforces it matches `.cookies(` with whitespace stripped, so
  `page.context().cookies()` and a call split across lines cannot slip through either.
- **Read-only.** No publish, delete, message, upload or account tool exists. The five mtop API names
  the server may use are a closed list — only `window.lib.mtop.request`, the client method the whole
  design rests on, is exempt — and a test fails if any other `mtop.*` name appears.
- **goofish only, over https.** Every navigation passes a host *and* scheme allowlist checked against
  the *parsed* URL, and re-checked against the URL goofish itself landed on, at both `goto` sites and in
  `currentPage`. Those checks are point-in-time, and a caller then polls for seconds before it reads
  anything, so every DOM read also re-checks the URL that is live *now*, in the same statement as the
  read — one helper, and no scraper may bypass it (a test fails the build if one does).
  `https://www.goofish.com@evil.com/`, `https://www.goofish.computer/` and
  `https://www.goofish.com.evil.com/` are all refused, including when the page lands on one of them
  mid-call.
- **No invented data.** If a page will not render, the tool raises rather than guessing. If goofish
  serves a different listing than the one asked for — or a page with no listing id at all —
  `item_view` raises instead of reporting its fields. The recommendation rail is never returned as
  search results.
- **The page is never clicked.** A structural test fails if a `.click(` call appears anywhere in
  `src/` or `test/`, and if the dismisser's selectors come back.

## Development

```bash
node --test              # 40 tests, no network, no browser
npx tsc --noEmit
node src/index.ts        # stdio; refuses to run interactively
```
