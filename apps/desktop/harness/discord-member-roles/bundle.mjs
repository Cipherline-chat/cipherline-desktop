// Bundles setup.ts (the REAL desktop snapshot / runner code) for node.
//   OUT=<scratch>/setup.cjs node harness/discord-member-roles/bundle.mjs
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..', '..');
const repo = resolve(desktop, '..', '..');
const nm = process.env.MAIN_NODE_MODULES ?? '/home/antigravity/Cipherline';
const require = createRequire(join(nm, 'package.json'));
const { build } = require('esbuild');
await build({
    entryPoints: [join(here, 'setup.ts')],
    outfile: process.env.OUT,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'error',
    nodePaths: [join(nm, 'apps/desktop/node_modules'), join(nm, 'node_modules')],
    alias: {
        '@desk': join(desktop, 'src'),
        '@elec': join(desktop, 'electron'),
        '@cipherline/shared': join(repo, 'packages/shared/index.ts'),
    },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
