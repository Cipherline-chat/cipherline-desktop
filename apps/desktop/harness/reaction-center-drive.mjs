/* eslint-disable -- harness driver, not shipped */
// The reaction chip in each message shape the owner compares, measured on
// PAINTED pixels (see reaction-center-measure.mjs): emoji centre minus chip
// centre, in CSS px (+ = emoji LOW, - = emoji HIGH). Every shape must agree.
//
//   RXC_PORT=5217 node harness/reaction-center-drive.mjs [--dsf=1,1.25,1.5,2] [--phases=0,0.25,0.5,0.75] [--shots=<dir>]
//
// Shapes (reaction-center-main.tsx, scene=static):
//   text               text message with a reaction
//   text-mine          the same, a reaction that is mine (lume-tinted chip)
//   image-alone        image message (fractional-height photo) with a reaction
//   image-followed     the same image message with another message under it
//   continuation-text  a grouped continuation text message with a reaction
// `--phases` shifts every shape by that many fractional px (a scroll phase).
import { chromium, exe, arg, skewOf } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.RXC_PORT ?? 5217;
const dsfs = arg('dsf', '1,1.25,1.5,2').split(',').map(Number);
const phases = arg('phases', '0,0.25,0.5,0.75').split(',').map(Number);
const shots = arg('shots', '');
const extra = arg('q', ''); // extra page query, e.g. enter=sent
const emoji = arg('emoji', '\u{1F534}');
const CASES = ['text', 'text-mine', 'image-alone', 'image-followed', 'continuation-text'];

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const rows = [];
try {
  for (const dsf of dsfs) {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 1500 }, deviceScaleFactor: dsf });
    const page = await ctx.newPage();
    const scratch = await ctx.newPage(); await scratch.goto('about:blank');
    for (const off of phases) {
      await page.goto(`http://127.0.0.1:${port}/harness/reaction-center.html?${extra}&off=${off}&emoji=${encodeURIComponent(emoji)}`, { waitUntil: 'commit', timeout: 180000 });
      await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
      await page.waitForTimeout(800); // image decode + pill mount animation settle
      const shoot = (clip) => page.screenshot({ clip, animations: 'disabled' });
      for (const id of CASES) {
        const r = await page.locator(`[data-case="${id}"] button`).first().boundingBox();
        const [m] = await skewOf(shoot, scratch, [[r.x, r.y, r.width, r.height]], dsf);
        rows.push({ dsf, off, id, y: r.y, skew: m.skew });
        if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, `${id}-dsf${dsf}-off${off}.png`), m.buf); }
      }
    }
    await ctx.close();
  }
} finally { await browser.close(); }

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('dsf', 6) + pad('phase', 7) + CASES.map(c => pad(c, 19)).join(''));
for (const dsf of dsfs) for (const off of phases) {
  const line = rows.filter(r => r.dsf === dsf && r.off === off);
  console.log(pad(dsf, 6) + pad(off, 7) + CASES.map(c => pad(line.find(x => x.id === c).skew.toFixed(2), 19)).join(''));
}
const worst = Math.max(...rows.map(r => Math.abs(r.skew)));
const spread = Math.max(...rows.map(r => r.skew)) - Math.min(...rows.map(r => r.skew));
console.log(`\nworst |skew| = ${worst.toFixed(2)} css px; spread across every shape/phase/scale = ${spread.toFixed(2)} css px`);
