// Text size as a SPAN (Small / Normal / Large in one message): behaviour checks + screenshots of the
// REAL components in headless Chromium. Same harness page as the WYSIWYG composer.
//
//   npx vite --config harness/composer-wysiwyg.vite.config.ts      (serves :5347)
//   node harness/composer-span-size-shots.mjs                     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// One browser for the whole run, closed at the end (see CLAUDE.md "Headless Chrome cleanup").
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5347/harness/composer-wysiwyg.html';
const OUT = process.env.OUT ?? '/tmp/composer-span-size-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 620 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });
    const box = '[data-rich-composer]';
    const value = () => page.evaluate(() => window.__cw.value());
    const shot = async (name, clip) => {
        const path = `${OUT}/${name}`;
        if (clip) await page.screenshot({ path, clip }); else await page.screenshot({ path, fullPage: true });
        console.log(`SHOT  ${path}`);
    };
    const pickSize = async (id) => {
        await page.click('[data-size-button]');
        await page.click(`[data-size-id="${id}"]`);
        await sleep(80);
    };

    // ---------- 1. one message, three sizes, in the box ----------
    await page.goto(`${BASE}?scene=composer`);
    await page.waitForSelector(box);
    await page.evaluate(() => document.fonts.ready);
    await page.click(box);
    await page.click('.fmt-toggle');
    const line = 'small print, normal words, BIG WORDS';
    await page.keyboard.type(line);
    await page.evaluate(() => window.__cw.select(0, 11));
    await pickSize('small');
    await page.evaluate(() => window.__cw.select(27, 36));
    await pickSize('large');
    const inBox = await page.$eval(box, el => {
        const smE = el.querySelector('.rc-sm'), lgE = el.querySelector('.rc-lg');
        const cs = (e) => e && getComputedStyle(e);
        const r = (e) => e.getBoundingClientRect();
        return {
            sm: smE?.textContent, lg: lgE?.textContent,
            smPx: cs(smE)?.fontSize, lgPx: cs(lgE)?.fontSize, base: cs(el.querySelector('.rc-b'))?.fontSize,
            va: [cs(smE)?.verticalAlign, cs(lgE)?.verticalAlign],
            sameLine: smE && lgE ? Math.abs(r(smE).bottom - r(lgE).bottom) < r(lgE).height : false,
        };
    });
    check('a selection becomes Small, another Large, in the same message (box preview)', inBox.sm === 'small print' && inBox.lg === 'BIG WORDS', JSON.stringify(inBox));
    check('box sizes: 14.5 x 0.875 = 12.6875px, 14.5 x 1.5 = 21.75px, around 14.5px text', inBox.smPx === '12.6875px' && inBox.lgPx === '21.75px' && inBox.base === '14.5px');
    check('mixed sizes share one baseline on one line', inBox.va.every(v => v === 'baseline') && inBox.sameLine);
    check('the text carries the spans', (await value()) === '[small]small print[/small], normal words, [large]BIG WORDS[/large]', await value());

    // ---------- 2. the picker says "Mixed" ----------
    await page.evaluate(() => window.__cw.select(0, 36));
    await sleep(150);
    const lab = await page.$eval('[data-size-button]', b => ({ text: b.textContent, aria: b.getAttribute('aria-label') }));
    check('a mixed selection: the picker shows "Mixed"', lab.text.includes('Mixed') && lab.aria === 'Text size: Mixed', JSON.stringify(lab));
    await page.click('[data-size-button]');
    await sleep(120);
    const checked = await page.$$eval('[role="menuitemradio"]', els => els.map(e => e.getAttribute('aria-checked')));
    check('...and no size is checked in its menu', checked.every(c => c === 'false'), JSON.stringify(checked));
    await shot('02-picker-mixed.png', { x: 0, y: 260, width: 760, height: 360 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__cw.select(14, 14));
    await sleep(150);
    check('a caret in normal text: "Normal"', (await page.$eval('[data-size-button]', b => b.textContent)).includes('Normal'));
    await page.evaluate(() => window.__cw.select(30, 30));
    await sleep(150);
    check('a caret in large text: "Large"', (await page.$eval('[data-size-button]', b => b.textContent)).includes('Large'));

    // ---------- 3. more lines: a large heading, inline code in a large span, a small list item ----------
    await page.evaluate(() => window.__cw.select(36, 36));
    await page.keyboard.press('Shift+Enter');
    await pickSize('large');
    await page.keyboard.type('**3 PM** with `npm run build`');
    await sleep(150);
    check('an armed size survives a typed shortcut (`**3 PM** ` then more text stays Large)', /\[large\]\*\*3 PM\*\* with .*npm run build.*\[\/large\]$/.test(await value()), await value());
    await page.keyboard.press('Shift+Enter');
    await pickSize('small');
    await page.keyboard.type('- and snacks');
    await sleep(150);
    check('...and a typed `- ` (the bullet keeps the armed Small)', (await value()).endsWith('- [small]and snacks[/small]'), await value());
    await sleep(120);
    await shot('01a-mixed-sizes-in-box.png', { x: 0, y: 260, width: 760, height: 360 });
    const before = await value();
    await page.keyboard.press('Enter');
    await sleep(250);

    // ---------- 4. the sent message ----------
    const sent = await page.evaluate(() => {
        const row = document.querySelector('[data-row="sent-0"]');
        const body = row.querySelector('.whitespace-pre-wrap');
        const spans = [...body.querySelectorAll('.cl-fmt-size')].map(s => ({ size: s.dataset.size, px: getComputedStyle(s).fontSize, text: s.textContent }));
        const code = body.querySelector('.cl-fmt-size code.cl-fmt-code');
        return { field: body.getAttribute('data-msg-size'), base: getComputedStyle(body).fontSize, spans, codePx: code && getComputedStyle(code).fontSize, text: body.textContent, raw: window.__cw.sent()[0] };
    });
    check('sent: spans at 13.125px / 22.5px around 15px text, no markers in the text', sent.base === '15px' && sent.spans.some(s => s.size === 'small' && s.px === '13.125px') && sent.spans.some(s => s.size === 'large' && s.px === '22.5px') && !/\[\/?(small|large)\]/.test(sent.text), JSON.stringify(sent.spans));
    check('...inline code inside a Large span scales with it (0.86em of 22.5px)', sent.codePx === '19.35px', sent.codePx);
    check('...a mixed message has no per-message field', sent.field === null && sent.raw.size === null && sent.raw.text === before, JSON.stringify(sent.raw));
    await shot('01b-mixed-sizes-sent.png', { x: 0, y: 0, width: 760, height: 300 });
    await page.setViewportSize({ width: 760, height: 620 });

    // ---------- 5. a one-size message goes out as the field (clean text) ----------
    await page.click(box);
    await pickSize('large');
    await page.keyboard.type('everything big');
    await page.keyboard.press('Enter');
    await sleep(250);
    const uni = await page.evaluate(() => window.__cw.sent()[1]);
    check('a one-size message is sent as size: "large" with clean text (older clients)', uni.size === 'large' && uni.text === 'everything big', JSON.stringify(uni));
    check('...and the next message starts Normal (nothing sticks)', (await page.$eval('[data-size-button]', b => b.textContent)).includes('Normal'));

    // ---------- 6. the feed: mixed, heading, list, and an OLD field-only message ----------
    await page.goto(`${BASE}?scene=mixed`);
    await page.waitForSelector('[data-row]');
    await page.evaluate(() => document.fonts.ready);
    await sleep(300);
    const feed = await page.evaluate(() => {
        const m = document.querySelector('[data-row="m-mixed"] .whitespace-pre-wrap');
        const old = document.querySelector('[data-row="m-old"] .whitespace-pre-wrap');
        const head = m.querySelector('.cl-fmt-h .cl-fmt-size, [role="heading"] .cl-fmt-size');
        const line = (el) => getComputedStyle(el).lineHeight;
        return {
            head: head && getComputedStyle(head).fontSize,
            old: getComputedStyle(old).fontSize, oldSpans: old.querySelectorAll('.cl-fmt-size').length,
            lh: line(m), text: m.textContent,
        };
    });
    check('a Large heading span is 22.5px; the old field-only Large message renders at 22.5px exactly as before (no spans)', feed.head === '22.5px' && feed.old === '22.5px' && feed.oldSpans === 0, JSON.stringify(feed));
    check('no markers anywhere in the rendered text', !/\[\/?(small|large)\]/.test(feed.text));
    await shot('03-mixed-feed-and-old-field.png');
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
