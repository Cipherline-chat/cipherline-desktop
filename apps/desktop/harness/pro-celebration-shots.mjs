// ProWelcome ("You're Pro" celebration): behaviour checks + timeline frames + MP4, in real Chromium.
//
//   npx vite --config harness/pro-celebration.vite.config.ts      (serves :5233)
//   node harness/pro-celebration-shots.mjs                         (env: OUT=<dir> BASE=... CDP=http://127.0.0.1:9510)
//
// Connects to an already-running headless shell over CDP when CDP is set (reuse ONE
// instance; see CLAUDE.md "Headless Chrome cleanup"), else launches its own.
// Timers run on Playwright's fake clock and every CSS animation is seeked by hand, so
// frames are deterministic: frame N is exactly N/30 s into the sequence.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5233/harness/pro-celebration.html';
const OUT = process.env.OUT ?? '/tmp/pro-celebration-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = process.env.CDP
    ? await chromium.connectOverCDP(process.env.CDP)
    : await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open({ theme = 'dark', size = [1600, 900], reduced = false, name = 'Dawson', dpr = 1 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000); // first load runs Vite's dep optimiser; the box is often at load 20+
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await page.clock.install();
    await page.goto(`${BASE}?theme=${theme}&name=${encodeURIComponent(name)}`);
    await page.waitForSelector('.pcel');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.__pcel.seek(0));
    return { ctx, page };
}
const phase = (page) => page.$eval('.pcel', el => el.dataset.phase);
const focused = (page) => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
const seekTo = async (page, ms, clockAt) => {
    if (ms > clockAt.t) { await page.clock.runFor(ms - clockAt.t); clockAt.t = ms; }
    await page.evaluate((t) => window.__pcel.seek(t), ms);
    await page.waitForTimeout(40);
};

try {
    // ---------- 1. behaviour -------------------------------------------------
    {
        const { ctx, page } = await open();
        const a = await page.$eval('.pcel', el => ({ role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), label: document.getElementById(el.getAttribute('aria-labelledby'))?.textContent }));
        check('dialog semantics (role=dialog, aria-modal, labelled by the heading)', a.role === 'dialog' && a.modal === 'true' && /Welcome to Pro, Dawson/.test(a.label), JSON.stringify(a));
        check('focus starts on the dialog', (await focused(page)) === 'pcel');
        check('intro: Skip shown, CTA not tabbable', (await page.$('.pcel-skip')) !== null && (await page.$eval('.pcel-cta', b => b.tabIndex)) === -1);
        // Every animated property must be compositor-only.
        const props = await page.evaluate(() => {
            const s = new Set();
            for (const an of document.querySelector('.pcel').getAnimations({ subtree: true })) for (const kf of an.effect.getKeyframes()) for (const k of Object.keys(kf)) s.add(k);
            return [...s].filter(k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
        });
        check('only transform/opacity animate', props.every(p => p === 'transform' || p === 'opacity'), props.join(','));
        await page.mouse.click(800, 120); // backdrop, mid-intro
        await page.waitForTimeout(50);
        check('click during intro fast-forwards to rest', (await phase(page)) === 'rest');
        check('…and focuses "Let’s go"', (await focused(page)) === 'pcel-cta');
        await page.keyboard.press('Tab');
        check('Tab stays trapped in the dialog', (await focused(page)) === 'pcel-cta');
        await page.mouse.click(800, 300); // the card itself: reading, not dismissing
        await page.clock.runFor(400);
        check('click on the card at rest does not close', (await page.evaluate(() => window.__pcel.closed)) === 0);
        await page.keyboard.press('Escape');
        await page.clock.runFor(400);
        const esc = { closed: await page.evaluate(() => window.__pcel.closed), present: (await page.$('.pcel')) !== null };
        check('Esc closes', esc.closed === 1 && !esc.present, JSON.stringify(esc));
        await ctx.close();
    }
    {
        const { ctx, page } = await open();
        await page.clock.runFor(3000);
        check('intro ends on its own at ~2.9 s', (await phase(page)) === 'rest' && (await page.$('.pcel-skip')) === null);
        check('"Let’s go" takes focus at rest', (await focused(page)) === 'pcel-cta');
        await page.keyboard.press('Enter');
        await page.clock.runFor(400);
        check('Enter on "Let’s go" closes', (await page.evaluate(() => window.__pcel.closed)) === 1);
        await ctx.close();
    }
    {
        const { ctx, page } = await open();
        await page.click('.pcel-skip');
        await page.clock.runFor(400);
        check('Skip closes mid-intro', (await page.evaluate(() => window.__pcel.closed)) === 1);
        await ctx.close();
    }
    {
        const { ctx, page } = await open({ reduced: true });
        check('reduced motion: starts at rest, CTA focused', (await phase(page)) === 'rest' && (await focused(page)) === 'pcel-cta');
        const anims = await page.evaluate(() => { const root = document.querySelector('.pcel'); return root.getAnimations({ subtree: true }).filter(a => a.effect.target !== root).length; });
        check('reduced motion: nothing inside the overlay animates (only its 0.2 s fade-in)', anims === 0, String(anims));
        await page.clock.runFor(300);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/reduced-motion-dark-1600x900.png` });
        await ctx.close();
    }

    // ---------- 2. stills ----------------------------------------------------
    const stills = [
        { theme: 'dark', size: [1600, 900], times: [150, 450, 800, 1150, 1500, 1700, 2300, 3600] },
        { theme: 'light', size: [1600, 900], times: [450, 1150, 1700, 3600] },
        { theme: 'dark', size: [1280, 720], times: [1700, 3600] },
        { theme: 'dark', size: [3840, 2160], times: [3600] },
        { theme: 'dark', size: [1920, 1080], times: [3600], dpr: 2 },
    ];
    for (const s of stills) {
        const { ctx, page } = await open(s);
        const clockAt = { t: 0 };
        for (const t of s.times) {
            await seekTo(page, t, clockAt);
            const f = `${OUT}/${s.theme}-${s.size.join('x')}${s.dpr ? '@' + s.dpr + 'x' : ''}-t${String(t).padStart(4, '0')}.png`;
            await page.screenshot({ path: f });
            console.log('SHOT  ' + f);
        }
        await ctx.close();
    }

    // ---------- 3. video (30 fps, 0–4.2 s, then 0.4 s hold) + frame strip -----
    if (!process.env.NO_VIDEO) {
        const dir = `${OUT}/frames`;
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { ctx, page } = await open({ size: [1600, 900] });
        const clockAt = { t: 0 };
        const N = 126;
        for (let i = 0; i < N; i++) {
            await seekTo(page, Math.round(i * 1000 / 30), clockAt);
            await page.screenshot({ path: `${dir}/f${String(i).padStart(4, '0')}.png` });
        }
        await ctx.close();
        const mp4 = `${OUT}/pro-celebration-1600x900.mp4`;
        const vaapi = ['-vaapi_device', '/dev/dri/renderD128', '-vf', 'tpad=stop_mode=clone:stop_duration=0.6,format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '18'];
        const x264 = ['-vf', 'tpad=stop_mode=clone:stop_duration=0.6,format=yuv420p', '-c:v', 'libx264', '-crf', '18'];
        try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', `${dir}/f%04d.png`, ...vaapi, mp4]); }
        catch { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', `${dir}/f%04d.png`, ...x264, mp4]); }
        console.log('VIDEO ' + mp4);
        const pick = [3, 9, 15, 24, 34, 45, 51, 60, 69, 80, 95, 120].map(i => `${dir}/f${String(i).padStart(4, '0')}.png`);
        const strip = `${OUT}/frame-strip.png`;
        execFileSync('montage', [...pick, '-tile', '4x', '-geometry', '800x450+6+6', '-background', '#05070d', strip]);
        console.log('STRIP ' + strip);
    }
} finally {
    if (process.env.CDP) await browser.close().catch(() => {}); // disconnect only
    else await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
