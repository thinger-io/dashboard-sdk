# Dashboard app templates

Starting points for `thinger dashboard init` (in `@thinger-io/cli`), shipped in the package under
`templates/`:

| Template | Stack | Build output |
|---|---|---|
| `react` | Vite + React + React Router (hash) | `dist/` |
| `angular` | Angular CLI (application builder, hash routing) | `dist/thinger-dashboard-angular/browser/` |

Both depend on `@thinger-io/dashboard-sdk` and wait for `Thinger.ready()` before rendering.

To create a project from one, copy the folder and:

- rename `_gitignore` to `.gitignore` (npm leaves `.gitignore` files out of packages);
- set `name` in `package.json` (and, for Angular, the project name in `angular.json`, which also
  names the output folder);
- set the `@thinger-io/dashboard-sdk` version range to the current package version.
