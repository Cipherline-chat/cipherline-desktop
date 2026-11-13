// Device-sync "Send history" button: idle / loading / done screenshots + a few DOM measurements.
//   npx vite --config harness/device-sync.vite.config.ts   (serves :5291)
//   node harness/device-sync-shots.mjs                      (env: OUT=<dir> PREFIX=before|after BASE PW_CHROMIUM_EXE)
// Launches (and closes) its OWN headless browser; nothing is left running.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5291/harness/device-sync.html';
const OUT = process.env.OUT ?? '.';
const PREFIX = process.env.PREFIX ?? 'after';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: exe });
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', e => console.log('pageerror', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text()); });
    await page.goto(BASE);
    const send = page.getByRole('button', { name: /send history/i });
    await send.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await sleep(1200);
    const measure = async () => page.evaluate(() => {
        const btns = [...document.querySelectorAll('.mcard button.cap')].slice(-2);
        return btns.map(b => {
            const r = b.getBoundingClientRect(); const w = b.closest('.clb').getBoundingClientRect();
            return { text: b.textContent.trim(), cap: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], clb: [Math.round(w.width), Math.round(w.height)], disabled: b.disabled, busy: b.getAttribute('aria-busy'), cls: b.closest('.clb').className };
        });
    });
    const card = page.locator('.mcard').first();
    // Real use: the dialog pops up while the mouse is the last input, so the modal's
    // initial programmatic focus draws no ring. Headless has had no input at all, so
    // click the (inert) title first to put the page in that same state.
    await page.getByRole('heading', { name: /send history to this device/i }).click();
    await sleep(300);
    console.log('idle', JSON.stringify(await measure()));
    await page.screenshot({ path: `${OUT}/${PREFIX}-idle.png` });
    await card.screenshot({ path: `${OUT}/${PREFIX}-idle-card.png` });

    // Keyboard focus ring on the idle button.
    await send.focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await sleep(300);
    await card.screenshot({ path: `${OUT}/${PREFIX}-focus-card.png` });

    await send.click();
    await sleep(900);
    console.log('loading', JSON.stringify(await measure()));
    await page.screenshot({ path: `${OUT}/${PREFIX}-loading.png` });
    await card.screenshot({ path: `${OUT}/${PREFIX}-loading-card.png` });
    // A second click while busy must not start another send.
    await page.locator('.mcard button.cap').last().click({ force: true }).catch(() => {});
    await sleep(200);

    // The dialog auto-closes 1.2s after a successful send: grab the card's box now and
    // photograph the done state by clip (a locator shot would wait out the close).
    const box = await card.boundingBox();
    await page.evaluate(() => window.__releaseExport?.());
    await sleep(650);
    console.log('done', JSON.stringify(await measure()));
    await page.screenshot({ path: `${OUT}/${PREFIX}-done-card.png`, clip: { x: box.x, y: box.y - 40, width: box.width, height: box.height + 80 } });
    await page.screenshot({ path: `${OUT}/${PREFIX}-done.png` });
    await sleep(1500);
    console.log('log', JSON.stringify(await page.evaluate(() => window.__log)));
    await ctx.close();
} finally {
    await browser.close();
}
