// "Saving a message in a chat with formatted text makes the chat jump" (owner,
// 0.1.2-staging.242, and "for a split second" on .245). Drives the REAL ChatPane
// (harness/save-no-jump-main.tsx: Dashboard's props and its save / pin / push
// sequence) and checks, FRAME BY FRAME, that nothing in the feed moves.
//
//   SNJ_PORT=5417 npx vite --config harness/save-no-jump.vite.config.ts        (another shell)
//   node harness/save-no-jump-check.mjs --out=<dir> [--sizes=min,laptop,large] [--only=<case,...>]
//
// Sizes: min = 1000x720 with both side panels (electron/main.ts minimum; the
// chat column is ~400 px), laptop = 1366x768, large = 1920x1080.
//
// Feed: headings / lists / quotes, syntax-highlighted code blocks, a long
// collapsed message, two styled cards, a link card, an invite card, an
// auto-loaded image link, a reply, reactions. Target: m33 (a styled card), with
// the image (m30), invite (m28), code blocks and cards above it and more below.
//
// Cases (each on a fresh page, after every embed and image has loaded):
//   menu-* / bar-*   right-click menu or hover action bar: Save to server,
//                    Remove from server, Pin, Unpin. The target's top is 35% down
//                    the feed. unsave / unpin start from a saved / pinned state.
//   straddle-menu-save   the round-1 bug: the target's top 15% of the feed height
//                    ABOVE the fold (a plain focus() on the menu's return scrolled it).
//   image-bar-save   the saved message is the image link itself (m30).
//   *-psave / *-punsave   the personal "Save for me" / "Remove from my saves"
//                    (0.1.2-staging.247 round 3). Needs --ret=1mo: with the default
//                    keep-forever policy every row already reads as saved.
//
// Round 3 options: --ret=1mo (finite channel retention: countdowns + Save for me),
// --loadall=1 (load every page first, so the first message and "This is the
// beginning of #general" are in the DOM — the state where a personal save used
// to un-cover the channel and move every row 29 px; the start line must survive),
// --sizes=...,hidpi (1280x800 at 150%). Each case also reports how many message
// rows re-rendered (a counting MemoRow, harness/save-no-jump-memorow.tsx) and how
// many history-gap fills ran.
//   node harness/save-no-jump-check.mjs --ret=1mo --loadall=1 --sizes=min,laptop,large,hidpi
// Per case, from just before the click until 2.2 s after it (the menu's exit,
// the POST, the saves_changed push and its refetch all land inside it), EVERY
// animation frame samples the feed's scrollTop and every row's top and height.
// PASS = no frame differs from the first by more than 0.5 px anywhere, and the
// mark was applied.
//
// Positive control (first size): a 6 px height change injected into a row above
// the target mid-trace MUST be caught. Exit code 1 if any case fails or the
// control is missed.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

// --ret=1mo: a finite channel retention, so rows show countdowns and the personal
// "Save for me" cases have something to save (the default policy keeps everything).
const RET = arg('ret', '');
const BASE = `http://127.0.0.1:${process.env.SNJ_PORT ?? 5417}/harness/save-no-jump.html${RET ? `?ret=${RET}` : ''}`;
const OUT = arg('out', path.join(process.env.TMPDIR ?? '/tmp', 'save-no-jump'));
const SIZES = {
    min: { width: 1000, height: 720 },
    laptop: { width: 1366, height: 768 },
    large: { width: 1920, height: 1080 },
    // 1280x800 at 150% (a HiDPI laptop): fractional device pixels.
    hidpi: { width: 1280, height: 800, scale: 1.5 },
};
const sizes = arg('sizes', 'min,laptop,large').split(',');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const TARGET = 'm33';
// --loadall=1: load every page first ("Load earlier messages" until it is gone),
// so the first message and the "This is the beginning of #general" line are in
// the DOM above the target — the state of a channel the reader scrolled through.
const LOADALL = arg('loadall', '') === '1';
const TOL = 0.5;
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
    { name: 'menu-save', via: 'menu', item: /^Save to server$/, mark: 'saved' },
    { name: 'menu-unsave', via: 'menu', pre: 'save', item: /^Remove from server$/, mark: 'unsaved' },
    { name: 'menu-pin', via: 'menu', item: /^Pin$/, mark: 'pinned' },
    { name: 'menu-unpin', via: 'menu', pre: 'pin', item: /^Unpin$/, mark: 'unpinned' },
    { name: 'bar-save', via: 'bar', label: /^Save to server/, mark: 'saved' },
    { name: 'bar-unsave', via: 'bar', pre: 'save', label: /^Remove from server/, mark: 'unsaved' },
    { name: 'bar-pin', via: 'bar', label: /^Pin —/, mark: 'pinned' },
    { name: 'bar-unpin', via: 'bar', pre: 'pin', label: /^Unpin/, mark: 'unpinned' },
    { name: 'straddle-menu-save', via: 'menu', item: /^Save to server$/, mark: 'saved', frac: -0.15 },
    // The saved message IS the image link (its own row re-renders on save).
    { name: 'image-bar-save', via: 'bar', label: /^Save to server/, mark: 'saved', target: 'm30' },
    // Personal "Save for me" / "Remove from my saves" (retention save + the
    // synced personal channel save, Dashboard's channelRetention).
    { name: 'menu-psave', via: 'menu', item: /^Save for me$/, mark: 'psaved' },
    { name: 'menu-punsave', via: 'menu', pre: 'psave', item: /^Remove from my saves$/, mark: 'punsaved' },
    { name: 'bar-psave', via: 'bar', label: /^Save for me/, mark: 'psaved' },
    { name: 'bar-punsave', via: 'bar', pre: 'psave', label: /^Remove from my saves/, mark: 'punsaved' },
    { name: 'image-bar-psave', via: 'bar', label: /^Save for me/, mark: 'psaved', target: 'm30' },
];

async function openCase(browser, size, c) {
    const { scale, ...viewport } = SIZES[size];
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale ?? 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(`window.__snjStartLine = ${START_LINE.toString()};`);
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForSelector(`#msg-${c.target ?? TARGET}`, { timeout: 60000 });
    // Every embed settled: the image decoded, the invite preview answered.
    await page.waitForFunction(() => {
        const img = document.querySelector('.img-link-wrap img');
        return !!img && img.complete && img.naturalWidth > 0 && !!document.querySelector('[id^="msg-"] button') ;
    }, null, { timeout: 30000 });
    await page.waitForTimeout(900);
    if (LOADALL) {
        // The reader has scrolled up through the whole channel: every row is in
        // the DOM and the feed opens with "This is the beginning of #general".
        for (let i = 0; i < 10; i++) {
            const clicked = await page.evaluate(() => {
                const b = Array.from(document.querySelectorAll('button')).find(x => /^Load earlier messages/.test(x.textContent ?? ''));
                b?.click();
                return !!b;
            });
            if (!clicked) break;
            await page.waitForTimeout(300);
        }
        await page.waitForFunction(() => !!(window).__snjStartLine?.(), null, { timeout: 10000 });
        await page.waitForTimeout(600);
    }
    if (c.pre) {
        await page.evaluate(([fn, id]) => window.__snj[fn](id), [c.pre, c.target ?? TARGET]);
        await page.waitForTimeout(600);
    }
    await page.evaluate(([id, f]) => {
        const row = document.getElementById(`msg-${id}`);
        const feed = row.closest('.overflow-y-auto');
        const fr = feed.getBoundingClientRect();
        feed.scrollTop += row.getBoundingClientRect().top - fr.top - fr.height * f;
    }, [c.target ?? TARGET, c.frac ?? 0.35]);
    await page.waitForTimeout(500);
    return { page, errors };
}

/** True while the feed shows the channel-start line. */
const START_LINE = () => !!Array.from(document.querySelectorAll('div')).find(d => d.children.length === 0 && /^This is the beginning of/.test(d.textContent ?? ''));

/** Per-frame sampling of scrollTop + every row's top and height (relative to the feed). */
const startTrace = (page, id) => page.evaluate((id) => {
    const feed = document.getElementById(`msg-${id}`).closest('.overflow-y-auto');
    const snap = () => {
        const fr = feed.getBoundingClientRect();
        const rows = {};
        for (const r of feed.querySelectorAll('[id^="msg-"]')) { const b = r.getBoundingClientRect(); rows[r.id] = [b.top - fr.top, b.height]; }
        return { st: feed.scrollTop, rows, start: window.__snjStartLine?.() ?? null };
    };
    const t0 = performance.now();
    window.__snjRenders0 = window.__snjRowRenders ?? 0;
    window.__snjTrace = [];
    window.__snjStop = false;
    const rec = () => {
        window.__snjTrace.push({ t: performance.now() - t0, ...snap() });
        if (!window.__snjStop) requestAnimationFrame(rec);
    };
    rec();
}, id);

const stopTrace = (page, id) => page.evaluate((id) => {
    window.__snjStop = true;
    const row = document.getElementById(`msg-${id}`);
    return {
        trace: window.__snjTrace,
        saved: !!row.querySelector('[title="Saved to server"]'),
        pinned: !!row.querySelector('[title="Pinned"]'),
        psaved: window.__snj.psaved(id),
        fills: window.__snjFills ?? 0,
        rowRenders: (window.__snjRowRenders ?? 0) - window.__snjRenders0,
        start: window.__snjStartLine(),
    };
}, id);

function verdict(c, r) {
    const base = r.trace[0];
    let maxSt = 0, maxTop = 0, maxH = 0, moving = 0, worst = '';
    const movedRows = new Set();
    for (const f of r.trace) {
        let moved = false;
        const dSt = Math.abs(f.st - base.st);
        if (dSt > TOL) moved = true;
        maxSt = Math.max(maxSt, dSt);
        for (const [id, [top, h]] of Object.entries(f.rows)) {
            const b = base.rows[id];
            if (!b) { moved = true; worst ||= `${id} appeared at ${f.t.toFixed(0)}ms`; continue; }
            const dT = Math.abs(top - b[0]), dH = Math.abs(h - b[1]);
            if (dT > maxTop) { maxTop = dT; if (dT > TOL) worst = `${id} top ${dT.toFixed(1)}px at ${f.t.toFixed(0)}ms`; }
            if (dH > maxH) { maxH = dH; if (dH > TOL) worst = `${id} height ${dH.toFixed(1)}px at ${f.t.toFixed(0)}ms`; }
            if (dT > TOL || dH > TOL) { moved = true; movedRows.add(id); }
        }
        if (moved) moving++;
    }
    const markOk = c.mark === 'saved' ? r.saved
        : c.mark === 'unsaved' ? !r.saved
        : c.mark === 'pinned' ? r.pinned && r.saved
        : c.mark === 'unpinned' ? !r.pinned && r.saved
        : c.mark === 'psaved' ? r.psaved
        : c.mark === 'punsaved' ? !r.psaved
        : true;
    const fail = [];
    if (moving) fail.push(`${moving}/${r.trace.length} frames moved, ${movedRows.size} rows (worst: ${worst})`);
    if (!markOk) fail.push(`mark not applied (${c.mark})`);
    if (LOADALL && r.start === false) fail.push("the channel-start line is gone (coverage no longer reaches the first message)");
    return { ok: fail.length === 0, fail, frames: r.trace.length, moving, maxSt, maxTop, maxH, fills: r.fills, rowRenders: r.rowRenders };
}

async function runCase(browser, size, c) {
    const { page, errors } = await openCase(browser, size, c);
    const id = c.target ?? TARGET;
    const row = page.locator(`#msg-${id}`);
    const box = await row.boundingBox();
    const feedTop = await page.evaluate((id) => document.getElementById(`msg-${id}`).closest('.overflow-y-auto').getBoundingClientRect().top, id);
    const px = box.x + box.width * 0.6;
    const py = Math.max(box.y, feedTop) + 50;
    await page.mouse.move(px, py);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT, `${size}-${c.name}-1-before.png`) });
    await startTrace(page, id);
    if (c.via === 'menu') {
        await page.mouse.click(px, py, { button: 'right' });
        const item = page.getByRole('menuitem', { name: c.item }).first();
        await item.waitFor({ timeout: 5000 });
        await page.waitForTimeout(200);
        await item.click();
    } else {
        let hit = null;
        for (const b of await row.locator('button[aria-label]').all()) {
            const l = await b.getAttribute('aria-label');
            if (l && c.label.test(l)) { hit = b; break; }
        }
        if (!hit) throw new Error(`${size} ${c.name}: no hover-bar button matching ${c.label}`);
        const bb = await hit.boundingBox();
        if (bb.y < feedTop) throw new Error(`${size} ${c.name}: the hover bar is off screen`);
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    }
    await page.waitForTimeout(2200);
    const r = await stopTrace(page, id);
    await page.screenshot({ path: path.join(OUT, `${size}-${c.name}-2-after.png`) });
    await page.close();
    const v = verdict(c, r);
    if (errors.length) { v.ok = false; v.fail.push(`page errors: ${errors.join(' | ')}`); }
    return v;
}

/** Positive control: a 6 px height change in a row above the target, mid-trace, must be caught. */
async function control(browser, size) {
    const { page } = await openCase(browser, size, {});
    await startTrace(page, TARGET);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
        const r = document.getElementById('msg-m31');
        r.style.paddingBottom = '6px';
        requestAnimationFrame(() => requestAnimationFrame(() => { r.style.paddingBottom = ''; }));
    });
    await page.waitForTimeout(300);
    const r = await stopTrace(page, TARGET);
    await page.close();
    return verdict({ mark: null }, r);
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_EXE ?? exe });
const rows = [];
let failed = 0;
try {
    const ctl = await control(browser, sizes[0]);
    const caught = !ctl.ok;
    console.log(`control  ${sizes[0]}  injected 2-frame 6px height change: ${caught ? `CAUGHT (${ctl.moving} frames, max dH ${ctl.maxH.toFixed(1)}px)` : 'MISSED - the measurement is blind'}`);
    if (!caught) failed++;
    for (const size of sizes) {
        for (const c of CASES.filter(x => !ONLY || ONLY.includes(x.name))) {
            const v = await runCase(browser, size, c);
            rows.push({ size, case: c.name, ...v });
            if (!v.ok) failed++;
            console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${size.padEnd(6)} ${c.name.padEnd(19)} ${v.frames} frames, moved ${v.moving}; max |dTop| ${v.maxTop.toFixed(1)} |dH| ${v.maxH.toFixed(1)} |dScroll| ${v.maxSt.toFixed(1)}; gap fills ${v.fills ?? 0}; row renders ${v.rowRenders ?? '?'}${v.fail.length ? '  ' + v.fail.join('; ') : ''}`);
        }
    }
} finally {
    await browser.close();
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} cases pass; screenshots + results.json in ${OUT}`);
process.exit(failed ? 1 : 0);
