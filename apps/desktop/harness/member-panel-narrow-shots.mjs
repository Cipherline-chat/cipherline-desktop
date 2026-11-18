// Narrow right-panel check (RIGHT_PANEL_MIN_PX in Dashboard.tsx). Renders the REAL ServerContextPanel
// (harness/member-groups-main.tsx) at a given panel width x the four window sizes and fails on:
//   panel-hscroll  the panel scrolls sideways
//   overflow       an element's content is wider than its box and it is not an ellipsized line
//   clipped        a control (button/input/link) sticks out of the panel's box
//   overlap        two controls overlap
// `--broken` is the positive control: a 600px child inside the panel, the check MUST fail on it.
//
//   MG_PORT=5237 npx vite --config harness/member-groups.vite.config.ts   (another shell)
//   MG_PORT=5237 node harness/member-panel-narrow-shots.mjs --w=240 --out=<dir> [--broken]
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.MG_PORT ?? 5237;
const w = Number(arg('w', '240'));
const out = arg('out', '/tmp/member-panel-narrow');
const broken = process.argv.includes('--broken');
fs.mkdirSync(out, { recursive: true });
const SIZES = [
  { id: 'min', width: 1000, height: 720, dsf: 1 },
  { id: 'laptop', width: 1366, height: 768, dsf: 1 },
  { id: 'large', width: 1920, height: 1080, dsf: 1 },
  { id: 'hidpi', width: 1280, height: 800, dsf: 1.5 },
];
const VARIANTS = [
  { id: 'default', q: '' },
  { id: 'long', q: 'long=1' },
  { id: 'stale-hidden', q: 'stalehidden=1&long=1' },
  { id: 'call', q: 'call=1&long=1' },
];

const measure = `(() => {
  const panel = document.querySelector('#panel');
  const pr = panel.getBoundingClientRect();
  const probs = [];
  if (panel.scrollWidth > panel.clientWidth + 1) probs.push('panel-hscroll ' + panel.scrollWidth + '>' + panel.clientWidth);
  const label = (e) => (e.tagName + '.' + String(e.className).split(' ')[0] + ' "' + (e.textContent || '').trim().slice(0, 30) + '"');
  const ellipsized = (e) => { for (let n = e; n && n !== panel; n = n.parentElement) { if (getComputedStyle(n).textOverflow === 'ellipsis') return true; } return false; };
  for (const e of panel.querySelectorAll('*')) {
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) {
      const c = getComputedStyle(e);
      if (c.overflowX === 'auto' || c.overflowX === 'scroll') continue;
      if (c.overflowX === 'visible') { const r = e.getBoundingClientRect(); const ex = [...e.querySelectorAll('*')].some(k => k.getBoundingClientRect().right > pr.right + 1); if (!ex) continue; }
      if (ellipsized(e)) continue;
      probs.push('overflow ' + label(e) + ' ' + e.scrollWidth + '>' + e.clientWidth);
    }
  }
  const ctl = [...panel.querySelectorAll('button, a, input, select, textarea, [role=button]')].filter(e => e.getBoundingClientRect().width > 0);
  for (const e of ctl) { const r = e.getBoundingClientRect(); if (r.left < pr.left - 1 || r.right > pr.right + 1) probs.push('clipped ' + label(e) + ' ' + Math.round(r.left - pr.left) + '..' + Math.round(r.right - pr.left)); }
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    if (ctl[i].contains(ctl[j]) || ctl[j].contains(ctl[i])) continue;
    const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect();
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 2 && oy > 2) probs.push('overlap ' + label(ctl[i]) + ' x ' + label(ctl[j]));
  }
  const heads = document.querySelectorAll('.cl-mgroup-head').length;
  return { probs, heads, panelW: Math.round(pr.width) };
})()`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
try {
  for (const s of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dsf });
    for (const v of VARIANTS) {
      const page = await ctx.newPage();
      page.on('pageerror', e => console.log('PAGEERROR', e.message));
      await page.goto(`http://127.0.0.1:${port}/harness/member-groups.html?w=${w}${v.q ? '&' + v.q : ''}${broken ? '&broken=1' : ''}`, { waitUntil: 'commit', timeout: 180000 });
      await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
      await page.waitForSelector('.cl-mgroup-head', { timeout: 60000 });
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
      await page.waitForTimeout(500);
      const r = await page.evaluate(measure);
      const ok = r.probs.length === 0 && r.heads >= 4 && r.panelW === w;
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  w=${w} ${s.id} ${v.id}  heads=${r.heads} panelW=${r.panelW}${r.probs.length ? '\n      ' + r.probs.slice(0, 6).join('\n      ') : ''}`);
      await page.locator('#panel').screenshot({ path: path.join(out, `${s.id}-${v.id}${broken ? '-BROKEN' : ''}.png`) });
      await page.close();
    }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(failed ? `\n${failed} case(s) FAILED` : '\nall cases passed');
process.exit(failed ? 1 : 0);
