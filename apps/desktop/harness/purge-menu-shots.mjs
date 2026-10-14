// PurgeDropdown: computed-style/geometry assertions + 2x screenshots in real Chromium.
//
//   npx vite --config harness/purge-menu.vite.config.ts        (serves :5297)
//   node harness/purge-menu-shots.mjs                          (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Renders the REAL StorageSettings ("Conversation storage" cards) so the dropdown is
// the shipped one. Checks: spec'd metrics (12px radius, 4px padding, 32px rows, 13px
// text, 12px faint counts, flash/red-tinted Everything), flip-above near the viewport
// bottom, no clipping by an overflow:auto ancestor, reduced motion, keyboard focus
// return, and that the count in the menu equals the count in the confirm modal.
// Screenshots (deviceScaleFactor 2): closed, open+hover "1 month", open+hover "Everything".
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5297/harness/purge-menu.html';
const OUT = process.env.OUT ?? '/tmp/purge-menu-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
});
try {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000); // dev-box load average is routinely 20-30
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });

    const open = async (url = BASE) => {
        await page.goto(url);
        await page.waitForSelector('.purge-trigger');
        await sleep(900); // settings-descent card entrance
    };
    const card = () => page.locator('.sd-card', { has: page.locator('h3', { hasText: 'Conversation storage' }) });
    const triggers = () => page.locator('.purge-trigger');
    const rect = (loc) => loc.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; });
    const shot = async (name, extra = []) => {
        const c = await rect(card());
        const rects = [c, ...extra];
        const x = Math.max(0, Math.min(...rects.map(r => r.x)) - 16);
        const y = Math.max(0, Math.min(...rects.map(r => r.y)) - 16);
        const x2 = Math.max(...rects.map(r => r.x + r.w)) + 16;
        const y2 = Math.max(...rects.map(r => r.y + r.h)) + 16;
        await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x, y, width: x2 - x, height: y2 - y } });
        console.log(`SHOT  ${OUT}/${name}.png`);
    };

    // ---------- 1. closed ---------------------------------------------------
    await open();
    await card().scrollIntoViewIfNeeded();
    await sleep(200);
    const t0 = triggers().first();
    const tcs = await t0.evaluate(el => {
        const cs = getComputedStyle(el);
        const svg = el.querySelector('.purge-trigger-label svg');
        return {
            haspopup: el.getAttribute('aria-haspopup'), expanded: el.getAttribute('aria-expanded'),
            textAlign: cs.textAlign, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
            iconW: svg ? svg.getAttribute('width') : null, label: el.textContent,
            justify: cs.justifyContent, chevRight: !!el.querySelector('svg.chev'),
        };
    });
    check('trigger is a menu button (aria-haspopup=menu, collapsed)', tcs.haspopup === 'menu' && tcs.expanded === 'false');
    check('trigger: Trash2 icon 14px at the left, label, chevron at the right', tcs.iconW === '14' && tcs.label.includes('Purge older than…') && tcs.chevRight && tcs.justify === 'space-between', JSON.stringify(tcs));
    check('trigger text is 13px, not a centred bold kit button', tcs.fontSize === '13px' && Number(tcs.fontWeight) <= 600);
    await shot('01-closed');

    // ---------- 2. open + hover 1 month -------------------------------------
    await t0.click();
    await page.waitForSelector('[role="menu"]');
    await sleep(450); // entrance
    const m = page.locator('[role="menu"]');
    check('menu has 5 menuitems', (await page.locator('[role="menuitem"]').count()) === 5);
    const firstFocused = await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'
        && document.activeElement.textContent.startsWith('1 year'));
    check('focus moved to the first item on open', firstFocused);
    const metrics = await m.evaluate(el => {
        const cs = getComputedStyle(el);
        const rows = [...el.querySelectorAll('[role="menuitem"]')];
        const r0 = rows[0], rE = rows[4];
        const acc = r0.querySelector('.ctxm-acc');
        const rcs = getComputedStyle(r0), ecs = getComputedStyle(rE), acs = getComputedStyle(acc);
        return {
            bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, radius: cs.borderTopLeftRadius,
            padding: cs.paddingTop + '/' + cs.paddingLeft, position: cs.position,
            rowH: rows.map(r => r.getBoundingClientRect().height),
            rowFont: rcs.fontSize + '/' + rcs.fontWeight, rowAlign: rcs.textAlign,
            accFont: acs.fontSize, accColor: acs.color, accFamily: acs.fontFamily,
            countText: rows.map(r => r.querySelector('.ctxm-acc')?.textContent),
            evColor: ecs.color, evIcon: !!rE.querySelector('.ci svg'),
            dangerClasses: rows.map(r => r.classList.contains('danger')),
            sep: !!el.querySelector('[role="separator"]'),
            role: el.getAttribute('role'), anim: cs.animationName, opacity: cs.opacity,
        };
    });
    console.log('INFO  ' + JSON.stringify(metrics));
    check('panel: --cl-deep bg (19,26,48), 1px border, radius 12, padding 4', metrics.bg === 'rgb(19, 26, 48)' && metrics.border.startsWith('1px') && metrics.radius === '12px' && metrics.padding === '4px/4px');
    check('rows are ~32px tall, 13px / 600, left-aligned', metrics.rowH.every(h => near(h, 32)) && metrics.rowFont === '13px/600' && metrics.rowAlign !== 'center');
    check('counts: 12px, faint (94,107,143), body font (not mono)', metrics.accFont === '12px' && metrics.accColor === 'rgb(94, 107, 143)' && !/mono/i.test(metrics.accFont + metrics.accFamily));
    check('counts shown on every row', metrics.countText.every(t => /^\d[\d,]* msgs?$/.test(t ?? '')), JSON.stringify(metrics.countText));
    check('only Everything is danger; flash text + Trash2; divider before it', JSON.stringify(metrics.dangerClasses) === '[false,false,false,false,true]' && metrics.evColor === 'rgb(255, 107, 94)' && metrics.evIcon && metrics.sep);
    check('entrance animation runs with motion allowed', metrics.anim === 'purge-menu-in', metrics.anim);

    const mrect = await rect(m);
    const trect = await rect(t0);
    check('opens BELOW the trigger by 4px', near(mrect.y, trect.b + 4, 1.5), `menu.y=${mrect.y} trigger.bottom=${trect.b}`);

    await page.locator('[role="menuitem"]', { hasText: '1 month' }).hover();
    await sleep(350);
    const hov = await page.locator('[role="menuitem"]', { hasText: '1 month' }).evaluate(el => {
        const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color };
    });
    check('hover "1 month": lume tint rgba(37,224,200,.10), text --cl-text', hov.bg === 'rgba(37, 224, 200, 0.1)' && hov.color === 'rgb(244, 247, 255)', JSON.stringify(hov));
    const idle = await page.locator('[role="menuitem"]', { hasText: '1 year' }).evaluate(el => getComputedStyle(el).backgroundColor);
    check('NEGATIVE CONTROL: a non-hovered row has no tint', idle === 'rgba(0, 0, 0, 0)', idle);
    await shot('02-open-hover-1-month', [await rect(m)]);

    // ---------- 3. hover Everything ----------------------------------------
    await page.locator('[role="menuitem"]', { hasText: 'Everything' }).hover();
    await sleep(350);
    const hovE = await page.locator('[role="menuitem"]', { hasText: 'Everything' }).evaluate(el => {
        const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color };
    });
    check('hover "Everything": red tint rgba(255,107,94,.12), flash text', hovE.bg === 'rgba(255, 107, 94, 0.12)' && hovE.color === 'rgb(255, 107, 94)', JSON.stringify(hovE));
    const idleE = await page.locator('[role="menuitem"]', { hasText: 'Everything' }).evaluate(el => null);
    await shot('03-open-hover-everything', [await rect(m)]);

    // ---------- 4. keyboard -------------------------------------------------
    await page.keyboard.press('End');
    check('End -> Everything focused', await page.evaluate(() => document.activeElement?.textContent.startsWith('Everything')));
    await page.keyboard.press('ArrowDown');
    check('ArrowDown wraps to the first row', await page.evaluate(() => document.activeElement?.textContent.startsWith('1 year')));
    await page.keyboard.press('ArrowUp');
    check('ArrowUp wraps to the last row', await page.evaluate(() => document.activeElement?.textContent.startsWith('Everything')));
    await page.keyboard.press('Home');
    check('Home -> first row', await page.evaluate(() => document.activeElement?.textContent.startsWith('1 year')));
    await page.keyboard.press('Escape');
    await sleep(100);
    check('Esc closes the menu and returns focus to the trigger',
        (await page.locator('[role="menu"]').count()) === 0 && await page.evaluate(() => document.activeElement?.classList.contains('purge-trigger')));

    // ---------- 5. select -> confirm modal; count parity --------------------
    await t0.click();
    await page.waitForSelector('[role="menu"]');
    const monthCount = await page.locator('[role="menuitem"]', { hasText: '1 month' }).locator('.ctxm-acc').textContent();
    await page.locator('[role="menuitem"]', { hasText: '1 month' }).click();
    await page.waitForSelector('text=Purge Messages');
    const modalText = await page.locator('.mod.open, .mod').first().innerText();
    const n = monthCount.replace(/\D/g, '');
    check('selecting opens the unchanged confirm modal with the SAME count as the menu',
        modalText.replace(/,/g, '').includes(`delete ${n} message`) || modalText.replace(/,/g, '').includes(`${n}`), `menu=${monthCount} modal=${JSON.stringify(modalText.slice(0, 120))}`);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await sleep(500);

    // ---------- 6. outside click closes ------------------------------------
    await t0.click();
    await page.waitForSelector('[role="menu"]');
    await page.mouse.click(8, 8);
    await sleep(150);
    check('outside click closes the menu', (await page.locator('[role="menu"]').count()) === 0);

    // ---------- 7. flip above near the viewport bottom ---------------------
    // Short viewport so the 2nd card's trigger sits ~100px above the bottom edge.
    await page.setViewportSize({ width: 900, height: 400 });
    await open();
    const last = triggers().nth(1);
    await sleep(200);
    await last.click();
    await page.waitForSelector('[role="menu"]');
    await sleep(450);
    const fm = await rect(page.locator('[role="menu"]'));
    const ft = await rect(last);
    const side = await page.locator('[role="menu"]').getAttribute('data-side');
    check('near the bottom edge the menu flips ABOVE the trigger, fully on screen', side === 'above' && fm.b <= ft.y + 0.5 && fm.y >= 0 && fm.b <= 400, `menu=${fm.y.toFixed(0)}..${fm.b.toFixed(0)} trigger.top=${ft.y.toFixed(0)}`);
    await shot('04-flipped-above', [fm, ft]);
    await page.keyboard.press('Escape');
    await sleep(100);

    // ---------- 7b. neither side fits: height-capped, never covers the trigger ----
    await page.setViewportSize({ width: 900, height: 330 });
    await open();
    const tight = triggers().nth(1);
    await tight.click();
    await page.waitForSelector('[role="menu"]');
    await sleep(450);
    const tm = await rect(page.locator('[role="menu"]'));
    const tt = await rect(tight);
    const tmax = await page.locator('[role="menu"]').evaluate(el => ({ mh: el.style.maxHeight, oy: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight }));
    check('when neither side fits the panel is height-capped (scrolls) and never overlaps the trigger',
        (tm.b <= tt.y + 0.5 || tm.y >= tt.b - 0.5) && tm.y >= 0 && tm.b <= 330 && (tmax.mh !== '' ? tmax.oy === 'auto' && tmax.sh >= tmax.ch : true), `menu=${tm.y.toFixed(0)}..${tm.b.toFixed(0)} trigger=${tt.y.toFixed(0)}..${tt.b.toFixed(0)} ${JSON.stringify(tmax)}`);
    await page.keyboard.press('Escape');
    await sleep(100);

    // ---------- 8. not clipped by an overflow:auto ancestor ----------------
    await page.setViewportSize({ width: 900, height: 1000 });
    await open(BASE + '?scroller=1');
    const sc = page.locator('#scroller');
    const lastInScroller = triggers().nth(2);
    await lastInScroller.scrollIntoViewIfNeeded();
    await sc.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await sleep(200);
    await lastInScroller.click();
    await page.waitForSelector('[role="menu"]');
    await sleep(450);
    const scr = await rect(sc);
    const mr = await rect(page.locator('[role="menu"]'));
    const probe = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="menu"]'), { x: mr.x + mr.w / 2, y: mr.b - 6 });
    const escapes = mr.b > scr.b || mr.y < scr.y;
    check('menu is portaled: its lowest row is hit-testable even where it overflows the scroller', probe, `menu=${mr.y.toFixed(0)}..${mr.b.toFixed(0)} scroller=${scr.y.toFixed(0)}..${scr.b.toFixed(0)} overflowsScroller=${escapes}`);
    check('menu lives outside the scroller in the DOM', await page.evaluate(() => !document.querySelector('#scroller').contains(document.querySelector('[role="menu"]'))));
    await page.keyboard.press('Escape');

    // ---------- 9. reduced motion ------------------------------------------
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open();
    await triggers().first().click();
    await page.waitForSelector('[role="menu"]');
    const rm = await page.locator('[role="menu"]').evaluate(el => { const cs = getComputedStyle(el); return { anim: cs.animationName, opacity: cs.opacity, transform: cs.transform }; });
    check('prefers-reduced-motion: no animation, fully visible immediately, no transform', rm.anim === 'none' && rm.opacity === '1' && rm.transform === 'none', JSON.stringify(rm));
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
