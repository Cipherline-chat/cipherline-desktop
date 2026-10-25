// Bundles client.ts against one source tree (CKH_ROOT) for the harness.
// @desk → apps/desktop/src, @elec → apps/desktop/electron,
// @cipherline/shared → packages/shared/index.ts (as the website build does).
// electron/storage is swapped for an in-memory SecureStore (storage-stub.ts):
// the REAL crypto modules (e2ee-engine, channel-keys, signal-identity) run,
// just without the OS keychain.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.CKH_ROOT;
const nm = process.env.CKH_NODE_MODULES;
const require = createRequire(join(nm, 'package.json'));
const { build } = require('esbuild');

await build({
    entryPoints: [join(here, 'client.ts')],
    outfile: process.env.CKH_OUT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'error',
    nodePaths: [join(nm, 'apps/desktop/node_modules'), join(nm, 'node_modules')],
    alias: {
        '@desk': join(root, 'apps/desktop/src'),
        '@elec': join(root, 'apps/desktop/electron'),
        '@cipherline/shared': join(root, 'packages/shared/index.ts'),
    },
    plugins: [{
        name: 'ckh-stubs',
        setup(b) {
            b.onResolve({ filter: /^\.\/storage$/ }, (args) =>
                args.importer.includes('/apps/desktop/electron/') ? { path: join(here, 'storage-stub.ts') } : undefined);
            b.onResolve({ filter: /(^|\/)secureLocalStore$/ }, (args) =>
                args.importer.includes('/apps/desktop/src/') ? { path: join(here, 'secure-local-store-stub.ts') } : undefined);
            b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', external: true }));
        },
    }],
});
