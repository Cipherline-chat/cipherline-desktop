import { defineConfig } from 'vite';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..', '..');

// Static build of the call-audio E2E page (src/audio/audit/callAudioE2E.sweep.test.ts builds it into its OUT dir).
export default defineConfig({
    root: here,
    base: './',
    logLevel: 'warn',
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
    resolve: { alias: [
        { find: '@cipherline/shared', replacement: process.env.SHARED_INDEX ?? path.resolve(app, '..', '..', 'packages', 'shared', 'index.ts') },
    ] },
});
