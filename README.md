# @thinger-io/dashboard-sdk

SDK for Thinger.io dashboard apps: web pages and apps (React, Angular, Vue…) that run inside the
Thinger console as url dashboards, or on their own with a standalone link. The console renders
the app in a sandboxed iframe and hands it the viewer's session over `postMessage`. The app never
handles credentials.

```sh
npm install @thinger-io/dashboard-sdk
```

```ts
import { Thinger } from '@thinger-io/dashboard-sdk';

await Thinger.ready();
// device: true → the device of the dashboard context (device and product dashboards)
Thinger.buckets.subscribe('my_bucket', { device: true, from: '6h', items: 500 }, (data, err) => {
    if (err) return console.error(err);
    render(data);
});
```

- Written in TypeScript; the package ships ESM with its type declarations.
- Thinger 7.5 or later. See [Server versions](#server-versions).
- The contract with the console: [PROTOCOL.md](PROTOCOL.md). Changes and migrations:
  [CHANGELOG.md](CHANGELOG.md).
- Versions are 0.x until the contract is frozen at 1.0.

Platform concepts (projects, products, buckets, properties…) are in the Thinger CLI's
documentation for agents (`doc_read` with id `concepts`, from `@thinger-io/cli`).

## Contents

- [Getting started](#getting-started)
- [Publishing](#publishing)
- [Standalone: dev servers, preview links and embedding](#standalone-dev-servers-preview-links-and-embedding)
- [Reviewing the layout](#reviewing-the-layout)
- [Context](#context-after-ready)
- [Core](#core)
- [Server versions](#server-versions)
- [Errors](#errors)
- [Buckets](#buckets)
- [Devices](#devices)
- [Products, endpoints and other resources](#products-endpoints-and-other-resources)
- [Files and projects](#files-and-projects)
- [Alarms](#alarms)
- [Events](#events)
- [Time values](#time-values-from--to)
- [Script build (deprecated)](#script-build-deprecated)

## Getting started

`thinger dashboard init` (from `@thinger-io/cli`) creates a Vite project from the templates in
`templates/` (React or Angular). By hand, any bundler works:

1. Install the package and `import { Thinger } from '@thinger-io/dashboard-sdk'`. The SDK starts
   on import: inside the console it posts `thinger:ready` at once.
2. Wait for `Thinger.ready()` before rendering anything that uses the session (React: render after
   it; Angular: `provideAppInitializer(() => Thinger.ready())`).
3. Use **hash routing** (React Router `createHashRouter`, Angular `withHashLocation()`, Vue Router
   `createWebHashHistory`): a file storage only serves real files.
4. Build with **relative asset URLs** and **no `<base>` tag** (Vite: `base: './'`). Assets then
   resolve next to the entry file, and hash navigation keeps a named entry file in the URL. No
   hashed file names or `?v=` on assets are needed either.
5. Reload with `Thinger.reload()`, not `location.reload()`: inside the console the frame URL
   carries a per-load key the SDK removes on start, and a page reloaded without it gets no token.
   For the same reason, keep the app in one page (hash routing) rather than linking from one
   entry file to another inside the frame; open other dashboards with `Thinger.navigate()`.
6. No `localStorage`, `sessionStorage` or cookies: the iframe has an opaque origin. Keep settings
   in properties (`Thinger.properties`).

The SDK reports the hash route to the console, which keeps it in its own URL
(`/console/dashboards/x#/devices/d1`). Reloading or sharing that link reopens the same screen, and
typing a route there or going back / forward moves the app. There is nothing to do in the app.

One build can serve several dashboards, each pointing at its entry file (the folder URL for the
storage index, or `device.html`…), optionally with an initial route after `#`.

## Publishing

- Upload the build (index.html + assets) to a file storage (`thinger dashboard publish` does it).
  Use a **public** storage: the iframe cannot send the Authorization header when loading files.
  Data stays protected, since every API call made through the SDK carries the viewer's token. Set
  the storage's `index` to the entry file (`index.html`).
- Point a dashboard at the storage folder, **with the trailing slash**:
  `{ "source": "url", "url": "/v1/users/<u>/storages/<s>/files/" }`. The server answers it with
  the index file; without the slash it returns the file listing. Another entry file is given by
  name (`…/files/device.html`). Only same-origin URLs receive a token.
- No version parameter is needed: storage files are served with `Cache-Control: no-cache` and an
  ETag, so browsers revalidate them on every load (a cheap 304 when unchanged) and always get the
  latest upload. Changing the URL (e.g. `?v=2`) makes consoles that already have the dashboard
  open reload it at once, keeping the app's route.
- Dashboards of the dashboards collection get an empty `context`. For a per-device or per-product
  dashboard, store the same object as the `dashboard` property of the device, product, asset
  type, asset group or project: `context` then carries that id.

## Standalone: dev servers, preview links and embedding

The same app also runs on its own, outside the console, when its URL fragment carries a token:

```
https://<server>/v1/users/<u>/storages/<s>/files/#/<route>&thinger_token=<access token>&thinger_project=<project>
```

- The fragment never reaches the server. The SDK reads the `thinger_*` params and removes them
  from the address bar (and so from the history) before the app starts, leaving its route.
- Params: `thinger_token` (required; the user comes from it), `thinger_project`, `thinger_device`,
  `thinger_product`, `thinger_type` and `thinger_group` (fill `Thinger.context`), and
  `thinger_api`: the server address (`https://<server>`, URL-encoded) when the page is not served
  by the server itself. API calls, file URLs and WebSockets then go there (`Thinger.apiBase`);
  without it, to the page's own origin. An address that is not `http(s)://host[:port]` is logged
  as an error and ignored. `standaloneFragment()` (from `@thinger-io/dashboard-sdk/protocol`)
  builds the fragment.
- `ready()` resolves without a handshake. The params are kept in the tab's `sessionStorage`, so
  reloading the page keeps working in that tab. There is no token refresh: when the token
  expires, calls fail with 401 (the SDK logs it once).
- A page opened on its own with no token (and nothing stored in the tab) rejects `ready()` with
  an error (`code: 'no-session'`) instead of waiting forever: show it. Inside a website's iframe
  without a token the SDK takes the website for the console: it posts `thinger:ready` (no data)
  and rejects `ready()` the same way after 10 s without an answer.

Uses:

- **Developing on the app's own dev server** (`vite`, `ng serve`…), with live reload and no
  upload: `thinger dashboard dev` creates a short-lived token and opens
  `http://localhost:5173/#/&thinger_api=https%3A%2F%2F<server>&thinger_token=<token>`. The server
  answers CORS for any origin, and the SDK is part of the app's own build, so nothing else is
  needed: no proxy.
- **Reviewing the app as a normal page** (DOM, styles, scrolling, console, sizes): inside the
  console's sandboxed iframe, browser automation can neither read nor scroll the app. See
  [Reviewing the layout](#reviewing-the-layout). Use a token that expires soon, created for the
  purpose.
- **Permanent links**: a wall screen in a control room, or a customer without an account. One
  token per link, named after its use, without `expire`; deleting the token revokes that link.
- **Embedding a live app in a website** (`<iframe src="…#thinger_token=…">`). Once its first API
  call succeeds, the page posts `{ type: 'thinger:dashboard-ready' }` to the parent window (no
  data). The site can wait for it (check `event.origin` is the Thinger server) before showing the
  frame, and keep a placeholder otherwise: a frame blocked by X-Frame-Options or
  `frame-ancestors` still fires `load`. The server must allow the site in its `frame-ancestors`
  (host setting `deployment.content_security_policy`). The token is public there, so give it the
  least access: created inside the project (`?project=`, it then only works over that project)
  and read-only permissions on the resources the app reads.

Tokens:

- Never put a user's console token in a link: create an access token with only the permissions
  the page needs.
- A read-only token for a live app (create it inside the project with `?project=`): Device
  `ListDevices`, `ReadDeviceConfig`, `ReadDeviceStatus`, `ListDeviceProperties`,
  `ReadDeviceProperty`, `ReadDeviceBucket`; Bucket `ListBuckets`, `ReadBucket`, `ListBucketTags`;
  Product, Type, Group and Project `List*` / `Read*Config` / `List*Properties` / `Read*Property`;
  Alarm `ListAlarmRules`, `ReadAlarmRuleConfig`, `ListAlarmInstances`; Storage `ReadStorageFiles`
  (private files); and **User `SubscribeUserEvents`**: without it every read works but realtime
  (`buckets.subscribe`, `alarms.subscribe`, `events.subscribe`) never updates. The SDK logs a
  console warning when the server refuses a subscription. Add actions (`AccessDeviceResources`,
  `SetDeviceProperty`, `UpdateAlarmInstance`…) only if the page should perform them.
- The token decides what works, and the page cannot know it in advance. Handle a refused action
  (`err.status === 403`) by telling the viewer that this link has no permission for it, instead
  of failing silently. The same applies inside the console, where project members may lack
  permissions too.

## Reviewing the layout

Check the app as it will be seen: at the sizes of the places it is shown (the console's content
area, a website frame, a phone), with real data. Open its standalone link at top level, where
browser automation can read the DOM, run scripts, take screenshots and read the console.

- **Sizes.** Typical ones: 1150×758 and 950×678 (console on a laptop, with and without its side
  menu) and 380×598 (phone). Browsers do not shrink a window below ~500 px, so for narrower sizes
  either set the viewport (Playwright `page.setViewportSize()`, DevTools device emulation) or load
  the app inside its own page in an iframe of that size, loaded with the **standalone link** (the
  SDK removes the token from the page's address, and a frame does not read the tab's stored
  session). Same origin, so the frame's document can be inspected like the page, and the frame
  tells the page when its data is in (`thinger:dashboard-ready`).

    ```js
    // run in the app's page; STANDALONE_LINK is the full link, with #…&thinger_token=…
    const frame = Object.assign(document.createElement('iframe'), { src: STANDALONE_LINK });
    Object.assign(frame.style, {
        width: '380px',
        height: '598px',
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 99999,
        background: '#fff',
    });
    addEventListener('message', (ev) => {
        if (ev.source === frame.contentWindow && ev.data?.type === 'thinger:dashboard-ready') {
            // data loaded: frame.contentDocument is the app at 380 px
        }
    });
    document.body.append(frame);
    ```

- **Wait for data**, not just for `load`: the first successful API call (in a website frame, the
  `thinger:dashboard-ready` message), then a second or two for charts and late renders.
- **What to check at each size:**
    - horizontal scroll: `document.documentElement.scrollWidth > innerWidth`;
    - elements past the right edge: `getBoundingClientRect().right > innerWidth` for visible
      elements;
    - clipped text: `scrollWidth > clientWidth` on elements with `overflow: hidden` (an ellipsis
      on purpose is fine);
    - rows of cards with room for one more, or a lone card on the last row;
    - failed requests and console errors;
    - what the first screen shows without scrolling.
- Inside the console the app scrolls within its frame, which fills the content area: design for
  that height instead of a fixed one.

## Context (after `ready()`)

| Field                   | Meaning                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Thinger.token`         | Viewer's access token (their full console permissions).                                                                                                                                                                                                                                                                                                     |
| `Thinger.user`          | `{ id }`.                                                                                                                                                                                                                                                                                                                                                   |
| `Thinger.project`       | Project the dashboard runs in (`{ id, owner, name }`) or null: in a project dashboard, that project; elsewhere, the project selected in the console. API calls are scoped to it (`?project=`): a project is a workspace, so a device or product of another project opened by URL shows no data. Select its project first in the console's project selector. |
| `Thinger.context`       | `{ device, product, type, group, project }`: the resource whose `dashboard` property is shown (null when not set).                                                                                                                                                                                                                                          |
| `Thinger.dashboard`     | `{ id, name }`.                                                                                                                                                                                                                                                                                                                                             |
| `Thinger.apiBase`       | Base URL of API calls (`''`: the page's origin).                                                                                                                                                                                                                                                                                                            |
| `Thinger.version`       | SDK version (`"0.2.0"`).                                                                                                                                                                                                                                                                                                                                    |
| `Thinger.serverVersion` | Server version (`"7.5.0"`), or null when it could not be read.                                                                                                                                                                                                                                                                                              |

## Core

| Call                  | Description                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready()`             | Promise resolved once the session is there (console handshake or standalone link) and the server version has been read (up to 3 s). Rejects with `code: 'no-session'` when there is none.                                                                                                                                             |
| `onInit(fn)`          | Call `fn(Thinger)` on every init (and at once when already initialized).                                                                                                                                                                                                                                                              |
| `request(path, opts)` | API call. `opts.body`: any JSON value, or a string / Blob / FormData / ArrayBuffer sent as is. `opts.as` forces the response type (`json`, `text`, `blob`, `arrayBuffer`); by default JSON for JSON responses, text otherwise, null when empty. `opts.project: false` skips the project scoping. Use it for any API not wrapped here. |
| `fetch(path, opts)`   | Raw `fetch()` with the Bearer token and `?project=`; inside the console, retries once after a transparent token refresh on 401. Absolute URLs of other servers get neither: the token only goes to the Thinger server.                                                                                                                |
| `reload()`            | Reload the app. Use it instead of `location.reload()`: inside the console it keeps the key of the frame load, without which the reloaded page gets no token.                                                                                                                                                                          |
| `navigate(target)`    | Navigate the console: a path, or one of `{ device }`, `{ product }`, `{ project }`, `{ dashboard }`, `{ url }`. Standalone pages go to the URL themselves.                                                                                                                                                                            |
| `supports(name)`      | Whether a function is available on this server: `Thinger.supports('devices.list')`. See below.                                                                                                                                                                                                                                        |

## Server versions

The SDK supports Thinger 7.5 and later. A function that needs a newer server declares its minimum
version in the SDK; its documentation says "Requires Thinger ≥ X", and on an older server it fails
before calling, with `err.code === 'unsupported'` and `err.requires` (e.g. `"7.6"`). Functions
without a note work on every supported server.

- The SDK reads the version once, from `GET /v1/server/version` (public, no token), before
  `ready()` resolves. `Thinger.serverVersion` has it. Develop builds report versions like
  `7.3.4-144-g9b2ac16f-develop`: only the numeric part counts.
- `Thinger.supports('alarms.rules.get')` answers whether a function can run, to hide or disable
  what the server lacks. Unknown names answer false (and log a warning).
- When the version cannot be read, functions run, and a 404 from a function that declares a
  minimum becomes the same `unsupported` error.
- A server older than 7.5 is reported once, as a console warning, when the app starts.
- The package ships the declarations as `@thinger-io/dashboard-sdk/compat.json`
  (`{ sdk, baseServer, functions: { name: minimumVersion } }`), which the CLI reads to warn about
  functions a server does not support. In this version every function works on 7.5:
  `functions` is empty.

## Errors

Every call that fails rejects with a `ThingerError` (exported), an `Error` with:

| Field      | Meaning                                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`     | `'http'` (the server answered an error), `'unsupported'` (the server is too old), `'no-session'` (no user or token yet), `'invalid-argument'` (e.g. `device: true` without a context device), `'unexpected-response'`. |
| `status`   | HTTP status, for `http`.                                                                                                                                                                                               |
| `requires` | Minimum server version, for `unsupported`.                                                                                                                                                                             |
| `message`  | `HTTP <status> <reason>` for API errors, the reason being the server's error message.                                                                                                                                  |

Subscriptions report errors through their callback instead.

## Buckets

`opts.device` (a device id, or `true` for the context device) reads the device-scoped view of a
product bucket. `true` only works in device and product dashboards; project and plain dashboards
have no context device, so pass the id (the call fails otherwise). It only needs access to the
device, not to the bucket, so prefer it whenever a view is about one device; fleet-wide reads need
the bucket in the project. With `aggregation` and no `groupBy`, each point aggregates **all** the
records in the bucket for that period (all devices together); use `device` or
`groupBy: 'device'` for one series per device. Without `fields`, an aggregation only covers
numeric fields (those of the latest record): list string fields in `fields` to read them with
`last`, `first`, `mode` or `count`.

| Call                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buckets.read(id, opts)`          | Records `{ ts, ...fields }`. `opts`: `device, from, to, items` (max 1000 per call), `sort` (`desc` default, `asc`), `aggregation` (`'5m'`, `'1h'`, `'1d'`…) with `aggregator` (`mean`, `max`, `min`, `sum`, `count`…), `transform`, `fields` (`['temperature']`), `groupBy` (`'device'`), `tags: { k: v \| [v] }`, `timeZone` (IANA name: where aggregation windows start; default the viewer's browser zone, so set the site's zone for per-day totals of a site). For long ranges aggregate, or page with `from` / `to` and `sort`. Type the records with `read<MyRecord>(…)`. |
| `buckets.subscribe(id, opts, cb)` | `read(id, opts)`, then the same read kept current as the bucket is written (debounced, `opts.debounceMs` = 500): only what changed is read again (with `sort: 'asc'`, only while the range fits in `items`, see below). `cb(data, err, { added, reset })`: `data` as `read()` returns it, `added` the records new or updated in this call, `reset` true after a full read. `opts.refetch: true` re-runs the whole read on each write instead. Returns unsubscribe.                                                                                                               |
| `buckets.write(id, value)`        | Write a record to a bucket fed by the API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `buckets.tags(id, tag?, opts)`    | Tags of a bucket, or the values of one tag (for filters).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

How `subscribe` keeps the read current:

- Raw reads take the written record from the event (MongoDB buckets send it as stored) or read
  only the records after the last one. A duration `from` (`'48h'`) slides: older records leave.
  `items` stays the cap (50 by default, like `read()`), keeping the newest.
- **`sort: 'asc'` and `items`**: an ascending read holds the oldest `items` records, raw or
  aggregated, so once the range has more it re-reads everything on each write. For an ascending
  chart over a long range keep the points under `items` (max 1000): 7 days at `'15m'` are 672
  points, at `'10m'` 1008. The default `desc` order has no such limit.
- Aggregated reads re-read from the start of the window a write falls in, with the same
  aggregation, `timeZone` and `groupBy`, and replace those windows (per group with `groupBy`).
  The oldest window stays until it is completely out of a duration range.
- Late records (imports, devices catching up) re-read just their range. After the socket
  reconnects, the records written meanwhile are read. Any failure falls back to a full read.
- Full re-read on each write, as with `refetch: true`: `transform`, `aggregation` without
  `aggregator`, a `to` in the past or given as a duration, and `groupBy` without aggregation in
  `asc` order.
- `cb` runs when the data changes, with a new array each time.

## Devices

| Call                                                    | Description                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devices.list(query)`                                   | Device documents (`device` id, `name`, `description`, `type`, `product`, `asset_type`, `asset_group`, `labels`, `enabled`, `connection: { active, ts, location }`). All devices, paginated internally. `query`: `product, asset_type, asset_group, type, name, sort, order, limit, labels: { key: value } \| [key]`. |
| `devices.get(d)`                                        | Device document with `connection` status.                                                                                                                                                                                                                                                                            |
| `devices.locations(opts)`                               | Locations for maps: all assets, `{ group }`, `{ type }` or `{ connected: true }`.                                                                                                                                                                                                                                    |
| `devices.stats(d)`                                      | Traffic usage over the last 30 days.                                                                                                                                                                                                                                                                                 |
| `devices.listProperties(d, query)`                      | Property list, inherited ones included; `query.id` accepts a pattern (`'temp*'`). Inherited entries carry `source` (`type`, `group` or `product`); the device's own have none.                                                                                                                                       |
| `devices.getProperty(d, p)`                             | `{ property, value, source, created, modified, … }`. `source` is the level the value comes from: `device`, `type`, `group` or `product` (e.g. to show "set on this device" vs "product default").                                                                                                                    |
| `devices.setProperty(d, p, v)` / `deleteProperty(d, p)` | Create or update / remove a property.                                                                                                                                                                                                                                                                                |
| `devices.getResource(d, r, { shadow })`                 | Read a device resource. `shadow: true` returns the last value saved when the device disconnected.                                                                                                                                                                                                                    |
| `devices.callResource(d, r, input)`                     | Call a device resource with a JSON input.                                                                                                                                                                                                                                                                            |
| `devices.pollResource(d, r, ms, cb)`                    | Periodic `getResource`. `cb(data, err)`. Returns unsubscribe.                                                                                                                                                                                                                                                        |
| `devices.streamResource(d, r, ms, cb)`                  | The device pushes the resource every `ms` (0 or omitted = on change; whole seconds on the wire). `cb(payload, err, frame)`. Subscribers of the same resource share one stream. When the device is offline, `cb` gets the error and then the last known value (`frame.signal === 'shadow'`). Returns unsubscribe.     |
| `devices.subscribeProperty(d, p, cb)`                   | Property update events. Returns unsubscribe.                                                                                                                                                                                                                                                                         |
| `devices.subscribeState(d, cb)`                         | Connection events; `event.state` is connected, disconnected, resumed, awake or asleep. Returns unsubscribe.                                                                                                                                                                                                          |

## Products, endpoints and other resources

| Call                                                                                                    | Description                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `products.list(query)` / `get(p)`                                                                       | Product documents (`product` id, `name`, `description`, `enabled`, `config`, `profile`).                    |
| `products.call(p, r, input)`                                                                            | Call a product API resource. Reaches a device only if the resource defines a `device_id_resolver` function. |
| `endpoints.call(e, payload)`                                                                            | Trigger an endpoint (email, webhook, notification…).                                                        |
| `resources.list(kind, query)` / `get(kind, id)`                                                         | `kind`: device, product, bucket, group, type, project, dashboard, endpoint, storage, alarm_rule.            |
| `properties.list(kind, id, query)` / `get(kind, id, p)` / `set(kind, id, p, v)` / `delete(kind, id, p)` | Properties of a device, product, project, group or type. Also a place for the dashboard's own settings.     |
| `stats.account()`                                                                                       | Account statistics.                                                                                         |
| `stats.usage(d?)`                                                                                       | Traffic usage over 30 days, all devices or one.                                                             |

## Files and projects

Storage calls carry the viewer's token, so they work with private storages too. A plain
`<img src>` or link to a private storage file goes without the token and fails: use `url()`.

Maps: use a tile provider that works without a key, or with a key restricted to your domain.
CARTO basemaps (`basemaps.cartocdn.com`) answer "API key required"; Esri Canvas
`World_Light_Gray` works in the iframe without a key.

Errors: uncaught errors, unhandled rejections and `console.error` of the page are copied to the
console's browser console as warnings prefixed `[dashboard <id>]`, so tools that only read the
tab's console see them too.

PDFs: browsers do not show their PDF viewer inside the sandboxed iframe (an `<iframe>` or
`<embed>` with the PDF stays blank). Render it in the page with pdf.js from
`read(s, path, { as: 'arrayBuffer' })`, or offer `open()` / `download()`.

| Call                                    | Description                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storages.list(s, path?)`               | Files of a storage, optionally inside a folder.                                                                                                                                                    |
| `storages.read(s, path, { as })`        | File contents. `as`: `'json'`, `'text'`, `'blob'` or `'arrayBuffer'`; by default JSON when the server says so, text otherwise. Use `blob` / `arrayBuffer` for PDFs, images and other binary files. |
| `storages.url(s, path)`                 | Temporary `blob:` URL with the file, for `<img>`, `<video>`, `<a href>`… Revoke it with `URL.revokeObjectURL` when done.                                                                           |
| `storages.open(s, path)`                | Open the file in a new browser tab, through the console. Call it from a click handler.                                                                                                             |
| `storages.download(s, path, filename?)` | Save the file on the viewer's computer.                                                                                                                                                            |
| `storages.write(s, path, data)`         | Create or overwrite a file; folders are created. `data`: string, `Blob` / `File` (e.g. from `<input type="file">`), `ArrayBuffer` / typed array, or any value (stored as JSON).                    |
| `storages.remove(s, path)`              | Delete a file, or a folder with its contents.                                                                                                                                                      |
| `storages.publicUrl(s, path)`           | Direct URL of a file in a **public** storage, for `<img src>` without the SDK.                                                                                                                     |
| `projects.list()` / `get(p)`            | Projects the viewer can open: their own and the ones shared with them (those have `owner`). Not scoped to the console's current project.                                                           |

## Alarms

| Call                                                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alarms.list(query)` / `get(id)`                              | Alarm instances; `query` is sent as query params, exact values, nested fields with dots, an array matching any of its values (e.g. `{ state: 1 }`, `{ 'alarm.rule': 'r1', 'origin.id': ['d1', 'd2'] }`). Each instance: `instance` (id), `name`, `severity`, `state`, `alarm.rule` (rule id), `origin: { source: 'device', id, name }` (the device), `asset_type`, `asset_group`, `project`, `activation` / `normalization: { detections, initiated, completed }` (ms), `evaluation.last_values` (`{ "<source>.<field>": value }`), `notification`, `annotation`. |
| `alarms.stats()`                                              | Counts per state / severity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `alarms.subscribe(query, cb)`                                 | Initial list, then re-list whenever an instance is activated, normalized, updated (acknowledge, shelve, latch, clear, annotation; from this app or elsewhere), created or deleted. `query.debounceMs` (500). `cb(list, err)`.                                                                                                                                                                                                                                                                                                                                     |
| `alarms.onActivate(cb)` / `onNormalize(cb)` / `onUpdate(cb)`  | Raw events, one per instance change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `alarms.acknowledge(id, opts)` / `shelve` / `latch` / `clear` | Change state. `opts`: `{ annotation, reactivation: { type: 'timespan', timespan: { value, magnitude } } }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `alarms.update(id, body)`                                     | Generic instance update.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `alarms.STATE`                                                | NONE 0, ACTIVATED 1, ACKNOWLEDGED 2, LATCHED 3, SHELVED 4, CLEARED 5 (also exported as `ALARM_STATE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `alarms.SEVERITY`                                             | NONE 0, LOW 1, MEDIUM 2, HIGH 3, CRITICAL 4 (also exported as `ALARM_SEVERITY`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `alarms.rules.list(query)` / `get(id)` / `subscribe(cb)`      | Alarm rules and their executions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Events

`events.subscribe(filter, cb, onReconnect?)`: `filter = { event, ...filters }`, e.g.
`{ event: 'bucket_write', bucket: 'b' }`. Returns unsubscribe. All subscriptions share one
WebSocket. Sockets reconnect with backoff, and refresh the token first when it has expired. Events
sent while the socket is down are lost: `onReconnect()` runs when it is back.

Project members and access tokens can only subscribe to `device_property_update`,
`bucket_write` and `alarm_instance_*`. `subscribeState` and alarm rule events need the owner.

## Time values (`from` / `to`)

A milliseconds timestamp, a `Date`, `'now'`, or a duration before now: `'30s'`, `'30m'`,
`'6h'`, `'7d'`, `'2w'`, `'1M'`, `'1y'`.

## Types

Everything is typed. Besides `Thinger`, the package exports `ThingerClient` (its class),
`ThingerError`, the data types (`Device`, `Property`, `BucketRecord`, `AlarmInstance`,
`StreamFrame`…) and the protocol types. Server documents keep their extra fields reachable.

```ts
import { Thinger, type BucketRecord, type Device } from '@thinger-io/dashboard-sdk';

interface Reading extends BucketRecord {
    temperature: number;
}
const readings = await Thinger.buckets.read<Reading>('climate', { device: true, from: '24h' });
```

## Script build (deprecated)

`dist/thinger-dashboard.min.js` (also `@thinger-io/dashboard-sdk/iife`, and on npm CDNs) is a
classic script that defines the global `Thinger`, for plain HTML pages without a build step. It is
deprecated: it logs a warning asking to install the package. For its types:

```ts
/// <reference types="@thinger-io/dashboard-sdk/global" />
```

They also keep the type names of SDK 0.1 (`ThingerSDK.Device`, `ThingerSDK.Unsubscribe`…).

Moving a script page to the package (a Vite project, ES modules):

- Every module that uses `Thinger` imports it; there is no global. Import the SDK before any code
  that reads `location.hash` at load time (a router): it removes its parameters from the fragment
  when its module runs.
- App scripts that shared state through globals become modules that import and export it.
  Watch for an app global with the name of a browser global (`Cache`, `Image`, `Event`,
  `Notification`, `Request`…): once the script that defined it is a module, the code that used it
  silently gets the browser's, and `no-undef` does not catch it. Import it explicitly or rename it.
- Reload with `Thinger.reload()`, and keep `base: './'` and hash routing (see
  [Getting started](#getting-started)).

## Development

```sh
npm install
npm test                 # unit tests (vitest)
npm run test:browser     # builds, then the handshake in Chrome against a minimal console (Playwright)
npm run build            # dist/: ESM + .d.ts, thinger-dashboard(.min).js, compat.json

# integration tests against a real server (skipped without the variables)
THINGER_SERVER=https://<server> THINGER_TOKEN=<token> npm run test:integration

# or against a throwaway server in Docker
eval "$(scripts/ci-server.sh thinger/server:develop)"
npm run test:integration
scripts/ci-server.sh --stop
```

A function that needs a server newer than 7.5 is declared where it is defined:

```ts
@requiresServer('devices.something', '7.6')
async something(): Promise<Thing> { … }

@requiresServer('devices.watchSomething', '7.6', 'value') // returns synchronously: throws
watchSomething(cb: (e: Event) => void): Unsubscribe { … }
```

That declaration is the only place: the build adds "Requires Thinger ≥ 7.6" to its TSDoc and the
entry to `compat.json`, and at run time the call fails with `unsupported` on older servers.
SDK-only logic declares nothing. Integration tests of such a function must skip servers below its
minimum.

## License

MIT
