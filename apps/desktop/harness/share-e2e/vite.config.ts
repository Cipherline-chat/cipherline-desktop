import { defineConfig } from 'vite';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Static build of the share E2E harness page. OUT_DIR defaults to ./dist
// (gitignored by the README's instructions — build it somewhere scratch).
export default defineConfig({
    root: here,
    base: './',
    logLevel: 'warn',
    esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    build: {
        outDir: process.env.OUT_DIR ?? path.join(here, 'dist'),
        emptyOutDir: true,
        target: 'es2022',
        minify: false,
        sourcemap: false,
    },
    define: {
        'import.meta.env.VITE_APP_VERSION': JSON.stringify('0.0.0-harness'),
        'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify('harness'),
    },
});
