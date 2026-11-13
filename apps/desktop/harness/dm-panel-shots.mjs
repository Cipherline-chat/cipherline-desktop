// DM right-hand panel profile card: node harness/dm-panel-shots.mjs  (env: OUT BASE QS)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5349/harness/dm-panel.html';
const OUT = process.env.OUT ?? '/tmp/dm-panel';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
try {
    for (const [name, qs, motion] of [['still', '', 'reduce'], ['motion', '', 'no-preference']]) {
        const ctx = await browser.newContext({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2, reducedMotion: motion });
        const page = await ctx.newPage();
        page.on('pageerror', e => console.log('pageerror ' + e.message));
        page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });
        await page.goto(BASE + '?' + (process.env.QS ?? qs));
        await page.waitForSelector('[data-testid="panel-custom"]');
        await page.evaluate(() => document.fonts.ready);
        await new Promise(r => setTimeout(r, motion === 'reduce' ? 800 : 2500));
        await page.locator('#root > div').screenshot({ path: `${OUT}/${name}.png` });
        console.log(`SHOT ${OUT}/${name}.png`);
        await ctx.close();
    }
} finally { await browser.close(); }
