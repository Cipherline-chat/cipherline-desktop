// Cosmetic thumbnails: 2x screenshots of the picker grid + per-size detail sheets in real Chromium.
//
//   npx vite --config harness/cosmetic-thumbs.vite.config.ts      (serves :5347)
//   node harness/cosmetic-thumbs-shots.mjs                        (env: OUT=<dir> LABEL=before|after BASE PW_CHROMIUM_EXE)
//
// Writes <LABEL>-grid.png (reduced motion: the still every reduced-motion user sees), <LABEL>-grid-locked.png,
// <LABEL>-grid-light-face.png, <LABEL>-grid-tint.png (Match theme), <LABEL>-detail.png (26/36/44/92px on two faces),
// and <LABEL>-frames.png (the three weak items' grid tiles sampled through their animation, normal motion).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5347/harness/cosmetic-thumbs.html';
const OUT = process.env.OUT ?? '/tmp/cosmetic-thumbs';
const LABEL = process.env.LABEL ?? 'shot';
const WEAK = (process.env.IDS ?? 'orrery,bat-halo,eclipse').split(',');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'],
});
try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });

    const shoot = async (url, sel, file) => {
        await page.goto(url);
        await page.waitForSelector(sel);
        await page.evaluate(() => document.fonts.ready);
        await sleep(400);
        await page.locator(sel).first().screenshot({ path: `${OUT}/${file}` });
        console.log(`SHOT  ${OUT}/${file}`);
    };
    await shoot(`${BASE}?scene=grid`, '[data-testid="grid"]', `${LABEL}-grid.png`);
    await shoot(`${BASE}?scene=grid&locked=1`, '[data-testid="grid"]', `${LABEL}-grid-locked.png`);
    await shoot(`${BASE}?scene=grid&face=light`, '[data-testid="grid"]', `${LABEL}-grid-light-face.png`);
    await shoot(`${BASE}?scene=grid&tint=${encodeURIComponent('#FF6B5E')}`, '[data-testid="grid"]', `${LABEL}-grid-tint.png`);
    await shoot(`${BASE}?scene=detail&ids=${WEAK.join(',')},lume-ring,neon-ring,circlet`, '#root > div', `${LABEL}-detail.png`);

    // Normal motion: the grid tiles of the weak items, sampled through their loops (every animation paused at t).
    const mctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    const mp = await mctx.newPage();
    mp.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await mp.goto(`${BASE}?scene=detail&ids=${WEAK.join(',')}`);
    await mp.waitForSelector('[data-row]');
    await sleep(400);
    const times = [0, 1.3, 2.6, 4.1, 5.5, 7.4, 9.8, 13.1];
    // One strip: rows = items, columns = times; each cell = that item's 36px (mid face) thumbnail.
    await mp.evaluate(({ ids, times }) => {
        const host = document.createElement('div');
        host.id = 'frames';
        host.style.cssText = 'position:absolute;left:0;top:0;background:#131A30;display:grid;gap:0;padding:12px;z-index:9;align-content:start;justify-content:start;';
        host.style.gridTemplateColumns = `repeat(${times.length}, 92px)`;
        document.body.appendChild(host);
        for (const id of ids) {
            for (let i = 0; i < times.length; i++) {
                const src = document.querySelector(`[data-row="${id}"] > div:nth-child(3)`);
                const cell = document.createElement('div');
                cell.className = 'pst-tile';
                cell.style.cssText = 'margin:4px;';
                cell.innerHTML = `<span class="pst-tile-prev"></span><span class="pst-tile-name" style="color:#A7B3D4;font-weight:600">${id} ${times[i]}s</span>`;
                cell.firstChild.appendChild(src.firstElementChild.cloneNode(true));
                host.appendChild(cell);
            }
        }
    }, { ids: WEAK, times });
    await sleep(300);
    await mp.evaluate((times) => {
        const cells = [...document.querySelectorAll('#frames > .pst-tile')];
        const n = times.length;
        for (const a of document.getAnimations()) {
            const el = a.effect && a.effect.target;
            const cell = el && el.closest && el.closest('#frames > .pst-tile');
            a.pause();
            if (!cell) continue;
            a.currentTime = times[cells.indexOf(cell) % n] * 1000;
        }
    }, times);
    await sleep(200);
    await mp.locator('#frames').screenshot({ path: `${OUT}/${LABEL}-frames.png` });
    console.log(`SHOT  ${OUT}/${LABEL}-frames.png`);
    await mctx.close();
    await ctx.close();
} finally {
    await browser.close();
}
console.log(failures ? `${failures} failure(s)` : 'OK');
process.exit(failures ? 1 : 0);
