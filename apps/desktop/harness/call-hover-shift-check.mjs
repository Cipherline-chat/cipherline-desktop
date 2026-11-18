// Hover-shift measurement for the Calls / Voice sections of the server panel.
//   WS_PORT=5391 npx vite --config harness/window-sizes.vite.config.ts   (another shell)
//   node harness/call-hover-shift-check.mjs [--shots=<dir>] [--control]
// For each hover target, snapshots every element's getBoundingClientRect inside #panel at rest and
// while hovered, and reports the largest |dx|/|dy|/|dw|/|dh| among elements that exist at rest
// (zero-size boxes at rest are the hover-only controls themselves and are skipped).
// --control injects `.group:hover{padding-top:6px}` so the check MUST report a shift.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';
const URL = `http://127.0.0.1:${process.env.WS_PORT ?? 5391}/harness/window-sizes.html?scene=callhover`;
const shots = arg('shots', '');
const control = process.argv.includes('--control');
if (shots) fs.mkdirSync(shots, { recursive: true });
const SIZES = [
  { id: 'min', width: 1000, height: 720, dsf: 1 }, { id: 'laptop', width: 1366, height: 768, dsf: 1 },
  { id: 'large', width: 1920, height: 1080, dsf: 1 }, { id: 'hidpi', width: 1280, height: 800, dsf: 1.5 },
];
const TARGETS = [
  { id: 'call-category-header', sel: '#panel [role="button"][aria-label^="Game Nights,"]' },
  { id: 'call-category-header-2', sel: '#panel [role="button"][aria-label^="Work,"]' },
  { id: 'huddle-row', sel: '#panel :text-is("lounge")' },
  { id: 'voice-channel-row', sel: '#panel :text-is("General Voice")' },
  { id: 'voice-participant-row', sel: '#panel .cursor-pointer.group.relative.isolate' },
];
const snap = () => {
  const out = []; const root = document.querySelector('#panel');
  // A header's own contents give up width to the "+"/"..." slot by design (the label gets the whole row
  // otherwise); only vertical position/height and the header's own box must stay put there.
  root.querySelectorAll('*').forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const inHeader = !!el.parentElement?.closest('[role="button"][aria-label$="category"]');
    out.push([i, inHeader ? 0 : r.x, r.y, inHeader ? 0 : r.width, r.height]);
  });
  return out;
};
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let bad = 0;
try {
  for (const s of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dsf });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('PAGEERROR', e.message));
    await page.goto(URL, { waitUntil: 'commit', timeout: 180000 });
    await page.waitForSelector('#panel [aria-label$="category"]', { timeout: 120000 });
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
    await page.waitForTimeout(1500);
    if (control) await page.addStyleTag({ content: '.group:hover{padding-top:6px !important}' });
    for (const t of TARGETS) {
      const loc = page.locator(t.sel).first();
      if (!(await loc.count())) { console.log(`${s.id} ${t.id}: NOT FOUND`); bad++; continue; }
      await page.mouse.move(1, 1); await page.waitForTimeout(350);
      const before = await page.evaluate(snap);
      await loc.hover(); await page.waitForTimeout(450);
      const after = await page.evaluate(snap);
      let max = 0, worst = null;
      for (let i = 0; i < before.length; i++) {
        const [, x, y, w, h] = before[i]; const [, x2, y2, w2, h2] = after[i];
        if (w === 0 && h === 0) continue;
        const d = Math.max(Math.abs(x - x2), Math.abs(y - y2), Math.abs(w - w2), Math.abs(h - h2));
        if (d > max) { max = d; worst = i; }
      }
      const shifted = max > 0.01;
      console.log(`${s.id} ${t.id}: max delta ${max.toFixed(2)}px${worst != null && shifted ? ` (el #${worst})` : ''}`);
      if (shifted) bad++;
      if (shots && t.id === 'call-category-header') await page.locator('#panel').screenshot({ path: path.join(shots, `${s.id}-${t.id}-hover.png`) });
    }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(bad ? `SHIFT DETECTED in ${bad} case(s)` : 'ALL ZERO');
process.exit(bad ? 1 : 0);
