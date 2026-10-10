# Security Policy

## What this server does and does not hold

The server stores no credentials or browser state. `test/invariants.test.ts` enforces this by
scanning the source tree for `addCookies`, `storageState`, `launchPersistentContext`, `userDataDir`,
`localStorage`, `sessionStorage` and Goofish cookie names (`cookie2`, `sgcookie`, `x5sec`,
`_m_h5_tk`). Any match fails the build.

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

Use this repository's GitHub security advisory form (**Security → Report a vulnerability**). Do not
report vulnerabilities in a public issue.

Include what you found, the file and line, and a reproduction if you have one.

The main risks are **redirect/SSRF escapes** that make the scraper read a host other than
goofish.com, and **scope escapes** that let a tool write or change state. Either breaks the guarantees
above and is treated as high severity.

## A note on what this project is not responsible for

This unofficial client is not affiliated with, endorsed by, or supported by Alibaba or Goofish. It
reads the site as an anonymous visitor. For problems with Goofish itself, contact the site operator.