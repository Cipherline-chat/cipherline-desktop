// Screenshots of the report dialog with custom emoji (verified + unverified message) at 1366x768
// plus the minimum window and a HiDPI laptop size, with layout checks.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5341/harness/report-emoji.html';
const OUT = process.env.OUT ?? '/tmp/report-emoji-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sizes = [['1366x768', 1366, 768, 1], ['1000x720', 1000, 720, 1], ['1280x800@1.5', 1280, 800, 1.5]];
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const [name, w, h, dsf] of sizes) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
        const page = await ctx.newPage();
        page.on('pageerror', e => { failures++; console.log('FAIL pageerror ' + e.message); });
        for (const scene of ['verified', 'unverified']) {
            await page.goto(`${BASE}?scene=${scene}`);
            await page.waitForSelector('[data-testid="report-emoji-list"]', { timeout: 15000 });
            await sleep(900);
            const info = await page.evaluate(() => {
                const imgs = [...document.querySelectorAll('[data-testid="report-emoji-list"] img')];
                const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
                const inline = [...document.querySelectorAll('[data-testid="report-verified-text"] img')].length;
                const raw = (document.querySelector('[data-testid="report-verified-text"]')?.textContent ?? '').includes('<:');
                const card = document.querySelector('.dlg-card')?.getBoundingClientRect();
                return { imgs: imgs.length, loaded, inline, raw, card: card && { x: card.x, y: card.y, r: card.right, b: card.bottom }, rows: document.querySelectorAll('[data-testid="report-emoji-row"]').length };
            });
            check(info.rows === 4, `${scene} ${name}: 4 emoji rows (got ${info.rows})`);
            check(info.loaded === info.imgs && info.imgs === 3, `${scene} ${name}: 3 list pictures all decoded (got ${info.loaded}/${info.imgs})`);
            if (scene === 'verified') check(info.inline >= 3 && !info.raw, `${scene} ${name}: emoji drawn inline, no raw token (inline ${info.inline})`);
            check(!!info.card && info.card.x >= 0 && info.card.r <= w && info.card.y >= 0 && info.card.b <= h, `${scene} ${name}: dialog fits the window`);
            // Scroll the dialog body so the emoji section is in view for the shot.
            await page.evaluate(() => document.querySelector('[data-testid="report-emoji"]')?.scrollIntoView({ block: 'center' }));
            await sleep(300);
            await page.screenshot({ path: `${OUT}/reporter-${scene}-${name}.png` });
            console.log(`SHOT ${OUT}/reporter-${scene}-${name}.png`);
        }
        await ctx.close();
    }
} finally { await browser.close(); }
process.exit(failures ? 1 : 0);
