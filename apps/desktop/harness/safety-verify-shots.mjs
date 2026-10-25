// Safety-verify harness shots: the one-time hint in a DM header, the first-verification ceremony as
// deterministic frames, its reduced-motion card, and an end-to-end run through the real commit point.
//
//   npx vite --config harness/safety-verify.vite.config.ts      (serves :5439)
//   node harness/safety-verify-shots.mjs     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Ceremony frames are DETERMINISTIC: the ceremony is played, the window is reported hidden (the host pauses
// its own clock, the same path a minimised window takes), then every animation is paused and seeked with
// document.getAnimations() to each sample time.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5439/harness/safety-verify.html';
const OUT = process.env.OUT ?? '/tmp/safety-verify-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open(query, opts = {}) {
    const ctx = await browser.newContext({
        viewport: opts.viewport ?? { width: 1280, height: 800 },
        deviceScaleFactor: opts.dpr ?? 1,
        reducedMotion: opts.reducedMotion ?? 'no-preference',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(opts.settle ?? 700);
    return { ctx, page };
}
const seek = (page, t) => page.evaluate(ms => {
    for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = String(a.animationName ?? '').startsWith('k2-') ? 0 : ms;
    }
}, t);
const label = (page, text) => page.evaluate(t => {
    let el = document.getElementById('__t');
    if (!el) {
        el = document.createElement('div');
        el.id = '__t';
        el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;font:700 22px/1.2 monospace;color:#fff;background:rgba(0,0,0,.65);padding:4px 10px;border-radius:6px;pointer-events:none';
        document.body.appendChild(el);
    }
    el.textContent = t;
}, text);
const unlabel = page => page.evaluate(() => document.getElementById('__t')?.remove());
async function playFrozen(page, peer) {
    await page.evaluate(() => window.__reset());
    await page.evaluate(p => window.__ceremony(p), peer);
    await page.waitForSelector('[data-moment="safety-verified"]', { timeout: 20000 });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        for (const a of document.getAnimations()) a.pause();
    });
}

// ── 1. the hint, in a DM header ─────────────────────────────────────────────
{
    const { ctx, page } = await open('?scene=hint', { dpr: 2 });
    await page.waitForSelector('[data-testid="safety-verify-hint"]', { timeout: 20000 });
    await page.waitForTimeout(500); // entrance (220 ms) done
    const box = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="safety-verify-hint"]').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    check('hint is fully on screen', box.x >= 0 && box.right <= box.vw && box.bottom <= box.vh, JSON.stringify(box));
    const text = await page.evaluate(() => document.querySelector('[data-testid="safety-verify-hint"]').textContent);
    check('hint copy is the owner’s', text.includes('Make sure it’s really them') && text.includes('Compare safety numbers with Mara once, in person or on a call. If they match, nobody is sitting in the middle.') && text.includes('Compare now') && text.includes('Not now'));
    await page.screenshot({ path: `${OUT}/hint-dm-header.png` });
    await page.screenshot({ path: `${OUT}/hint-closeup.png`, clip: { x: 780, y: 0, width: 500, height: 260 } });
    // keyboard: Tab from the shield lands on "Compare now", then "Not now"; focus was never stolen on appearance.
    const order = await page.evaluate(() => {
        const shield = document.querySelector('[aria-label^="Identity:"]');
        shield.focus();
        return shield.getAttribute('aria-label');
    });
    await page.keyboard.press('Tab');
    const t1 = await page.evaluate(() => document.activeElement?.textContent?.trim());
    await page.keyboard.press('Tab');
    const t2 = await page.evaluate(() => document.activeElement?.textContent?.trim());
    check('keyboard: shield -> Compare now -> Not now', /Identity/.test(order) && t1 === 'Compare now' && t2 === 'Not now', `${t1} / ${t2}`);
    await page.screenshot({ path: `${OUT}/hint-keyboard-focus.png`, clip: { x: 780, y: 0, width: 500, height: 260 } });
    // Escape dismisses, and it is done for good.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => window.__state());
    check('Escape dismisses the hint and records it', st.hint === false && st.hintDone === '1', JSON.stringify({ hint: st.hint, done: st.hintDone }));
    await ctx.close();
}

// ── 2. the ceremony, frame by frame ─────────────────────────────────────────
const FRAMES = [
    ['1-start', 150, 'notice: orbs fade in'],
    ['2-slide', 700, 'blocks slide in'],
    ['3-lock', 1130, 'blocks lock, lock forms'],
    ['4-pulse', 1650, 'pulse sweeps out, line rises'],
    ['5-text', 2300, 'pulse fading, line up'],
    ['6-final', 3300, 'settled frame'],
];
{
    const { ctx, page } = await open('?scene=ceremony');
    await playFrozen(page, 'Mara');
    const dur = await page.evaluate(async () => (await import('/src/utils/moments.ts')).CEREMONIES['safety-verified'].durationMs);
    console.log('ceremony durationMs', dur);
    for (const [name, t, what] of FRAMES) {
        await seek(page, t);
        await page.screenshot({ path: `${OUT}/ceremony-${name}.png` });
        await label(page, `${(t / 1000).toFixed(2)}s  ${what}`);
        await page.screenshot({ path: `${OUT}/ceremony-labelled-${name}.png` });
        await unlabel(page);
    }
    if (existsSync('/usr/bin/ffmpeg')) {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-pattern_type', 'glob', '-i', `${OUT}/ceremony-labelled-*.png`, '-vf', 'scale=640:-1,tile=3x2:padding=6:color=0x05070f', '-frames:v', '1', `${OUT}/ceremony-strip.png`]);
    }
    // The final frame: the line fully opaque and fully inside the viewport.
    await seek(page, 3300);
    const fin = await page.evaluate(() => {
        const el = document.querySelector('[data-moment="safety-verified"] [data-read]');
        const r = el.getBoundingClientRect();
        let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
        return { text: el.textContent, opacity: o, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
    });
    check('final frame: the line is fully visible and on screen', fin.opacity > 0.99 && fin.inside, JSON.stringify(fin));
    check('final frame text', fin.text === 'Verified. Only you and Mara hold the keys.', fin.text);
    // The hold is really still: two samples a moment apart are pixel-identical.
    await seek(page, 3250); const a = await page.screenshot();
    await seek(page, 3500); const b = await page.screenshot();
    check('the settled hold does not travel', Buffer.compare(a, b) === 0);
    // The exit: the very end is (nearly) gone.
    await seek(page, dur - 30);
    const endOpacity = await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-moment="safety-verified"] .mo-view')).opacity));
    check('the exit fades the scene out', endOpacity < 0.1, String(endOpacity));
    await ctx.close();
}

// ── 3. reduced motion: the still card ───────────────────────────────────────
{
    const { ctx, page } = await open('?scene=ceremony', { reducedMotion: 'reduce' });
    await playFrozen(page, 'Mara');
    await seek(page, 1500);
    const info = await page.evaluate(() => {
        const root = document.querySelector('[data-moment="safety-verified"]');
        const still = root.querySelector('.mo-still');
        return {
            reducedClass: root.className.includes('mo-reduced'),
            hasArt: !!root.querySelector('.mo-sv'),
            headline: root.querySelector('.mo-still-headline')?.textContent,
            line: root.querySelector('.mo-still-line')?.textContent,
            opacity: Number(getComputedStyle(still).opacity),
            fadeName: getComputedStyle(still).animationName,
        };
    });
    check('reduced motion: still card, same words, no travelling art, a fade only', info.reducedClass && !info.hasArt && info.headline === 'Verified.' && info.line === 'Only you and Mara hold the keys.' && info.fadeName === 'mo-sv-still' && info.opacity > 0.99, JSON.stringify(info));
    await page.screenshot({ path: `${OUT}/ceremony-reduced-motion-card.png` });
    await seek(page, 5);
    const early = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.mo-still')).opacity));
    check('reduced motion: the card fades IN (opacity starts near 0)', early < 0.3, String(early));
    await ctx.close();
}

// ── 4. end to end: hint -> real markVerified -> hint gone -> ceremony 1.5 s later, once ─────
{
    const { ctx, page } = await open('?scene=flow');
    await page.waitForSelector('[data-testid="safety-verify-hint"]', { timeout: 20000 });
    await page.evaluate(() => window.__verify());
    await page.waitForTimeout(150);
    let st = await page.evaluate(() => window.__state());
    check('verifying: the hint comes down at once and is done for good', st.hint === false && st.hintDone === '1', JSON.stringify({ hint: st.hint, done: st.hintDone }));
    check('verifying: the first-verification flag is written at once', st.played === '1');
    check('verifying: the ceremony waits for the dialog’s own animation (not yet at 0.15 s)', st.moment === null);
    await page.waitForTimeout(900);
    st = await page.evaluate(() => window.__state());
    check('...still waiting at ~1 s', st.moment === null);
    await page.waitForSelector('[data-moment="safety-verified"]', { timeout: 5000 });
    check('...then the ceremony plays', true);
    await page.waitForSelector('[data-moment="safety-verified"]', { state: 'detached', timeout: 10000 });
    check('...and finishes by itself', true);
    // A second verification (another device, or another contact) never plays it again.
    await page.evaluate(() => { window.__verify(); });
    await page.waitForTimeout(2200);
    st = await page.evaluate(() => window.__state());
    check('a second verification does not play it again', st.moment === null);
    await ctx.close();
}

await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
