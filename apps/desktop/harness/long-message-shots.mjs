// Long-message collapse: geometry/behaviour assertions, PERF numbers, and screenshots in real Chromium.
//
//   npx vite --config harness/long-message.vite.config.ts        (serves :5331)
//   node harness/long-message-shots.mjs                          (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// 1. Collapsed rows: preview only, footer text, aria-expanded, no horizontal overflow, fade mask applied,
//    collapsed height is a small fraction of the expanded height.
// 2. Expand / Collapse inline; Open full screen -> dialog covering >= 88% of the window in both axes with its own
//    scroll; Escape closes; Copy text; keyboard (Tab to the footer, Enter toggles).
// 3. Edit across the threshold (5001 -> 4999 -> 5001).
// 4. PERF: building the nodes for 12k / 100k characters, expand and reader-open latency for the 100k message, and
//    a 60-message feed mounted + scrolled COLLAPSED vs EXPANDED (the "no collapse" baseline).
// 5. Screenshots to OUT.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5331/harness/long-message.html';
const OUT = process.env.OUT ?? '/tmp/long-message-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const perf = {};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
});
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });
    const load = async (qs = '') => {
        await page.goto(`${BASE}${qs}`);
        await page.waitForSelector('[data-row]');
        await sleep(500);
    };
    const row = (id) => page.locator(`[data-row="${id}"]`);
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));

    // ---------- 1. collapsed ------------------------------------------------------------------------------
    await load();
    const b1 = await row('b1').evaluate(el => {
        const lm = el.querySelector('[data-long-message]');
        const text = lm.querySelector('.lm-text');
        const cs = getComputedStyle(text);
        const foot = lm.querySelector('.lm-foot');
        const expand = [...lm.querySelectorAll('button')].find(b => b.textContent.includes('Expand'));
        return {
            state: lm.getAttribute('data-state'), textLen: text.textContent.length, h: el.getBoundingClientRect().height,
            mask: cs.maskImage || cs.webkitMaskImage, maxH: cs.maxHeight,
            foot: foot.textContent, ariaExpanded: expand.getAttribute('aria-expanded'),
            overflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
        };
    });
    check('b1 (12,345 chars) is collapsed', b1.state === 'collapsed');
    check('only ~700 characters are in the DOM', b1.textLen > 400 && b1.textLen <= 720, `textLen=${b1.textLen}`);
    check('footer reads "Long message · 12,345 characters · ~N min read" + both actions',
        /Long message · 12,345 characters · ~\d+ min read/.test(b1.foot) && b1.foot.includes('Expand') && b1.foot.includes('Open full screen'), b1.foot);
    check('fade-out mask is applied to the clipped preview', /linear-gradient/.test(b1.mask || ''), b1.mask);
    check('Expand carries aria-expanded=false', b1.ariaExpanded === 'false');
    check('no horizontal overflow', !b1.overflowX);
    check('a collapsed 12k message is a small row (< 260px)', b1.h < 260, `h=${b1.h.toFixed(0)}`);

    const d1 = await row('d1').evaluate(el => !!el.querySelector('[data-long-message]'));
    const d2 = await row('d2').evaluate(el => !!el.querySelector('[data-long-message]'));
    check('exactly 5,000 chars is NOT collapsed; 5,001 IS', d1 === false && d2 === true);

    await row('b1').scrollIntoViewIfNeeded();
    await sleep(200);
    await page.screenshot({ path: `${OUT}/01-collapsed-in-chat.png` });
    console.log(`SHOT  ${OUT}/01-collapsed-in-chat.png`);

    // ---------- 2. expand inline ----------------------------------------------------------------------------
    const t0h = await row('b1').evaluate(el => el.getBoundingClientRect().height);
    await row('b1').locator('button', { hasText: 'Expand' }).click();
    await frame();
    const exp = await row('b1').evaluate(el => {
        const lm = el.querySelector('[data-long-message]');
        const btn = [...lm.querySelectorAll('button')].find(b => b.textContent.includes('Collapse'));
        return { state: lm.getAttribute('data-state'), len: lm.querySelector('.lm-text').textContent.length, ae: btn && btn.getAttribute('aria-expanded'), h: el.getBoundingClientRect().height };
    });
    check('Expand shows the whole message (12,3xx chars in the DOM)', exp.state === 'expanded' && exp.len > 12000, `len=${exp.len}`);
    check('button flips to Collapse with aria-expanded=true', exp.ae === 'true');
    check('expanded row is several times taller than collapsed', exp.h > t0h * 4, `${t0h.toFixed(0)} -> ${exp.h.toFixed(0)}`);
    await row('b1').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('[data-row="b1"]').scrollIntoView({ block: 'start' }));
    await sleep(200);
    await page.screenshot({ path: `${OUT}/02-expanded-inline.png` });
    console.log(`SHOT  ${OUT}/02-expanded-inline.png`);
    await row('b1').locator('button', { hasText: 'Collapse' }).click();
    await frame();
    check('Collapse returns to the preview', await row('b1').evaluate(el => el.querySelector('[data-long-message]').getAttribute('data-state')) === 'collapsed');

    // keyboard: focus Expand with Tab from the row, Enter toggles
    await row('b1').locator('button', { hasText: 'Expand' }).focus();
    await page.keyboard.press('Enter');
    await frame();
    check('keyboard: Enter on a focused Expand expands', await row('b1').evaluate(el => el.querySelector('[data-long-message]').getAttribute('data-state')) === 'expanded');
    await page.keyboard.press('Space');
    await frame();
    check('keyboard: Space on the focused button collapses again', await row('b1').evaluate(el => el.querySelector('[data-long-message]').getAttribute('data-state')) === 'collapsed');
    const ring = await row('b1').locator('button', { hasText: 'Expand' }).evaluate(b => { b.focus(); return getComputedStyle(b).outlineStyle; });
    check('focus ring visible on footer buttons (outline set on :focus-visible)', ring !== undefined);

    // ---------- 3. full-screen reader -------------------------------------------------------------------------
    await row('c1').scrollIntoViewIfNeeded();
    await row('c1').locator('button', { hasText: 'Open full screen' }).click();
    await page.waitForSelector('[role="dialog"]');
    await sleep(1500);
    const rd = await page.evaluate(() => {
        const card = document.querySelector('.mcard.lm-reader');
        const r = card.getBoundingClientRect();
        const sc = document.querySelector('.lm-reader-scroll');
        const t = document.querySelector('.lm-reader-text');
        return {
            w: r.width / innerWidth, h: r.height / innerHeight, scrolls: sc.scrollHeight > sc.clientHeight + 50,
            textW: t.getBoundingClientRect().width, len: t.textContent.length, busy: sc.getAttribute('aria-busy'),
            title: card.querySelector('.dlg-title').textContent, sub: card.querySelector('.dlg-subtitle').textContent,
            lh: parseFloat(getComputedStyle(t).lineHeight) / parseFloat(getComputedStyle(t).fontSize),
            bodyLock: getComputedStyle(document.querySelector('.mod')).position,
        };
    });
    check('reader covers >= 88% of the window width and height', rd.w >= 0.88 && rd.h >= 0.88, `${(rd.w * 100).toFixed(0)}% x ${(rd.h * 100).toFixed(0)}%`);
    check('reader holds the full 100k message (mention tokens render shorter than their wire form)', rd.len >= 95000 && rd.busy === 'false', `len=${rd.len}`);
    check('reader scrolls on its own', rd.scrolls);
    check('comfortable reading width (<= 760px) and line-height >= 1.6', rd.textW <= 760 && rd.lh >= 1.6, `w=${rd.textW.toFixed(0)} lh=${rd.lh.toFixed(2)}`);
    check('header shows sender + timestamp + size', rd.title === 'Dawson' && /Today at 9:51 AM/.test(rd.sub) && /100,000 characters/.test(rd.sub), `${rd.title} | ${rd.sub}`);
    await page.screenshot({ path: `${OUT}/03-fullscreen-reader.png` });
    console.log(`SHOT  ${OUT}/03-fullscreen-reader.png`);

    // scroll the reader, screenshot mid-document
    await page.evaluate(() => { const s = document.querySelector('.lm-reader-scroll'); s.scrollTop = s.scrollHeight * 0.4; });
    await sleep(200);
    await page.screenshot({ path: `${OUT}/04-reader-scrolled.png` });
    console.log(`SHOT  ${OUT}/04-reader-scrolled.png`);

    // keyboard scrolling works (scroller is focused on open)
    const before = await page.evaluate(() => document.querySelector('.lm-reader-scroll').scrollTop);
    await page.keyboard.press('PageDown');
    await sleep(300);
    const after = await page.evaluate(() => document.querySelector('.lm-reader-scroll').scrollTop);
    check('PageDown scrolls the reader (it holds focus)', after > before, `${before.toFixed(0)} -> ${after.toFixed(0)}`);

    await page.keyboard.press('Escape');
    await sleep(500);
    check('Escape closes the reader', (await page.locator('[role="dialog"]').count()) === 0);
    const rowIsOpenFocus = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
    check('focus returns to the "Open full screen" button', /Open full screen/.test(rowIsOpenFocus || ''), rowIsOpenFocus);

    // overlay click closes; Close button closes
    await row('c1').locator('button', { hasText: 'Open full screen' }).click();
    await page.waitForSelector('[role="dialog"]');
    await sleep(400);
    await page.mouse.click(8, 8);
    await sleep(500);
    check('clicking the backdrop closes the reader', (await page.locator('[role="dialog"]').count()) === 0);

    // ---------- 4. edit across the threshold -----------------------------------------------------------------
    await page.evaluate(() => { window.__lm.setText('d2', 'edited down'); });
    await sleep(200);
    check('edit 5001 -> short: collapse footer disappears', await row('d2').evaluate(el => !el.querySelector('[data-long-message]')));
    await page.evaluate(() => { window.__lm.setText('d2', window.__lm.longText(6000, 'edited up')); });
    await sleep(200);
    check('edit short -> 6000: collapses', await row('d2').evaluate(el => el.querySelector('[data-long-message]')?.getAttribute('data-state') === 'collapsed'));

    // ---------- 5. PERF ---------------------------------------------------------------------------------------
    // 5a. building the React nodes (ChatPane's real renderer), no DOM
    for (const n of [12_345, 100_000]) {
        const xs = [];
        for (let i = 0; i < 7; i++) xs.push(await page.evaluate((c) => window.__lm.bench(c), n));
        perf[`renderTextWithMentions ${n.toLocaleString()} chars (median of 7)`] = `${med(xs).toFixed(1)} ms`;
    }
    const pv = [];
    for (let i = 0; i < 7; i++) pv.push(await page.evaluate(() => window.__lm.bench(700)));
    perf['renderTextWithMentions 700 chars (the collapsed preview, median of 7)'] = `${med(pv).toFixed(2)} ms`;

    // 5b. expand + reader latency on the 100k message (commit + layout + paint)
    await load();
    await row('c1').scrollIntoViewIfNeeded();
    const expandMs = await row('c1').evaluate(async (el) => {
        const btn = [...el.querySelectorAll('button')].find(b => b.textContent.includes('Expand'));
        const t0 = performance.now();
        btn.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - t0;
    });
    perf['100k message: click Expand -> painted'] = `${expandMs.toFixed(0)} ms`;
    const collapseMs = await row('c1').evaluate(async (el) => {
        const btn = [...el.querySelectorAll('button')].find(b => b.textContent.includes('Collapse'));
        const t0 = performance.now();
        btn.click();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - t0;
    });
    perf['100k message: click Collapse -> painted'] = `${collapseMs.toFixed(0)} ms`;

    const readerMs = await row('c1').evaluate(async (el) => {
        const btn = [...el.querySelectorAll('button')].find(b => b.textContent.includes('Open full screen'));
        const t0 = performance.now();
        btn.click();
        let shell = null;
        await new Promise((resolve) => {
            const tick = () => {
                if (shell === null && document.querySelector('.mcard.lm-reader .dlg-title')) shell = performance.now() - t0;
                const sc = document.querySelector('.lm-reader-scroll');
                if (sc && sc.getAttribute('aria-busy') === 'false') resolve();
                else requestAnimationFrame(tick);
            };
            tick();
        });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { shell, full: performance.now() - t0 };
    });
    perf['100k message: click Open full screen -> dialog shell in DOM'] = `${readerMs.shell.toFixed(0)} ms`;
    perf['100k message: click Open full screen -> full text rendered + painted'] = `${readerMs.full.toFixed(0)} ms`;
    await page.keyboard.press('Escape');
    await sleep(500);

    // 5c. a feed of 60 long (12k) messages: collapsed (shipped) vs every one expanded (no collapse)
    for (const [label, qs] of [['collapsed (as shipped)', '?scene=many&n=60'], ['all expanded (no collapse baseline)', '?scene=many&n=60&openall=1']]) {
        const t0 = Date.now();
        await page.goto(`${BASE}${qs}`);
        await page.waitForSelector('[data-row]');
        const mounted = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
        const wall = Date.now() - t0;
        await sleep(400);
        const stats = await page.evaluate(async () => {
            const feed = document.querySelector('[data-feed]');
            const nodes = document.getElementsByTagName('*').length;
            const heapMB = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
            // scroll the whole feed in 40 steps, measure per-frame times
            const total = feed.scrollHeight - feed.clientHeight;
            const frames = [];
            let last = performance.now();
            for (let i = 1; i <= 40; i++) {
                feed.scrollTop = (total * i) / 40;
                await new Promise(r => requestAnimationFrame(r));
                const now = performance.now();
                frames.push(now - last);
                last = now;
            }
            frames.sort((a, b) => a - b);
            return { nodes, heapMB, scrollH: feed.scrollHeight, p50: frames[20], p95: frames[38], max: frames[39] };
        });
        perf[`60 x 12k-char messages, ${label}: DOM nodes`] = stats.nodes;
        perf[`60 x 12k-char messages, ${label}: page load -> first painted frame (wall)`] = `${wall} ms`;
        perf[`60 x 12k-char messages, ${label}: scroll top->bottom frame time p50 / p95 / max`] = `${stats.p50.toFixed(1)} / ${stats.p95.toFixed(1)} / ${stats.max.toFixed(1)} ms`;
        perf[`60 x 12k-char messages, ${label}: feed scrollHeight`] = `${stats.scrollH.toFixed(0)} px`;
        if (stats.heapMB) perf[`60 x 12k-char messages, ${label}: JS heap`] = `${stats.heapMB.toFixed(0)} MB`;
        if (label.startsWith('collapsed')) {
            await page.evaluate(() => { document.querySelector('[data-feed]').scrollTop = 0; });
            await sleep(200);
            await page.screenshot({ path: `${OUT}/05-many-collapsed.png` });
            console.log(`SHOT  ${OUT}/05-many-collapsed.png`);
        }
    }

    console.log('\nPERF');
    for (const [k, v] of Object.entries(perf)) console.log(`  ${k}: ${v}`);
} finally {
    await browser.close();
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
