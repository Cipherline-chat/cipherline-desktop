// Home Keys spam-egg driver (harness/keys-egg-main.tsx): does sustained
// spam-clicking with a REAL pointer open the Firewall game?
//
//   npx vite --config harness/keys-egg.vite.config.ts   (serves :5211)
//   node harness/keys-egg-drive.mjs        (env: N=20 MOTION=both|reduce|no-preference PW_CHROMIUM_EXE BASE)
//
// Each attempt aims at a random spot on him and spams at a human cadence (a
// click every ~90-240 ms, an occasional 250-450 ms stutter, a 20-70 ms press,
// +-3 px of hand jitter) for SPAM_MS (6.5 s), then reports whether the game
// opened and the real FirewallOverlay is on screen. Every press records what
// was actually under the pointer (document.elementFromPoint) and whether any
// ancestor is an -webkit-app-region: drag region. THROTTLE=<n> applies a CDP
// CPU throttle (a busy main thread).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5211/harness/keys-egg.html';
const N = Number(process.env.N ?? 20);
const SPAM_MS = Number(process.env.SPAM_MS ?? 6500);
const STUTTER = Number(process.env.STUTTER ?? 0.08);
const THROTTLE = Number(process.env.THROTTLE ?? 1);
const MODES = (process.env.MOTION ?? 'both') === 'both' ? ['no-preference', 'reduce'] : [process.env.MOTION];

let seed = Number(process.env.SEED ?? 1234);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Input is fired through CDP WITHOUT awaiting each event (a hand does not wait
// for the renderer: on a busy main thread clicks queue up and arrive late,
// stamped with when they happened), so the cadence is the person's, not the
// page's. Every press also records, in the page, what was under the pointer
// and the gap between this click and the last one by its input timestamp
// (e.timeStamp) and by when the handler actually ran (performance.now()).
async function attempt(page, cdp) {
    await page.evaluate(() => {
        window.__egg.played = 0; window.__egg.verdicts.length = 0;
        const log = window.__log = [];
        if (!window.__logOn) {
            window.__logOn = true;
            addEventListener('pointerdown', e => {
                const el = document.elementFromPoint(e.clientX, e.clientY);
                let drag = false;
                for (let n = el; n; n = n.parentElement) if (getComputedStyle(n).getPropertyValue('-webkit-app-region') === 'drag') drag = true;
                const where = !el ? 'none' : el.closest('.hk [role="img"]') ? 'rig' : el.closest('.hk') ? 'zone' : String(el.className?.baseVal ?? el.className ?? el.tagName);
                window.__log.push({ type: 'down', ts: e.timeStamp, now: performance.now(), where, drag });
            }, true);
            addEventListener('click', e => {
                window.__log.push({ type: 'click', ts: e.timeStamp, now: performance.now(), onHk: !!e.target.closest?.('.hk') });
            }, true);
        }
    });
    const box = await page.locator('.hk [role="img"]').boundingBox();
    // Where this person aims: anywhere on him (dome or legs), held still while spamming.
    const cx = box.x + box.width * (0.25 + rnd() * 0.5), cy = box.y + box.height * (0.2 + rnd() * 0.6);
    const t0 = Date.now();
    const sent = [], pressedAt = [];
    let next = t0;
    const fire = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }).catch(() => {});
    while (Date.now() - t0 < SPAM_MS) {
        const x = cx + (rnd() - 0.5) * 6, y = cy + (rnd() - 0.5) * 6;
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        pressedAt.push(Date.now());
        sent.push(fire('mouseMoved', x, y), fire('mousePressed', x, y));
        await sleep(20 + rnd() * 50);
        sent.push(fire('mouseReleased', x, y));
        next += rnd() < STUTTER ? 250 + rnd() * 200 : 90 + rnd() * 150;
    }
    await Promise.all(sent);
    await sleep(1500); // the play delay is 750 ms after the 5-second click
    const r = await page.evaluate(() => {
        // The game, if it opened: on screen, and over him?
        const fw = document.querySelector('.fw-root');
        const rect = fw?.getBoundingClientRect();
        const overlay = !fw ? 'none' : `${fw.classList.contains('is-ready') ? 'ready' : 'shown'} ${Math.round(rect.width)}x${Math.round(rect.height)} op=${getComputedStyle(fw).opacity}`;
        window.__egg.close();
        return { played: window.__egg.played, verdicts: [...window.__egg.verdicts], log: window.__log, overlay };
    });
    await sleep(2500); // let him settle before the next streak
    const clicks = r.log.filter(e => e.type === 'click');
    const downs = r.log.filter(e => e.type === 'down');
    let maxIn = 0, maxRun = 0;
    for (let i = 1; i < clicks.length; i++) {
        maxIn = Math.max(maxIn, clicks[i].ts - clicks[i - 1].ts);
        maxRun = Math.max(maxRun, clicks[i].now - clicks[i - 1].now);
    }
    let maxSent = 0;
    for (let i = 1; i < pressedAt.length; i++) maxSent = Math.max(maxSent, pressedAt[i] - pressedAt[i - 1]);
    const missedOn = {};
    for (const d of downs) if (d.where !== 'rig' && d.where !== 'zone') missedOn[d.where] = (missedOn[d.where] ?? 0) + 1;
    return {
        played: r.played, verdicts: r.verdicts, overlay: r.overlay, clicks: clicks.length, offHk: clicks.filter(c => !c.onHk).length,
        missedOn, dragHits: downs.filter(d => d.drag).length,
        maxSentGap: maxSent, maxInputGap: Math.round(maxIn), maxHandledGap: Math.round(maxRun),
    };
}

const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const mode of MODES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: mode });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await ctx.newCDPSession(page);
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.goto(BASE);
    await page.waitForSelector('.hk [role="img"]');
    await sleep(1500);
    let ok = 0;
    const rows = [];
    for (let i = 0; i < N; i++) {
        const r = await attempt(page, cdp);
        if (r.played > 0) ok++;
        rows.push(r);
        console.log(`[${mode}] #${i + 1} played=${r.played} overlay=[${r.overlay}] verdicts=${r.verdicts.join(',') || '-'} clicks=${r.clicks} offHk=${r.offHk} missedOn=${JSON.stringify(r.missedOn)} drag=${r.dragHits} maxSentGap=${r.maxSentGap} maxInputGap=${r.maxInputGap} maxHandledGap=${r.maxHandledGap}`);
    }
    console.log(`== ${mode}: game opened ${ok}/${N}; errors: ${errors.length ? errors.slice(0, 5).join(' | ') : 'none'}`);
    await ctx.close();
}
await browser.close();
