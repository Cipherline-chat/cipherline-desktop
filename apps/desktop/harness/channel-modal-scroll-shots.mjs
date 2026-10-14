// Channel / category settings modal at small window sizes: layout checks + screenshots in real Chromium.
//
//   npx vite --config harness/channel-modal-scroll.vite.config.ts        (serves :5299)
//   node harness/channel-modal-scroll-shots.mjs                          (env: OUT=<dir> CDP=http://127.0.0.1:9510 ONLY=<dlg>)
//
// With CDP set it reuses an already-running headless Chromium (opens and closes ONE tab of its own);
// otherwise it launches one. Never leaves a page open.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5299/harness/channel-modal-scroll.html';
const OUT = process.env.OUT ?? '/tmp/channel-modal-scroll';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const SIZES = (process.env.SIZES ?? "1280x600,900x560").split(",").map(x => x.split("x").map(Number));
// dlg, tab to open, shot-name stem (null = no screenshot), the heading that must be reachable by scrolling
const CASES = [
    { dlg: 'call-edit', tab: 'overview', stem: 'modal-small-calls-overview', reach: 'Call names' },
    { dlg: 'call-edit', tab: 'permissions', stem: 'modal-small-calls-permissions' },
    { dlg: 'text-edit', tab: 'overview', stem: 'modal-small-text-overview', reach: 'Topic' },
    { dlg: 'call-create', tab: 'overview', stem: null, reach: 'Call names' },
    { dlg: 'cat-edit', tab: 'overview', stem: 'modal-small-category-overview' },
    { dlg: 'cat-edit', tab: 'permissions', stem: null },
].filter(c => !process.env.ONLY || c.dlg === process.env.ONLY);

const browser = process.env.CDP
    ? await chromium.connectOverCDP(process.env.CDP)
    : await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
let page;
try {
    const ctx = process.env.CDP ? (browser.contexts()[0] ?? await browser.newContext()) : await browser.newContext();
    page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });

    // Everything the layout assertions need, measured in the page.
    const measure = () => page.evaluate(() => {
        const card = document.querySelector('[role="dialog"]');
        const vh = window.innerHeight;
        const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
        const btns = [...card.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        const byText = (re) => btns.find(b => re.test((b.textContent || '').trim()));
        const save = byText(/^(Save|Create)/i), cancel = byText(/^Cancel$/i), del = byText(/^Delete/i);
        // The scroll body: the largest overflow:auto descendant that actually has extra content, else the largest auto one.
        const scrollers = [...card.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight > 80);
        scrollers.sort((a, b) => b.clientHeight - a.clientHeight);
        const sc = scrollers[0];
        return {
            vh, vw: window.innerWidth, card: r(card),
            save: save && r(save), cancel: cancel && r(cancel), del: del && r(del),
            scroller: sc ? { ...r(sc), sh: sc.scrollHeight, ch: sc.clientHeight, st: sc.scrollTop, oy: getComputedStyle(sc).overflowY, ob: getComputedStyle(sc).overscrollBehaviorY } : null,
            cardOverflow: getComputedStyle(card).overflowY,
        };
    });
    const scrollBodyTo = (where) => page.evaluate((where) => {
        const card = document.querySelector('[role="dialog"]');
        const sc = [...card.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight > 80)
            .sort((a, b) => b.clientHeight - a.clientHeight)[0];
        if (sc) sc.scrollTop = where === 'end' ? sc.scrollHeight : 0;
    }, where);

    for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        for (const c of CASES) {
            const tag = `${c.dlg}/${c.tab} @${w}x${h}`;
            await page.goto(`${BASE}?dlg=${c.dlg}`);
            await page.waitForSelector('[role="dialog"]');
            await sleep(900); // spring-in
            if (c.tab === 'permissions') {
                await page.locator('[role="dialog"] [role="tab"], [role="dialog"] button').filter({ hasText: /^\s*Permissions/ }).first().click();
                await sleep(700);
            }
            await scrollBodyTo('start');
            const m = await measure();
            const inView = (b) => b && b.top >= 0 && b.bottom <= m.vh && b.left >= 0 && b.right <= m.vw;
            check(`${tag}: card fits the viewport`, m.card.top >= 0 && m.card.bottom <= m.vh, `card ${m.card.top.toFixed(0)}..${m.card.bottom.toFixed(0)} of ${m.vh}`);
            check(`${tag}: Save/Create visible`, inView(m.save), m.save ? `${m.save.top.toFixed(0)}..${m.save.bottom.toFixed(0)}` : 'missing');
            check(`${tag}: Cancel visible`, inView(m.cancel), m.cancel ? `${m.cancel.top.toFixed(0)}..${m.cancel.bottom.toFixed(0)}` : 'missing');
            if (c.dlg.endsWith('edit')) check(`${tag}: Delete visible`, inView(m.del), m.del ? `${m.del.top.toFixed(0)}..${m.del.bottom.toFixed(0)}` : 'missing');
            if (c.tab === 'overview') {
                check(`${tag}: a scroll body exists`, !!m.scroller);
                if (m.scroller) {
                    check(`${tag}: scroll body never extends under the footer`, !m.save || m.scroller.bottom <= m.save.top, `body bottom ${m.scroller.bottom.toFixed(0)} save top ${m.save?.top.toFixed(0)}`);
                    check(`${tag}: overscroll contained`, m.scroller.ob === 'contain', m.scroller.ob);
                }
            }
            if (c.stem) {
                await page.screenshot({ path: `${OUT}/${c.stem}-${w}x${h}-top.png` });
                console.log(`SHOT  ${OUT}/${c.stem}-${w}x${h}-top.png`);
            }
            if (c.tab === 'overview' && m.scroller && m.scroller.sh > m.scroller.ch) {
                // Keyboard: Tab through the body from the top; whatever holds focus must end up inside the visible scroller.
                await scrollBodyTo('start');
                await page.locator('[role="dialog"] input').first().focus();
                let worst = true, steps = 0;
                for (let i = 0; i < 40; i++) {
                    await page.keyboard.press('Tab'); steps++;
                    await sleep(30);
                    const r = await page.evaluate(() => {
                        const a = document.activeElement; const card = document.querySelector('[role="dialog"]');
                        const sc = [...card.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight > 80).sort((x, y) => y.clientHeight - x.clientHeight)[0];
                        if (!a || !sc || !sc.contains(a)) return { inside: false };
                        const b = a.getBoundingClientRect(), s = sc.getBoundingClientRect();
                        return { inside: true, ok: b.top >= s.top - 1 && b.bottom <= s.bottom + 1 };
                    });
                    if (r.inside && !r.ok) { worst = false; break; }
                    if (!r.inside) break; // reached the footer
                }
                const st = (await measure()).scroller.st;
                check(`${tag}: Tab through the body keeps focus on screen (scrolled to ${st.toFixed(0)}px after ${steps} Tabs)`, worst && st > 0);
                await scrollBodyTo('start');
            }
            if (c.dlg === 'call-edit' && c.tab === 'overview') {
                // Popovers inside the scroll body must not be clipped by its overflow.
                const visible = (b, m) => b && b.y >= 0 && b.y + b.height <= m.vh && b.x >= 0 && b.x + b.width <= m.vw;
                for (const [label, atEnd] of [['Category', false], ['Name new calls', true]]) {
                    await scrollBodyTo(atEnd ? 'end' : 'start');
                    await sleep(100);
                    await page.locator(`[role="dialog"] [aria-label="${label}"], [role="dialog"] button:has-text("${label}")`).first().click();
                    await sleep(400);
                    const menu = page.locator('[role="listbox"]').last();
                    const mb = await menu.boundingBox();
                    const mm = await measure();
                    check(`${tag}: "${label}" menu is fully on screen`, visible(mb, mm), mb ? `${mb.y.toFixed(0)}..${(mb.y + mb.height).toFixed(0)} of ${mm.vh}` : 'no menu');
                    if (label === 'Name new calls' && c.stem) { await page.screenshot({ path: `${OUT}/modal-small-select-open-${w}x${h}.png` }); console.log(`SHOT  ${OUT}/modal-small-select-open-${w}x${h}.png`); }
                    await page.keyboard.press('Escape');
                    await sleep(300);
                    check(`${tag}: Escape closed only the menu, dialog still open`, (await page.locator('[role="dialog"]').count()) === 1);
                }
                await scrollBodyTo('start');
                // The inline "+ Role" finder (Private preset) lives in the scroll body.
                await page.locator('[role="dialog"] [role="radio"]', { hasText: 'Private' }).first().click();
                await sleep(300);
                await page.locator('[role="dialog"] button', { hasText: /^\s*Role\s*$/ }).first().click();
                await sleep(300);
                const fb = await page.locator('[role="listbox"][aria-label="Roles"]').boundingBox();
                const fm = await measure();
                check(`${tag}: "+ Role" finder list is on screen above the footer`, !!fb && fb.y >= 0 && fb.y + fb.height <= (fm.save?.top ?? fm.vh), fb ? `${fb.y.toFixed(0)}..${(fb.y + fb.height).toFixed(0)} footer ${fm.save?.top.toFixed(0)}` : 'no list');
                await scrollBodyTo('start');
            }
            if (c.reach) {
                await scrollBodyTo('end');
                await sleep(150);
                const head = page.locator('[role="dialog"]').getByText(new RegExp('^' + c.reach)).first();
                const hb = await head.boundingBox();
                const m2 = await measure();
                check(`${tag}: scrolled to the end, "${c.reach}" is on screen above the footer`,
                    !!hb && hb.y >= 0 && hb.y + hb.height <= (m2.save?.top ?? m2.vh), `heading ${hb ? hb.y.toFixed(0) : 'n/a'} footer ${m2.save?.top.toFixed(0)}`);
                check(`${tag}: footer did not move while the body scrolled`, !!m.save && !!m2.save && Math.abs(m.save.top - m2.save.top) < 1);
                if (c.stem) {
                    await page.screenshot({ path: `${OUT}/${c.stem}-${w}x${h}-bottom.png` });
                    console.log(`SHOT  ${OUT}/${c.stem}-${w}x${h}-bottom.png`);
                }
            }
        }
    }
} finally {
    await page?.close().catch(() => {});
    if (process.env.CDP) await browser.close().catch(() => {}); else await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
