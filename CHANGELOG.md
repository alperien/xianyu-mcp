# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## About this file

This repository was published from a working history that had already been squashed, so the entries
below are release notes rather than a commit log. There is no per-commit trail on `main` to generate
them from and no attempt is made to invent one — `main` begins at a single squashed import of the
TypeScript port (`7ab7d6b`, 2026-09-30) and everything after it is a handful of deliberate commits.
From here on, each release gets a commit behind it and this file grows normally.

The Python implementation this is a port of is not in this history at all: it lives on the
`python-original` branch as a single commit (`cfe401d`, 2026-09-27).

## [0.2.0] — 2026-10-03

### Added

- `XIANYU_SEARCH_MAX_ITEMS`: a runtime ceiling on one `search_items` call, clamped to 30–300 and read
  per call like the budget overrides. It clamps both `limit` and how deep the pager walk goes (one
  page of 30 per 30 of the cap), so even `pages: 10, limit: 500` stops inside
  `XIANYU_SEARCH_BUDGET_S`. A test pins the walk stopping at the cap, and that the recommendation
  rail is still refused as results.
- This file, and a test that the version the MCP handshake advertises is read from `package.json`
  rather than written down a second time.

### Changed

- `search_items` defaults to 120 results instead of 60, and its published maximum is 300 — the full
  pager depth — instead of the shared 500. Depth is still two arguments: `pages` walks the pager and
  `detail` reads the top N in full, and both still ride the one shared dom page without relaunching
  the browser.

### Fixed

- The MCP handshake advertised a hardcoded `0.1.0` while `package.json` carried its own copy of the
  same number. Nothing compared them, so a `npm version` bump would leave every client being told the
  previous release existed. The entry point now reads `package.json` at startup.

## [0.1.0] — 2026-10-01

First public release. `v0.1.0` is the tag; it points at `9b5b656`.

### Added

- Eight read-only tools — `capabilities`, `browse_feed`, `search_count`, `search_suggest`,
  `search_items`, `related_items`, `item_view`, `recommendations` — over goofish.com with no Xianyu
  account, no cookies, no stored credentials and no write path.
- Reads goofish's own `window.lib.mtop.request` from the page rather than re-implementing token
  minting and request signing, which is the whole reason a browser is involved.
- `item_view` and `search_items` read the calls the page makes for itself, and `search_items` refuses
  to return the recommendation rail as results.
- A two-page browser session: four mtop-only tools get a parked page of their own so they never queue
  behind a 70s search, and only the three DOM tools take the shared-page lock.
- Windowed Chromium by default, because headless is served goofish's risk-control page instead of the
  app. `XIANYU_HEADLESS=1` overrides it, and `XIANYU_BROWSER_PATH` supplies a specific binary.
- Wall-clock budgets for the three retry loops, via `XIANYU_SEARCH_BUDGET_S`,
  `XIANYU_ITEM_VIEW_BUDGET_S` and `XIANYU_RECOMMENDATIONS_BUDGET_S`.
- 58 hermetic tests: no network, no browser, driven through a fake session.
- CI on push and pull request, pinned to Node 22.18 — the floor for unflagged type stripping.

### Changed

- `playwright` moved from `dependencies` to `optionalDependencies` and is imported dynamically inside
  `launch()`. Module load drops from ~4.0s to ~30ms, and a missing browser is now a launch-time
  `BrowserError` carrying the install hint instead of a `MODULE_NOT_FOUND` at startup.

### Notes

- The published tarball ships prebuilt `dist/`. Node refuses to strip TypeScript types from files
  under `node_modules/`, so shipping `src/*.ts` would install cleanly and then fail on first run.
- `npx playwright install chromium` is still required: playwright has no install script, so `npm ci`
  does not fetch a browser.
- Endpoint knowledge, the search-relevance rules and the item/search extractors derive from
  [fancyboi999/goofish-cli](https://github.com/fancyboi999/goofish-cli), credited in `NOTICE`.
