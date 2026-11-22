// Probe: can the REAL dev Electron (main + preload + renderer from Vite) start here? Screenshot + console.
//   OUT=<dir> PROFILE=<dir> node harness/discord-import-final/electron-probe.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { _electron } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const OUT = process.env.OUT;
const PROFILE = process.env.PROFILE;
const app = await _electron.launch({
  executablePath: '/home/antigravity/Cipherline/apps/desktop/node_modules/electron/dist/electron',
  args: [APP, '--no-sandbox', `--user-data-dir=${PROFILE}`, '--password-store=basic'],
  cwd: APP,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5274',
    VITE_API_HOST: '127.0.0.1:13151',
    NODE_OPTIONS: `--require ${path.join(HERE, 'main-redirect.cjs')}`,
    DISCORD_MOCK: 'http://127.0.0.1:7982',
    MAIN_NET_LOG: path.join(OUT, 'main-net.log'),
    ELECTRON_ENABLE_LOGGING: '1',
  },
  timeout: 120000,
});
app.process().stdout.on('data', (d) => process.stdout.write(`[main] ${d}`));
app.process().stderr.on('data', (d) => process.stdout.write(`[main!] ${d}`));
app.on('window', (w) => { console.log('window opened', w.url()); w.on('console', (m) => console.log(`[renderer ${m.type()}] ${m.text().slice(0, 300)}`)); });
let win = null;
for (let i = 0; i < 240 && !win; i++) {
  win = app.windows().find((w) => w.url().startsWith('http://127.0.0.1:5274')) ?? null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
console.log('main window', win && win.url());
await new Promise((r) => setTimeout(r, 25000));
const wins = app.windows();
console.log('windows', wins.map((w) => w.url()));
for (const [i, w] of wins.entries()) await w.screenshot({ path: path.join(OUT, `probe-${i}.png`) }).catch((e) => console.log('shot fail', e.message));
await app.close();
