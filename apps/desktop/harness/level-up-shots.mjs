// Level-up celebration: behaviour checks + timeline frames + a video, in real Chromium.
//
//   npx vite --config harness/level-up.vite.config.ts      (serves :5493)
//   node harness/level-up-shots.mjs                        (env: OUT=<dir> BASE=... CDP=http://127.0.0.1:9510 ONLY=frames|checks|video)
//
// Frames are deterministic: Playwright's fake clock drives the timers and every CSS animation
// is seeked by hand (window.__lvu.seek), so "big-1400" is exactly 1.4 s into the sequence.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5493/harness/level-up.html';
const OUT = process.env.OUT ?? '/tmp/level-up-shots';
const ONLY = process.env.ONLY ?? '';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = process.env.CDP
    ? await chromium.connectOverCDP(process.env.CDP)
    : await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

async function open(params, { reduced = false, size = [1280, 800], clock = true, video = null } = {}) {
    const ctx = await browser.newContext({
        viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference',
        ...(video ? { recordVideo: { dir: video, size: { width: size[0], height: size[1] } } } : {}),
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000); // first load runs Vite's dep optimiser
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    if (clock) await page.clock.install();
    await page.goto(`${BASE}?${new URLSearchParams(params)}`);
    return { ctx, page };
}
const ready = async (page) => {
    await page.waitForSelector('.lvu');
    await page.evaluate(() => document.fonts.ready);
};
const seekTo = async (page, ms, at) => {
    if (ms > at.t) { await page.clock.runFor(ms - at.t); at.t = ms; }
    await page.evaluate((t) => window.__lvu.seek(t), ms);
    await page.waitForTimeout(60);
};
const focused = (page) => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
const phase = (page) => page.$eval('.lvu', el => el.dataset.phase);

try {
    if (!ONLY || ONLY === 'frames') {
        // First level-up (big), 1 -> 2, with the achievement toast held underneath.
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '2', from: '1', points: '5', toast: '1' });
            await ready(page);
            const at = { t: 0 };
            for (const ms of [300, 900, 1250, 1500, 1650, 2300, 3400]) {
                await seekTo(page, ms, at);
                await page.screenshot({ path: `${OUT}/big-${String(ms).padStart(4, '0')}.png` });
            }
            await ctx.close();
        }
        // First level-up for a brand-new account: 0 -> 1 (nothing unlocked yet: says what level 2 brings).
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '1', from: '0', points: '1' });
            await ready(page);
            const at = { t: 0 };
            await seekTo(page, 3400, at);
            await page.screenshot({ path: `${OUT}/big-first-level-0to1-settled.png` });
            await ctx.close();
        }
        // A later level-up (short): 2 -> 3 (a showcase slot + Seagrass), its peak and settled frames.
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'short', level: '3', from: '2', points: '9' });
            await ready(page);
            const at = { t: 0 };
            for (const ms of [420, 1700]) {
                await seekTo(page, ms, at);
                await page.screenshot({ path: `${OUT}/short-${String(ms).padStart(4, '0')}.png` });
            }
            await ctx.close();
        }
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'short', level: '7', from: '6', points: '49' });
            await ready(page);
            const at = { t: 0 };
            await seekTo(page, 1700, at);
            await page.screenshot({ path: `${OUT}/short-level7-settled.png` });
            await ctx.close();
        }
        // Reduced motion: the still card.
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '2', from: '1', points: '5', motion: 'still', toast: '1' }, { reduced: true });
            await ready(page);
            await page.clock.runFor(400);
            await page.waitForTimeout(80);
            await page.screenshot({ path: `${OUT}/reduced-motion-card.png` });
            const anims = await page.evaluate(() => document.querySelector('.lvu').getAnimations({ subtree: true }).map(a => a.animationName).filter(n => n !== 'lvu-fade'));
            check('reduced motion: nothing moves (only the 160 ms fade-in)', anims.length === 0, anims.join(','));
            const blur = await page.$eval('.lvu-veil', el => getComputedStyle(el).backdropFilter);
            check('reduced motion: the app behind is still blurred', /blur/.test(blur), blur);
            await ctx.close();
        }
    }

    if (!ONLY || ONLY === 'checks') {
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '2', from: '1', toast: '1' });
            await ready(page);
            const a = await page.$eval('.lvu', el => ({ role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), label: document.getElementById(el.getAttribute('aria-labelledby'))?.textContent, z: getComputedStyle(el).zIndex }));
            check('dialog semantics (role=dialog, aria-modal, labelled by the title)', a.role === 'dialog' && a.modal === 'true' && /Level 2/.test(a.label ?? ''), JSON.stringify(a));
            check('sits above toasts (60000 on starter-achievements) and moments (50000)', Number(a.z) > 60000 && Number(a.z) < 99999, a.z);
            check('focus starts on the dialog', (await focused(page)) === 'lvu');
            const props = await page.evaluate(() => {
                const s = new Set();
                for (const an of document.querySelector('.lvu').getAnimations({ subtree: true })) for (const kf of an.effect.getKeyframes()) for (const k of Object.keys(kf)) s.add(k);
                return [...s].filter(k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
            });
            check('only transform/opacity animate (Keys\'s own rig aside)', props.every(p => p === 'transform' || p === 'opacity' || p === 'd' || p === 'rotate' || p === 'translate'), props.join(','));
            await page.mouse.click(640, 120);
            await page.waitForTimeout(50);
            check('click during the intro fast-forwards to rest', (await phase(page)) === 'rest');
            check('…and focuses Continue', (await focused(page)) === 'lvu-cta');
            await page.keyboard.press('Tab');
            check('Tab stays trapped on Continue', (await focused(page)) === 'lvu-cta');
            await page.keyboard.press('Shift+Tab');
            check('Shift+Tab stays trapped too', (await focused(page)) === 'lvu-cta');
            await page.keyboard.press('Escape');
            await page.clock.runFor(400);
            const esc = { closed: await page.evaluate(() => window.__lvu.closed), present: (await page.$('.lvu')) !== null };
            check('Esc closes', esc.closed === 1 && !esc.present, JSON.stringify(esc));
            await ctx.close();
        }
        // Keys glides up and stops: never above his resting spot, and nothing loops on him at rest.
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '2', from: '1' });
            await ready(page);
            const at = { t: 0 };
            const tops = [];
            for (let ms = 0; ms <= 3400; ms += 50) {
                await seekTo(page, ms, at);
                tops.push([ms, await page.$eval('.lvu-keys', el => el.getBoundingClientRect().top)]);
            }
            const final = tops[tops.length - 1][1];
            const above = tops.filter(([, y]) => y < final - 0.5);
            check('Keys never rises above his final spot', above.length === 0, above.length ? JSON.stringify(above.slice(0, 5)) : `final top ${final.toFixed(1)}px`);
            let monotonic = true;
            for (let i = 1; i < tops.length; i++) if (tops[i][1] > tops[i - 1][1] + 0.5) monotonic = false;
            check('Keys only ever moves up (no bounce)', monotonic);
            const loops = await page.evaluate(() => document.querySelector('.lvu-keys').getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations === Infinity).map(a => a.animationName));
            check('nothing loops on Keys at rest (no wave, bob or idle wiggle)', loops.length === 0, loops.join(','));
            await ctx.close();
        }
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '2', from: '1' });
            await ready(page);
            await page.clock.runFor(3400);
            check('big intro ends on its own at ~3.3 s', (await phase(page)) === 'rest');
            check('Continue takes focus at rest', (await focused(page)) === 'lvu-cta');
            await page.mouse.click(1100, 700);
            await page.clock.runFor(400);
            check('a click anywhere at rest closes', (await page.evaluate(() => window.__lvu.closed)) === 1);
            await ctx.close();
        }
        {
            const { ctx, page } = await open({ scene: 'card', variant: 'short', level: '3', from: '2' });
            await ready(page);
            await page.clock.runFor(1700);
            check('short intro at rest by 1.7 s', (await phase(page)) === 'rest');
            await page.keyboard.press('Enter');
            await page.clock.runFor(400);
            check('Enter on Continue closes', (await page.evaluate(() => window.__lvu.closed)) === 1);
            await ctx.close();
        }
        // The real host, driven like the app: baseline silently, then a local unlock levels up.
        {
            const { ctx, page } = await open({ scene: 'flow' }, { clock: true });
            await page.waitForFunction(() => typeof window.__unlock === 'function');
            await page.clock.runFor(500);
            check('first run: the current level is recorded silently', (await page.$('.lvu')) === null && /"level":1/.test(await page.evaluate(() => window.__record()) ?? ''), await page.evaluate(() => window.__record()));
            await page.evaluate(() => window.__unlock(2, 5, 9));
            await page.clock.runFor(1600);
            check('the achievement toast shows first', await page.getByText('Achievement unlocked').isVisible());
            await page.clock.runFor(2200); // ack at 3.2 s + 400 ms refresh
            check('/auth/me re-read once after the server ack', (await page.evaluate(() => window.__refreshes)) === 1, String(await page.evaluate(() => window.__refreshes)));
            // Quiet rule: no keystroke for 8 s (the harness made none) -> it plays now.
            await page.clock.runFor(1100);
            check('level 2 plays, big (the account was level 1)', (await page.$eval('.lvu', el => el.dataset.variant).catch(() => null)) === 'big');
            check('recorded as it starts', /"level":2,"big":true/.test(await page.evaluate(() => window.__record()) ?? ''));
            await page.clock.runFor(12000); // way past the toast's own 8 s
            check('the toast is held under the celebration', await page.getByText('Achievement unlocked').count() === 1);
            await page.keyboard.press('Escape');
            await page.clock.runFor(1000);
            check('Esc closed the celebration', (await page.$('.lvu')) === null);
            check('…and the toast is still there after it closes', await page.getByText('Achievement unlocked').isVisible());
            await page.clock.runFor(6500); // it had ~6 s left when the celebration took over
            check('…then times out normally', (await page.getByText('Achievement unlocked').count()) === 0);
            await ctx.close();
        }
        // Restart with the record at level 2: the same level never replays, even "armed".
        {
            const { ctx, page } = await open({ scene: 'flow', record: '{"level":2,"big":true}' }, { clock: true });
            await page.waitForFunction(() => typeof window.__unlock === 'function');
            await page.evaluate(() => { window.__server = { level: 2, points: 5, next_level_points: 9, showcase_slots: 3 }; });
            await page.evaluate(() => window.__unlock(2, 6, 9));
            await page.clock.runFor(15000);
            check('restart: level 2 (already celebrated) does not replay', (await page.$('.lvu')) === null);
            await page.evaluate(() => window.__unlock(3, 9, 16));
            await page.clock.runFor(13000);
            check('level 3 then plays the SHORT version', (await page.$eval('.lvu', el => el.dataset.variant).catch(() => null)) === 'short');
            await ctx.close();
        }
    }

    if (!ONLY || ONLY === 'video') {
        // The first level-up as a 30 fps MP4, rendered frame by frame (the same seek as the stills),
        // so it is smooth however loaded this box is: frame N is exactly N/30 s in. 4.2 s of sequence
        // + a 1.2 s hold on the settled frame.
        const dir = `${OUT}/_video`;
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const { ctx, page } = await open({ scene: 'card', variant: 'big', level: '2', from: '1', points: '5', toast: '1' });
        await ready(page);
        const at = { t: 0 };
        const FPS = 30, END = 4200;
        let n = 0;
        for (let ms = 0; ms <= END; ms += 1000 / FPS) {
            await seekTo(page, Math.round(ms), at);
            await page.screenshot({ path: `${dir}/f${String(n++).padStart(4, '0')}.png` });
        }
        await ctx.close();
        try {
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/f%04d.png`,
                '-vf', 'tpad=stop_mode=clone:stop_duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', `${OUT}/first-level-up.mp4`]);
            execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/f%04d.png`,
                '-vf', 'fps=15,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=sierra2_4a', `${OUT}/first-level-up.gif`]);
            console.log(`video: ${OUT}/first-level-up.mp4 (+ .gif), ${n} frames`);
        } catch (e) { console.log('FAIL  ffmpeg ' + e.message); failures++; }
        rmSync(dir, { recursive: true, force: true });
    }
} finally {
    if (!process.env.CDP) await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
