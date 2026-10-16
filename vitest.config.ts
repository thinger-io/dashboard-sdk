import { defineConfig } from 'vitest/config';
import { standardDecorators } from './vitest.shared.js';

export default defineConfig({
    plugins: [standardDecorators()],
    test: {
        include: ['test/unit/**/*.test.ts'],
        environment: 'node',
    },
});
