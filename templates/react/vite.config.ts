import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './': asset URLs relative to index.html, so the build works from any storage folder
// (and no <base> tag is emitted, which would break hash navigation from a named entry file).
export default defineConfig({
    base: './',
    plugins: [react()],
});
