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

From a clone:

```bash
npm install                      # deps: @modelcontextprotocol/sdk, playwright, zod
npx playwright install chromium  # or point XIANYU_BROWSER_PATH at a Chrome/Chromium binary
```

As a dependency (`npm install xianyu-mcp`), the published tarball is prebuilt — `dist/` — and
`npx playwright install chromium` is still needed. The build exists because Node refuses to strip
TypeScript types from files under `node_modules/`, so shipping `src/*.ts` would install fine and then
fail on first run.

Requires **Node 22.18+** (the server runs TypeScript directly, natively). It launches a windowed
Chromium, so it needs a display — on a headless box, `xvfb-run -a node src/index.ts` or an X server.
See [Headless vs headed](#headless-vs-headed) for what `XIANYU_HEADLESS=1` costs you.

## MCP client config

```json
{
  "mcpServers": {
    "xianyu": { "command": "node", "args": ["/path/to/xianyu-mcp/dist/index.js"] }
  }
}
```

| Env var | Default | Purpose |
|---|---|---|
| `XIANYU_BROWSER_PATH` | Playwright's Chromium | use a specific Chrome/Chromium binary |
| `XIANYU_HEADLESS` | `0` (windowed) | `1` runs headless. Headed is the default because goofish serves headless Chromium its risk-control page instead of the app — see [Headless vs headed](#headless-vs-headed). Needs a display (`DISPLAY=:0`, or Xvfb). |
| `XIANYU_SEARCH_BUDGET_S` | 150 | wall-clock budget for the `search_items` retry loop (5–600s) |
| `XIANYU_ITEM_VIEW_BUDGET_S` | 90 | wall-clock budget for the `item_view` retry loop (5–600s) |
| `XIANYU_RECOMMENDATIONS_BUDGET_S` | 45 | wall-clock budget for the `recommendations` retry loop (5–600s) |

The budget bounds the *loop*, not the call. It is checked between attempts, so a page load already in
flight runs to completion: at the 150s default and a 10–25s load you get several attempts, and a call
can overshoot its budget by roughly one page load.

**The server runs windowed and needs a display.** goofish serves headless Chromium its risk-control
page instead of the app, which leaves the three DOM tools with nothing to read, so headed is the
default and a headless machine needs `xvfb-run` or an X server. The four mtop tools work either way.

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

## Search is a keystroke, not a URL

`search_items` does not navigate to `/search?q=`. It loads goofish's **homepage**, finds the SPA's own
header search input, focuses it, types the query and presses Enter.

This is measured, not preferred. A 2x2x2 matrix — headed/headless x fresh/persistent profile x
direct-URL/search-input, one fresh browser per cell — returned results from exactly one cell:

| cell | cards | cards whose titles contain the query | outcome |
|---|---|---|---|
| headed, fresh, **typed into the input** | 30 | 30 | results |
| headed, fresh, `/search?q=` | 20 | 0 | 猜你喜欢 rail |
| every direct-URL cell, headed included | 20 | 0 | 猜你喜欢 rail |
| headless, all cells | 20 | 0 | risk-control page |

So a direct-URL search on this client returns the recommendation rail, not results, and no amount of
retrying fixes it. The first three attempts load the homepage and type; the last is the one direct-URL
navigation, kept so a refusal can quote a real page rather than a guess — it is expected to be refused,
and is reported as what it is.

**The input is focused, not clicked.** goofish's login dialog puts an `ant-modal-mask` over the header,
and Playwright's click actionability check times out against it (measured: a 10s timeout with the element
resolved but never receiving the event). `focus()` needs no pointer, and the keystrokes that follow are
what the SPA's form listens for.

**Typing is verified, not assumed.** The SPA re-renders that input under the cursor, and a
`keyboard.type` burst spanning a re-render is silently truncated — measured, `thinkpad x220` landing as
`th`, which then submitted a near-empty keyword and served the rail. The input is read back after
typing and whatever did not land is re-sent; a query that still will not take is reported as
`incomplete-keystrokes` rather than as a decline.

The homepage is a 512-character footer-only shell for 8–14s before the app mounts, so "no input yet" is
the normal state for the first ten seconds and is polled, not treated as a verdict. After Enter the
router needs ~12s, and the SPA destroys the execution context on the way — a lost context is waited out,
because it is the navigation landing rather than a failure.

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
| `search_items` | 45.9s | 45.3s / 47.6s | **`SearchUnavailableError`** — see the retry note below |
| `item_view` | 51.3s | 52.6s / 57.3s | **`DetailUnavailableError`** — detail block not served, see below |

Six of eight work in both modes. The two failures are the same failure with or without the login dialog.

**This table predates the searchbox rewrite and is out of date for `search_items`.** Search now types into
goofish's own header input instead of navigating to `/search?q=`, and it succeeds: measured 8/8 live
queries (`thinkpad x220`, `x220`, `iPhone 15 Pro`, `自行车`, `thinkpad t480`, `相机`, `显示器`,
`机械键盘`), 7 of them on the first attempt, 18–40s. `item_view` still needs a re-read of the table
below; it is a render-timing problem, not a site refusal.

On a warm session the mtop tools drop to **~1–2s** — they are one request with no navigation: the four raw
mtop calls measured 319ms (suggest), 646ms (recommend), 768ms (feed) and 9422ms (the match counter, which
is the one the server actually waits on). The figures above are cold-process, so each one also carries a
Chromium launch and usually a page load, and on a loaded box the launch alone dominated the spread.

The budget bounds the *loop*, not the call. It is checked between attempts, so a page load already in
flight runs to completion: at the 150s default and a 10–25s load you get several attempts, and a call
can overshoot its budget by roughly one page load.

**The server runs windowed and needs a display.** goofish serves headless Chromium its risk-control
page instead of the app, which leaves the three DOM tools with nothing to read, so headed is the
default and a headless machine needs `xvfb-run` or an X server. The four mtop tools work either way. With the 45s default `attempts: 4` is
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

**Not working, right now, and the reason is the site, not this code.** One of the eight:

- `item_view` — the detail block is not served reliably. The page comes back as the 512-character
  footer-only shell for up to **26s** on a slow link (20s on a warm one) and the detail block only
  paints after that, so the call gives up before the page has finished arriving. This is a wait, not a
  refusal, and it is why the readiness poll is 32s rather than the 6s it used to be.

  Separately, a listing whose title goofish renders only inside its description reports
  `fields_missing: ["title"]` — the scraper is reading the real detail block and refusing to attribute
  a *rail* card's title to the listing, which is the behaviour that keeps one listing's fields from
  being reported as another's.

**`search_items` used to fail here and no longer does.** An earlier run of this README reported it
declining on every attempt. That was true of the design it describes — direct-URL navigation — and the
fix was to stop navigating and type instead. It now returns real matches: 8/8 live queries, 7 on the
first attempt, 18–40s. See [Search is a keystroke, not a URL](#search-is-a-keystroke-not-a-url).

**Still worth knowing about the site, because it will happen again.** goofish decides *per page load*
whether to serve a given page, and an automated client is served a risk-control notice
(`非法访问 / 请使用正常浏览器访问闲鱼`) far more often than a real browser is. That page is a 200 that
renders no listing at all; the four mtop tools keep working through it because they need only the
client. When that happens the DOM tools say `blocked: true` rather than reporting zero results.

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
npm test                 # 40 tests, no network, no browser
npm run typecheck        # tsc --noEmit over src and test
npm run build            # src/*.ts -> dist/*.js, what the tarball ships
node src/index.ts        # stdio, run from source; refuses to run interactively
```

`tsconfig.json` is `noEmit` on purpose — the source runs directly under Node's type stripping, so a
clone needs no build step. `tsconfig.build.json` is the emit config for the published artifact, and the
two differ only in that. Any import in `src/` keeps its `.ts` extension and `rewriteRelativeImportExtensions`
turns it into a `.js` one at build time; do not hand-write `.js` imports.
