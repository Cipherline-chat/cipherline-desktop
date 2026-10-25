// ClBanner: geometry assertions + 2x screenshots in real Chromium.
//
//   npx vite --config harness/banners.vite.config.ts        (serves :5311)
//   node harness/banners-shots.mjs                          (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Writes banner-redesign.png (the owner's trial banner in a Dashboard mock) and banner-gallery.png (every
// banner type and tone, the stack cap, the overlay layers and the narrow widths). Checks: slim height, an
// inset rounded card, no clipped text or horizontal overflow, actions drop below the text when narrow,
// reduced motion switches the entrance off, and the surface is a design token, never khaki.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5311/harness/banners.html';
const OUT = process.env.OUT ?? '/tmp/banner-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
});
try {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 700 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });

    // ---------- 1. the owner's banner in a Dashboard mock --------------------------------------------
    await page.goto(`${BASE}?scene=dashboard&days=3`);
    await page.waitForSelector('.cl-banner');
    await sleep(900); // entrance animation + fonts
    const card = await page.locator('.cl-banner__card').first().evaluate(el => {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        const parent = el.closest('.cl-banner-stack').getBoundingClientRect();
        return { w: r.width, h: r.height, x: r.x, parentX: parent.x, radius: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor, scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    check('trial banner is slim (40-48px on one line)', card.h >= 40 && card.h <= 48, `h=${card.h}`);
    check('inset card (12px inside the stack), rounded >= 12px', card.x - card.parentX >= 11 && card.radius >= 12, `x-offset=${card.x - card.parentX} r=${card.radius}`);
    check('no horizontal overflow inside the card', card.scrollW <= card.clientW + 1, `${card.scrollW}/${card.clientW}`);
    const rgb = card.bg.match(/[\d.]+/g).map(Number);
    check('surface is a dark navy token, not an olive/khaki fill', rgb[2] >= rgb[0] && rgb[0] < 40 && rgb[1] < 50, card.bg);
    const clip = await page.locator('.cl-banner__text').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1);
    check('title/description text not clipped', clip);
    const titleColor = await page.locator('.cl-banner__title').first().evaluate(el => getComputedStyle(el).color);
    check('title is the normal foreground (not yellow)', titleColor === 'rgb(244, 247, 255)', titleColor);
    const root = await page.locator('#root > div').first().boundingBox();
    await page.screenshot({ path: `${OUT}/banner-redesign.png`, clip: { x: root.x, y: root.y, width: root.width, height: Math.min(root.height, 420) } });
    console.log(`SHOT  ${OUT}/banner-redesign.png`);

    // stacked: two banners
    await page.goto(`${BASE}?scene=dashboard&days=1&stack=1`);
    await page.waitForSelector('.cl-banner');
    await sleep(700);
    const n = await page.locator('.cl-banner').count();
    check('two banners stack with consistent 8px spacing', n === 2);
    const gap = await page.evaluate(() => { const a = [...document.querySelectorAll('.cl-banner')].map(e => e.getBoundingClientRect()); a.sort((x, y) => x.y - y.y); return a[1].y - a[0].bottom; });
    check('gap between stacked banners is 8px', Math.abs(gap - 8) < 1.5, `gap=${gap}`);
    await page.screenshot({ path: `${OUT}/banner-stack.png`, clip: { x: root.x, y: root.y, width: root.width, height: 300 } });

    // reduced motion: no entrance animation
    const rm = await browser.newContext({ viewport: { width: 1320, height: 700 }, reducedMotion: 'reduce' });
    const rp = await rm.newPage();
    await rp.goto(`${BASE}?scene=dashboard&days=3`);
    await rp.waitForSelector('.cl-banner');
    const anim = await rp.locator('.cl-banner').first().evaluate(el => getComputedStyle(el).animationName);
    check('prefers-reduced-motion: entrance animation is off', anim === 'none', anim);
    const anim2 = await page.locator('.cl-banner').first().evaluate(el => getComputedStyle(el).animationName);
    check('control: with motion allowed the entrance animation is set', anim2 !== 'none', anim2);
    await rm.close();

    // ---------- 2. the gallery -------------------------------------------------------------------------
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.goto(`${BASE}?scene=gallery`);
    await page.waitForSelector('.cl-banner');
    await sleep(1500);
    const over = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('.cl-banner__text')) if (el.scrollWidth > el.clientWidth + 1) bad.push(el.textContent.slice(0, 40));
        for (const el of document.querySelectorAll('.cl-banner__card')) if (el.scrollWidth > el.clientWidth + 1) bad.push('card:' + el.textContent.slice(0, 40));
        return { bad, docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    check('gallery: no clipped text, no horizontal page scroll', over.bad.length === 0 && !over.docOverflow, JSON.stringify(over));

    const narrow = async (sectionTitle) => page.evaluate((t) => {
        const sec = [...document.querySelectorAll('section')].find(s => s.firstChild.textContent.startsWith(t));
        const card = sec.querySelector('.cl-banner__card');
        const text = card.querySelector('.cl-banner__text').getBoundingClientRect();
        const act = card.querySelector('.cl-banner__actions').getBoundingClientRect();
        const x = card.querySelector('.cl-banner__x');
        const xr = x ? x.getBoundingClientRect() : null;
        return { actionsBelow: act.top >= text.bottom - 1, dismissTop: xr ? xr.top < text.bottom : null, w: card.getBoundingClientRect().width };
    }, sectionTitle);
    const n700 = await narrow('Narrow, 700px');
    check('700px: actions drop below the text, dismiss stays top-right', n700.actionsBelow && n700.dismissTop, JSON.stringify(n700));
    const n420 = await narrow('Narrow, 420px');
    check('420px: actions drop below the text, dismiss stays top-right', n420.actionsBelow && n420.dismissTop, JSON.stringify(n420));
    const wide = await page.evaluate(() => {
        const sec = document.querySelector('section');
        const card = sec.querySelector('.cl-banner__card');
        const text = card.querySelector('.cl-banner__text').getBoundingClientRect();
        const act = card.querySelector('.cl-banner__actions').getBoundingClientRect();
        return { sameRow: act.top < text.bottom && act.bottom > text.top };
    });
    check('1100px: actions sit on the same row as the text', wide.sameRow);

    // stack cap in the gallery: 4 banners, 2 shown + "+2 more"
    const cap = await page.evaluate(() => {
        const sec = [...document.querySelectorAll('section')].find(s => s.firstChild.textContent.startsWith('Stack of four'));
        return { shown: sec.querySelectorAll('.cl-banner').length, more: sec.querySelector('.cl-banner-more')?.textContent, first: [...sec.querySelectorAll('.cl-banner')].sort((a, b) => Number(a.style.order) - Number(b.style.order))[0].getAttribute('data-banner-tone') };
    });
    check('stack of four: danger first, 2 shown, "+2 more"', cap.shown === 2 && /\+2 more/.test(cap.more) && cap.first === 'danger', JSON.stringify(cap));

    await page.screenshot({ path: `${OUT}/banner-gallery.png`, fullPage: true });
    console.log(`SHOT  ${OUT}/banner-gallery.png`);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
