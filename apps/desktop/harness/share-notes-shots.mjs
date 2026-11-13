// Screen-share notices: node harness/share-notes-shots.mjs  (env: OUT PREFIX BASE PW_CHROMIUM_EXE)
// Screenshots each notice where it really appears (2x) and prints the box-vs-text geometry.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5351/harness/share-notes.html';
const OUT = process.env.OUT ?? '/tmp/share-notes';
const PREFIX = process.env.PREFIX ?? 'shot';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open(qs, viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('pageerror ' + e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });
    await page.goto(`${BASE}?${qs}`, { timeout: 120000, waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    return { ctx, page };
}
/** Box vs text geometry of the first element matching sel (the notice box and its text node's rect). */
async function geom(page, sel, label) {
    const g = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(el.querySelector('p, span.txt') ?? el);
        const rr = range.getBoundingClientRect();
        const pad = getComputedStyle(el);
        const chain = []; for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) { const c = getComputedStyle(n); chain.push(`${n.tagName.toLowerCase()}[${c.display}${c.display.includes('flex') ? ' ' + c.flexDirection + ' ai=' + c.alignItems + ' wrap=' + c.flexWrap : ''}] h=${n.getBoundingClientRect().height.toFixed(1)} minH=${c.minHeight} mt=${c.marginTop} mb=${c.marginBottom} lh=${c.lineHeight}`); }
        return { chain, box: [Math.round(r.width), +r.height.toFixed(1)], text: [Math.round(rr.width), +rr.height.toFixed(1)], top: +(rr.top - r.top).toFixed(1), bottom: +(r.bottom - rr.bottom).toFixed(1), padY: pad.paddingTop + '/' + pad.paddingBottom };
    }, sel);
    console.log('GEOM', label, JSON.stringify(g));
    return g;
}
async function pickFps(page, label) {
    await page.getByText('Frame Rate').first().locator('xpath=following::*[@role="combobox" or self::button][1]').click().catch(() => {});
    await page.getByText(label, { exact: true }).last().click();
    await new Promise(r => setTimeout(r, 400));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
    // ---- Picker modal: 90 fps (hz high), display cap (hz 60), Wayland cap, mac bypass note ----
    for (const [name, qs, fps] of [
        ['picker-90fps', 's=picker&hz=144', 'Up to 90 fps'],
        ['picker-hzcap', 's=picker&hz=60', 'Up to 90 fps'],
        ['picker-wayland', 's=picker&plat=linux&hz=144&ceil=60', 'Up to 90 fps'],
        ['picker-macnote', 's=picker&plat=mac&hz=144', null],
        ['picker-wide90', 's=picker&wide=1&hz=144', 'Up to 90 fps'],
    ].filter(([n]) => !process.env.ONLY || process.env.ONLY === n)) {
        const { ctx, page } = await open(qs);
        await wait(900);
        if (qs.includes('wide=1')) { await page.getByText('Screen 1', { exact: true }).first().click(); await wait(500); }
        if (fps) await pickFps(page, fps);
        await wait(300);
        await page.screenshot({ path: `${OUT}/${PREFIX}-${name}-full.png` });
        const modal = page.locator('[role="dialog"]').first();
        if (await modal.count()) await modal.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
        await geom(page, 'div[class*="rounded-lg"][class*="border"][class*="items-start"]', name);
        console.log('SHOT', name);
        await ctx.close();
    }
    // ---- Call-bar quality popover ----
    if (!process.env.ONLY) {
        const { ctx, page } = await open('s=bar&fps=30');
        await wait(600);
        await page.locator('button[title="Screen share options"]').click();
        await wait(500);
        await page.getByText('Adjust Quality').first().click().catch(async () => { await page.getByText('Quality', { exact: false }).first().click(); });
        await wait(500);
        await page.getByText('90 fps', { exact: true }).first().click();
        await wait(500);
        const panel = page.locator('div.rounded-2xl.overflow-hidden.select-none').last();
        await panel.screenshot({ path: `${OUT}/${PREFIX}-bar-90fps.png` });
        await geom(page, '[data-testid="share-fps-note"]', 'bar-90fps');
        console.log('SHOT bar-90fps');
        await ctx.close();
    }
    // ---- In-call (sidebar) share notices ----
    if (!process.env.ONLY) for (const [name, qs] of [
        ['conf-warn', 's=conf&tone=warn' + (process.env.LEGACY ? '&legacy=1' : '')],
        ['conf-info', 's=conf&tone=info' + (process.env.LEGACY ? '&legacy=1' : '') + '&text=' + encodeURIComponent('HDR was turned off on the shared screen. Share it again to continue.')],
        ['conf-warn-short', 's=conf&tone=warn' + (process.env.LEGACY ? '&legacy=1' : '') + '&text=' + encodeURIComponent('Sharing a single screen sends video only on this system (no system audio).')],
    ]) {
        const { ctx, page } = await open(qs, { width: 420, height: 260 });
        await wait(500);
        await page.locator('[data-testid="conf-col"]').screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
        await geom(page, '[data-testid="conf-col"] > *', name);
        console.log('SHOT', name);
        await ctx.close();
    }
} finally { await browser.close(); }
