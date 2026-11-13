// Home pins reorder screenshots + live checks (real Chromium). Needs the harness server:
//   npx vite --config harness/home-pins.vite.config.ts      (serves :5327, HP_PORT to change)
//   node harness/home-pins-shots.mjs <outDir>
//     env: BASE, PW_CORE, PW_CHROMIUM_EXE
// Writes rest.png, mid-drag.png, after-drop.png, keyboard-move.png, reduced-mid-drag.png
// and checks: a real mouse drag across a row wrap reorders, neighbours really
// slide (translate) mid-drag, Esc cancels, a click still opens, Alt+Arrow moves
// with focus kept, and reduced motion has no slide transition / lift.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5327/harness/home-pins.html';
const OUT = process.argv[2] ?? '/tmp/home-pins-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    async function open(reducedMotion = 'no-preference') {
        const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1, reducedMotion, colorScheme: 'dark' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(120000);
        page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
        await page.goto(BASE);
        await page.waitForFunction(() => window.__booted === true);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForSelector('.hd-cards [data-pin-key]');
        await page.waitForTimeout(1800); // deck entry animations
        return { ctx, page };
    }
    const pinsSection = page => page.locator('section:has(.hd-cards [data-pin-key])').first();
    const center = async (page, key) => {
        const b = await page.locator(`.hd-cards [data-pin-key="${key}"]`).boundingBox();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const order = page => page.evaluate(() => window.__pins());
    const cols = page => page.evaluate(() => {
        const tops = [...document.querySelectorAll('.hd-cards [data-pin-key]')].map(e => e.offsetTop);
        return tops.filter(t => t === tops[0]).length;
    });

    // ── Normal motion ───────────────────────────────────────────────────────
    {
        const { ctx, page } = await open();
        const start = await order(page);
        const c = await cols(page);
        console.log('order', start.join(' '), '| columns', c);
        check('pins wrap onto more than one row', c < start.length, `${c} cols for ${start.length} pins`);
        await pinsSection(page).screenshot({ path: `${OUT}/rest.png` });

        // Drag the first pin to the slot of the first pin on row 2.
        const from = await center(page, start[0]);
        const to = await center(page, start[c]);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 4, from.y + 3, { steps: 2 });
        check('no drag under the 8px threshold', (await page.locator('[data-dnd="source"]').count()) === 0);
        await page.mouse.move(to.x, to.y, { steps: 14 });
        // Rest a little off the slot's centre (still closest to it) so the
        // shot shows the lume gap peeking out from under the ghost.
        await page.mouse.move(to.x + 46, to.y - 22, { steps: 4 });
        await page.waitForTimeout(400);
        const mid = await page.evaluate(() => [...document.querySelectorAll('.hd-cards [data-pin-key]')].map(e => getComputedStyle(e).translate));
        check('neighbours slide via `translate` mid-drag', mid.some(t => t && t !== 'none' && t !== '0px'), mid.join(' | '));
        check('ghost overlay is lifted', await page.locator('.hd-pinlift > .hd-card').evaluate(e => getComputedStyle(e).transform !== 'none'));
        await page.screenshot({ path: `${OUT}/mid-drag-full.png` });
        await pinsSection(page).screenshot({ path: `${OUT}/mid-drag.png` });
        await page.mouse.up();
        await page.waitForTimeout(500);
        const after = await order(page);
        const expected = [...start.slice(1, c + 1), start[0], ...start.slice(c + 1)];
        check('mouse drop across the row wrap commits the live-preview order', JSON.stringify(after) === JSON.stringify(expected), after.join(' '));
        check('moved card is visible after drop (no entry-animation replay)', await page.locator(`.hd-cards [data-pin-key="${start[0]}"]`).evaluate(e => getComputedStyle(e).opacity === '1'));
        await pinsSection(page).screenshot({ path: `${OUT}/after-drop.png` });

        // Esc cancels.
        const before = await order(page);
        const a = await center(page, before[0]);
        const b = await center(page, before[2]);
        await page.mouse.move(a.x, a.y); await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 10 });
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await page.waitForTimeout(300);
        check('Esc cancels the drag', JSON.stringify(await order(page)) === JSON.stringify(before));

        // A click still opens (harness onOpen is a no-op; prove no reorder + no drag state).
        await page.locator(`.hd-cards [data-pin-key="${before[1]}"]`).click();
        check('plain click does not reorder', JSON.stringify(await order(page)) === JSON.stringify(before));

        // Keyboard: Alt+ArrowDown on the 2nd pin.
        const k = before[1];
        // Reach it from the keyboard (Shift+Tab back from its own unpin button)
        // so the focus ring shows the way it does for a keyboard user.
        await page.mouse.move(5, 5);
        await page.locator(`.hd-cards [data-pin-key="${k}"] .hd-unpin`).focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Alt+ArrowDown');
        await page.waitForTimeout(350);
        const kAfter = await order(page);
        check('Alt+ArrowDown moves one row', kAfter.indexOf(k) === Math.min(before.length - 1, 1 + c), kAfter.join(' '));
        check('focus stays on the moved pin', await page.evaluate(key => document.activeElement?.getAttribute('data-pin-key') === key, k));
        check('focus ring still showing after the move', await page.evaluate(() => document.activeElement?.matches(':focus-visible') === true));
        const said = await page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"]')].map(n => n.textContent).join('|'));
        check('announcement', /Moved .+ to position \d+ of \d+\./.test(said), said.match(/Moved[^|]*/)?.[0] ?? said);
        await pinsSection(page).screenshot({ path: `${OUT}/keyboard-move.png` });
        await ctx.close();
    }

    // ── Reduced motion ──────────────────────────────────────────────────────
    {
        const { ctx, page } = await open('reduce');
        const start = await order(page);
        const from = await center(page, start[0]);
        const to = await center(page, start[2]);
        await page.mouse.move(from.x, from.y); await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 10 });
        await page.waitForTimeout(200);
        const trans = await page.evaluate(() => [...document.querySelectorAll('.hd-cards [data-pin-key]')].map(e => e.style.transition).filter(Boolean));
        check('reduced motion: no slide transition', trans.length === 0, trans.join(' | '));
        check('reduced motion: ghost not scaled', await page.locator('.hd-pinlift > .hd-card').evaluate(e => getComputedStyle(e).transform === 'none'));
        await pinsSection(page).screenshot({ path: `${OUT}/reduced-mid-drag.png` });
        await page.mouse.up();
        await page.waitForTimeout(100);
        check('reduced motion: drop still reorders', (await order(page)).indexOf(start[0]) === 2);
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
