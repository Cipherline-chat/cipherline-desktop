// Composer touches: behaviour checks + frame strips + clips, real Chromium.
//
//   npx vite --config harness/composer-fun.vite.config.ts      (serves :5463)
//   node harness/composer-fun-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Frames: every running animation is paused and seeked to the same time t, so a
// strip shows exact moments of the real CSS animations, not whatever a slow
// screenshot happened to catch. Clips: Playwright's recorder (webm), converted
// to MP4 by the caller.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5463/harness/composer-fun.html';
const OUT = process.env.OUT ?? '/tmp/composer-fun-shots';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
mkdirSync(`${OUT}/frames`, { recursive: true });
mkdirSync(`${OUT}/webm`, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const VIEW = { width: 900, height: 600 };

async function open(query = '', opts = {}) {
    const ctx = await browser.newContext({
        viewport: VIEW,
        deviceScaleFactor: opts.video ? 1 : 2,
        reducedMotion: opts.reducedMotion ?? 'no-preference',
        ...(opts.video ? { recordVideo: { dir: `${OUT}/webm`, size: VIEW } } : {}),
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    return { ctx, page };
}
async function closeClip(ctx, page, name) {
    const v = page.video();
    await ctx.close();
    if (v) { const p = await v.path(); const { renameSync } = await import('node:fs'); renameSync(p, `${OUT}/webm/${name}.webm`); }
}
/** Pause every animation/transition on the page and seek it to t ms. */
const seek = (page, t) => page.evaluate((t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
}, t);
async function strip(page, name, times, clip) {
    for (let i = 0; i < times.length; i++) {
        await seek(page, times[i]);
        await page.screenshot({ path: `${OUT}/frames/${name}-${String(i).padStart(2, '0')}-${times[i]}ms.png`, clip });
    }
}
const typeDraft = async (page, text) => { await page.click('textarea'); await page.keyboard.type(text, { delay: 8 }); };
const dialogText = page => page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? null);

const SCENES = {
    async confirm() {
        // Behaviour: >100 asks, Cancel keeps the draft, Enter and the button both ask.
        const { ctx, page } = await open('?members=1284');
        const msg = '@everyone 1.0.23 is out on staging, please update and report anything odd';
        await typeDraft(page, msg);
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="dialog"]');
        await page.waitForTimeout(450);
        const txt = await dialogText(page);
        check('Enter → dialog with the real count', /Mention everyone\?/.test(txt) && /This will notify 1,284 members\./.test(txt), txt);
        check('focus starts on Cancel', (await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Cancel');
        await page.screenshot({ path: `${OUT}/confirm-dialog.png` });
        await page.click('button:has-text("Cancel")');
        await page.waitForTimeout(450);
        const st = await page.evaluate(() => window.__fun.state());
        check('Cancel → draft intact, nothing sent', st.draft === msg && st.rows === 5 && !st.ask, JSON.stringify(st));
        await page.click('.cl-send-btn');
        await page.waitForSelector('[role="dialog"]');
        check('the send button asks too', true);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(450);
        check('Escape = Cancel', (await page.evaluate(() => window.__fun.state())).draft === msg);
        await ctx.close();

        for (const [q, label] of [['?members=100', '100 members'], ['?members=101&canMention=0', 'no MENTION_EVERYONE']]) {
            const { ctx: c2, page: p2 } = await open(q);
            await typeDraft(p2, '@here quick check');
            await p2.keyboard.press('Enter');
            await p2.waitForTimeout(500);
            check(`${label}: no dialog`, (await dialogText(p2)) === null);
            await c2.close();
        }
        const { ctx: c3, page: p3 } = await open('?members=101');
        await typeDraft(p3, '@here quick check');
        await p3.keyboard.press('Enter');
        await p3.waitForTimeout(500);
        const t3 = await dialogText(p3);
        check('101 members + @here: dialog (online wording)', /online/.test(t3 ?? ''), t3);
        await p3.screenshot({ path: `${OUT}/confirm-dialog-here.png` });
        await c3.close();
    },

    async impact() {
        const { ctx, page } = await open('?members=1284');
        await typeDraft(page, '@everyone 1.0.23 is out on staging, please update and report anything odd');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="dialog"]');
        await page.waitForTimeout(400);
        await page.click('button:has-text("Send to everyone")');
        await page.waitForSelector('.cl-msg-enter-impact');
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const fx = await page.evaluate(() => ({
            rows: document.querySelectorAll('.cl-msg-enter-impact').length,
            rings: document.querySelectorAll('.cl-impact-ring').length,
            bits: document.querySelectorAll('.cl-impact-bit').length,
            nudge: document.querySelector('[data-chat-feed]')?.classList.contains('cl-feed-nudge'),
        }));
        check('impact: one row, rings + debris, the feed nudge armed', fx.rows === 1 && fx.rings === 2 && fx.bits === 6 && fx.nudge, JSON.stringify(fx));
        await strip(page, 'impact', [0, 110, 220, 330, 420, 470, 530, 620, 720, 850, 1050], { x: 0, y: 260, width: 900, height: 290 });
        // Let it finish for real, then check it is spent and does not replay.
        await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
        await page.waitForTimeout(1400);
        // (aria-disabled reads as "not enabled" to Playwright's actionability check; a person can click it.)
        const after = await page.evaluate(() => ({
            cls: document.querySelectorAll('.cl-msg-enter-impact').length,
            fxVisible: [...document.querySelectorAll('[data-impact-fx]')].some(n => getComputedStyle(n).visibility !== 'hidden'),
            landed: window.__landed,
        }));
        check('impact spent after landing (class gone, FX hidden)', after.cls === 0 && !after.fxVisible && after.landed === 1, JSON.stringify(after));
        await page.screenshot({ path: `${OUT}/impact-landed.png` });
        // A plain follow-up send: normal entrance, no impact.
        await typeDraft(page, 'thanks all');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(80);
        check('next own send: normal entrance, no impact', (await page.evaluate(() => document.querySelectorAll('.cl-msg-enter-impact').length)) === 0);
        await ctx.close();

        // Reduced motion: a highlight, no fall.
        const { ctx: c2, page: p2 } = await open('?members=1284', { reducedMotion: 'reduce' });
        await typeDraft(p2, '@everyone reduced-motion check');
        await p2.keyboard.press('Enter');
        await p2.waitForSelector('[role="dialog"]');
        await p2.waitForTimeout(400);
        await p2.click('button:has-text("Send to everyone")');
        await p2.waitForSelector('.cl-msg-enter-impact');
        const rm = await p2.evaluate(() => {
            const row = document.querySelector('.cl-msg-enter-impact');
            const cs = getComputedStyle(row);
            return { name: cs.animationName, fx: getComputedStyle(document.querySelector('.cl-impact-fx')).display };
        });
        check('reduced motion: highlight animation, FX hidden', rm.name === 'cl-msg-in-impact-calm' && rm.fx === 'none', JSON.stringify(rm));
        await seek(p2, 120);
        await p2.screenshot({ path: `${OUT}/impact-reduced-motion.png`, clip: { x: 0, y: 260, width: 900, height: 290 } });
        await c2.close();

        // Clip.
        const { ctx: c3, page: p3 } = await open('?members=1284', { video: true });
        await typeDraft(p3, '@everyone 1.0.23 is out on staging, please update and report anything odd');
        await p3.keyboard.press('Enter');
        await p3.waitForTimeout(1300);
        await p3.click('button:has-text("Send to everyone")');
        await p3.waitForTimeout(2200);
        await closeClip(c3, p3, 'impact');
    },

    async spam() {
        const { ctx, page } = await open();
        const clickN = async (n, gap = 140) => { for (let i = 0; i < n; i++) { await page.click('.cl-send-btn', { force: true }); await page.waitForTimeout(gap); } };
        await clickN(4);
        check('4 clicks: nothing', (await page.$('.cmp-spam-bubble')) === null);
        await clickN(1);
        const b1 = await page.textContent('[data-spam-stage="wobble"]');
        check('5th click in 2 s: wobble + line', b1 === 'Nothing to send.', b1);
        await page.waitForTimeout(160);
        await page.screenshot({ path: `${OUT}/frames/spam-1-wobble.png`, clip: { x: 540, y: 470, width: 360, height: 130 } });
        await clickN(4);
        await page.waitForTimeout(350);
        check('…sulk', (await page.textContent('[data-spam-stage="sulk"]')) === 'Clicking harder won’t help.');
        await page.screenshot({ path: `${OUT}/frames/spam-2-sulk.png`, clip: { x: 540, y: 470, width: 360, height: 130 } });
        await clickN(4);
        await page.waitForTimeout(900);
        const k = await page.textContent('[data-spam-stage="keys"] .cmp-spam-bubble');
        check('…Keys with the empty envelope', k === 'You have to write something first.', k);
        await page.screenshot({ path: `${OUT}/frames/spam-3-keys.png`, clip: { x: 440, y: 400, width: 460, height: 200 } });
        await clickN(6);
        check('cooldown: more clicks do nothing new', (await page.$('[data-spam-stage="wobble"]')) === null);
        await page.waitForTimeout(3600);
        check('reaction clears itself', (await page.$('.cmp-spam-bubble')) === null);
        check('button never submitted / nothing sent', (await page.evaluate(() => window.__fun.state().rows)) === 5);
        await ctx.close();

        const { ctx: c2, page: p2 } = await open('', { video: true });
        await p2.waitForTimeout(400);
        for (let i = 0; i < 13; i++) { await p2.click('.cl-send-btn', { force: true }); await p2.waitForTimeout(170); }
        await p2.waitForTimeout(3600);
        await closeClip(c2, p2, 'spam');
    },

    async micro() {
        const { ctx, page } = await open();
        const composer = { x: 0, y: 470, width: 900, height: 130 };
        // On the hour chime.
        await page.evaluate(() => window.__fun.chime());
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
        await strip(page, 'chime', [0, 150, 300, 500, 750], { x: 660, y: 470, width: 240, height: 130 });
        await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
        await page.waitForTimeout(1200);
        // First of the day ripple.
        await page.evaluate(() => window.__fun.ripple());
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
        await strip(page, 'ripple', [0, 250, 500, 800], composer);
        await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
        await page.waitForTimeout(2600);
        // ↑ shrug on an empty composer.
        await page.click('textarea');
        await page.keyboard.press('ArrowUp');
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
        check('↑ shrug: placeholder line', (await page.getAttribute('textarea', 'placeholder')) === 'nothing of yours to edit yet');
        await strip(page, 'shrug', [0, 120, 240, 360], composer);
        await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
        await page.waitForTimeout(2600);
        // Big paste chip.
        await page.evaluate(() => window.__fun.paste());
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/frames/paste-chip.png`, clip: { x: 0, y: 420, width: 900, height: 180 } });
        await page.waitForTimeout(2600);
        await ctx.close();

        // Counter near / at the real 100,000 cap.
        const { ctx: c2, page: p2 } = await open();
        await p2.evaluate(() => window.__fun.type('x'.repeat(91000)));
        await p2.waitForTimeout(300);
        check('counter appears at 90%', (await p2.textContent('[data-char-counter]')) === '9,000 left');
        await p2.screenshot({ path: `${OUT}/frames/counter-near.png`, clip: { x: 540, y: 470, width: 360, height: 130 } });
        await p2.evaluate(() => window.__fun.type('x'.repeat(100000)));
        await p2.waitForTimeout(700);
        check('counter at the cap', (await p2.textContent('[data-char-counter]')) === 'Limit reached');
        await p2.screenshot({ path: `${OUT}/frames/counter-full.png`, clip: { x: 540, y: 470, width: 360, height: 130 } });
        await c2.close();

        // One clip with all of them.
        const { ctx: c3, page: p3 } = await open('', { video: true });
        await p3.evaluate(() => window.__fun.chime()); await p3.waitForTimeout(1600);
        await p3.evaluate(() => window.__fun.ripple()); await p3.waitForTimeout(2600);
        await p3.click('textarea'); await p3.keyboard.press('ArrowUp'); await p3.waitForTimeout(2600);
        await p3.evaluate(() => window.__fun.paste()); await p3.waitForTimeout(2900);
        await p3.evaluate(() => window.__fun.type('x'.repeat(99990))); await p3.waitForTimeout(700);
        await p3.evaluate(() => window.__fun.type('x'.repeat(100000))); await p3.waitForTimeout(1200);
        await closeClip(c3, p3, 'micro');
    },

    async confirmclip() {
        const { ctx, page } = await open('?members=1284', { video: true });
        await typeDraft(page, '@everyone 1.0.23 is out on staging, please update and report anything odd');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1400);
        await page.click('button:has-text("Cancel")');
        await page.waitForTimeout(900);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1200);
        await page.click('button:has-text("Send to everyone")');
        await page.waitForTimeout(2000);
        await closeClip(ctx, page, 'confirm');
    },
};

for (const [name, fn] of Object.entries(SCENES)) {
    if (ONLY && !ONLY.has(name)) continue;
    console.log(`── ${name}`);
    try { await fn(); } catch (e) { failures++; console.log('FAIL', name, e.message); }
}
await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
