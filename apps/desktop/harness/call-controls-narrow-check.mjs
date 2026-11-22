// Docked call console at narrow panel widths (2026-11-19, "with the side bar being as small as it goes now
// the call controls looks broke"). Renders harness/window-sizes-main.tsx ?scene=incall — the REAL ControlBar
// in Dashboard's pane4 shape over the REAL ServerContextPanel, self row with a long name + custom status —
// at each panel width x each window size x each console state, and fails on:
//   outside-capsule  a control sticks out of the capsule (.cl-console-inner)
//   outside-panel    a control or the capsule sticks out of the panel
//   small            a control is under 28px (the minimum hit target)
//   overlap          two controls overlap
//   row-under-pill   scrolled to the end, a row of the panel still sits under the pill (the pb-24 clearance)
//   panel-hscroll    the panel scrolls sideways
// `--legacy` is the positive control: the console CSS as it was before the narrow tier — the check MUST fail.
//
//   WS_PORT=5391 npx vite --config harness/window-sizes.vite.config.ts      (another shell)
//   WS_PORT=5391 node harness/call-controls-narrow-check.mjs --out=<dir> [--widths=240,260,...|max] [--legacy]
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.WS_PORT ?? 5391;
const out = arg('out', '/tmp/call-controls-narrow');
const legacy = process.argv.includes('--legacy');
const widths = arg('widths', '240,250,260,280,320,400,max').split(',');
fs.mkdirSync(out, { recursive: true });
const SIZES = [
  { id: 'min', width: 1000, height: 720, dsf: 1 },
  { id: 'laptop', width: 1366, height: 768, dsf: 1 },
  { id: 'large', width: 1920, height: 1080, dsf: 1 },
  { id: 'hidpi', width: 1280, height: 800, dsf: 1.5 },
].filter(s => !arg('sizes', '') || arg('sizes', '').split(',').includes(s.id));
const STATES = [
  { id: 'idle', q: '' },
  { id: 'share', q: 'share=1' },
  { id: 'cam', q: 'cam=1' },
  { id: 'joining', q: 'joining=1' },
  { id: 'enc-mixed', q: 'enc=mixed' },
  { id: 'scrolled', q: 'scroll=bottom' },
];

const measure = `(() => {
  const panel = document.querySelector('#panel');
  const pr = panel.getBoundingClientRect();
  const cap = document.querySelector('#call-controlbar-root .cl-console-inner');
  const cr = cap.getBoundingClientRect();
  const probs = [];
  const r1 = (n) => Math.round(n * 10) / 10;
  if (panel.scrollWidth > panel.clientWidth + 1) probs.push('panel-hscroll ' + panel.scrollWidth + '>' + panel.clientWidth);
  if (cr.left < pr.left - 0.5 || cr.right > pr.right + 0.5) probs.push('outside-panel capsule ' + r1(cr.left - pr.left) + '..' + r1(cr.right - pr.left) + ' of ' + r1(pr.width));
  const ctl = [...cap.querySelectorAll('button, .cl-join-status')].filter(e => e.getBoundingClientRect().width > 0);
  const name = (e) => (e.getAttribute('title') || e.textContent || e.className).trim().slice(0, 24);
  for (const e of ctl) {
    const r = e.getBoundingClientRect();
    if (r.left < cr.left - 0.5 || r.right > cr.right + 0.5) probs.push('outside-capsule "' + name(e) + '" ' + r1(r.left - cr.left) + '..' + r1(r.right - cr.left) + ' of ' + r1(cr.width));
    if (r.right > pr.right + 0.5 || r.left < pr.left - 0.5) probs.push('outside-panel "' + name(e) + '"');
    if (e.tagName === 'BUTTON' && !e.classList.contains('cl-share-chev') && (r.width < 27.9 || r.height < 27.9)) probs.push('small "' + name(e) + '" ' + r1(r.width) + 'x' + r1(r.height));
  }
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect();
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 0.5 && oy > 0.5) probs.push('overlap "' + name(ctl[i]) + '" x "' + name(ctl[j]) + '"');
  }
  // Scrolled to the end, nothing of the panel's content may sit under the pill.
  const zone = document.querySelector('[data-call-scroll-zone]');
  const atEnd = zone.scrollTop + zone.clientHeight >= zone.scrollHeight - 1;
  const pillTop = document.querySelector('#call-controlbar-root').firstElementChild.getBoundingClientRect().top;
  let underPill = null;
  if (atEnd && zone.scrollTop > 0) {
    for (const e of zone.querySelectorAll('button, [role=button], span, p, h3')) {
      const r = e.getBoundingClientRect();
      if (r.height > 0 && r.width > 0 && r.bottom > pillTop + 1 && r.top < pillTop + 200 && (e.textContent || '').trim()) { underPill = name(e); break; }
    }
    if (underPill) probs.push('row-under-pill "' + underPill + '"');
  }
  const sizes = ctl.filter(e => e.tagName === 'BUTTON').map(e => Math.round(e.getBoundingClientRect().width));
  return { probs, panelW: r1(pr.width), capW: r1(cr.width), rowW: r1(ctl.length ? ctl[ctl.length - 1].getBoundingClientRect().right - ctl[0].getBoundingClientRect().left : 0), sizes, atEnd, scrolled: zone.scrollTop > 0 };
})()`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0, total = 0;
const results = [];
try {
  for (const s of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dsf });
    for (const w of widths) {
      for (const st of STATES) {
        const page = await ctx.newPage();
        page.on('pageerror', e => console.log('PAGEERROR', e.message));
        const url = `http://127.0.0.1:${port}/harness/window-sizes.html?scene=incall&selflong=1&rw=${w}${st.q ? '&' + st.q : ''}${legacy ? '&legacy=1' : ''}`;
        await page.goto(url, { waitUntil: 'commit', timeout: 180000 });
        await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
        await page.waitForSelector('#call-controlbar-root .cl-console-inner', { timeout: 60000 });
        await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
        await page.waitForTimeout(st.id === 'scrolled' ? 900 : 500);
        const r = await page.evaluate(measure);
        total++;
        const ok = r.probs.length === 0 && (st.id !== 'scrolled' || r.atEnd);
        if (!ok) failed++;
        results.push({ size: s.id, w, state: st.id, ok, ...r });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.id} w=${w} ${st.id}  panel=${r.panelW} capsule=${r.capW} row=${r.rowW} btn=${r.sizes.join('/')}${st.id === 'scrolled' ? ` scrolled=${r.scrolled}` : ''}${r.probs.length ? '\n      ' + r.probs.slice(0, 6).join('\n      ') : ''}`);
        await page.locator('#panel').screenshot({ path: path.join(out, `${s.id}-w${w}-${st.id}${legacy ? '-LEGACY' : ''}.png`) });
        await page.close();
      }
    }
    await ctx.close();
  }
} finally { await browser.close(); }
fs.writeFileSync(path.join(out, `results${legacy ? '-legacy' : ''}.json`), JSON.stringify(results, null, 1));
console.log(failed ? `\n${failed}/${total} case(s) FAILED` : `\nall ${total} cases passed`);
process.exit(failed ? 1 : 0);
