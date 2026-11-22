// Status backing screenshots.  SB_PORT=5461 npx vite --config harness/status-backing.vite.config.ts   (another shell)
//   node harness/status-backing-shots.mjs <outDir>
// Per theme: whole sheet at 1366x768, x4 crops of every context (rest + hovered row), and one 1280x800@1.5.
import { chromium, exe } from './reaction-center-measure.mjs';
import fs from 'fs';
const BASE = `http://127.0.0.1:${process.env.SB_PORT ?? 5461}/harness/status-backing.html`;
const OUT = process.argv[2] ?? '/tmp/status-backing';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const THEMES = (process.env.SB_THEMES ?? 'dark,light,midnight,hc-dark,hc-light').split(',');
async function open(w, h, dsf, theme) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => console.log('PAGEERR', e.message));
    await page.goto(`${BASE}?theme=${theme}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__booted === true);
    await sleep(2500);
    return { ctx, page };
}
for (const theme of THEMES) {
    const { ctx, page } = await open(1366, 768, 1, theme);
    await page.screenshot({ path: `${OUT}/${theme}-sheet-1366x768.png` });
    await ctx.close();
    const c4 = await open(1366, 768, 4, theme);
    for (const id of ['members', 'dms', 'friends', 'deck', 'profile', 'picker']) {
        await c4.page.locator(`#${id}`).screenshot({ path: `${OUT}/${theme}-${id}-x4.png` });
        if (['members', 'dms', 'friends', 'deck'].includes(id)) {
            for (const st of ['away', 'offline']) {
                await c4.page.locator(`#${id} [data-row=${st}]`).hover(); await sleep(450);
                await c4.page.locator(`#${id}`).screenshot({ path: `${OUT}/${theme}-${id}-hover-${st}-x4.png` });
            }
            await c4.page.mouse.move(0, 0);
        }
    }
    await c4.ctx.close();
    console.log('done', theme);
}
const { ctx } = await open(1280, 800, 1.5, 'dark');
await ctx.pages()[0].screenshot({ path: `${OUT}/dark-sheet-1280x800-1.5.png` });
await ctx.close();
await browser.close();
