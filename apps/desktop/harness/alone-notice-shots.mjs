// Screenshots of the alone dialog / setting row / share hint at four window sizes.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5322/harness/alone-notice.html';
const OUT = process.env.OUT ?? '/tmp/alone-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sizes = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];
let failures = 0;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const [name, w, h, dsf] of sizes) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
        const page = await ctx.newPage();
        page.on('pageerror', e => { failures++; console.log('FAIL pageerror ' + e.message); });
        for (const scene of ['dialog', 'setting', 'hint']) {
            await page.goto(`${BASE}?scene=${scene}`);
            await sleep(900);
            if (scene === 'dialog') {
                const d = await page.locator('[role=alertdialog]').boundingBox();
                const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
                const ok = d && d.x >= 0 && d.x + d.width <= w && d.y >= 0 && d.y + d.height <= h;
                console.log(`${ok ? 'PASS' : 'FAIL'} dialog fits ${name}; focused="${focused}"`); if (!ok) failures++;
                if (!/Stay in call/.test(focused)) { failures++; console.log('FAIL Stay not focused'); }
            }
            if (scene === 'hint') {
                const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
                console.log(`${over ? 'FAIL' : 'PASS'} hint no horizontal overflow ${name}`); if (over) failures++;
            }
            await page.screenshot({ path: `${OUT}/${scene}-${name}.png` });
            console.log(`SHOT ${OUT}/${scene}-${name}.png`);
        }
        await ctx.close();
    }
} finally { await browser.close(); }
process.exit(failures ? 1 : 0);
