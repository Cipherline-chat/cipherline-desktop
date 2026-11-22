// node pw.mjs <cdpPort> <step.mjs> [args]: attach to the running REAL Electron app (launch.sh) over CDP and run the
// step module's default export (page, ctx). Every renderer request to a non-loopback host is aborted and counted
// (written to $S/blocked-<port>.log). The app is never closed here.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/home/antigravity/Cipherline/node_modules/');
const { chromium } = require('playwright-core');
const [,, port, script, ...rest] = process.argv;
const S = process.env.S;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().startsWith('http://127.0.0.1:5297')) ?? pages[0];
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (['data:', 'blob:', 'devtools:', 'chrome-extension:', 'file:'].includes(u.protocol) || ['127.0.0.1', 'localhost'].includes(u.hostname)) return route.continue();
  if (S) fs.appendFileSync(`${S}/blocked-${port}.log`, `${u.hostname}\n`);
  return route.abort();
}).catch(() => undefined);
const mod = await import(`${script}?t=${Date.now()}`);
try {
  const out = await mod.default(page, { browser, ctx, pages, args: rest });
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
} catch (e) { console.error('ERR', String(e?.message ?? e).slice(0, 3000)); process.exitCode = 1; }
process.exit();
