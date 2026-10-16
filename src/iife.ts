/**
 * Entry of the classic-script build (thinger-dashboard.min.js), which defines the global
 * `Thinger` for pages without a build step. Deprecated: apps install the npm package.
 */
import { Thinger } from './index.js';

(globalThis as unknown as { Thinger: typeof Thinger }).Thinger = Thinger;

console.warn(
    '[Thinger] the <script> build of the dashboard SDK is deprecated: install ' +
        '@thinger-io/dashboard-sdk from npm and import { Thinger } from it.',
);
