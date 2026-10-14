// Group "+ add people": geometry assertions + screenshots, in real Chromium at 2x.
//
//   npx vite --config harness/group-add.vite.config.ts        (serves :5293)
//   node harness/group-add-shots.mjs                          (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// 1. Panel: Members heading has a 24x24 + at its right end, vertically centred on the text,
//    the row is exactly as tall as the text-only heading was (no list shift), and the heading
//    text matches the "Shared" heading above it (font, weight, spacing, colour).
// 2. Hover: the + turns from --cl-faint to --cl-text; the "Add people" tooltip appears.
// 3. Keyboard: Tab focus shows a visible ring (box-shadow).
// 4. can=0: no + at all (NEGATIVE CONTROL).
// 5. Modal: titled with the group, members (Mira, Jun) are not offered, a selection can be added
//    through POST .../invite, a success state shows, then it closes by itself.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5293/harness/group-add.html';
const OUT = process.env.OUT ?? '/tmp/group-add-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 760 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    const PLUS = 'button[aria-label="Add people"]';

    // ---- 1. panel -------------------------------------------------------------
    await page.goto(`${BASE}?view=panel`);
    await page.waitForSelector(PLUS);
    await sleep(500);
    const g = await page.evaluate((PLUS) => {
        const plus = document.querySelector(PLUS);
        const block = document.getElementById('members-block');
        const headingRow = plus.parentElement;
        const text = headingRow.querySelector('span');
        const shared = [...document.querySelectorAll('div')].find(d => d.textContent === 'Shared' && d.children.length === 0);
        const r = (el) => el.getBoundingClientRect();
        const cs = (el) => getComputedStyle(el);
        const probe = document.createElement('div');          // the OLD text-only heading, same style
        probe.setAttribute('style', headingRow.getAttribute('style'));
        probe.textContent = 'Members (3)';
        block.insertBefore(probe, block.firstChild);
        const oldH = r(probe).height; probe.remove();
        return {
            plus: r(plus), row: r(headingRow), text: r(text), block: r(block), oldH,
            plusColor: cs(plus).color, faint: cs(text).color,
            fs: [cs(text).fontSize, cs(shared).fontSize], fw: [cs(text).fontWeight, cs(shared).fontWeight],
            ls: [cs(text).letterSpacing, cs(shared).letterSpacing], col: [cs(text).color, cs(shared).color],
            tt: [cs(text).textTransform, cs(shared).textTransform], ff: [cs(text).fontFamily, cs(shared).fontFamily],
            textLeft: r(text).left, sharedLeft: r(shared).left,
        };
    }, PLUS);
    check('+ hit target is 24x24', Math.round(g.plus.width) === 24 && Math.round(g.plus.height) === 24, `${g.plus.width}x${g.plus.height}`);
    // the heading's own style carries 2px horizontal padding, so the + ends 2px inside the row (mirrors the text's 2px left inset)
    check('+ is at the right end of the row (inside its 2px padding)', Math.abs(g.plus.right - (g.row.right - 2)) <= 0.5, `plus.right=${g.plus.right} row.right=${g.row.right}`);
    check('+ is vertically centred on the heading text', Math.abs((g.plus.top + g.plus.height / 2) - (g.text.top + g.text.height / 2)) <= 1);
    check('row height unchanged vs the old text-only heading (no list shift)', Math.abs(g.row.height - g.oldH) <= 0.5, `${g.row.height} vs ${g.oldH}`);
    check('heading text style identical to "Shared"', JSON.stringify(g.fs) === JSON.stringify([g.fs[1], g.fs[1]]) && g.fw[0] === g.fw[1] && g.ls[0] === g.ls[1] && g.col[0] === g.col[1] && g.tt[0] === g.tt[1] && g.ff[0] === g.ff[1], JSON.stringify({ fs: g.fs, fw: g.fw, ls: g.ls }));
    // "Shared" is a bare padded div, so its text starts 2px (padding-left) in from the div's left edge
    check('heading text lines up with "Shared" (same text left edge)', Math.abs(g.textLeft - (g.sharedLeft + 2)) <= 0.5, `${g.textLeft} vs ${g.sharedLeft + 2}`);
    await page.screenshot({ path: `${OUT}/01-members-heading-normal.png`, clip: { x: 0, y: 0, width: 330, height: 280 } });

    // ---- 2. hover -------------------------------------------------------------
    await page.hover(PLUS);
    await sleep(700);                                          // tooltip opens after 400ms
    const hov = await page.evaluate((PLUS) => {
        const plus = document.querySelector(PLUS);
        const tip = [...document.querySelectorAll('body *')].find(e => e.textContent === 'Add people' && e.children.length === 0 && e !== plus);
        return { color: getComputedStyle(plus).color, bg: getComputedStyle(plus).backgroundColor, tip: !!tip };
    }, PLUS);
    check('hover: + colour changes from faint', hov.color !== g.plusColor, `${g.plusColor} -> ${hov.color}`);
    check('hover: "Add people" tooltip shown', hov.tip);
    await page.screenshot({ path: `${OUT}/02-members-heading-hover.png`, clip: { x: 0, y: 0, width: 330, height: 280 } });
    await page.mouse.move(600, 600);

    // ---- 3. keyboard focus ring -----------------------------------------------
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), shadow: getComputedStyle(document.activeElement).boxShadow }));
    check('keyboard: Tab reaches the + and draws a focus ring', focus.label === 'Add people' && focus.shadow !== 'none' && focus.shadow !== '', focus.shadow);
    await page.screenshot({ path: `${OUT}/03-members-heading-focus.png`, clip: { x: 0, y: 0, width: 330, height: 280 } });

    // ---- 4. negative control --------------------------------------------------
    await page.goto(`${BASE}?view=panel&can=0`);
    await page.waitForSelector('#members-block');
    await sleep(300);
    check('NEGATIVE CONTROL: no + when the user may not add', (await page.$(PLUS)) === null);
    await page.screenshot({ path: `${OUT}/04-members-heading-not-permitted.png`, clip: { x: 0, y: 0, width: 330, height: 280 } });

    // ---- 5. modal -------------------------------------------------------------
    await page.goto(`${BASE}?view=panel`);
    await page.waitForSelector(PLUS);
    await page.click(PLUS);
    await page.waitForSelector('[role="dialog"]');
    await sleep(700);
    const title = await page.textContent('[role="dialog"] h2');
    check('modal title', title === 'Add people to Weekend Crew', title);
    const offered = await page.$$eval('[role="dialog"] button', bs => bs.map(b => b.textContent.trim()));
    check('members (Mira, Jun) are not offered', !offered.some(t => /Mira|Jun/.test(t)) && offered.some(t => /Tobias/.test(t)));
    await page.screenshot({ path: `${OUT}/05-modal-open.png` });

    await page.click('[role="dialog"] button:has-text("Tobias")');
    await page.click('[role="dialog"] button:has-text("Sana")');
    await sleep(300);
    await page.screenshot({ path: `${OUT}/06-modal-selected.png` });

    await page.click('[role="dialog"] button:has-text("Add 2 Members")');
    await page.waitForSelector('[role="status"]');
    await sleep(250);
    const posts = await page.evaluate(() => window.__posts);
    check('invite POSTed once per person', posts.length === 2 && posts.every(p => /\/conversations\/conv-1\/invite /.test(p)), JSON.stringify(posts));
    await page.screenshot({ path: `${OUT}/07-modal-success.png` });
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).then(
        () => check('modal closes itself after success', true),
        () => check('modal closes itself after success', false));
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
