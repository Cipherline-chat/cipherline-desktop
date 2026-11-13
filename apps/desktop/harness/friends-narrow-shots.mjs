// OUT=<dir> TAG=before|after node harness/friends-narrow-shots.mjs   (server: npx vite --config harness/friends-narrow.vite.config.ts)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5341/harness/friends-narrow.html';
const OUT = process.env.OUT; const TAG = process.env.TAG ?? 'x';
mkdirSync(OUT, { recursive: true });
const widths = (process.env.WIDTHS ?? '320,400,560,640,760,1100').split(',').map(Number);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
for (const long of [0, 1]) for (const w of widths) {
  const page = await browser.newPage({ viewport: { width: w + 20, height: 780 }, deviceScaleFactor: 1.5 });
  await page.goto(`${BASE}?w=${w}${long ? '&long=1' : ''}`);
  await page.waitForSelector('.fp-root');
  await page.getByText('Pending', { exact: false }).first().click();
  await page.waitForSelector('.fp-sheet');
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.fp-row')].map(r => {
      const rr = r.getBoundingClientRect();
      const btns = [...r.querySelectorAll('button, .fp-pending')].map(b => { const x = b.getBoundingClientRect(); return { t: (b.textContent || b.getAttribute('aria-label') || '').trim(), l: Math.round(x.left), r: Math.round(x.right), w: Math.round(x.width) }; });
      const clip = [...r.querySelectorAll('.fp-name, .fp-sub, .fp-sub *')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className + ':' + (e.textContent || '').slice(0, 20));
      return { rowR: Math.round(rr.right), rowH: Math.round(rr.height), btns, clip, overflowX: r.scrollWidth > r.clientWidth + 1 };
    });
    const b = document.querySelector('.fp-body');
    return { scrollW: b.scrollWidth, clientW: b.clientWidth, rows };
  });
  const bad = m.rows.filter(r => r.clip.length || r.overflowX || r.btns.some(b => b.r > r.rowR));
  console.log(`${TAG} w=${w} long=${long} bodyOverflow=${m.scrollW > m.clientW} rows=${m.rows.length} clippedRows=${bad.length}`, bad.length ? JSON.stringify(bad[0]) : '');
  await page.screenshot({ path: `${OUT}/${TAG}-${w}${long ? '-long' : ''}.png`, clip: { x: 0, y: 0, width: w + 20, height: 780 } });
  await page.close();
}
await browser.close();
