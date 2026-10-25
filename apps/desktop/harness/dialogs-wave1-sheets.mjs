// Composes "before | after" contact sheets from two screenshot dirs made by dialogs-wave1-shots.mjs.
//   BEFORE=<dir> AFTER=<dir> OUT=<dir> node harness/dialogs-wave1-sheets.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const { BEFORE, AFTER, OUT } = process.env;
if (!BEFORE || !AFTER || !OUT) throw new Error('set BEFORE, AFTER and OUT');
mkdirSync(OUT, { recursive: true });
const names = readdirSync(AFTER).filter(f => f.endsWith('.png') && !f.endsWith('.FAILED.png')).map(f => f.slice(0, -4));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 2580, height: 860 } });
for (const name of names) {
    const b = join(BEFORE, `${name}.png`), a = join(AFTER, `${name}.png`);
    const html = `<!doctype html><body style="margin:0;background:#05070f;font:600 15px system-ui;color:#9fb0d8">
      <div style="display:flex;gap:20px;padding:10px">
        <div><div style="padding:0 0 6px">BEFORE · ${name}</div>${existsSync(b) ? `<img src="file://${b}" width="1280">` : '<div style="width:1280px;height:800px;display:grid;place-items:center;border:1px dashed #334">(new)</div>'}</div>
        <div><div style="padding:0 0 6px">AFTER · ${name}</div><img src="file://${a}" width="1280"></div>
      </div></body>`;
    const f = join(OUT, `.${name}.html`);
    writeFileSync(f, html);
    await page.goto('file://' + f);
    await page.waitForLoadState('load');
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log('sheet', name);
}
await browser.close();
