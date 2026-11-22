// Bulk emoji review list at the four window sizes. env: OUT=<dir> BASE PW_CHROMIUM_EXE STATES=review,finished
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5358/harness/emoji-bulk.html';
const OUT = process.env.OUT ?? '/tmp/emoji-bulk';
mkdirSync(OUT, { recursive: true });
const SIZES = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];
const STATES = (process.env.STATES ?? 'review').split(',');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const scene of ['server', 'my']) for (const state of STATES) for (const [label, w, h, dpr] of SIZES) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(240_000);
        page.on('pageerror', e => console.log('pageerror ' + e.message));
        await page.goto(`${BASE}?scene=${scene}&state=${state}`);
        await page.waitForSelector('.dlg-card');
        await page.evaluate(() => document.fonts.ready);
        if (state !== 'review') await page.getByRole('button', { name: /^Upload/ }).click();
        await new Promise(r => setTimeout(r, state === 'finished' ? 1800 : 900));
        const box = await page.evaluate(() => { const r = document.querySelector('.dlg-card').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: innerHeight, w: innerWidth, sw: document.documentElement.scrollWidth }; });
        console.log(`${scene} ${state} ${label}: card top=${Math.round(box.top)} bottom=${Math.round(box.bottom)} of ${box.h}; hscroll=${box.sw > box.w}`);
        const p = `${OUT}/${scene}-${state}-${label}.png`;
        await page.screenshot({ path: p });
        console.log('SHOT ' + p);
        await ctx.close();
    }
} finally { await browser.close(); }
