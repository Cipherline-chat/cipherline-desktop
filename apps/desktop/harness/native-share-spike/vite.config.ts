import { defineConfig } from 'vite';
import path from 'node:path';

// Builds the spike's test page (harness only; not part of the app build). OUT_DIR is set by run.sh.
export default defineConfig({
    root: __dirname,
    base: './',
    build: { outDir: process.env.OUT_DIR ?? path.join(__dirname, 'dist'), emptyOutDir: true, target: 'esnext', minify: false, rollupOptions: { input: path.join(__dirname, 'page.html') } },
    worker: { format: 'es' },
});
