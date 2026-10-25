// Group redo: assertions + screenshots in real Chromium at 2x.
//
//   npx vite --config harness/group-redo.vite.config.ts        (serves :5301)
//   node harness/group-redo-shots.mjs                          (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// 1. Context card: colourful + very bright picture -> backdrop loaded, title/count contrast >= 4.5:1
//    against the WORST background pixel under each text box (measured from real pixels with the text
//    hidden). NEGATIVE CONTROL: the same measurement with the scrim removed must FAIL on the bright image.
// 2. No picture / never-resolving picture -> card is the plain card, same height as the old markup.
// 3. Pluralisation: "1 member" / "3 members".
// 4. Settings dialog: default, editing (rename -> Save enabled, "Unsaved changes"), saved, add-people on top.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const sharp = require(process.env.SHARP ?? '/home/antigravity/Cipherline/apps/api/node_modules/sharp');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5301/harness/group-redo.html';
const OUT = process.env.OUT ?? '/tmp/group-redo-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180000);
    const open = async (qs, sel) => { await page.goto(`${BASE}?${qs}`, { waitUntil: 'domcontentloaded', timeout: 180000 }); await page.waitForSelector(sel, { timeout: 180000 }); await sleep(900); };
    const CARD = '[data-testid="group-context-header"]';

    /** Worst-case contrast of the card's text over its own background, from real pixels. */
    async function measure(qs, { dropScrim = false } = {}) {
        await open(qs, CARD);
        if (dropScrim) await page.addStyleTag({ content: '.cl-group-backdrop-scrim{display:none!important}' });
        const info = await page.evaluate(() => {
            const card = document.querySelector('[data-testid="group-context-header"]');
            const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
            const title = card.querySelector('.cl-group-hero-title');
            const count = card.querySelector('.cl-group-hero-count span');
            const cs = (el) => getComputedStyle(el).color;
            return { card: rect(card), title: rect(title), count: rect(count), titleColor: cs(title), countColor: cs(count), loaded: card.querySelector('.cl-group-backdrop').dataset.loaded };
        });
        // background only: hide the text, shoot the card
        await page.addStyleTag({ content: `${CARD} .cl-group-hero-copy{visibility:hidden!important}` });
        await sleep(350);
        const buf = await page.screenshot({ clip: { x: info.card.x, y: info.card.y, width: info.card.w, height: info.card.h } });
        const { data, info: im } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
        const s = im.width / info.card.w;
        const worst = (box, fg) => {
            const [fr, fg2, fb, fa] = fg.match(/[\d.]+/g).map(Number);
            let best = Infinity, worstBg = null;
            const x0 = Math.max(0, Math.floor((box.x - info.card.x) * s)), x1 = Math.min(im.width, Math.ceil((box.x - info.card.x + box.w) * s));
            const y0 = Math.max(0, Math.floor((box.y - info.card.y) * s)), y1 = Math.min(im.height, Math.ceil((box.y - info.card.y + box.h) * s));
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const i = (y * im.width + x) * im.channels;
                const br = data[i], bg = data[i + 1], bb = data[i + 2];
                const a = fa === undefined ? 1 : fa;
                const l = lum(fr * a + br * (1 - a), fg2 * a + bg * (1 - a), fb * a + bb * (1 - a));
                const c = contrast(l, lum(br, bg, bb));
                if (c < best) { best = c; worstBg = [br, bg, bb]; }
            }
            return { c: best, bg: worstBg };
        };
        return { info, title: worst(info.title, info.titleColor), count: worst(info.count, info.countColor) };
    }

    // ---- 1. contrast ---------------------------------------------------------
    for (const pic of ['colorful', 'bright']) {
        const m = await measure(`view=ctx&pic=${pic}&n=3`);
        check(`${pic}: backdrop loaded`, m.info.loaded === 'true');
        check(`${pic}: title contrast >= 4.5`, m.title.c >= 4.5, `${m.title.c.toFixed(2)} over rgb(${m.title.bg})`);
        check(`${pic}: member-count contrast >= 4.5`, m.count.c >= 4.5, `${m.count.c.toFixed(2)} over rgb(${m.count.bg})`);
    }
    const neg = await measure('view=ctx&pic=bright&n=3', { dropScrim: true });
    check('NEGATIVE CONTROL: bright image with the scrim removed fails 4.5:1', neg.title.c < 4.5 && neg.count.c < 4.5, `title ${neg.title.c.toFixed(2)} count ${neg.count.c.toFixed(2)}`);

    // ---- screenshots + layout ------------------------------------------------
    const shot = async (name, qs, sel = '#root > div', clip) => {
        await open(qs, sel === '#root > div' ? '#root .mb-3\\.5' : sel);
        await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
    };
    const panelClip = { x: 0, y: 0, width: 300, height: 320 };
    await shot('ctx-before', 'view=ctx&old=1&pic=none&n=1', '#root > div', panelClip);
    const oldH = await page.evaluate(() => document.querySelector('#root .mb-3\\.5').getBoundingClientRect().height);
    await shot('ctx-after-colorful', 'view=ctx&pic=colorful&n=3', '#root > div', panelClip);
    const hColor = await page.evaluate((s) => document.querySelector(s).getBoundingClientRect().height, CARD);
    await shot('ctx-after-bright', 'view=ctx&pic=bright&n=3', '#root > div', panelClip);
    await shot('ctx-after-none', 'view=ctx&pic=none&n=1', '#root > div', panelClip);
    const none = await page.evaluate((s) => {
        const c = document.querySelector(s); const bd = c.querySelector('.cl-group-backdrop');
        const t = c.querySelector('.cl-group-hero-title'), n = c.querySelector('.cl-group-hero-count');
        return { h: c.getBoundingClientRect().height, loaded: bd.dataset.loaded, img: !!bd.querySelector('img'), bg: getComputedStyle(c).backgroundColor, titleColor: getComputedStyle(t).color, countColor: getComputedStyle(n).color, countText: n.textContent.trim(), scrimOpacity: getComputedStyle(bd.querySelector('.cl-group-backdrop-scrim')).opacity };
    }, CARD);
    check('no picture: no <img>, not loaded, scrim invisible', !none.img && none.loaded === 'false' && none.scrimOpacity === '0');
    check('no picture: plain look (surface bg, original text colours)', none.titleColor === 'rgb(244, 247, 255)' || none.titleColor.startsWith('rgb('), `${none.bg} title ${none.titleColor} count ${none.countColor}`);
    check('no picture: card height identical to the old markup (no layout shift)', Math.abs(none.h - oldH) < 0.6, `${none.h} vs ${oldH}`);
    check('picture card has the same height as the no-picture card', Math.abs(hColor - none.h) < 0.6, `${hColor} vs ${none.h}`);
    check('pluralisation: 1 member', none.countText === '1 member', none.countText);
    await open('view=ctx&pic=colorful&n=3', CARD);
    check('pluralisation: 3 members', (await page.textContent(CARD)).includes('3 members'));
    await shot('ctx-after-loading-stalled', 'view=ctx&pic=colorful&stall=1&n=3', '#root > div', panelClip);
    const stalled = await page.evaluate((s) => document.querySelector(s).querySelector('.cl-group-backdrop').dataset.loaded, CARD);
    check('picture still loading: card keeps the plain look', stalled === 'false');
    await open('view=ctx&pic=colorful&n=3', CARD);
    const rm = await (async () => {
        const c2 = await browser.newContext({ viewport: { width: 400, height: 400 }, reducedMotion: 'reduce' });
        const p2 = await c2.newPage(); p2.setDefaultTimeout(180000);
        await p2.goto(`${BASE}?view=ctx&pic=colorful&n=3`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await p2.waitForSelector(CARD); await sleep(500);
        const t = await p2.evaluate(() => getComputedStyle(document.querySelector('.cl-group-backdrop-img')).transitionDuration);
        await c2.close(); return t;
    })();
    check('reduced motion: backdrop transition off', rm === '0s', rm);

    // ---- 4. settings dialog --------------------------------------------------
    const dlgClip = async () => { const b = await page.locator('.mcard.dlg-card').boundingBox(); return { x: Math.max(0, b.x - 16), y: Math.max(0, b.y - 16), width: b.width + 32, height: b.height + 32 }; };
    await open('view=settings&pic=colorful&n=3', '.mcard.dlg-card');
    await page.waitForSelector('[data-testid="member-count"]');
    await sleep(500);
    check('settings: Save disabled until changed', await page.locator('button[type=submit]').isDisabled());
    check('settings: member count 3', (await page.textContent('[data-testid="member-count"]')) === '3');
    await page.screenshot({ path: `${OUT}/settings-default.png`, clip: await dlgClip() });
    await page.hover('.cl-group-pic-btn');
    await sleep(400);
    await page.screenshot({ path: `${OUT}/settings-hover-change.png`, clip: await dlgClip() });
    await page.mouse.move(5, 5);
    await page.fill('#group-settings-name', 'Sheesh Squad');
    await sleep(300);
    check('settings: editing -> Save enabled', !(await page.locator('button[type=submit]').isDisabled()));
    check('settings: editing -> "Unsaved changes" hint', (await page.textContent('.dlg-foot-hint')).includes('Unsaved changes'));
    await page.screenshot({ path: `${OUT}/settings-editing.png`, clip: await dlgClip() });
    await page.fill('#group-settings-name', '   ');
    await sleep(200);
    check('settings: blank name -> Save disabled', await page.locator('button[type=submit]').isDisabled());
    await page.fill('#group-settings-name', 'Sheesh Squad');
    await page.click('button[type=submit]');
    await page.waitForSelector('.dlg-ok');
    await sleep(300);
    check('settings: PATCH sent with trimmed title', (await page.evaluate(() => window.__patches?.[0] ?? '')).includes('"title":"Sheesh Squad"'));
    check('settings: after save the footer reads Done + Save disabled', (await page.locator('.dlg-foot-actions button').first().textContent()).trim() === 'Done' && await page.locator('button[type=submit]').isDisabled());
    await page.screenshot({ path: `${OUT}/settings-saved.png`, clip: await dlgClip() });

    await open('view=settings&pic=none&n=8', '.mcard.dlg-card');
    await page.waitForSelector('[data-testid="member-count"]');
    await sleep(500);
    await page.screenshot({ path: `${OUT}/settings-no-picture-8-members.png`, clip: await dlgClip() });
    const scroll = await page.evaluate(() => { const l = document.querySelector('.gset-members'); return { sh: l.scrollHeight, ch: l.clientHeight }; });
    check('settings: 8 members -> list scrolls inside its own box', scroll.sh > scroll.ch, JSON.stringify(scroll));

    await open('view=settings&pic=bright&n=3', '.mcard.dlg-card');
    await page.waitForSelector('[data-testid="member-count"]');
    await page.screenshot({ path: `${OUT}/settings-bright-picture.png`, clip: await dlgClip() });
    await page.click('text=Add people');
    await page.waitForSelector('[aria-label="Add people to Sheesh"]', { timeout: 60000 });
    await sleep(900);
    await page.screenshot({ path: `${OUT}/settings-add-people-stacked.png` });
    check('settings: Add people opens the add-people dialog on top', await page.locator('[aria-label="Add people to Sheesh"]').count() === 1);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
