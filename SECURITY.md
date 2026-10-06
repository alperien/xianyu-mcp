# Security Policy

## What this server does and does not hold

This server stores nothing and asks for nothing. That is a design property rather than a promise, and
there is a test that enforces it: `test/invariants.test.ts` scans the whole source tree for
`addCookies`, `storageState`, `launchPersistentContext`, `userDataDir`, `localStorage`,
`sessionStorage` and every goofish cookie name (`cookie2`, `sgcookie`, `x5sec`, `_m_h5_tk`), and
fails the build if any appears.

- No credentials, ever. It launches its own throwaway Chromium with a brand-new context on every
  launch: no profile directory, no persistent state, nothing carried between sessions.
- No Xianyu account, no login. Every tool works logged out. `capabilities` reports
  `session_state` by probing goofish's own `loginuser.get` endpoint -- the one endpoint used *solely*
  to prove the session is logged out, never to act as a user.
- Read-only. There are no write tools, and a test asserts the tool list can never gain one. It
  cannot publish, message, or change anything on goofish.
- Navigation is confined to `https://goofish.com`. Host *and* scheme are checked by exact
  comparison against parsed URL parts, before navigation and again after every redirect, so
  `https://www.goofish.com@evil.com/` is rejected as `evil.com` and `file://www.goofish.com/x` is
  rejected as not-https. There are exactly two navigation sites and both re-check.
- Cookies set by goofish are never read. The page sets its own anonymous ones; this server does
  not look at them.

## Reporting a vulnerability

Report it privately through GitHub's security advisory form on this repository
(**Security → Report a vulnerability**), not as a public issue.

Include what you found, the file and line, and a reproduction if you have one.

Because this server drives a real browser against a live third-party site, the most likely real
reports are **redirect/SSRF escapes** (getting the scraper to read a host other than goofish.com) or
**scope escapes** (getting a tool to write or change state). Both are treated as high severity: they
would break the two guarantees above.

## A note on what this project is not responsible for

This is an unofficial client. It is not affiliated with, endorsed by, or supported by Alibaba or
Goofish. It reads goofish the way an anonymous visitor's browser does; if you have a problem with
how the site responds to that, the site operator is the right place.