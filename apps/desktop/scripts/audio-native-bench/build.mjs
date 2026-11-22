// Build the bench's pieces into an output dir: node scripts/audio-native-bench/build.mjs <outDir>
//   <outDir>/dist-electron/   the electron/ TypeScript compiled by the app's own tsconfig (REAL preload, host, ipc)
//   <outDir>/page-glue.js     the page glue (src/utils/clAudioNative.ts) bundled by esbuild
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../..');
const out = resolve(process.argv[2] ?? join(desktop, '../../.bench-out'));
mkdirSync(out, { recursive: true });
execFileSync('npx', ['--no-install', 'tsc', '-p', 'tsconfig.electron.json', '--outDir', join(out, 'dist-electron')], { cwd: desktop, stdio: 'inherit' });
execFileSync('npx', ['--no-install', 'esbuild', join(here, 'entry.ts'), '--bundle', '--format=iife', `--outfile=${join(out, 'page-glue.js')}`], { cwd: desktop, stdio: 'inherit' });
console.log('built into', out);
