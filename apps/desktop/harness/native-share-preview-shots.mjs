// NativeSharePreview: asserts the tile shows a picture (not the explanation text) and shoots before/after.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5321/harness/native-share-preview.html';
const OUT = process.env.OUT ?? '/tmp/native-share-preview-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1060, height: 380 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await page.goto(`${BASE}?mode=old`); await sleep(600);
    await page.screenshot({ path: `${OUT}/before-linux-sharer-tile.png` }); console.log(`SHOT  ${OUT}/before-linux-sharer-tile.png`);
    await page.goto(`${BASE}?mode=live`); await sleep(900);
    const txt = await page.locator('[data-testid=docked]').innerText();
    check('no long explanation text', !/costs nothing|hardware encoding/.test(txt), JSON.stringify(txt));
    const c = await page.locator('[data-testid=docked] canvas').first();
    check('a picture canvas is visible', await c.isVisible());
    const nonBlank = await c.evaluate(el => { const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n / (d.length / 4); });
    check('the picture has content', nonBlank > 0.5, `lit=${nonBlank.toFixed(2)}`);
    check('the helper was asked for pictures once (a tile mounted)', JSON.stringify(await page.evaluate(() => window.__asked)) === '[true]');
    await page.screenshot({ path: `${OUT}/after-linux-sharer-tile.png` }); console.log(`SHOT  ${OUT}/after-linux-sharer-tile.png`);
} finally { await browser.close(); }
process.exit(failures ? 1 : 0);
