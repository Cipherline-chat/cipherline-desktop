// Message action-bar placement: geometry assertions + screenshots, in real Chromium.
//
//   npx vite --config harness/msgbar.vite.config.ts        (serves :5291)
//   node harness/msgbar-shots.mjs                          (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Placement under test: the bar is anchored at the row's TOP-RIGHT and centred on
// its top edge -- half inside the row, half poking out above it.
//
// 1. Geometry, for every mock row (single line, continuation, multi-line, long
//    text, image, wide image, reply): bar centre on the row's top edge (+-1px),
//    ~50% of the bar inside the row, bar inside the row's right edge, bar painted
//    ABOVE the previous message (elementFromPoint over its upper half is the bar).
//    NEGATIVE CONTROL: the original above-the-row placement (?old=1) must fail it.
// 2. Clipping: with ChatPane's feed padding (16px) a bar on the list's FIRST row is
//    fully visible; NEGATIVE CONTROL: with 0 padding it is clipped by the scroller.
// 3. Hover handoff: row -> bar's UPPER half (which lies over the previous row) keeps
//    THIS row's bar open and never opens the previous row's; sliding back onto the
//    message keeps it; leaving closes it. Keyboard: Tab into a row, Tab into the bar.
// 4. prefers-reduced-motion: the bar has no animation.
// 5. Screenshots to OUT.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5291/harness/msgbar.html';
const OUT = process.env.OUT ?? '/tmp/msgbar-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000); // dev-box load average is routinely 20-30

    // ---------- 1. geometry -------------------------------------------------
    async function geometry(query) {
        await page.goto(`${BASE}?show=all&${query}`);
        await page.waitForSelector('.msgbar');
        await sleep(400); // let the entrance animation settle
        return page.evaluate(() => [...document.querySelectorAll('[data-row]')].map(row => {
            const r = row.getBoundingClientRect();
            const bar = row.querySelector('.msgbar');
            const b = bar?.getBoundingClientRect();
            const inside = b ? Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top)) / b.height : 0;
            // is the bar's upper half what the user would hit there (i.e. painted above the previous message)?
            let upperHitsBar = false;
            if (b) {
                const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height * 0.2);
                upperHitsBar = !!el?.closest('.msgbar');
            }
            return {
                id: row.dataset.row, rowH: Math.round(r.height * 10) / 10,
                barH: b ? Math.round(b.height * 10) / 10 : null,
                centreOffset: b ? Math.round(((b.top + b.height / 2) - r.top) * 10) / 10 : null,
                insideFrac: Math.round(inside * 100) / 100,
                insideRight: b ? b.right <= r.right + 0.01 : false,
                upperHitsBar,
            };
        }));
    }
    const fresh = await geometry('');
    console.table(fresh);
    const straddles = (g) => g.barH === 24 && Math.abs(g.centreOffset) <= 1 && Math.abs(g.insideFrac - 0.5) <= 0.05 && g.insideRight && g.upperHitsBar;
    for (const g of fresh) {
        check(`bar straddles the row's top edge [${g.id}]`, straddles(g), `centre ${g.centreOffset}px from top, ${Math.round(g.insideFrac * 100)}% inside`);
    }
    const old = await geometry('old=1');
    check('NEGATIVE CONTROL: the original above-the-row placement fails the same check', old.every(g => !straddles(g)), `${old.filter(g => !straddles(g)).length}/${old.length} rows rejected`);

    // ---------- 2. clipping ---------------------------------------------------
    async function firstRowVisible(query) {
        await page.goto(`${BASE}?show=z0&first=cont&${query}`);
        await page.waitForSelector('.msgbar');
        await sleep(400);
        return page.evaluate(() => {
            const feed = document.querySelector('[data-feed]').getBoundingClientRect();
            const b = document.querySelector('.msgbar').getBoundingClientRect();
            return { visible: b.top >= feed.top - 0.01, aboveFeedBy: Math.round((feed.top - b.top) * 10) / 10 };
        });
    }
    const padded = await firstRowVisible('');
    check('first message of the list: bar not clipped with ChatPane\'s 16px top padding', padded.visible, `overhang ${padded.aboveFeedBy}px`);
    const unpadded = await firstRowVisible('pad=0');
    check('NEGATIVE CONTROL: with 0 top padding the same bar IS clipped', !unpadded.visible, `${unpadded.aboveFeedBy}px above the scroller`);

    // ---------- shots -------------------------------------------------------
    async function shot(file, query, rowId, pad = 18) {
        await page.goto(`${BASE}?${query}`);
        await page.waitForSelector('.msgbar');
        await sleep(400);
        const clip = await page.evaluate((id) => {
            const row = document.querySelector(`[data-row="${id}"]`);
            const r = row.getBoundingClientRect();
            const p = row.previousElementSibling?.getBoundingClientRect();
            const n = row.nextElementSibling?.getBoundingClientRect();
            return { top: (p ? p.top : r.top - 20), bottom: (n ? n.bottom : r.bottom + 20) };
        }, rowId);
        await page.screenshot({ path: `${OUT}/${file}`, clip: { x: 0, y: Math.max(0, clip.top - pad), width: 820, height: clip.bottom - clip.top + pad * 2 } });
        console.log('shot', `${OUT}/${file}`);
    }
    for (const [name, row] of [['single-line-continuation', 'a3'], ['multi-line', 'b1'], ['long-text-overlap', 'c1'], ['image', 'd1'], ['image-continuation-wide', 'd2'], ['reply', 'e1']]) {
        await shot(`${name}.after.png`, `show=${row}`, row);
        await shot(`${name}.before.png`, `show=${row}&old=1`, row);
    }
    await page.goto(`${BASE}?show=all`);
    await sleep(400);
    await page.screenshot({ path: `${OUT}/all-rows.after.png`, fullPage: true });
    await page.goto(`${BASE}?show=all&old=1`);
    await sleep(400);
    await page.screenshot({ path: `${OUT}/all-rows.before.png`, fullPage: true });

    // ---------- 3. live hover / flicker / handoff -----------------------------
    await page.goto(BASE);
    await page.waitForSelector('[data-row="a2"]');
    const rect = async (sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
    const bars = () => page.evaluate(() => [...document.querySelectorAll('.msgbar')].map(b => b.closest('[data-row]')?.dataset.row));

    // Handoff, twice: a continuation row (bar's upper half lies OVER the previous
    // row's content) and a header row (it lies over the 12px gap above it).
    for (const [rowId, prevId] of [['a3', 'a2'], ['b1', 'a3']]) {
        const row = await rect(`[data-row="${rowId}"]`);
        const prev = await rect(`[data-row="${prevId}"]`);
        await page.mouse.move(8, row.y + row.h / 2); // park outside any row
        await sleep(400);
        await page.mouse.move(row.x + 120, row.y + row.h / 2);
        await sleep(300);
        check(`[${rowId}] bar opens on hover`, (await bars()).join() === rowId, (await bars()).join());
        const bar = await rect('.msgbar');
        const upperY = bar.y + bar.h * 0.25; // upper half: above the row's top edge
        const overPrev = upperY < row.y && upperY >= prev.y && upperY <= prev.y + prev.h;
        check(`[${rowId}] target point on the bar's upper half is above this row`, upperY < row.y, rowId === 'a3' ? `over ${prevId}'s box: ${overPrev}` : `in the gap above it`);
        if (rowId === 'a3') check(`[${rowId}] that point lies over the previous row's box (the overlap case)`, overPrev);
        // travel row body -> bar upper half in small steps (what a hand does)
        await page.mouse.move(bar.x + bar.w / 2, upperY, { steps: 25 });
        await sleep(700);
        check(`[${rowId}] pointer on the bar's upper half keeps THIS row's bar and opens no other`, (await bars()).join() === rowId, (await bars()).join());
        // slide back off the bar onto the SAME message: must not close it
        await page.mouse.move(row.x + 120, row.y + row.h / 2, { steps: 25 });
        await sleep(700);
        check(`[${rowId}] sliding bar -> same message keeps the bar (no flicker)`, (await bars()).join() === rowId);
        await page.mouse.move(8, row.y + row.h / 2, { steps: 10 });
        await sleep(500);
        check(`[${rowId}] bar closes after leaving the message`, (await bars()).length === 0);
    }
    // walking UP off the row onto the previous message's body shows THAT message's own bar
    {
        const row = await rect('[data-row="a3"]');
        const prev = await rect('[data-row="a2"]');
        await page.mouse.move(row.x + 120, row.y + row.h / 2);
        await sleep(300);
        await page.mouse.move(row.x + 120, prev.y + 3, { steps: 6 }); // left of the bar, over a2's text row
        await sleep(600);
        check('moving up past the bar onto the previous message opens the PREVIOUS message\'s bar', (await bars()).join() === 'a2', (await bars()).join());
    }

    // keyboard: Tab to a row, Tab again into the bar
    await page.goto(BASE);
    await page.waitForSelector('[data-row="a1"]');
    await page.keyboard.press('Tab');
    await sleep(100);
    check('Tab focuses the row and opens the bar', (await bars()).length === 1);
    await page.keyboard.press('Tab');
    await sleep(100);
    check('second Tab lands on a button inside the bar', await page.evaluate(() => !!document.activeElement?.closest('.msgbar')));
    check('bar still open while focus is inside it', (await bars()).length === 1);
    const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle + ' ' + cs.outlineWidth; });
    check('focus-visible ring on the focused bar button', /solid 2px/.test(ring), ring);
    await page.screenshot({ path: `${OUT}/keyboard-focus.after.png`, clip: { x: 0, y: 0, width: 820, height: 150 } });

    // ---------- 4. reduced motion --------------------------------------------
    for (const mode of ['reduce', 'no-preference']) {
        const c2 = await browser.newContext({ viewport: { width: 820, height: 600 }, reducedMotion: mode });
        const p2 = await c2.newPage();
        p2.setDefaultTimeout(120000);
        await p2.goto(`${BASE}?show=a2`);
        await p2.waitForSelector('.msgbar');
        const an = await p2.evaluate(() => getComputedStyle(document.querySelector('.msgbar')).animationName);
        check(`animation under reducedMotion=${mode}`, mode === 'reduce' ? an === 'none' : an === 'msgbar-inline-in', an);
        await c2.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
