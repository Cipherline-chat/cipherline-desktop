// Settings → Accessibility → Motion & effects: screenshots in real Chromium.
//   npx vite --config harness/settings-redesign.vite.config.ts   (:5311)
//   A11Y_PORT=5393 npx vite --config harness/a11y-motion.vite.config.ts   (:5393)
//   node harness/a11y-motion-shots.mjs <outDir>
//
// Window sizes follow the owner's rule. Interface scale is emulated exactly as the host's
// setZoomFactor does it: CSS viewport = window / factor, device pixel ratio x factor.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const SR = 'http://127.0.0.1:5311/harness/settings-redesign.html';
const AM = 'http://127.0.0.1:5393/harness/a11y-motion.html';
const OUT = process.argv[2] ?? '/tmp/a11y-motion';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// [name, window w, h, device scale, interface scale %]
const SIZES = [
    ['1000x720', 1000, 720, 1, 100],
    ['1366x768', 1366, 768, 1, 100],
    ['1920x1080', 1920, 1080, 1, 100],
    ['1280x800@1.5-ui125', 1280, 800, 1.5, 125],
];


/** Scroll the Motion & effects card to just under the top of the window. */
async function showCard(page) {
    await page.evaluate(() => {
        const c = [...document.querySelectorAll('.sd-card')].find(x => x.querySelector('h3')?.textContent?.includes('Motion & effects'));
        c.scrollIntoView({ block: 'start' });
        let p = c.parentElement;
        while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
        if (p) p.scrollTop -= 36;
    });
    await sleep(600);
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];
try {
    for (const [name, w, h, dpr, ui] of SIZES) {
        const z = ui / 100;
        const ctx = await browser.newContext({ viewport: { width: Math.round(w / z), height: Math.round(h / z) }, deviceScaleFactor: dpr * z });
        const page = await ctx.newPage();
        page.setDefaultTimeout(180000);
        page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
        await page.goto(`${SR}?tab=accessibility`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__booted === true);
        await page.waitForSelector('.sd-pane');
        await sleep(2500);
        await showCard(page);
        await page.screenshot({ path: `${OUT}/accessibility-motion-${name}.png` });
        console.log('shot', name);
        await ctx.close();
    }

    // Reduce motion forced On with the OS asking for full motion: the card, and a state with effects off.
    {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.on('pageerror', e => errors.push(`states: ${e.message}`));
        const motion = encodeURIComponent(JSON.stringify({ reduce: 'on', images: 'never', effects: false }));
        await page.goto(`${SR}?tab=accessibility&motion=${motion}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__booted === true);
        await page.waitForSelector('.sd-pane');
        await sleep(2500);
        await showCard(page);
        const attrs = await page.evaluate(() => [document.documentElement.getAttribute('data-reduced-motion'), document.documentElement.getAttribute('data-effects')]);
        console.log('html attrs (expect true, off):', attrs);
        if (attrs[0] !== 'true' || attrs[1] !== 'off') errors.push('attributes not applied from stored value: ' + attrs);
        await page.screenshot({ path: `${OUT}/accessibility-motion-1366x768-on-never-off.png` });
        await ctx.close();
    }

    // Animated image in a message: Always (plays) vs Never (first frame + play button).
    for (const mode of ['always', 'never']) {
        const ctx = await browser.newContext({ viewport: { width: 640, height: 300 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        page.on('pageerror', e => errors.push(`gif ${mode}: ${e.message}`));
        await page.goto(`${AM}?images=${mode}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__booted === true);
        await sleep(1700); // always: a later frame by now; never: still frame 1
        const info = await page.evaluate(() => ({
            playing: getComputedStyle(document.querySelector('img')).display !== 'none',
            badge: !!document.querySelector('button.gif-play-badge'),
        }));
        console.log(mode, info);
        await page.screenshot({ path: `${OUT}/animated-image-${mode === 'always' ? 'BEFORE-always' : 'AFTER-never'}.png` });
        await ctx.close();
    }
} finally {
    await browser.close();
}
if (errors.length) { console.log('ERRORS', errors); process.exit(1); }
