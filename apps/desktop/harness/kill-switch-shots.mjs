// Kill-switch blocking screens: screenshots every state + checks the screen really blocks.
//   npx vite --config harness/kill-switch.vite.config.ts     (serves :5241)
//   node harness/kill-switch-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// Launches (and closes) its OWN headless browser; nothing is left running.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5241/harness/kill-switch.html';
const OUT = process.env.OUT ?? '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCREENS = ['update', 'update-downloading', 'update-ready', 'update-failed', 'suspended', 'suspended-plain', 'back'];

const browser = await chromium.launch({ executablePath: exe });
try {
    for (const reduced of [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(120_000);
        page.on('pageerror', e => console.log('pageerror', e.message));
        for (const s of (reduced ? ['suspended'] : SCREENS)) {
            await page.goto(`${BASE}?screen=${s}`);
            await page.waitForSelector('.cb-card');
            await page.evaluate(() => document.fonts.ready);
            await sleep(s === 'back' ? 300 : 1200); // entrance animation
            const name = `kill-switch-${s}${reduced ? '-reduced-motion' : ''}.png`;
            await page.screenshot({ path: `${OUT}/${name}` });
            const info = await page.evaluate(() => ({
                rootInert: document.getElementById('root').inert,
                active: document.activeElement?.textContent?.trim().slice(0, 40),
                role: document.querySelector('.cb-root')?.getAttribute('role'),
            }));
            // A click on the app underneath must land on the blocking screen instead.
            const hit = await page.evaluate(() => {
                const r = document.getElementById('under').getBoundingClientRect();
                const el = document.elementFromPoint(r.left + 5, r.top + 5);
                return el?.closest('.cb-root') ? 'screen' : el?.id || el?.tagName;
            });
            console.log(name, JSON.stringify({ ...info, clickAtAppButtonHits: hit }));
        }
        // Keyboard: Tab cycles inside; it never reaches the app's button.
        if (!reduced) {
            await page.goto(`${BASE}?screen=suspended`);
            await page.waitForSelector('.cb-card');
            await sleep(400);
            const seen = [];
            for (let i = 0; i < 6; i++) {
                await page.keyboard.press('Tab');
                seen.push(await page.evaluate(() => (document.activeElement?.closest('.cb-root') ? 'in:' : 'OUT:') + (document.activeElement?.textContent?.trim().slice(0, 16) || document.activeElement?.tagName)));
            }
            await page.keyboard.press('Escape');
            const still = await page.$('.cb-root');
            console.log('tab cycle', JSON.stringify(seen), 'after Escape still shown:', !!still);
        }
        await ctx.close();
    }
} finally {
    await browser.close();
}
