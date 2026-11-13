import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5361/harness/status-dropdown.html';
const OUT = process.env.OUT ?? '/tmp/status-dropdown';
const PREFIX = process.env.PREFIX ?? 'after';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const [name, vp] of [['open', { width: 1100, height: 600 }], ['open-small', { width: 800, height: 330 }]]) {
        const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(240_000);
        await page.goto(BASE);
        await page.getByRole('button', { name: 'Clear after' }).click();
        await new Promise((r) => setTimeout(r, 800));
        const r = await page.evaluate(() => { const b = document.querySelector('.selm')?.getBoundingClientRect(); return b ? { top: b.top, bottom: b.bottom, vh: innerHeight } : null; });
        console.log(name, JSON.stringify(r), r && r.top >= 0 && r.bottom <= r.vh ? 'INSIDE' : 'CUT OFF');
        await page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
        await ctx.close();
    }
} finally { await browser.close(); }
