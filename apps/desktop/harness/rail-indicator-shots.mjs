// Rail indicator through cold (first-open) server switches: frames + per-frame geometry (real Chromium).
// Needs the harness server:
//   npx vite --config harness/rail-indicator.vite.config.ts      (serves :5332, RI_PORT to change)
//   node harness/rail-indicator-shots.mjs <outDir> [stallMs=60] [cpuThrottle=1]
//     env: BASE, PW_CORE, PW_CHROMIUM_EXE
// Writes <outDir>/frames/*.jpg + frames.json (CDP screencast, every frame), geo.json (one row per animation frame:
// the indicator's painted top/height/width, plus click marks) and rail.json — the same layout as
// rail-indicator/step-record.mjs, so rail-indicator/strip.py and rail-indicator/analyze.mjs read both.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const STALL = Number(process.argv[3] ?? 60);
const THROTTLE = Number(process.argv[4] ?? 1);
const BASE = process.env.BASE ?? `http://127.0.0.1:5332/harness/rail-indicator.html?stall=${STALL}`;
const OUT = process.argv[2] ?? '/tmp/rail-indicator-shots';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/frames`, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 260, height: 660 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.goto(BASE);
    await page.waitForFunction(() => window.__booted === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.evaluate(() => {
        const w = window;
        w.__geo = []; w.__on = true;
        const tick = (ts) => {
            const el = document.querySelector('[data-testid="rail-scroll"] .cl-rail-indicator');
            if (el) w.__geo.push({ ts, now: performance.now(), top: parseFloat(el.style.top), height: parseFloat(el.style.height), width: parseFloat(el.style.width) });
            if (w.__on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const frames = [];
    let n = 0;
    cdp.on('Page.screencastFrame', (f) => {
        const file = `${String(n++).padStart(4, '0')}.jpg`;
        fs.writeFileSync(`${OUT}/frames/${file}`, Buffer.from(f.data, 'base64'));
        frames.push({ file, ts: f.metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    await page.waitForTimeout(500);
    // dm(warm) -> S1 (cold), dm -> S3 (cold), groups -> S2 (cold), S1 (warm) — the owner's DMs->server pattern.
    const seq = ['dm', 'srv:0', 'dm', 'srv:2', 'groups', 'srv:1', 'srv:0'];
    const marks = [];
    for (const c of seq) {
        const loc = c === 'dm' ? page.locator('[data-rail-id="nav:dm"]')
            : c === 'groups' ? page.locator('[data-rail-id="nav:group"]')
                : page.locator('[data-rail-id^="srv:"]').nth(Number(c.split(':')[1])).locator('button');
        const now = await page.evaluate(() => performance.now());
        marks.push({ click: c, now, wall: Date.now() / 1000 });
        await loc.click();
        await page.waitForTimeout(1100);
    }
    await cdp.send('Page.stopScreencast');
    const geo = await page.evaluate(() => { window.__on = false; return window.__geo; });
    const rail = await page.evaluate(() => {
        const r = document.querySelector('nav.app-rail').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight };
    });
    fs.writeFileSync(`${OUT}/frames.json`, JSON.stringify(frames));
    fs.writeFileSync(`${OUT}/geo.json`, JSON.stringify({ marks, geo }));
    fs.writeFileSync(`${OUT}/rail.json`, JSON.stringify(rail));
    console.log(`frames ${frames.length}, geo rows ${geo.length}`);
} finally {
    await browser.close();
}
