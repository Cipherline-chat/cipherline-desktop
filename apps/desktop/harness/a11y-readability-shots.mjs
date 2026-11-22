// Accessibility readability screenshots + the Compact clipping check.
//   A11Y_PORT=5447 npx vite --config harness/a11y-readability.vite.config.ts      (another shell)
//   node harness/a11y-readability-shots.mjs <outDir> [--only=chat,fonts,status,settings,focus,scale]
// Sizes: 1000x720, 1366x768, 1920x1080, 1280x800 @1.5. "scale" runs Interface size 125 % the way
// webContents.setZoomFactor does: the CSS viewport is the window / 1.25 and the pixel ratio x 1.25.
// Exit code 1 when a Compact row clips or scrolls sideways at any size.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';

const BASE = `http://127.0.0.1:${process.env.A11Y_PORT ?? 5447}/harness/a11y-readability.html`;
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/tmp/a11y-readability';
const only = arg('only', '').split(',').filter(Boolean);
const want = (k) => !only.length || only.includes(k);
const SIZES = [
    { id: '1000x720', w: 1000, h: 720, dsf: 1 },
    { id: '1366x768', w: 1366, h: 768, dsf: 1 },
    { id: '1920x1080', w: 1920, h: 1080, dsf: 1 },
    { id: '1280x800@1.5', w: 1280, h: 800, dsf: 1.5 },
];
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const errors = [];
let clipFail = 0;

async function open(size, qs, { scale = 1 } = {}) {
    const ctx = await browser.newContext({ viewport: { width: Math.round(size.w / scale), height: Math.round(size.h / scale) }, deviceScaleFactor: size.dsf * scale });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => errors.push(`${qs}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) errors.push(`${qs}: ${m.text().slice(0, 200)}`); });
    await page.goto(`${BASE}?${qs}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__booted === true);
    await sleep(3000);
    return { ctx, page };
}

// Compact (and Cozy) must never clip: no message row scrolls sideways, nothing pokes out of the feed.
const CLIP = `(() => {
  const rows = [...document.querySelectorAll('.cl-msg-row')];
  const bad = [];
  for (const r of rows) {
    if (r.scrollWidth > r.clientWidth + 1) bad.push('row scrolls sideways: ' + (r.textContent || '').slice(0, 40));
    const rr = r.getBoundingClientRect();
    for (const el of r.querySelectorAll('img,canvas,.cl-msg-av,.cl-msg-gutter,.cl-msg-head,.cl-msg-body')) {
      const b = el.getBoundingClientRect();
      if (b.width && (b.left < rr.left - 1 || b.right > rr.right + 1)) bad.push('child outside row: ' + el.className.toString().slice(0, 40));
    }
  }
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) bad.push('page scrolls sideways');
  return { rows: rows.length, bad };
})()`;

async function shoot(page, name) { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); }
async function clipCheck(page, label) {
    const r = await page.evaluate(CLIP);
    console.log(`clip ${label}: rows=${r.rows} ${r.bad.length ? 'FAIL ' + r.bad.join(' | ') : 'ok'}`);
    if (r.bad.length || !r.rows) clipFail++;
}
async function scrollFeedBottom(page) {
    await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible' && el.querySelector('.cl-msg-row')) el.scrollTop = el.scrollHeight; });
    await sleep(500);
}

try {
    if (want('chat')) for (const s of SIZES) for (const density of ['cozy', 'compact']) {
        const { ctx, page } = await open(s, `view=chat&density=${density}`);
        await scrollFeedBottom(page);
        await clipCheck(page, `${density} ${s.id}`);
        await shoot(page, `chat-${density}-${s.id.replace('@', '-')}`);
        if (density === 'compact') { // hover a grouped row: its time shows in the gutter
            const row = page.locator('.cl-msg-row:not(.cl-msg-row--head)').first();
            await row.hover(); await sleep(250);
            await shoot(page, `chat-compact-hover-${s.id.replace('@', '-')}`);
        }
        await ctx.close();
    }
    if (want('chat')) { // gap slider extremes + relaxed + wide + underline links, compact and cozy, at the smallest window
        for (const [name, qs] of [['gap0', 'density=cozy&gap=0'], ['gap24', 'density=cozy&gap=24'], ['spacing', 'density=cozy&leading=relaxed&tracking=wide&links=on'], ['compact-spacing', 'density=compact&leading=relaxed&tracking=wide&links=on&text=20']]) {
            const { ctx, page } = await open(SIZES[0], `view=chat&${qs}`);
            await scrollFeedBottom(page);
            await clipCheck(page, name);
            await shoot(page, `chat-${name}-1000x720`);
            await ctx.close();
        }
    }
    if (want('scale')) for (const density of ['cozy', 'compact']) {
        const { ctx, page } = await open(SIZES[1], `view=chat&density=${density}&text=18`, { scale: 1.25 });
        await scrollFeedBottom(page);
        await clipCheck(page, `${density} 1366x768 @125%`);
        await shoot(page, `chat-${density}-1366x768-ui125-text18`);
        await ctx.close();
    }
    if (want('fonts')) for (const font of ['default', 'atkinson', 'lexend', 'opendyslexic']) {
        const { ctx, page } = await open(SIZES[1], `view=chat&density=cozy&font=${font}`);
        await scrollFeedBottom(page);
        await clipCheck(page, `font ${font}`);
        await shoot(page, `font-${font}-1366x768`);
        await ctx.close();
    }
    if (want('status')) for (const s of [SIZES[1], SIZES[3]]) {
        const { ctx, page } = await open(s, 'view=status');
        await shoot(page, `status-shapes-${s.id.replace('@', '-')}`);
        await ctx.close();
    }
    if (want('settings')) for (const s of SIZES) {
        const { ctx, page } = await open(s, 'view=settings&density=compact&font=lexend');
        const tall = await page.evaluate(() => document.querySelector('.sd-main').scrollHeight);
        await page.setViewportSize({ width: Math.round(s.w), height: Math.min(4000, tall + 40) });
        await sleep(500);
        await shoot(page, `settings-accessibility-${s.id.replace('@', '-')}`);
        await ctx.close();
    }
    if (want('settings')) { // 125 % interface scale
        const { ctx, page } = await open(SIZES[1], 'view=settings', { scale: 1.25 });
        const tall = await page.evaluate(() => document.querySelector('.sd-main').scrollHeight);
        await page.setViewportSize({ width: Math.round(1366 / 1.25), height: Math.min(4000, tall + 40) });
        await sleep(500);
        await shoot(page, 'settings-accessibility-1366x768-ui125');
        await ctx.close();
    }
    if (want('focus')) {
        const { ctx, page } = await open(SIZES[1], 'view=settings&focus=on');
        await page.locator('.a11y-choice button', { hasText: 'Compact' }).click();
        await sleep(300);
        await shoot(page, 'focus-always-on-after-click-1366x768');
        await ctx.close();
        const off = await open(SIZES[1], 'view=settings&focus=off');
        await off.page.locator('.a11y-choice button', { hasText: 'Compact' }).click();
        await sleep(300);
        await shoot(off.page, 'focus-off-after-click-1366x768');
        await off.ctx.close();
    }
} finally {
    await browser.close();
}
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'no page errors');
console.log(clipFail ? `CLIP FAILURES: ${clipFail}` : 'no clipping');
process.exit(clipFail ? 1 : 0);
