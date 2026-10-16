import { defineConfig } from 'vitest/config';
import { standardDecorators } from './vitest.shared.js';

// Against a real server: THINGER_SERVER (https://host) and THINGER_TOKEN. Skipped without them.
export default defineConfig({
    plugins: [standardDecorators()],
    test: {
        include: ['test/integration/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
