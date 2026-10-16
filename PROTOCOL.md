# Dashboard app ↔ console protocol

How a dashboard app (a page using this SDK) and the Thinger console that frames it talk to each
other, plus the parameters of standalone links. The SDK implements the app side; the console
(`url-dashboard.component.ts` in thinger-core) implements the other. The TypeScript types of
every message are exported from `@thinger-io/dashboard-sdk/protocol`, a module with no side
effects that the console imports:

```ts
import {
    IFRAME_SANDBOX,
    MESSAGE,
    type AppMessage,
    type InitMessage,
} from '@thinger-io/dashboard-sdk/protocol';
```

## Rules

1. **The contract only grows.** A new message or field is always optional. An existing one never
   goes away and never changes meaning.
2. **Each side ignores what it does not know**: unknown message types, unknown fields, and
   messages that are not objects. A new console works with an old SDK, and the other way round.
3. **No protocol number.** Nobody negotiates versions. `thinger:ready` carries the SDK version so
   the console can log it, never to change its behaviour.
4. Everything here is written down before the 1.0 of the package, and from then on changes only by
   the rules above.

## Transport

- The console renders the app in an `<iframe>` with
  `sandbox="allow-scripts allow-forms allow-downloads"` (`IFRAME_SANDBOX`). Without
  `allow-same-origin` the app has an opaque origin: no cookies, `localStorage` or
  `sessionStorage`, and its API requests are cross-origin (the server answers CORS for any
  origin). Without `allow-popups` or `allow-top-navigation` it can neither open tabs nor leave the
  console, which is why `thinger:navigate` and `thinger:open-file` exist. Apps depend on this list:
  it is part of the contract.
- Messages travel with `window.postMessage(message, '*')`. Every message is a plain object whose
  `type` is one of the names below, all starting with `thinger:`.
- **The app** accepts console messages only from `window.parent` (`event.source`). It cannot check
  the origin: it does not know the console's origin in advance.
- **The console** accepts app messages only from its own frame's `contentWindow`.
- **Who gets the token:** the console sends the access token (and answers token refreshes and
  file openings) only when the app's URL has the console's own origin, such as a file storage of
  the same server. An app on another origin gets `token: null` and the rest of the context.
- **One token per frame document.** The sandbox does not stop a link in the app from navigating
  the frame itself to another site, and that page would pass the `event.source` check (both have
  an opaque origin). So the console answers with a token (in `thinger:init`, `thinger:token`) only
  to the document it loaded: once the frame fires a second `load` (another document, not a hash
  change), it sends no token until it loads the dashboard URL again. _Console 7.5 does not do
  this yet: required from the next console release._
- **Handshake timeout.** A framed app that gets no `thinger:init` within 10 s
  (`HANDSHAKE_TIMEOUT_MS`) rejects `ready()` with `code: 'no-session'`, so a page framed by a site
  that is not the console fails visibly. A later `thinger:init` still starts the session.

## Sequence

```
app (iframe)                                   console
    |  thinger:ready { sdk }                       |   SDK starts (import / script load)
    | -------------------------------------------> |
    |  thinger:init { apiBase, token, user, … }    |
    | <------------------------------------------- |
    |  thinger:location { path }                   |   initial hash route, then on each change
    | -------------------------------------------> |
    |                                              |
    |  (a call answers 401)                        |
    |  thinger:refresh-token                       |
    | -------------------------------------------> |
    |  thinger:token { token | null }              |
    | <------------------------------------------- |   the call is retried once with it
```

## App → console

| Message                 | Fields                            | Meaning                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinger:ready`         | `sdk?: string`                    | The app is loaded and asks for `thinger:init`. Sent once, when the SDK starts. `sdk` is the SDK version (semver, e.g. `"0.2.0"`), sent since SDK 0.2.                                                                        |
| `thinger:refresh-token` | —                                 | A call got 401: send a new access token.                                                                                                                                                                                     |
| `thinger:location`      | `path: string`                    | The app's hash route (the part after `#`) changed, so the console can keep it in its own URL. Sent once at start and on every change. The console ignores paths longer than 1024 characters (`MAX_LOCATION_LENGTH`).         |
| `thinger:navigate`      | `target`                          | Navigate the console. `target` is a path or URL (string), or one of `{ device }`, `{ product }`, `{ project }`, `{ dashboard }`, `{ url }`. The console maps it to its routes and only follows `http(s)` URLs.               |
| `thinger:open-file`     | `storage: string`, `path: string` | Open a file of one of the viewer's storages in a new tab. The console builds the URL, fetches the file with its own token and opens it. It refuses storage ids outside `[a-zA-Z0-9_-]{1,32}` and paths with `..`.            |
| `thinger:error`         | `message: string`                 | An error of the app page (uncaught error, unhandled rejection, `console.error`), for the console's own browser console. At most 100 per page load (`MAX_ERROR_MESSAGES`), each at most 2000 characters (`MAX_ERROR_LENGTH`). |

## Console → app

| Message         | Fields                   | Meaning                                                                                                                                                                                                              |
| --------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinger:init`  | see below                | The answer to `thinger:ready`: credentials and context. The app may get it again; each one replaces the previous context for new calls (open WebSockets keep the credentials they opened with until they reconnect). |
| `thinger:token` | `token?: string \| null` | The answer to `thinger:refresh-token`: the new token, or null when the refresh failed. The console may also send it unasked. The app gives up after 8 s without an answer (`TOKEN_REFRESH_TIMEOUT_MS`).              |
| `thinger:route` | `path: string`           | The console's URL changed (typed, back / forward): move the app to this hash route.                                                                                                                                  |

### `thinger:init` fields

All optional. The app treats a missing field as empty.

| Field       | Type                                             | Meaning                                                                                                                                  |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apiBase`   | string                                           | Base URL of API calls; `''` means the page's own origin. WebSockets use it when it is absolute, the page's origin otherwise.             |
| `apiHost`   | string                                           | Informational: the absolute API host.                                                                                                    |
| `token`     | string \| null                                   | Viewer's access token; null for pages of another origin.                                                                                 |
| `user`      | `{ id }` \| null                                 | The viewer. API paths use this id.                                                                                                       |
| `project`   | `{ id, owner?, name? }` \| null                  | Project the dashboard runs in. The app scopes API calls to it with `?project=<id>`; the server maps the URL's user to the project owner. |
| `context`   | `{ device?, product?, type?, group?, project? }` | The resource whose `dashboard` property is shown. Empty for dashboards of the dashboards collection.                                     |
| `dashboard` | `{ id, name? }` \| null                          | The dashboard itself.                                                                                                                    |

## Standalone app → embedding page

A standalone app (below) framed by another website, not by the console:

| Message                   | Fields | Meaning                                                                                                                                                                                                                     |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinger:dashboard-ready` | —      | Sent once, when the app's first API call succeeds. A frame blocked by `X-Frame-Options` or `frame-ancestors` still fires `load`, so the site waits for this before showing the frame. The site should check `event.origin`. |

## Standalone links

The same app runs outside the console when its URL fragment carries a token:

```
https://<host>/<app>/#<route>&thinger_token=<access token>&thinger_api=<server>&thinger_project=<id>
```

| Parameter                                                            | Required | Meaning                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinger_token`                                                      | yes      | Access token. The user is its `usr` claim.                                                                                                                                                                                       |
| `thinger_api`                                                        | no       | Server address, `http(s)://host[:port][/path]`, URL-encoded, when the page is not served by the server itself (an app on its own dev server). API calls, file URLs and WebSockets go there. Anything else is logged and ignored. |
| `thinger_project`                                                    | no       | Project: scopes calls and fills `context.project`.                                                                                                                                                                               |
| `thinger_device`, `thinger_product`, `thinger_type`, `thinger_group` | no       | Fill `context`.                                                                                                                                                                                                                  |

- Values are URL-encoded; parameters are separated by `&` and may follow the app's own route.
  `standaloneFragment()` builds the fragment.
- The fragment never reaches the server. The SDK removes the `thinger_*` parameters from the
  address bar (`history.replaceState`) before the app reads its route.
- At top level the parameters are kept in the tab's `sessionStorage`, keyed by the page path, so
  a reload keeps the session.
- A standalone app posts nothing to its parent except `thinger:dashboard-ready`, and never asks
  for a token refresh: when the token expires, calls fail with 401.
- A token is only read from the fragment present when the page loads. A later hash change does not
  switch a loaded page to standalone mode.

## What is not in the protocol

- The server version: the SDK reads it itself from `GET /v1/server/version` (public, no token).
  The console passes nothing for compatibility, and the server keeps no list of SDK features.
- The app's size: the console sizes the frame to the space it has, and the app scrolls inside.
