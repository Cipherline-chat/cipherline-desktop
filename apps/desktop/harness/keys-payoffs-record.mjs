// Records a Keys payoff as a deterministic frame sequence (harness/keys-egg-main.tsx).
//
//   npx vite --config harness/keys-egg.vite.config.ts      (KEYS_EGG_PORT=5237 …)
//   SHOWS=dance,dodge OUT=/some/dir node harness/keys-payoffs-record.mjs
//
// Real pointer clicks spam him for 5 s IN A CALL (?call=1: the host answers
// 'call'), the show ends on its payoff, and the moment it starts the window
// is put to REST (the pause path under test). The payoff's animations are
// then seeked to t = 0, STEP, 2 STEP … and a clip of him is screenshotted at
// each, so the frames are exact however slow the box is. ENV: SHOWS (default
// all five), STEP (ms, 100), SCALE (device scale, 2), WIDTH (1300), MOTION
// (reduce for the reduced-motion control), OUT.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5237/harness/keys-egg.html';
const OUT = process.env.OUT ?? '/tmp/keys-payoffs';
const SHOWS = (process.env.SHOWS ?? 'glitch,dodge,charge,camo,dance').split(',');
const STEP = Number(process.env.STEP ?? 100);
const SCALE = Number(process.env.SCALE ?? 2);
const WIDTH = Number(process.env.WIDTH ?? 1300);
const MOTION = process.env.MOTION ?? 'no-preference';
const TOTAL = { glitch: 3600, dodge: 3600, charge: 3600, camo: 3800, dance: 4800 };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const summary = {};
for (const show of SHOWS) {
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: SCALE, reducedMotion: MOTION });
    const page = await ctx.newPage();
    await page.goto(`${BASE}?call=1&show=${show}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('.hk .k2-root', { timeout: 120000 });
    await page.waitForTimeout(1200); // the framer entrance
    const dir = `${OUT}/${show}${MOTION === 'reduce' ? '-reduced' : ''}`;
    mkdirSync(dir, { recursive: true });
    const box = await page.locator('.hk .k2-root').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height * 0.45;
    // 5 s of spam at ~9 clicks/s, then keep clicking until the payoff has begun
    const t0 = Date.now();
    await page.evaluate(() => { window.__t = []; });
    let started = false;
    while (Date.now() - t0 < 9000) {
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(95);
        started = await page.evaluate(() => !!document.querySelector('.k2-speech') && window.__egg.verdicts.length > 0);
        if (started) break;
    }
    if (!started) throw new Error(`${show}: the streak never completed`);
    await page.evaluate(() => window.__egg.rest(true)); // pause the payoff
    const verdicts = await page.evaluate(() => window.__egg.verdicts.slice());
    const line = await page.evaluate(() => document.querySelector('.k2-speech')?.textContent ?? null);
    const clip = { x: Math.max(0, box.x - 190), y: Math.max(0, box.y - 60), width: box.width + 260, height: box.height + 150 };
    const total = TOTAL[show];
    const live = await page.evaluate(() => document.getAnimations().filter(a => !a.effect?.target?.classList?.contains('hk-swim')).length);
    let n = 0;
    for (let t = 0; t <= total; t += STEP) {
        await page.evaluate(ms => {
            for (const a of document.getAnimations()) {
                const el = a.effect?.target;
                if (!el || el.classList?.contains('hk-swim') || !el.closest?.('.hk')) continue;
                if (el.classList?.contains('k2-speech')) continue;
                a.pause();
                a.currentTime = ms;
            }
        }, t);
        await page.screenshot({ path: `${dir}/f${String(n).padStart(3, '0')}.png`, clip });
        n++;
    }
    summary[show] = { verdicts, line, animationsDuringPayoff: live, frames: n, total };
    await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}/summary${MOTION === 'reduce' ? '-reduced' : ''}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
