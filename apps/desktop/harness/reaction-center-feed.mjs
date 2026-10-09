/* eslint-disable -- harness driver, not shipped */
// The owner's flow in ChatPane's real feed shell: an image message with a
// reaction is the LAST message; a follow-up is then appended through ChatPane's
// own FLIP reveal + entrance animation. Measures the image's chip BEFORE and
// AFTER (emoji centre minus chip centre, css px; + low, - high).
//
//   RXC_PORT=5217 node harness/reaction-center-feed.mjs [--dsf=1,1.25,...] [--grow=0,5,10,...]
//
// --grow adds that many px to the follow-up row's height (a taller message
// moves the feed by a different fraction).
import { chromium, exe, arg, skewOf } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';
const port = process.env.RXC_PORT ?? 5217;
const dsfs = arg('dsf', '1,1.25,1.5,2').split(',').map(Number);
const grows = arg('grow', '0,0.25,0.5,0.75').split(',').map(Number);
const shots = arg('shots', '');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const rows = [];
try {
  for (const dsf of dsfs) {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 600 }, deviceScaleFactor: dsf });
    const page = await ctx.newPage();
    const scratch = await ctx.newPage(); await scratch.goto('about:blank');
    for (const wc of [1, 0]) for (const grow of grows) {
      await page.goto(`http://127.0.0.1:${port}/harness/reaction-center.html?scene=feed&wc=${wc}&grow=${grow}`, { waitUntil: 'commit', timeout: 180000 });
      await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
      await page.waitForTimeout(900);
      const boxOf = () => page.evaluate(() => { const r = document.querySelector('[data-target-wrap] button').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
      const shoot = (clip) => page.screenshot({ clip, animations: 'disabled' });
      const [a] = await skewOf(shoot, scratch, [await boxOf()], dsf);
      await page.evaluate('window.__follow()');
      await page.waitForFunction('window.__flipDone === true && window.__enterDone === true', null, { timeout: 10000 });
      await page.waitForTimeout(500);
      const [b] = await skewOf(shoot, scratch, [await boxOf()], dsf);
      rows.push({ dsf, wc, grow, last: a.skew, followed: b.skew });
      if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, `feed-wc${wc}-grow${grow}-dsf${dsf}-last.png`), a.buf); fs.writeFileSync(path.join(shots, `feed-wc${wc}-grow${grow}-dsf${dsf}-followed.png`), b.buf); }
    }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log('dsf   wc  grow   last(css)  followed(css)  change');
for (const r of rows) console.log(String(r.dsf).padEnd(6) + String(r.wc).padEnd(4) + String(r.grow).padEnd(7) + r.last.toFixed(2).padEnd(11) + r.followed.toFixed(2).padEnd(15) + (r.followed - r.last).toFixed(2));
console.log(`\nworst |skew| = ${Math.max(...rows.flatMap(r => [Math.abs(r.last), Math.abs(r.followed)])).toFixed(2)}; worst before->after change = ${Math.max(...rows.map(r => Math.abs(r.followed - r.last))).toFixed(2)} css px`);
