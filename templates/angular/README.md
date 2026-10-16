# Thinger dashboard app (Angular)

An Angular app used as a url dashboard: device list → device detail with hash routing, using
`@thinger-io/dashboard-sdk`. The same build serves a collection dashboard (list) and a device
dashboard (opens straight on `Thinger.context.device`).

    npm install
    npm start         # ng serve; open it with `thinger dashboard dev`
    npx ng build      # dist/thinger-dashboard-angular/browser: upload it with `thinger dashboard publish`

What makes it work as a Thinger dashboard:

- `import { Thinger } from '@thinger-io/dashboard-sdk'`: the SDK comes with the build.
- `index.html` has no `<base>` tag: assets resolve next to the entry file, and hash navigation
  keeps `index.html?v=…` in the URL.
- `withHashLocation()`: the storage only serves real files.
- `provideAppInitializer(() => Thinger.ready())`: nothing renders before the session is there.
- No `localStorage` / cookies inside the console's frame: keep settings in properties.
