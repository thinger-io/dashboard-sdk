import { defineConfig } from '@playwright/test';

const port = 4173;

// Locally it uses the installed Google Chrome; CI installs Playwright's Chromium.
export default defineConfig({
    testDir: 'test/browser',
    timeout: 20000,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: `http://localhost:${port}`,
        channel: process.env.CI ? undefined : 'chrome',
        headless: true,
    },
    webServer: {
        command: 'node test/browser/server.mjs',
        url: `http://localhost:${port}/test/tokens`,
        env: { PORT: String(port) },
        reuseExistingServer: !process.env.CI,
    },
});
