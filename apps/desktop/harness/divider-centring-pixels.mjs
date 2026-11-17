// Pixel-level check that a divider's rule(s) sit on the vertical middle of the
// label's CAPS (screenshot-based, so real font rendering, not metrics).
//   SCL_PORT=5231 node harness/divider-centring-pixels.mjs
import { chromium, exe } from './reaction-center-measure.mjs';
const port = process.env.SCL_PORT ?? 5231;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let bad = 0;
for (const dsf of [1, 1.25, 1.5, 2]) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/harness/subcat-list.html?scene=styles`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(400);
  for (const [id, word] of [['community', 'TEST'], ['s-header', 'TEST'], ['s-pill', 'TEST']]) {
    await page.evaluate(([i, w]) => { document.querySelector(`[data-divider-id="${i}"] span.truncate`).textContent = w; }, [id, word]);
    await page.mouse.move(2, 2);
    const loc = page.locator(`[data-divider-id="${id}"]`);
    const png = await loc.screenshot();
    const r = await page.evaluate(async ({ b64, id, dsf }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data;
      const el = document.querySelector(`[data-divider-id="${id}"] span.truncate`).getBoundingClientRect();
      const row = document.querySelector(`[data-divider-id="${id}"]`).getBoundingClientRect();
      const lum = (x, y) => { const i = (y * c.width + x) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; };
      const x0 = Math.floor((el.left - row.left) * dsf), x1 = Math.ceil((el.right - row.left) * dsf);
      const bg = lum(1, 1);
      const rows = (xa, xb, thr) => { const out = []; for (let y = 0; y < c.height; y++) { let hit = false; for (let x = xa; x < xb; x++) if (lum(x, y) - bg > thr) { hit = true; break; } if (hit) out.push(y); } return out; };
      const text = rows(x0 + 1, x1 - 1, 70);
      const xr = id === 's-header' ? Math.floor(c.width - 30 * dsf) : Math.floor(Math.max(4, (el.left - row.left) * dsf - 50 * dsf));
      const rule = rows(xr, xr + 8, 6);
      return { text: [text[0], text[text.length - 1]], rule, h: c.height };
    }, { b64: png.toString('base64'), id, dsf });
    const capMid = (r.text[0] + r.text[1]) / 2;
    const ruleMid = r.rule.reduce((a, b) => a + b, 0) / r.rule.length;
    const ok = Math.abs(capMid - ruleMid) <= 0.75 * Math.max(1, dsf);
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} dsf=${dsf} ${id}: caps y ${r.text[0]}..${r.text[1]} (mid ${capMid}), rule y ${r.rule.join(',')} (mid ${ruleMid.toFixed(2)}), delta ${(ruleMid - capMid).toFixed(2)} device px`);
  }
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
