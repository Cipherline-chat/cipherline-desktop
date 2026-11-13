// Keys' wardrobe on Home (harness/keys-wardrobe-main.tsx): a still of every
// look, the "something else claims his head" cases, and frame strips of the
// put-on / take-off transitions, plus an overview sheet.
//
//   KEYS_WARDROBE_PORT=5251 npx vite --config harness/keys-wardrobe.vite.config.ts
//   OUT=/some/dir node harness/keys-wardrobe-shots.mjs
//
// Deterministic: Playwright's fake clock (timers, rAF, performance.now), and
// every Web Animation / CSS transition / CSS animation is paused at birth and
// seeked to the virtual time before each frame (keys-play-record.mjs's rule).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5251/harness/keys-wardrobe.html';
const OUT = process.env.OUT ?? '/tmp/keys-wardrobe';
const SCALE = Number(process.env.SCALE ?? 3);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];
const report = [];

async function open(qs, time = '2026-10-28T14:00:00') {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 520 }, deviceScaleFactor: SCALE });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${qs}: ${e}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${qs}: ${m.text()}`); });
    const t0 = new Date(time);
    await page.clock.install({ time: t0 });
    await page.addInitScript(() => {
        const seen = new Map();
        window.__vt = seen;
        const orig = Element.prototype.animate;
        Element.prototype.animate = function (k, o) {
            const a = orig.call(this, k, o);
            try { a.pause(); } catch { /* */ }
            seen.set(a, performance.now());
            return a;
        };
    });
    await page.clock.pauseAt(new Date(t0.getTime() + 1000));
    await page.goto(`${BASE}?${qs}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForSelector('.hk .k2-root', { timeout: 180000 });
    await page.mouse.move(5, 5);
    const box = await page.locator('.hk .k2-root').boundingBox();
    const clip = { x: Math.round(box.x - 30), y: Math.round(box.y - 46), width: Math.round(box.width + 60), height: Math.round(box.height + 62) };
    // Seek every animation / transition to the virtual clock, then shoot.
    const sync = () => page.evaluate(() => {
        const now = performance.now();
        for (const a of document.getAnimations()) {
            let s = window.__vt.get(a);
            if (s === undefined) {
                if (a.playState === 'finished') continue;
                try { a.pause(); } catch { /* */ }
                s = now;
                window.__vt.set(a, s);
            }
            try { a.currentTime = Math.max(0, now - s); } catch { /* */ }
        }
    });
    // register everything already running at virtual "load", so a still
    // taken later shows each entry animation at its real age (not frame 0)
    await sync();
    const info = () => page.evaluate(() => {
        const hk = document.querySelector('.hk');
        return { hat: hk?.dataset.hat ?? null, on: [...document.querySelectorAll('.hkg.is-on')].map(e => e.classList[1]) };
    });
    return { ctx, page, clip, sync, info };
}

const LOOKS = ['none', 'beanie', 'captain', 'snorkel', 'shades', 'flower', 'crown'];
const stills = [];
for (const hat of LOOKS) {
    const { ctx, page, clip, sync, info } = await open(`hat=${hat}&pro=1`);
    await page.clock.runFor(1500);
    await sync();
    const path = `${OUT}/look-${hat}.png`;
    await page.screenshot({ path, clip });
    const i = await info();
    report.push({ look: hat, ...i });
    stills.push({ label: hat === 'none' ? 'nothing' : hat === 'crown' ? 'crown (Pro only)' : hat, path });
    await ctx.close();
}

// Something else claims his head: it wins, the pick waits underneath.
const claims = [];
for (const [state, label, time] of [
    ['call', 'beanie picked, in a call: headset wins'],
    ['dnd', 'beanie picked, DND: headphones + mask win'],
    ['night', 'beanie picked, night dive: lantern wins'],
    ['', 'beanie picked, Halloween: the witch hat wins', '2026-10-31T14:00:00'],
]) {
    const { ctx, page, clip, sync, info } = await open(`hat=beanie${state ? `&state=${state}` : ''}`, time);
    await page.clock.runFor(1500);
    await sync();
    const path = `${OUT}/priority-${state || 'costume'}.png`;
    await page.screenshot({ path, clip });
    report.push({ priority: label, ...(await info()) });
    claims.push({ label, path });
    await ctx.close();
}

// Transitions: the idle change (fast-forward to the first idle check past
// WARDROBE_MIN_MS), shot every STEP ms; and Pro arriving late (crown on).
const STEP = 50;
const strips = [];
async function strip(name, qs, eventAt, frames) {
    const { ctx, page, clip, sync, info } = await open(qs);
    await page.clock.runFor(400);
    const before = await info();
    // fast-forward (in slices) to just before the change (ms after mount)
    let left = eventAt - 400 - 2 * STEP;
    while (left > 0) { const d = Math.min(20000, left); await page.clock.runFor(d); left -= d; }
    const shots = [];
    for (let k = 0; k < frames; k++) {
        await page.clock.runFor(STEP);
        await sync();
        const path = `${OUT}/${name}-f${String(k).padStart(2, '0')}.png`;
        await page.screenshot({ path, clip });
        shots.push(path);
    }
    report.push({ transition: name, before, after: await info() });
    strips.push({ name, shots });
    await ctx.close();
}
// the first idle check past 4 min: 6 x 45 s after mount
const IDLE_AT = 6 * 45_000;
await strip('puton-beanie', 'hat=none&to=beanie', IDLE_AT, 24);
await strip('swap-shades-to-captain', 'hat=shades&to=captain', IDLE_AT, 24);
await strip('takeoff-snorkel', 'hat=snorkel&to=none', IDLE_AT, 20);
await strip('puton-flower', 'hat=none&to=flower', IDLE_AT, 20);
await strip('pro-arrives-crown', 'hat=none&late=1&pro=1', 1000, 24);

// Sheets, laid out by the browser.
const b64 = p => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
async function sheet(path, html, width) {
    const ctx = await browser.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(`<html><body style="margin:0;background:#0B0F1E;color:#C9D3EE;font:600 15px/1.3 system-ui,sans-serif">${html}</body></html>`);
    await page.waitForLoadState('load');
    await page.screenshot({ path, fullPage: true });
    await ctx.close();
}
const cell = (s, w) => `<figure style="margin:0;text-align:center"><img src="${b64(s.path)}" style="width:${w}px;display:block;border-radius:10px;background:#0B0F1E"><figcaption style="margin-top:6px">${s.label}</figcaption></figure>`;
const row = (items, w) => `<div style="display:flex;flex-wrap:wrap;gap:14px;padding:6px 18px">${items.map(s => cell(s, w)).join('')}</div>`;
const h = t => `<h2 style="font:700 17px system-ui;color:#25E0C8;margin:18px 18px 4px">${t}</h2>`;
const stripHtml = (st, w) => `${h(st.name)}<div style="display:flex;flex-wrap:wrap;gap:4px;padding:6px 18px">${st.shots.map((p, k) => `<figure style="margin:0;text-align:center"><img src="${b64(p)}" style="width:${w}px;display:block"><figcaption style="font-size:10px;color:#5E6B8F">${k * STEP} ms</figcaption></figure>`).join('')}</div>`;
for (const st of strips) await sheet(`${OUT}/strip-${st.name}.png`, stripHtml(st, 150), 1400);
await sheet(`${OUT}/overview.png`,
    h('Keys\' wardrobe: each look (a Pro account; the crown is Pro-only)') + row(stills, 220)
    + h('Priority: whatever else claims his head wins (the pick waits underneath)') + row(claims, 220)
    + strips.map(st => stripHtml({ ...st, shots: st.shots.filter((_, k) => k % 2 === 0) }, 120)).join(''),
    1700);

writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, errors }, null, 2));
console.log(JSON.stringify({ report, errors }, null, 2));
await browser.close();
