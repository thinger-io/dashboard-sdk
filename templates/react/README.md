# Thinger dashboard app (React)

A device list → device detail app with React Router in hash mode, using
`@thinger-io/dashboard-sdk`.

    npm install
    npm run dev       # then open it with `thinger dashboard dev` (standalone link with a token)
    npm run build     # dist/: upload it with `thinger dashboard publish`

What makes it work as a Thinger dashboard:

- `import { Thinger } from '@thinger-io/dashboard-sdk'`: the SDK comes with the build.
- `createHashRouter`: a file storage only serves real files.
- `base: './'` in vite.config.ts: relative asset URLs, no `<base>` tag.
- Rendering waits for `Thinger.ready()`, and the router is created afterwards because the start
  route depends on `Thinger.context.device`.
- No `localStorage` / cookies inside the console's frame: keep settings in properties.
