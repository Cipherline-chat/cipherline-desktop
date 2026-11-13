// OUT=<dir> TAG=before|after node harness/cosmetics-everywhere-shots.mjs
// (server: npx vite --config harness/cosmetics-everywhere.vite.config.ts, PORT 5351 by default)
// Writes <TAG>-page.png (rail + Friends), <TAG>-rail.png (bottom-left avatar, zoomed) and <TAG>-friends-rows.png.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5351/harness/cosmetics-everywhere.html';
const OUT = process.env.OUT; const TAG = process.env.TAG ?? 'x';
if (!OUT) throw new Error('OUT=<dir> required');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 860, height: 720 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000); // a cold vite dev server transforms hundreds of modules on first load
  let errors = 0;
  page.on('pageerror', e => { errors++; console.log('FAIL pageerror ' + e.message); });
  await page.goto(BASE);
  await page.waitForSelector('.fp-row');
  await page.waitForSelector('[data-decoration]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const decos = await page.evaluate(() => [...document.querySelectorAll('[data-decoration]')].length);
  console.log(`${TAG}: ${decos} decorated avatars on screen`);
  await page.screenshot({ path: `${OUT}/${TAG}-page.png` });
  // Page-level clips (an element screenshot of a scroll container / pinned rail scrolls the wrong box).
  await page.screenshot({ path: `${OUT}/${TAG}-rail.png`, clip: { x: 0, y: 620, width: 72, height: 100 } });
  const rows = await page.locator('.fp-body').first().boundingBox();
  await page.screenshot({ path: `${OUT}/${TAG}-friends-rows.png`, clip: { x: rows.x, y: rows.y, width: rows.width, height: Math.min(rows.height, 720 - rows.y) } });
  console.log(`SHOT ${OUT}/${TAG}-{page,rail,friends-rows}.png errors=${errors}`);
} finally { await browser.close(); }
