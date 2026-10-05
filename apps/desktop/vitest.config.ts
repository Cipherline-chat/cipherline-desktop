import { defineConfig } from 'vitest/config';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Node environment + fake-indexeddb gives us a real IndexedDB and Node's
// WebCrypto (which actually implements crypto.subtle, unlike jsdom). The setup
// file installs the fake IndexedDB and minimal window/document stubs.
export default defineConfig({
    test: {
        environment: 'node',
        // `electron/**` is in scope for the pure, dependency-free modules the
        // main process and its preloads share (e.g. the overlay's coordinate
        // maths). Anything that imports `electron` itself is not testable here
        // and does not get a suite — the split is deliberate.
        include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
    },
    resolve: {
        alias: {
            // Must mirror vite.config.ts's alias of the same name. Vitest reads
            // THIS file instead of vite.config.ts, so an alias defined only
            // there is silently absent under test: the app would resolve the
            // workspace package from `packages/shared/index.ts` while its own
            // test suite resolved the gitignored `packages/shared/dist/` build
            // output. That split has two failure modes, and both have bitten:
            //
            //  - dist missing (a fresh worktree that has not run the shared
            //    build) → every importing suite dies at collection with
            //    "Failed to resolve entry for package @cipherline/shared",
            //    which reads like a broken test rather than an unbuilt package;
            //  - dist STALE (built before a shared export was added) → the
            //    suite fails with "X is not a function", or, far worse, passes
            //    green against code the app no longer runs.
            //
            // Resolving from source removes the build step from the test path
            // entirely, so the tests exercise the same files the app does.
            '@cipherline/shared': path.resolve(__dirname, '..', '..', 'packages', 'shared', 'index.ts'),
        },
    },
});
