// Screenshots of the sign-in history step and the own-device transfer screens at the owner's window sizes.
// Also checks: the dialog fits the window, no horizontal overflow, and the picker's Continue asks the chosen device.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5341/harness/history-transfer.html';
const OUT = process.env.OUT ?? '/tmp/history-transfer-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sizes = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];
const scenes = process.env.SCENES ? process.env.SCENES.split(',') : ['signin', 'unavailable', 'picker', 'wait', 'wait-slow', 'holder', 'gate', 'progress', 'paused', 'details', 'done', 'nonet', 'declined', 'noanswer', 'space', 'peercancel', 'failed', 'settings'];
let failures = 0;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const [name, w, h, dsf] of sizes) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
        const mainPage = await ctx.newPage();
        for (const scene of scenes) {
            // the fake clock sticks to a page: the slow-answer scene gets its own, so later scenes run on real time
            const page = scene === 'wait-slow' ? await ctx.newPage() : mainPage;
            page.setDefaultNavigationTimeout(240_000);
            if (page !== mainPage || !mainPage.__wired) { page.on('pageerror', e => { failures++; console.log('FAIL pageerror ' + e.message); }); if (page === mainPage) mainPage.__wired = true; }
            if (scene === 'wait-slow') await page.clock.install();
            await page.goto(`${BASE}?scene=${scene}`);
            await sleep(scene === 'done' || scene === 'details' ? 3000 : 1300);
            if (scene === 'wait-slow') { await page.clock.fastForward(21_000); await sleep(400); }
            const card = await page.locator('.mcard').first().boundingBox().catch(() => null);
            if (card) {
                const ok = card.x >= 0 && card.x + card.width <= w && card.y >= 0 && card.y + card.height <= h;
                console.log(`${ok ? 'PASS' : 'FAIL'} ${scene} dialog fits ${name}`); if (!ok) failures++;
            }
            const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
            if (over) { failures++; console.log(`FAIL ${scene} horizontal overflow ${name}`); }
            await page.screenshot({ path: `${OUT}/${scene}-${name}.png` });
            console.log(`SHOT ${OUT}/${scene}-${name}.png`);
            if (page !== mainPage) await page.close();
            if (scene === 'picker') {
                await page.getByRole('radio', { name: /Desk PC/ }).click();
                await page.getByRole('button', { name: 'Continue' }).click();
                await sleep(400);
                const log = await page.evaluate(() => JSON.stringify(window.__log));
                const ok = log.includes('"deviceId":"dev-desk"') && log.includes('"ownDeviceId":"dev-new"');
                console.log(`${ok ? 'PASS' : 'FAIL'} picker Continue asks Desk PC (${log})`); if (!ok) failures++;
            }
        }
        await ctx.close();
    }
} finally { await browser.close(); }
console.log(failures ? `FAILURES ${failures}` : 'ALL PASS');
process.exit(failures ? 1 : 0);
