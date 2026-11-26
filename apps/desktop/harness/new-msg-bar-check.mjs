// "When someone joins or someone sends a message in a chat you're scrolled up in,
// it jumps you down to the bottom" (owner, 2026-11-26). Drives the REAL ChatPane
// (harness/new-msg-bar-main.tsx) and checks, FRAME BY FRAME, that a scrolled-up
// reader's row does not move when the feed changes, that the top "new messages"
// bar appears with the right count, and that the follow-the-bottom cases still
// follow.
//
//   NMB_PORT=5452 npx vite --config harness/new-msg-bar.vite.config.ts        (another shell)
//   node harness/new-msg-bar-check.mjs --out=<dir> [--sizes=min,laptop,large,hidpi] [--only=<case,...>] [--shots=1]
//
// Sizes: min = 1000x720 with both side panels (electron/main.ts minimum; the chat
// column is ~400 px), laptop = 1366x768, large = 1920x1080, hidpi = 1280x800 @1.5.
//
// Hold cases (reader scrolled up, reading row R = m48 placed 35% down the feed):
// from just before the change until 1.5 s after it, every animation frame samples
// R's top relative to the feed. PASS = no frame differs from the first by more
// than 0.5 px, plus the case's bar expectation.
// Follow cases: PASS = the feed ends at the bottom.
//
// Positive control (first size): a 6 px scroll injected mid-trace MUST be caught.
// --shots=1 also saves the bar in dark + light at every size.
// Exit code 1 if any case fails or the control is missed.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const PORT = process.env.NMB_PORT ?? 5452;
const OUT = arg('out', path.join(process.env.TMPDIR ?? '/tmp', 'new-msg-bar'));
const SIZES = {
    min: { width: 1000, height: 720 },
    laptop: { width: 1366, height: 768 },
    large: { width: 1920, height: 1080 },
    hidpi: { width: 1280, height: 800, scale: 1.5 },
};
const sizes = arg('sizes', 'min,laptop,large').split(',');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const SHOTS = arg('shots', '') === '1';
const READ = 'm48';
const TOL = 0.5;
fs.mkdirSync(OUT, { recursive: true });

// expect: bar = expected bar text prefix (null = no bar); follow = must end at the bottom.
const CASES = [
    { name: 'incoming-1', act: 'incoming(1)', bar: /^1 new message since / },
    { name: 'incoming-3', act: 'incoming(3)', bar: /^3 new messages since / },
    { name: 'member-join', act: 'join()', bar: /^1 new message since / },
    // @above = the nearest row entirely ABOVE the viewport (off-screen), resolved in-page.
    { name: 'edit-above', act: "edit('@above')", bar: null },
    { name: 'edit-below', act: "edit('m52')", bar: null },
    { name: 'reaction-above', act: "react('@above')", bar: null },
    { name: 'image-above', act: "imageAbove('@above')", bar: null, wait: 2500 },
    { name: 'typing', act: 'typing(true)', bar: null },
    { name: 'history-load', act: 'loadEarlier()', bar: null },
    { name: 'own-row-scrolled-up', act: 'ownRow()', follow: true },
    { name: 'incoming-at-bottom', act: 'incoming(1)', atBottom: true, follow: true },
    { name: 'join-at-bottom', act: 'join()', atBottom: true, follow: true },
    { name: 'click-bar', special: 'click-bar' },
    { name: 'click-bar-screenful', special: 'click-bar', n: 80 },
    { name: 'scroll-to-bottom-clears', special: 'scroll-bottom' },
];

async function open(browser, size, { theme = 'dark', banner = false } = {}) {
    const { scale, ...viewport } = SIZES[size];
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale ?? 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const qs = new URLSearchParams({ theme, ...(banner ? { banner: '1' } : {}) });
    await page.goto(`http://127.0.0.1:${PORT}/harness/new-msg-bar.html?${qs}`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForSelector(`#msg-${READ}`, { timeout: 60000 });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
        window.__nmb.loadEarlier = () => {
            const b = Array.from(document.querySelectorAll('button')).find(x => /^Load earlier messages/.test(x.textContent ?? ''));
            b?.click();
        };
    });
    return { page, errors };
}

const feedOf = () => document.querySelector('[data-chat-feed]');

async function placeReader(page) {
    await page.evaluate((id) => {
        const feed = document.querySelector('[data-chat-feed]');
        const row = document.getElementById(`msg-${id}`);
        const fr = feed.getBoundingClientRect();
        feed.scrollTop += row.getBoundingClientRect().top - fr.top - fr.height * 0.35;
    }, READ);
    await page.waitForTimeout(500);
}

async function toBottom(page) {
    await page.evaluate(() => { const f = document.querySelector('[data-chat-feed]'); f.scrollTop = f.scrollHeight; });
    await page.waitForTimeout(400);
}

// What gets PAINTED: a frame's rendering steps run rAF callbacks, then layout,
// then ResizeObserver callbacks, then paint. ChatPane corrects size changes that
// happen outside a React commit (an image decoding) in a ResizeObserver, i.e.
// after rAF and before paint, so a rAF sample alone reports positions that never
// reach the screen. The trace's own observer is created after ChatPane's, so it
// runs after ChatPane's correction in the same frame and overwrites that frame's
// sample with the painted value.
const startTrace = (page) => page.evaluate((id) => {
    const feed = document.querySelector('[data-chat-feed]');
    const s = { frames: [], stop: false };
    window.__trace = s;
    const measure = () => {
        const row = document.getElementById(`msg-${id}`);
        return row ? row.getBoundingClientRect().top - feed.getBoundingClientRect().top : NaN;
    };
    let content = document.getElementById(`msg-${id}`);
    while (content && content.parentElement !== feed) content = content.parentElement;
    s.ro = new ResizeObserver(() => { if (s.frames.length) s.frames[s.frames.length - 1] = measure(); });
    s.ro.observe(content);
    const tick = () => {
        s.frames.push(measure());
        if (!s.stop) requestAnimationFrame(tick);
    };
    tick();
}, READ);
const stopTrace = (page) => page.evaluate(() => { window.__trace.stop = true; window.__trace.ro.disconnect(); return window.__trace.frames; });

const barText = (page) => page.evaluate(() => document.querySelector('[data-new-messages-bar]')?.textContent?.trim() ?? null);
const distBottom = (page) => page.evaluate(() => { const f = document.querySelector('[data-chat-feed]'); return f.scrollHeight - f.scrollTop - f.clientHeight; });

async function runCase(browser, size, c, control) {
    const { page, errors } = await open(browser, size);
    try {
        if (c.special === 'click-bar') {
            // n new messages; click the bar. A few fit on screen (the jump lands
            // on the bottom); a screenful+ lands the FIRST unseen near the top.
            const n = c.n ?? 3;
            await placeReader(page);
            await page.evaluate((n) => window.__nmb.incoming(n), n);
            await page.waitForTimeout(600);
            const before = await barText(page);
            await page.click('[data-new-messages-bar]');
            await page.waitForTimeout(1200);
            const r = await page.evaluate(() => {
                const feed = document.querySelector('[data-chat-feed]');
                const row = document.getElementById('msg-n1');
                const fr = feed.getBoundingClientRect(), rr = row.getBoundingClientRect();
                return {
                    inView: rr.top >= fr.top - 1 && rr.bottom <= fr.bottom + 1, top: Math.round(rr.top - fr.top),
                    dist: Math.round(feed.scrollHeight - feed.scrollTop - feed.clientHeight),
                };
            });
            const after = await barText(page);
            const where = c.n ? r.top >= 0 && r.top <= 40 : true;
            // The "new messages" state is gone. After a screenful jump the reader is
            // still >1500 px from the bottom, so the bar's quiet "You're viewing older
            // messages — Jump to present" state (the old Jump-to-latest pill) is right.
            const cleared = c.n ? (after === null || /^You.re viewing older messages/.test(after)) : after === null;
            const pass = new RegExp(`^${n} new messages`).test(before ?? '') && r.inView && where && cleared && !errors.length;
            return { name: c.name, pass, detail: `bar before="${before}" first-unseen in view=${r.inView} (top ${r.top}px, ${r.dist}px from bottom) bar after=${after}`, errors };
        }
        if (c.special === 'scroll-bottom') {
            await placeReader(page);
            await page.evaluate(() => window.__nmb.incoming(2));
            await page.waitForTimeout(600);
            const before = await barText(page);
            await toBottom(page);
            const after = await barText(page);
            const pass = /^2 new messages/.test(before ?? '') && after === null && !errors.length;
            return { name: c.name, pass, detail: `bar before="${before}" after reaching bottom=${after}`, errors };
        }
        if (c.atBottom) await toBottom(page); else await placeReader(page);
        await startTrace(page);
        await page.waitForTimeout(120);
        await page.evaluate((act) => {
            const feed = document.querySelector('[data-chat-feed]');
            const top = feed.getBoundingClientRect().top;
            const rows = Array.from(feed.querySelectorAll('[id^="msg-"]')).filter(r => r.getBoundingClientRect().bottom <= top);
            const above = rows.length ? rows[rows.length - 1].id.slice(4) : '';
            window.__lastAbove = above;
            eval(`window.__nmb.${act.replace('@above', above)}`);
        }, c.act);
        if (control) {
            await page.waitForTimeout(300);
            await page.evaluate(() => { document.querySelector('[data-chat-feed]').scrollTop += 6; });
        }
        await page.waitForTimeout(c.wait ?? 1500);
        const frames = await stopTrace(page);
        const bar = await barText(page);
        const dist = await distBottom(page);
        if (c.follow) {
            const pass = dist < 2 && !errors.length;
            return { name: c.name, pass, detail: `distance from bottom after = ${dist.toFixed(1)}px, bar=${bar}`, errors };
        }
        const base = frames[0];
        const drift = Math.max(...frames.map(f => (Number.isFinite(f) ? Math.abs(f - base) : Infinity)));
        const barOk = c.bar === null ? bar === null : c.bar.test(bar ?? '');
        const pass = drift <= TOL && barOk && !errors.length;
        return { name: c.name, pass, detail: `max drift ${drift.toFixed(2)}px over ${frames.length} frames; bar=${JSON.stringify(bar)}`, errors };
    } finally {
        await page.close();
    }
}

async function shots(browser, size) {
    for (const theme of ['dark', 'light']) {
        const { page } = await open(browser, size, { theme, banner: true });
        await placeReader(page);
        await page.evaluate(() => window.__nmb.incoming(3));
        await page.waitForTimeout(700);
        const file = path.join(OUT, `bar-${size}-${theme}.png`);
        await page.screenshot({ path: file });
        // Overlap check: the bar must not cover the header or the pinned strip above the feed.
        const ov = await page.evaluate(() => {
            const bar = document.querySelector('[data-new-messages-bar]')?.getBoundingClientRect();
            const feed = document.querySelector('[data-chat-feed]')?.getBoundingClientRect();
            if (!bar || !feed) return 'no bar';
            const out = bar.top < feed.top - 0.5 || bar.left < feed.left - 0.5 || bar.right > feed.right + 0.5;
            return out ? `bar outside feed: bar ${JSON.stringify(bar)} feed ${JSON.stringify(feed)}` : 'ok';
        });
        console.log(`  shot ${file}  [${ov}]`);
        await page.close();
    }
}

const browser = await chromium.launch({ executablePath: exe, args: ['--disable-gpu'] });
let failed = 0;
try {
    for (const [i, size] of sizes.entries()) {
        console.log(`\n== ${size} ==`);
        if (i === 0) {
            const r = await runCase(browser, size, CASES[0], true);
            const caught = !r.pass;
            console.log(`  ${caught ? 'ok  ' : 'MISS'} positive control (6 px scroll injected mid-trace must fail): ${r.detail}`);
            if (!caught) failed++;
        }
        for (const c of CASES) {
            if (ONLY && !ONLY.includes(c.name)) continue;
            const r = await runCase(browser, size, c, false);
            console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}${r.errors.length ? ` errors=${r.errors.join(' | ')}` : ''}`);
            if (!r.pass) failed++;
        }
        if (SHOTS) await shots(browser, size);
    }
} finally {
    await browser.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
