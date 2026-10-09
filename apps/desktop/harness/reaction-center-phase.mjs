/* eslint-disable -- harness driver, not shipped */
// Sub-pixel PHASE sweep of the bare reaction chip (scene=phase of
// reaction-center-main.tsx): 32 chips at successive 1/16-px fractional offsets,
// measured on painted pixels at several display scales.
//
//   RXC_PORT=5217 node harness/reaction-center-phase.mjs [--dsf=1,1.25,...] [--emoji=...] [--shots=<dir>]
//
// Per scale it prints, in DEVICE px, the range of (ink top - chip top) and of
// (chip bottom - ink bottom) across all phases. A chip that is centred
// independent of where it lands has the same value at every phase; "swing" is
// the change in the top/bottom imbalance (css px) between the best and worst
// phase - the emoji visibly jumping up or down a device pixel depending only on
// where in the scroll feed the chip happens to sit.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=').slice(1).join('=');
const port = process.env.RXC_PORT ?? 5217;
const dsfs = arg('dsf', '1,1.25,1.5,1.75,2,2.5,3').split(',').map(Number);
const emoji = arg('emoji', '\u{1F534}');
const shots = arg('shots', '');
const N = 32;

// Sub-pixel measurement. The chip is a rounded rect and Chrome paints it with
// anti-aliased edges at fractional positions, so "first non-background row" is
// the wrong ruler. Instead: the chip's centre line is the midpoint of its two
// 1px border lines (each located by luminance centroid), and the emoji's centre
// is the vertical centroid of its red mass. skew = emoji centre - chip centre.
const analyse = `(async (b64, rects) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const px = (i, j) => { const k = (j * c.width + i) * 4; return [d[k], d[k+1], d[k+2]]; };
  const lum = (p) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
  return rects.map(([l, t, w, h]) => {
    const cx = l + Math.floor(w / 2), mid = t + Math.floor(h / 2);
    const bgL = lum(px(cx, Math.max(0, t - 1))); // page/case background above the chip
    let top = t; while (top < mid && lum(px(cx, top)) <= bgL + 1.5) top++;   // first row touched by the chip
    let bot = t + h - 1; while (bot > mid && lum(px(cx, bot)) <= bgL + 1.5) bot--; // last row touched
    const inner = lum(px(cx, top + 4)); // chip fill just inside the top border
    const cen = (j0, j1) => { let sw = 0, sj = 0; for (let j = j0; j <= j1; j++) { const wgt = Math.max(0, lum(px(cx, j)) - inner); sw += wgt; sj += wgt * (j + 0.5); } return sj / sw; };
    const topC = cen(top, top + 2), botC = cen(bot - 2, bot);
    let sw = 0, sj = 0, it = 1e9, ib = -1;
    for (let j = top; j <= bot; j++) for (let i = l; i < l + w; i++) {
      const p = px(i, j); const wgt = Math.max(0, p[0] - Math.max(p[1], p[2]) - 20);
      if (wgt > 0) { sw += wgt; sj += wgt * (j + 0.5); }
    }
    return { chipC: (topC + botC) / 2, inkC: sj / sw, chipH: botC - topC };
  });
})`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const out = [];
try {
  for (const dsf of dsfs) {
    const ctx = await browser.newContext({ viewport: { width: 200, height: 1500 }, deviceScaleFactor: dsf });
    const page = await ctx.newPage();
    const scratch = await ctx.newPage(); await scratch.goto('about:blank');
    await page.goto(`http://127.0.0.1:${port}/harness/reaction-center.html?scene=phase&n=${N}&emoji=${encodeURIComponent(emoji)}`, { waitUntil: 'commit', timeout: 180000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
    await page.waitForTimeout(800);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('[data-slot] button')].map(b => { const r = b.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }));
    const H = Math.ceil(boxes[boxes.length - 1][1] + 40);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 140, height: H }, animations: 'disabled' });
    if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, `phase-dsf${dsf}.png`), buf); }
    // chip rects in screenshot device px (generous, centred on the chip)
    const rects = boxes.map(([l, t, w, h]) => [Math.floor(l * dsf), Math.floor(t * dsf) - 2, Math.ceil(w * dsf), Math.ceil(h * dsf) + 4]);
    const res = await scratch.evaluate(`${analyse}(${JSON.stringify(buf.toString('base64'))}, ${JSON.stringify(rects)})`);
    const imb = res.map(r => (r.inkC - r.chipC) / dsf); // css px; + = emoji LOW, - = emoji HIGH
    if (process.env.RXC_VERBOSE) console.log(JSON.stringify(res[0]), JSON.stringify(rects[0]));
    if (process.env.RXC_VERBOSE) console.log(dsf, res.map((r, i) => `${boxes[i][1].toFixed(2)}:${imb[i].toFixed(2)}`).join(' '));
    const swing = Math.max(...imb) - Math.min(...imb);
    out.push({ dsf, minImb: Math.min(...imb), maxImb: Math.max(...imb), swing });
    await ctx.close();
  }
} finally { await browser.close(); }
console.log('dsf   emoji-centre minus chip-centre, css px [min..max]   swing(css)   (+ low, - high)');
for (const o of out) console.log(String(o.dsf).padEnd(6) + `${o.minImb.toFixed(2)}..${o.maxImb.toFixed(2)}`.padEnd(40) + o.swing.toFixed(2));
console.log(`\nworst swing = ${Math.max(...out.map(o => o.swing)).toFixed(2)} css px; worst |imbalance| = ${Math.max(...out.map(o => Math.max(Math.abs(o.minImb), Math.abs(o.maxImb)))).toFixed(2)} css px`);
