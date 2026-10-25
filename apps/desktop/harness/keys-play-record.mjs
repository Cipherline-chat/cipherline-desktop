// Records Keys' click reactions per mirrored state as deterministic frames
// (harness/keys-play-main.tsx), then encodes an MP4 per state.
//
//   KEYS_PLAY_PORT=5243 npx vite --config harness/keys-play.vite.config.ts
//   STATES=gaming,dnd OUT=/some/dir node harness/keys-play-record.mjs
//
// Deterministic on a loaded box: the page's clock is Playwright's fake one
// (timers, rAF, performance.now, Date), and every Web Animation / CSS
// animation / transition is paused the moment it appears and seeked to the
// virtual time before each frame. So each frame is exactly STEP ms after the
// last however slow the screenshots are. The pointer is a real (Playwright)
// mouse: a hover loop for the parallax, three paced clicks (the three
// reactions), then a burst of six (the finale; DND's wall is knocked over
// with one more click).
//
// ENV: STATES (default all), STEP (33), SCALE (3), OUT, NO_ENCODE=1, SHINY=1 (a shiny still only).
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5243/harness/keys-play.html';
const OUT = process.env.OUT ?? '/tmp/keys-play';
const ALL = ['gaming', 'asleep', 'dnd', 'call', 'pile', 'box', 'safe', 'camo', 'offline', 'coffee', 'lantern', 'crown', 'neutral'];
const STATES = (process.env.STATES ?? ALL.join(',')).split(',');
const STEP = Number(process.env.STEP ?? 33);
const SCALE = Number(process.env.SCALE ?? 3);

/** Beat lengths (ms) to wait after each paced click, and the finale's. */
const PACE = 2500;
const FINALE_WAIT = { gaming: 3000, asleep: 2900, dnd: 900, call: 3000, pile: 3600, box: 3000, safe: 3200, camo: 3000, offline: 3000, coffee: 2600, lantern: 2800, crown: 2700 };

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});

async function record(state, { shiny = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 520 }, deviceScaleFactor: SCALE });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const t0 = new Date(state === 'coffee' ? '2026-10-20T07:30:00' : '2026-10-20T14:00:00');
    await page.clock.install({ time: t0 });
    await page.addInitScript(() => {
        // pause every Web Animation at birth; the recorder seeks them
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
    // paused from the start: a slow page load must not eat virtual time
    await page.clock.pauseAt(new Date(t0.getTime() + 1000));
    await page.goto(`${BASE}?state=${state}${shiny ? '&shiny=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForSelector('.hk .k2-root', { timeout: 180000 });
    const box = await page.locator('.hk .k2-root').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height * 0.45;
    const w = Math.round(box.width + 380), h = Math.round(box.height + 190);
    const clip = { x: Math.round(box.x - 210), y: Math.round(box.y - 64), width: w - (w % 2), height: h - (h % 2) };
    const dir = `${OUT}/${state}${shiny ? '-shiny' : ''}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let n = 0;
    const log = [];
    const caption = t => page.evaluate(s => window.__kp.caption(s), t);
    const snap = async () => {
        await page.clock.runFor(STEP);
        await page.evaluate(() => {
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
        await page.screenshot({ path: `${dir}/f${String(n).padStart(5, '0')}.png`, clip });
        n++;
    };
    const frames = async ms => { for (let t = 0; t < ms; t += STEP) await snap(); };
    const beat = () => page.evaluate(() => document.querySelector('.hk')?.dataset.beat ?? null);
    const line = () => page.evaluate(() => document.querySelector('.k2-speech')?.textContent ?? null);

    // settle in (entry transitions, the scene's own gesture)
    await page.mouse.move(clip.x + 5, clip.y + 5);
    await page.clock.runFor(1500);
    await caption(`${state}: hover`);
    await frames(300);
    // the hover: a loop around him (and a little beyond), then away
    const R = box.width * 0.62;
    for (let i = 0; i <= 90; i++) {
        const a = (i / 90) * Math.PI * 2.2;
        await page.mouse.move(cx + Math.cos(a) * R, cy + Math.sin(a * 1.5) * R * 0.75);
        await snap();
    }
    await page.mouse.move(clip.x + 4, clip.y + clip.height - 4);
    await frames(700);
    if (shiny) {
        await caption('Shiny Keys (1 launch in 500)');
        await frames(400);
        await page.mouse.move(cx + R * 0.7, cy - R * 0.4);
        await frames(500);
        await page.screenshot({ path: `${OUT}/shiny-keys-still.png`, clip });
        await ctx.close();
        return { state: 'shiny', frames: n, errors };
    }
    // three paced clicks: three different reactions
    for (let k = 1; k <= 3; k++) {
        await page.mouse.move(cx, cy);
        await page.mouse.click(cx, cy);
        const b = await beat();
        await caption(`${state}: click ${k}${b ? ` (${b})` : ''}`);
        const said = [];
        for (let t = 0; t < PACE; t += STEP) { await snap(); const l = await line(); if (l && !said.includes(l)) said.push(l); }
        log.push({ click: k, beat: b, lines: said });
    }
    if (state !== 'neutral') {
        // the burst: six clicks in under a second
        await caption(`${state}: spam ×6 → finale`);
        for (let k = 0; k < 6; k++) {
            await page.mouse.click(cx, cy);
            await frames(132);
        }
        const fb = await beat();
        const said = [];
        for (let t = 0; t < FINALE_WAIT[state]; t += STEP) { await snap(); const l = await line(); if (l && !said.includes(l)) said.push(l); }
        log.push({ finale: fb, lines: said });
        if (state === 'dnd') {
            await caption('dnd: knock the wall over');
            await page.mouse.click(cx, cy);
            log.push({ release: await beat() });
            let s2 = null;
            for (let t = 0; t < 1900; t += STEP) { await snap(); s2 = s2 ?? await line(); }
            log[log.length - 1].line = s2;
        }
    }
    await page.mouse.move(clip.x + 4, clip.y + 4);
    await frames(600);
    await ctx.close();
    return { state, frames: n, log, errors };
}

const summary = [];
if (process.env.SHINY === '1') summary.push(await record('neutral', { shiny: true }));
else for (const s of STATES) {
    const r = await record(s);
    summary.push(r);
    console.log(JSON.stringify(r));
    if (process.env.NO_ENCODE !== '1') {
        const dir = `${OUT}/${s}`;
        const mp4 = `${OUT}/keys-${s}.mp4`;
        const fps = String(Math.round(1000 / STEP));
        try {
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps, '-i', `${dir}/f%05d.png`,
                '-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '20', mp4]);
        } catch {
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps, '-i', `${dir}/f%05d.png`,
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
        }
        rmSync(dir, { recursive: true, force: true });
    }
}
await browser.close();
writeFileSync(`${OUT}/summary${process.env.SHINY === '1' ? '-shiny' : ''}.json`, JSON.stringify(summary, null, 2));
