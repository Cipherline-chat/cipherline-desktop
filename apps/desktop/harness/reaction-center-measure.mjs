/* eslint-disable -- harness helper, not shipped */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
export const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
export const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=').slice(1).join('=');

// Sub-pixel measurement. The chip is a rounded rect and Chrome paints it with
// anti-aliased edges at fractional positions, so "first non-background row" is
// the wrong ruler. Instead: the chip's centre line is the midpoint of its two
// 1px border lines (each located by luminance centroid), and the emoji's centre
// is the vertical centroid of its red mass. skew = emoji centre - chip centre.
export const analyse = `(async (b64, rects) => {
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


/**
 * Screenshot a clip around each button (CSS px rects [l, t, w, h]) and return,
 * per button, emoji-centre minus chip-centre in CSS px (+ = emoji LOW, - = HIGH).
 * `shoot(clip)` -> PNG Buffer; `scratch` is a blank page used to decode pixels.
 */
export async function skewOf(shoot, scratch, boxes, dsf) {
  const out = [];
  for (const [l, t, w, h] of boxes) {
    // Clip origin on a multiple of 4 css px: that is a whole number of device px at every
    // 0.25-step scale, so the capture is a straight copy of the painted pixels, not a resample.
    const cx0 = Math.floor(l / 4) * 4 - 4, cy0 = Math.floor(t / 4) * 4 - 4;
    const clip = { x: cx0, y: cy0, width: Math.ceil(l + w - cx0) + 4, height: Math.ceil(t + h - cy0) + 4 };
    const buf = await shoot(clip);
    const rect = [Math.floor((l - clip.x) * dsf), Math.floor((t - clip.y) * dsf) - 2, Math.ceil(w * dsf), Math.ceil(h * dsf) + 4];
    const [r] = await scratch.evaluate(`${analyse}(${JSON.stringify(buf.toString('base64'))}, ${JSON.stringify([rect])})`);
    out.push({ skew: (r.inkC - r.chipC) / dsf, buf });
  }
  return out;
}
