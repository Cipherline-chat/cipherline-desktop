// Main-thread cost of the hover parallax (harness/keys-play-main.tsx), real time:
// CDP Performance.getMetrics TaskDuration over WINDOW ms with the pointer
// (a) parked away from him, (b) sweeping continuously over him, (c) parked on
// him (settled: the frame loop should have stopped). Reported as ms of main-
// thread work per second. ENV: STATES (gaming,neutral), WINDOW (5000).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5243/harness/keys-play.html';
const STATES = (process.env.STATES ?? 'gaming,neutral').split(',');
const WINDOW = Number(process.env.WINDOW ?? 5000);

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const out = {};
for (const state of STATES) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 520 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${BASE}?state=${state}`, { timeout: 180000 });
    await page.waitForSelector('.hk .k2-root', { timeout: 180000 });
    await page.waitForTimeout(4000);
    const box = await page.locator('.hk .k2-root').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const KEYS = ['TaskDuration', 'ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration'];
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(m => KEYS.includes(m.name)).map(m => [m.name, m.value]));
    const measure = async (fn) => {
        const a = await metrics(); const t0 = Date.now();
        await fn();
        const b = await metrics(); const dt = (Date.now() - t0) / 1000;
        const r = Object.fromEntries(KEYS.map(k => [k.replace('Duration', ''), +(((b[k] - a[k]) * 1000) / dt).toFixed(1)]));
        return r;
    };
    const away = await measure(async () => { await page.mouse.move(20, 500); await page.waitForTimeout(WINDOW); });
    const sweepAt = (x0, y0) => measure(async () => {
        const t0 = Date.now(); let i = 0;
        while (Date.now() - t0 < WINDOW) {
            const a = i++ / 12;
            await page.mouse.move(x0 + Math.cos(a) * box.width * 0.6, y0 + Math.sin(a * 1.3) * box.height * 0.6);
            await page.waitForTimeout(16);
        }
    });
    // control: the same pointer sweep over an empty part of the page
    const sweepEmpty = await sweepAt(300, 420);
    const sweep = await sweepAt(cx, cy);
    await page.mouse.move(cx + 10, cy - 10);
    await page.waitForTimeout(800);
    const still = await measure(async () => { await page.waitForTimeout(WINDOW); });
    const rafWhileStill = await page.evaluate(() => new Promise(res => {
        // is anything of ours still scheduling frames? count rAF callbacks for 1 s
        let n = 0; const orig = window.requestAnimationFrame;
        window.requestAnimationFrame = cb => { n++; return orig(cb); };
        setTimeout(() => { window.requestAnimationFrame = orig; res(n); }, 1000);
    }));
    out[state] = { awayMsPerS: away, sweepEmptyControlMsPerS: sweepEmpty, hoverSweepMsPerS: sweep, hoverStillMsPerS: still, rafScheduledWhileStill1s: rafWhileStill };
    await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
