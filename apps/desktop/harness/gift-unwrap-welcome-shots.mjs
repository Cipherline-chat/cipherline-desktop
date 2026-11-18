// Accept -> unwrap -> Pro welcome, at the owner's window sizes, with and without
// prefers-reduced-motion, plus real-time videos of the whole recipient flow.
//
//   GIFTS_PORT=5631 npx vite --config harness/gifts.vite.config.ts
//   BASE=http://127.0.0.1:5631/harness/gifts.html OUT=<dir> node harness/gift-unwrap-welcome-shots.mjs
//     MODE=check   window-size frames + ordering checks (default)
//     MODE=video   the two real-time MP4s (normal, reduced motion)   VIDEO_NAMES=normal,reduced-motion
//     MODE=all     both
//
// Ordering is read from an in-page timeline (MutationObserver), not inferred from
// screenshots: when the welcome (.pcel) mounts, the box must already be in its
// final "open" pose, and an unwrap step (full motion) or the opacity cross-fade
// (reduced motion) must have been on screen before it.
// Launches its own headless shell and closes it at the end.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5617/harness/gifts.html';
const OUT = process.env.OUT ?? '/tmp/gift-unwrap-welcome';
const MODE = process.env.MODE ?? 'check';
const [VIDEO_NORMAL, VIDEO_REDUCED] = (process.env.VIDEO_NAMES ?? 'gift-unwrap-normal,gift-unwrap-reduced-motion').split(',');
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const SIZES = [
    { w: 1000, h: 720, dpr: 1 },
    { w: 1366, h: 768, dpr: 1 },
    { w: 1920, h: 1080, dpr: 1 },
    { w: 1280, h: 800, dpr: 1.5 },
];

// In-page timeline of the sequence (performance.now() ms).
const TIMELINE = () => {
    const tl = { events: [], add(ev, extra) { this.events.push({ t: Math.round(performance.now()), ev, ...extra }); } };
    window.__seq = tl;
    const seen = new Set();
    const once = (k, extra) => { if (!seen.has(k)) { seen.add(k); tl.add(k, extra); } };
    const scan = () => {
        const gb = document.querySelector('[data-testid="gift-card"] .gb');
        if (gb) {
            if (gb.dataset.state === 'unwrapping') once('unwrapping', { motion: gb.dataset.motion });
            if (gb.dataset.state === 'open' && seen.has('unwrapping')) once('open');
            if (gb.dataset.state === 'open' && !seen.has('unwrapping')) once('open-without-unwrap');
        }
        const status = document.querySelector('[data-testid="gift-card"] [role="status"]');
        if (status && /Gift accepted/.test(status.textContent ?? '')) once('announced');
        if (document.querySelector('.pcel')) {
            const running = gb ? gb.getAnimations({ subtree: true })
                .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length : -1;
            once('welcome', { boxState: gb?.dataset.state, boxRunning: running });
        }
    };
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['data-state', 'data-motion', 'class'] });
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
console.log('BROWSER PID ' + (browser.process?.()?.pid ?? '?'));

async function open({ w, h, dpr }, reduced) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000);
    page.on('pageerror', (e) => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await page.route(/api\.cipherline\.chat|js\.stripe\.com|stripe\.network/, (r) => r.abort());
    await page.addInitScript(TIMELINE);
    await page.goto(`${BASE}?scene=unwrap&welcome=1`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector('[data-kind="unopened"]');
    // emulateMedia as well as the context option, as the brief asks; same effect.
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    return { ctx, page };
}

function verifyOrder(tl, label, reduced, minGap) {
    const at = (k) => tl.find((e) => e.ev === k);
    const unwrap = at('unwrapping'), opened = at('open'), welcome = at('welcome'), ann = at('announced');
    check(`${label}: an unwrap step was on screen before the welcome`, !!unwrap && !at('open-without-unwrap'), JSON.stringify(tl.map((e) => e.ev)));
    if (reduced) check(`${label}: reduced motion uses the opacity cross-fade`, unwrap?.motion === 'fade', String(unwrap?.motion));
    else check(`${label}: full motion uses the full unwrap`, unwrap?.motion === 'full', String(unwrap?.motion));
    check(`${label}: the welcome mounted only after the box reached "open"`, !!welcome && !!opened && welcome.t >= opened.t && welcome.boxState === 'open', welcome ? `open@${opened?.t} welcome@${welcome.t} box=${welcome.boxState}` : 'no welcome');
    check(`${label}: no one-shot box animation was still running when the welcome mounted`, welcome?.boxRunning === 0, String(welcome?.boxRunning));
    const gap = welcome && unwrap ? welcome.t - unwrap.t : -1;
    // minGap: the rest of the animation still to play (the check pass seeks to the midpoint first).
    check(`${label}: unwrap-to-welcome gap is the animation, not a jump`, gap >= minGap, `${gap} ms (>= ${minGap})`);
    check(`${label}: "Gift accepted" announced before the welcome`, !!ann && !!welcome && ann.t <= welcome.t);
}

try {
    if (MODE === 'check' || MODE === 'all') {
        for (const reduced of [false, true]) {
            for (const size of SIZES) {
                const label = `${size.w}x${size.h}@${size.dpr}${reduced ? ' reduced' : ''}`;
                const tag = `${size.w}x${size.h}@${size.dpr}${reduced ? '-reduced' : ''}`;
                const { ctx, page } = await open(size, reduced);
                // Freeze JS timers (the fallback) and the box's animations to grab the midpoint.
                await page.clock.install();
                await page.clock.pauseAt(Date.now() + 60_000);
                await page.click('[data-testid="gift-card"] .gft-actions button');
                // Either the unwrap starts, or (the bug) the welcome is already up.
                await page.waitForSelector('.gb[data-state="unwrapping"], .pcel', { timeout: 8000 });
                const mid = reduced ? 450 : 650;
                await page.evaluate((ms) => { for (const a of document.querySelector('.gb').getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms; } }, mid);
                check(`${label}: the box is unwrapping right after Accept`, (await page.$('.gb[data-state="unwrapping"]')) !== null);
                await page.waitForTimeout(80);
                check(`${label}: no welcome at the unwrap midpoint`, (await page.$('.pcel')) === null);
                await page.screenshot({ path: `${OUT}/${tag}-1-mid.png` });
                // Let it run for real: animations resume, timers resume.
                await page.evaluate(() => { for (const a of document.querySelector('.gb').getAnimations({ subtree: true })) a.play(); });
                await page.clock.resume();
                await page.waitForSelector('.pcel', { timeout: 8000 });
                await page.waitForSelector('.pcel[data-phase="rest"]', { timeout: 8000 });
                await page.waitForTimeout(reduced ? 500 : 700);
                await page.screenshot({ path: `${OUT}/${tag}-2-welcome.png` });
                const tl = await page.evaluate(() => window.__seq.events);
                verifyOrder(tl, label, reduced, (reduced ? 900 : 1300) - mid - 50);
                // The card under the welcome: opened.
                check(`${label}: card settled on "opened"`, (await page.$eval('[data-testid="gift-card"]', (e) => e.dataset.kind)) === 'opened');
                await ctx.close();
                console.log('SHOT  ' + `${OUT}/${tag}-{1-mid,2-welcome}.png`);
            }
        }
    }

    if (MODE === 'video' || MODE === 'all') {
        for (const [reduced, name] of [[false, VIDEO_NORMAL], [true, VIDEO_REDUCED]]) {
            const { ctx, page } = await open({ w: 1366, h: 768, dpr: 1 }, reduced);
            const dir = `${OUT}/${name}-frames`;
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir, { recursive: true });
            const cdp = await ctx.newCDPSession(page);
            const frames = [];
            cdp.on('Page.screencastFrame', async (f) => {
                const file = `${dir}/f${String(frames.length).padStart(5, '0')}.jpg`;
                writeFileSync(file, Buffer.from(f.data, 'base64'));
                frames.push({ file, ts: f.metadata.timestamp });
                try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closing */ }
            });
            await page.waitForTimeout(600);
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1366, maxHeight: 768, everyNthFrame: 1 });
            const t0 = Date.now() / 1000;
            await page.waitForTimeout(1800); // the card sitting in the chat
            await page.hover('[data-testid="gift-card"] .gft-actions button');
            await page.waitForTimeout(400);
            await page.click('[data-testid="gift-card"] .gft-actions button');
            await page.waitForSelector('.pcel', { timeout: 10000 });
            await page.waitForSelector('.pcel[data-phase="rest"]', { timeout: 10000 });
            await page.waitForTimeout(2200); // hold on the finished welcome
            const tEnd = Date.now() / 1000;
            await cdp.send('Page.stopScreencast');
            const tl = await page.evaluate(() => window.__seq.events);
            verifyOrder(tl, `video ${name}`, reduced, reduced ? 850 : 1250);
            await ctx.close();
            // Variable-rate screencast frames -> constant 60 fps H.264.
            const lines = [];
            for (let i = 0; i < frames.length; i++) {
                const next = i + 1 < frames.length ? frames[i + 1].ts : Math.max(tEnd, frames[i].ts + 0.05);
                lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, next - frames[i].ts).toFixed(4)}`);
            }
            lines.push(`file '${frames[frames.length - 1].file}'`);
            writeFileSync(`${dir}/list.txt`, lines.join('\n'));
            const mp4 = `${OUT}/${name}.mp4`;
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`,
                '-vf', 'fps=60,scale=1366:768:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
            const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim();
            const span = frames.length ? (frames[frames.length - 1].ts - frames[0].ts) : 0;
            console.log(`VIDEO ${mp4}  ${Number(dur).toFixed(1)} s  (${frames.length} captured frames over ${span.toFixed(1)} s = ${(frames.length / Math.max(span, 0.001)).toFixed(0)} fps source; t0 ${t0.toFixed(0)})`);
            rmSync(dir, { recursive: true, force: true });
        }
    }
} catch (e) {
    failures++;
    console.log('FAIL  crashed: ' + (e?.message ?? e));
} finally {
    await browser.close();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exitCode = failures ? 1 : 0;
}
