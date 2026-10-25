// Settings redesign: screenshot every pane of the REAL SettingsScreen at 1280×800.
//
//   npx vite --config harness/settings-redesign.vite.config.ts      (serves :5311)
//   node harness/settings-redesign-shots.mjs <outDir> [tab,tab,...]
//
// Per pane: <tab>.png (the 1280×800 window as a user sees it, motion ON, after the
// entrance settles) and <tab>-full.png (the whole pane, scroll container unrolled).
// EXTRA=1 also shoots disclosure-open states (after-redesign only).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5311/harness/settings-redesign.html';
const OUT = process.argv[2] ?? '/tmp/settings-redesign';
const TABS = (process.argv[3] ?? 'profile,appearance,devices,voice,notifications,keybinds,activity,privacy,storage,billing,advanced,danger').split(',');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UNROLL = `.sd-root.sd-win{height:calc(100vh - 80px)!important}`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: process.env.REDUCED === '1' ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
    for (const tab of TABS) {
        await page.goto(`${BASE}?tab=${tab}${process.env.QS ?? ''}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForFunction(() => window.__booted === true, null, { timeout: 180000 });
        await page.waitForSelector('.sd-pane', { timeout: Number(process.env.WAIT ?? 180000) });
        await sleep(Number(process.env.SETTLE ?? 2500));
        await page.screenshot({ path: `${OUT}/${tab}.png` });
        const tall = await page.evaluate(() => document.querySelector('.sd-main').scrollHeight);
        await page.setViewportSize({ width: 1280, height: Math.min(9000, tall + 160) });
        const style = await page.addStyleTag({ content: UNROLL });
        await sleep(900);
        await page.screenshot({ path: `${OUT}/${tab}-full.png` });
        await style.evaluate(n => n.remove());
        await page.setViewportSize({ width: 1280, height: 800 });
        await sleep(400);
        if (process.env.EXTRA === '1') {
            const toggles = page.locator('.sx-disc > .sx-disc-head');
            const n = await toggles.count();
            if (n > 0) {
                for (let i = 0; i < n; i++) {
                    const t = toggles.nth(i);
                    if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
                }
                await sleep(800);
                await page.locator('.sx-disc').first().scrollIntoViewIfNeeded();
                await sleep(400);
                await page.screenshot({ path: `${OUT}/${tab}-open.png` });
                // put them back so the remembered state does not leak into the next run
                for (let i = 0; i < n; i++) await toggles.nth(i).click();
                await sleep(300);
            }
        }
        console.log('shot', tab);
    }
} finally {
    if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
    await browser.close();
}
