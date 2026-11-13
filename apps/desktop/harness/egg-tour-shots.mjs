// A new user's first days, photographed in journey order on ONE page (so the egg count, the
// Egg hunter tier and the starter achievements build up exactly as they would), plus the
// starter-achievement unlock toast and the achievements sheet. Real Chromium, real components.
//
//   npx vite --config harness/egg-tour.vite.config.ts      (serves :5471)
//   node harness/egg-tour-shots.mjs     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Moments are shot in real time at their settled "hold" frame (hold start + ~300 ms, see
// utils/moments.ts tl()): the punchline is fully up from `read` onward, so a few hundred ms of
// scheduling jitter does not change the frame.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5471/harness/egg-tour.html';
const OUT = process.env.OUT ?? '/tmp/egg-tour-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open(query, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark', ...opts });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Array.isArray(window.__ids) && window.__trackerReady === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` }).then(() => console.log('shot', name));
const toast = (page, text) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);

/** Play a moment and photograph its hold frame. `extra` runs right after the request (e.g. the tracker event). */
async function moment(page, id, holdMs, name, extra) {
    await page.evaluate(() => window.__reset());
    await page.evaluate(i => window.__play(i), id);
    if (extra) await page.evaluate(extra);
    await page.waitForSelector(`[data-moment="${id}"]`, { timeout: 20000 });
    await page.waitForTimeout(holdMs + 300);
    await shot(page, name);
}
/**
 * Freeze every animation on the page at `t` ms after the egg started (CSS animations carry their own
 * delay inside currentTime; a script-driven one, Keys' wave, starts `jsStartMs` in).
 */
const freezeAt = (page, t, jsStartMs = 0) => page.evaluate(([t, js]) => {
    for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = a.animationName !== undefined ? t : Math.max(0, t - js);
    }
}, [t, jsStartMs]);
const thaw = page => page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
const waitGone = (page, id) => page.waitForSelector(`[data-moment="${id}"]`, { state: 'detached', timeout: 30000 });

// ── the journey ─────────────────────────────────────────────────────────────
{
    const { ctx, page } = await open('?scene=play&date=2026-11-12T19:20:00');

    // A plain avatar does not count; customizing the profile (here a banner) → the "New Face" starter.
    await page.evaluate(() => window.__setProfile({ avatar_url: 'img-me' }));
    await page.waitForTimeout(1500);
    check('an avatar alone is not a customization', !(await page.evaluate(() => window.__unlocks.includes('profile-custom'))));
    await page.evaluate(() => window.__setProfile({ banner_url: 'img-banner' }));
    check('starter toast: New Face', await toast(page, 'Achievement unlocked: New Face'));
    await page.waitForTimeout(700);
    await shot(page, '90-starter-unlock');
    await page.waitForTimeout(8500); // let it clear

    // Add friend: typing your own tag (first time always plays).
    await moment(page, 'self-friend', 7400, '01-self-friend');
    await page.keyboard.press('Escape');
    await waitGone(page, 'self-friend');
    await page.waitForTimeout(6000);

    // The first friend request is accepted: the first-friend celebration (Dashboard) + the egg.
    // Deterministic frames, each from a fresh start (the layer lives 3.8 s, so no frame waits on another).
    for (const [tag, t] of [['a', 250], ['b', 700], ['c', 1300], ['d', 2300], ['e', 3450]]) {
        await page.evaluate(() => window.__confetti());
        await page.waitForSelector('[data-testid="first-friend"]');
        await page.waitForTimeout(450); // Keys' wave is a timer at 350 ms
        await freezeAt(page, t, 350);
        await shot(page, `02${tag}-first-friend-${t}ms`);
        await thaw(page);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[data-testid="first-friend"]', { state: 'detached' });
    }
    check('first-friend: Escape ends it', true);
    // …and played through in real time: it is gone on its own after ~3.8 s.
    await page.evaluate(() => window.__confetti());
    await page.waitForTimeout(4100);
    check('first-friend: gone on its own', (await page.$('[data-testid="first-friend"]')) === null);
    await page.waitForTimeout(1500);

    // Ten messages: Message in a Bottle (nine do nothing).
    await page.evaluate(() => { for (let i = 0; i < 9; i++) window.__message(); });
    check('nine messages unlock nothing', !(await page.evaluate(() => window.__unlocks.includes('msgs-10'))));
    await page.evaluate(() => window.__message());
    check('Message in a Bottle unlocked', await toast(page, 'Achievement unlocked: Message in a Bottle'));
    await page.waitForTimeout(8500);
    // Ten minutes in a call: Testing the Waters.
    await page.evaluate(() => window.__call(10.5 * 60_000));
    check('Testing the Waters unlocked', await toast(page, 'Achievement unlocked: Testing the Waters'));
    await page.waitForTimeout(8500);

    // First server they create.
    await moment(page, 'first-server', 6000, '06-first-server');
    await waitGone(page, 'first-server');
    // The third egg (self-friend, first-friend, first-server) earns the Egg hunter tier.
    check('tier toast: Tide Pooler', await toast(page, 'New badge: Tide Pooler'));
    await shot(page, '04-egg-hunter-tide-pooler');
    await page.waitForTimeout(8000);
    // @everyone in the brand-new (empty) server: mostly motion, so a 3-frame strip (echo, tumbleweed, punchline).
    // It stays up (it has an Invite button) until dismissed.
    await page.evaluate(() => window.__reset());
    await page.evaluate(() => window.__play('echo-everyone'));
    await page.waitForSelector('[data-moment="echo-everyone"]');
    for (const [i, t] of [[1, 1600], [2, 3600], [3, 6800]]) {
        await page.waitForTimeout(t - (i === 1 ? 0 : [0, 1600, 3600][i - 1]));
        await shot(page, `_echo-${i}`);
    }
    await page.keyboard.press('Escape');
    await waitGone(page, 'echo-everyone');
    // @mentioning yourself: a PASSIVE moment (clicks go through) on the same scrim.
    await moment(page, 'self-ping', 5900, '08-self-ping-passive');
    await page.mouse.click(700, 300);
    await waitGone(page, 'self-ping');
    check('a click skips a passive moment', true);
    // First note in "Notes to self".
    await moment(page, 'note-to-self', 7400, '09-note-to-self');
    await page.keyboard.press('Escape');
    await waitGone(page, 'note-to-self');
    // Ten quick clicks on the title bar's "Cipherline": a tiny Keys swims a lap.
    for (let i = 0; i < 10; i++) await page.getByTestId('titlebar-wordmark').click({ delay: 10 });
    await page.waitForSelector('[data-testid="titlebar-lap"]');
    // Deterministic frames: pause the lap and seek it (out at 0.6 s / 1.5 s, the way back at 4.4 s).
    for (const [tag, ms] of [['a', 600], ['b', 1500], ['c', 4400]]) {
        await page.evaluate(t => { for (const a of document.getAnimations()) { a.pause(); if (a.animationName === 'tb-lap' || a.animationName === 'tb-lap-rtl') a.currentTime = t; } }, ms);
        await page.screenshot({ path: `${OUT}/_lap-${tag}.png`, clip: { x: 0, y: 0, width: 1280, height: 40 } });
    }
    await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
    console.log('shot _lap-a/b/c (stack them into 17-titlebar-lap.png)');
    await page.waitForSelector('[data-testid="titlebar-lap"]', { state: 'detached', timeout: 15000 });
    await page.waitForTimeout(500);
    // The Konami code anywhere outside a text field (frozen at 0.4 s, 1.6 s and 3.0 s).
    for (const [tag, t] of [['a', 400], ['b', 1600], ['c', 3000]]) {
        await page.evaluate(() => window.__konami());
        await page.waitForSelector('[data-testid="keys-party"]');
        await page.waitForTimeout(150);
        await freezeAt(page, t);
        await shot(page, `10${tag}-konami-keys-party-${t}ms`);
        await thaw(page);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[data-testid="keys-party"]', { state: 'detached' });
    }
    console.log('unlocks', await page.evaluate(() => window.__unlocks.join(',')));
    await ctx.close();
}

// ── reduced motion: the still cards on the same scrim ────────────────────────
{
    const { ctx, page } = await open('?scene=play&date=2026-11-12T19:20:00', { reducedMotion: 'reduce' });
    await moment(page, 'self-friend', 200, '20-reduced-self-friend-still');
    await page.keyboard.press('Escape');
    await waitGone(page, 'self-friend');
    await page.evaluate(() => window.__konami());
    await page.waitForTimeout(300);
    await shot(page, '21-reduced-konami-still');
    await ctx.close();
}

// ── the achievements sheet after a first day ────────────────────────────────
{
    const { ctx, page } = await open('?scene=sheet');
    await page.evaluate(() => { window.__setProfile({ banner_url: 'img-banner' }); for (let i = 0; i < 10; i++) window.__message(); window.__call(10.5 * 60_000); });
    await page.evaluate(() => window.__find('first-friend'));
    await page.waitForFunction(() => (window.__unlocked ?? []).length >= 3, null, { timeout: 15000 });
    await page.waitForTimeout(2500);
    await page.mouse.move(5, 5);
    await shot(page, '91-achievements-list');
    await page.getByTestId('achievements-filter-locked').click();
    await page.waitForTimeout(800);
    await page.getByTestId('achievement-verify-1').hover();
    await page.waitForTimeout(500);
    await shot(page, '92-achievements-locked');
    console.log('sheet unlocked', await page.evaluate(() => window.__unlocked.join(',')));
    await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'all good');
process.exit(failures ? 1 : 0);
