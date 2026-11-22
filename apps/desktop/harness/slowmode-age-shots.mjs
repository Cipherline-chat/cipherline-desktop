// node harness/slowmode-age-shots.mjs --out=<dir>   (vite harness running on SM_PORT)
// Every scene x {dark, light} x {1000x720, 1366x768, 1920x1080, 1280x800 @1.5}; also fails on sideways page scroll.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
const BASE = `http://127.0.0.1:${process.env.SM_PORT ?? 5392}/harness/slowmode-age.html`;
const out = arg('out', '/tmp/slowmode-age');
fs.mkdirSync(out, { recursive: true });
const SIZES = [['min', 1000, 720, 1], ['laptop', 1366, 768, 1], ['large', 1920, 1080, 1], ['hidpi', 1280, 800, 1.5]];
const browser = await chromium.launch({ executablePath: exe });
let bad = 0;
for (const scene of ['gate', 'settings', 'chat'])
  for (const theme of ['dark', 'light'])
    for (const [id, w, h, dsf] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
      const page = await ctx.newPage();
      await page.goto(`${BASE}?scene=${scene}&theme=${theme}`);
      await page.waitForTimeout(900);
      const hs = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (hs) { bad++; console.log(`FAIL sideways scroll ${scene}/${theme}/${id}`); }
      if (scene === 'gate') {
        const focus = await page.evaluate(() => document.activeElement?.textContent ?? '');
        if (!/Go back/.test(focus)) { bad++; console.log(`FAIL focus not on Go back: "${focus}"`); }
      }
      await page.screenshot({ path: `${out}/${scene}-${theme}-${id}.png` });
      await ctx.close();
    }
await browser.close();
console.log(bad ? `${bad} problems` : 'all scenes OK');
process.exit(bad ? 1 : 0);
