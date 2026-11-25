// Frame-exact capture of the high-five move: freezes timers (Playwright clock), then scrubs every CSS
// animation to time T with the Web Animations API and screenshots the pill. Writes frames/NNNN.png.
//   OUT=<dir> W=1366 H=768 DSF=2 THEME=light node harness/high-five-film.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5447/harness/window-sizes.html';
const OUT = process.env.OUT ?? '/tmp/high-five-film';
const W = +(process.env.W ?? 1366), H = +(process.env.H ?? 768), DSF = +(process.env.DSF ?? 2);
const STEP = +(process.env.STEP ?? 33), END = +(process.env.END ?? 2300);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('pageerror ' + e.message));
    await page.clock.install();
    await page.goto(`${BASE}?scene=highfive${process.env.THEME ? `&theme=${process.env.THEME}` : ''}${process.env.FROM ? `&from=${encodeURIComponent(process.env.FROM)}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    for (let i = 0; i < 400; i++) { if (await page.evaluate(() => window.__ready === true)) break; await page.clock.runFor(100); await page.waitForTimeout(50); }
    await page.clock.runFor(450); // FireHighFive's 400 ms timer
    await page.waitForSelector('[data-testid="high-five-overlay"]', { timeout: 20000 });
    // Freeze the fake clock too (install() keeps it ticking), so the overlay's hide timer never fires mid-capture.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 20));
    await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
    const box = await page.evaluate(() => { const r = document.querySelector('[data-testid="high-five-overlay"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    // Placement + padding at rest (all animations at their end state), and whether the name is cut.
    const m = await page.evaluate(() => {
        document.getAnimations().forEach(a => { a.currentTime = 1900; });
        const el = document.querySelector('[data-testid="high-five-overlay"]');
        const r = el.getBoundingClientRect();
        const kids = [...el.children].map(c => c.getBoundingClientRect());
        const from = el.querySelector('.pe-hifive__from');
        return { w: Math.round(r.width), marginL: +(r.left).toFixed(1), marginR: +(innerWidth - r.right).toFixed(1),
            padL: +(Math.min(...kids.map(k => k.left)) - r.left).toFixed(1), padR: +(r.right - Math.max(...kids.map(k => k.right))).toFixed(1),
            nameCut: from.scrollWidth > from.clientWidth + 0.5, hOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    console.log('MEASURE ' + JSON.stringify(m));
    const clip = process.env.FULL ? undefined : { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 36), width: box.w + 120, height: box.h + 60 };
    const times = process.env.TIMES ? process.env.TIMES.split(',').map(Number) : null;
    let n = 0;
    for (let t = 0; t <= END; t += STEP) {
        if (times && !times.includes(t)) continue;
        await page.evaluate(t => document.getAnimations().forEach(a => { a.currentTime = t; }), t);
        await page.screenshot({ path: `${OUT}/${String(n++).padStart(4, '0')}.png`, clip });
    }
    console.log(`frames ${n} clip ${JSON.stringify(clip)} step ${STEP}ms`);
} finally { await browser.close(); }
