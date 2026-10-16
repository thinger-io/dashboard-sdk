# Changelog

Versions follow semver. While they are 0.x the contract with the console is still being fixed;
1.0.0 freezes it. Each major version gets a migration section.

## [0.2.1] - 2026-10-16

### Changed

- README: "Reviewing the layout" explains how to check an app at several sizes with the
  browser's own tools; the server's `/sdk/preview.html` is retired, with the rest of `/sdk/`.
  Platform concepts are read from the Thinger CLI's documentation.

## [0.2.0] - 2026-10-16

The dashboard SDK becomes an npm package, rewritten in TypeScript. SDK 0.1, the script the server
served at `/sdk/0.1/thinger-dashboard.js`, never reached production, so 0.2 keeps its API but not
its delivery.

### Migrating from 0.1

1. `npm install @thinger-io/dashboard-sdk`.
2. Remove `<script src="/sdk/…/thinger-dashboard.js">` from index.html, and the dev server proxy
   for `/sdk` if you had one.
3. `import { Thinger } from '@thinger-io/dashboard-sdk'` where you used the global, and drop the
   copied `thinger-dashboard.d.ts`: the types come with the package (`ThingerSDK.Device` →
   `import type { Device }`).

Pages that cannot have a build step can still load `dist/thinger-dashboard.min.js`, which defines
the global as before (deprecated).

### Added

- npm package `@thinger-io/dashboard-sdk`: ESM with type declarations generated from the source,
  and a minified classic script defining the global `Thinger`.
- `PROTOCOL.md`: the contract with the console in writing (messages, `thinger:init` fields,
  standalone parameters, iframe sandbox), and its types in `@thinger-io/dashboard-sdk/protocol`,
  a module without side effects for the console to import. `standaloneFragment()` builds
  standalone links.
- `thinger:ready` carries the SDK version (`sdk`), the only new field of the protocol.
- Server versions: the SDK reads `GET /v1/server/version` once, before `ready()` resolves.
  `Thinger.serverVersion`, `Thinger.supports(name)`, a warning for servers older than Thinger 7.5,
  and functions declared with a minimum server version fail with `err.code === 'unsupported'`.
  `@thinger-io/dashboard-sdk/compat.json` lists those minimums for tools (none in this version).
- `ThingerError`, with `code` (`http`, `unsupported`, `no-session`, `invalid-argument`,
  `unexpected-response`), `status` and `requires`. API errors keep the 0.1 message,
  `HTTP <status> <reason>`.
- Device properties carry `source` (`device`, `type`, `group` or `product`): the level an
  inherited value comes from.
- `/// <reference types="@thinger-io/dashboard-sdk/global" />` types the global for script users,
  with the 0.1 names under `ThingerSDK`.
- Exports `ALARM_STATE`, `ALARM_SEVERITY`, `ALARM_INSTANCE_EVENTS`, `SDK_VERSION`, `parseTime`.

### Changed

- `Thinger.version` is the full package version (`"0.2.0"`), not the served path (`"0.1"`).
- Every call that returns a promise rejects instead of throwing synchronously (e.g. calling before
  `ready()`, which now rejects with `code: 'no-session'`).
- The app only accepts console messages (`thinger:init`, `thinger:token`, `thinger:route`) from
  its parent window, not from frames the app itself embeds.
- `alarms.acknowledge` / `shelve` / `latch` / `clear` always set their own state, even when
  `opts` carries a `state`.
- `ready()` also waits (up to 3 s) for the server version.
- Inside a frame, `ready()` rejects with `code: 'no-session'` when no `thinger:init` arrives in
  10 s (a page framed by a website without a token), instead of waiting forever.
- `fetch()` / `request()` only add the token and `?project=` to the Thinger server's URLs
  (relative paths, `apiBase`, the page's origin): an absolute URL of another server gets a plain
  fetch, without the viewer's token.
- Importing the package without a browser window (server-side rendering, tests) leaves the SDK
  idle instead of failing.

### Fixed

- `devices.callResource` and `buckets.write` send their input as JSON whatever it is, a string
  too, as 0.1 did.
- Asking for a token refresh with no console to answer fails at once instead of after 8 s.
- `navigate(null)` from untyped code is ignored instead of throwing.
- Unsubscribing the last event subscription while its socket was reconnecting left a socket open.
