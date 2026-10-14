// Screen Lock → hide-previews suggestion: drives the REAL setup flow and screenshots the card.
//   npx vite --config harness/lock-preview-suggest.vite.config.ts      (serves :5233)
//   node harness/lock-preview-suggest-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// Launches (and closes) its OWN headless browser; nothing is left running.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5233/harness/lock-preview-suggest.html';
const OUT = process.env.OUT ?? '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: exe });
try {
    const page = await browser.newPage({ viewport: { width: 760, height: 560 }, deviceScaleFactor: 2 });
    page.on('pageerror', e => console.log('pageerror', e.message));
    await page.goto(BASE);
    await page.locator('button', { hasText: 'Set up' }).click();
    await sleep(900);
    await page.locator('button', { hasText: '4 digits' }).click();
    for (let step = 0; step < 2; step++) {          // enter, then confirm
        await sleep(500);
        await page.keyboard.type('4821', { delay: 60 });
        await sleep(500);
    }
    await page.waitForSelector('[data-testid="lock-preview-suggestion"]', { timeout: 8000 });
    await sleep(900);                                // card-in animation
    console.log('before:', await page.textContent('#readout'));
    await page.screenshot({ path: `${OUT}/lock-preview-suggest.png` });
    if (process.env.HIDE === '1') {
        await page.locator('button', { hasText: 'Hide previews' }).click();
        await sleep(400);
        console.log('after Hide:', await page.textContent('#readout'));
        await page.screenshot({ path: `${OUT}/lock-preview-suggest-done.png` });
    }
} finally {
    await browser.close();
}
