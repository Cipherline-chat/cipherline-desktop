// OUT=<dir> node harness/friends-activity-shots.mjs   (server: npx vite --config harness/friends-activity.vite.config.ts)
// Screens the panel per scenario x width, checks for horizontal overflow / clipped controls,
// then stitches overview.png.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5347/harness/friends-activity.html';
const OUT = process.env.OUT;
mkdirSync(OUT, { recursive: true });
const widths = (process.env.WIDTHS ?? '280,360').split(',').map(Number);
const scenarios = (process.env.SCENARIOS ?? 'busy,quiet,nofriends,loading').split(',');
const H = 1000;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const shots = [];
for (const s of scenarios) for (const w of widths) {
  for (const reduced of s === 'busy' && w === 280 ? [false, true] : [false]) {
    const page = await browser.newPage({ viewport: { width: w, height: H }, deviceScaleFactor: 2, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    page.setDefaultTimeout(180_000); // first load: vite's cold dependency optimise
    const logs = [];
    page.on('console', m => { if (m.type() === 'error') logs.push(m.text()); });
    page.on('pageerror', err => logs.push(String(err)));
    await page.goto(`${BASE}?w=${w}&s=${s}`);
    await page.waitForSelector('.fa-root');
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => {
      const host = document.getElementById('host');
      const clipped = [...document.querySelectorAll('.fa-join, .fa-here, .fa-time, .fa-card-kind')]
        .filter(el => { const r = el.getBoundingClientRect(); const h = host.getBoundingClientRect(); return r.right > h.right + 0.5 || r.left < h.left - 0.5; })
        .map(el => el.className);
      return {
        overflowX: host.scrollWidth > host.clientWidth + 1,
        cards: document.querySelectorAll('.fa-card').length,
        rows: document.querySelectorAll('.fa-rrow').length,
        ghost: document.body.textContent.includes('Ghost') || document.body.textContent.includes('SHOULD NOT SHOW'),
        clipped,
      };
    });
    console.log(`${s} w=${w}${reduced ? ' reduced' : ''}`, JSON.stringify(m), logs.length ? `errors=${JSON.stringify(logs.slice(0, 3))}` : '');
    const name = `${s}-${w}${reduced ? '-reduced' : ''}.png`;
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: false });
    if (!reduced) shots.push({ name, s, w });
    // Keyboard focus ring on the first card (busy only).
    if (s === 'busy' && !reduced) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/${s}-${w}-focus.png`, clip: { x: 0, y: 0, width: w, height: 260 } });
    }
    await page.close();
  }
}
// Composite overview: every shot side by side, labelled.
const overview = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
const { readFileSync } = await import('node:fs');
const tiles = shots.map(x => `<figure><figcaption>${x.s} · ${x.w}px</figcaption><img src="data:image/png;base64,${readFileSync(`${OUT}/${x.name}`).toString('base64')}" style="width:${x.w}px;height:${H}px"></figure>`).join('');
await overview.setContent(`<body style="margin:0;padding:24px;background:#05070f;display:flex;gap:20px;align-items:flex-start;font:600 14px Nunito,sans-serif;color:#A7B3D4;width:max-content">${tiles}<style>figure{margin:0}figcaption{margin:0 0 8px}img{display:block;border-radius:16px;outline:1px solid #2A3558}</style></body>`);
await overview.waitForTimeout(300);
await overview.screenshot({ path: `${OUT}/overview.png`, fullPage: true });
await browser.close();
