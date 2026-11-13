// OUT=<dir> node harness/call-anims-shots.mjs   (server: npx vite --config harness/call-anims.vite.config.ts)
// Frame strips (0/80/160/240/400 ms after the roster change) for every join / leave case, plus
// in-page numeric samples of the animated wrapper at exactly those times, then an overview.png.
//
// Time is WARPED ×SLOW (default 10) just before each action, so a ~100 ms screenshot costs ~10 ms of
// animation time: performance.now / rAF timestamps / setTimeout delays are scaled in-page (framer's
// JS frameloop and the presence tracker's ghost timer), and CDP Animation.setPlaybackRate scales
// the WAAPI side (framer's accelerated opacity). Frame labels carry the measured warped ms.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5361/harness/call-anims.html';
const OUT = process.env.OUT;
mkdirSync(OUT, { recursive: true });
const TIMES = [0, 80, 160, 240, 400];
const VIDEO = process.env.VIDEO === '1';
const SLOW = Number(process.env.SLOW ?? 10);
const WARP = `(() => {
  const rate = 1 / ${SLOW};
  const realNow = performance.now.bind(performance);
  const start = realNow();
  performance.now = () => start + (realNow() - start) * rate;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(ts => cb(start + (ts - start) * rate));
  const st = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => st(fn, (ms || 0) / rate, ...a);
})()`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = {};
const strips = [];

// In-page sampler: the presence wrapper of `who` (row / tile), at exact offsets from `t0`.
const SAMPLER = `
window.__sample = (who, times) => new Promise(res => {
  const t0 = performance.now(); const out = [];
  const one = w => {
    if (!w) return null;
    const cs = getComputedStyle(w); const r = w.getBoundingClientRect();
    return { o: +(+cs.opacity).toFixed(2), tf: cs.transform === 'none' ? 'none' : (() => { const n = cs.transform.slice(cs.transform.indexOf('(') + 1, -1).split(',').map(Number); return 'scale ' + n[0].toFixed(2) + ' y ' + n[5].toFixed(1); })(), h: Math.round(r.height), join: w.getAttribute('data-presence-join') };
  };
  const q = sel => document.querySelector(sel)?.parentElement;
  const pick = () => who === '@self'
    ? { self: one(document.querySelector('[data-panel="self"] [data-presence-join="self"]')) }
    : { server: one(q('[data-panel="server"] [data-row="'+who+'"]')), incall: one(q('#incall-grid [data-row="'+who+'"], #incall-grid [data-tile="'+who+'"], [data-panel="fs"] [data-tile="'+who+'"]')) };
  let i = 0;
  const tick = () => {
    const t = performance.now() - t0;
    while (i < times.length && t >= times[i]) { out.push({ t: times[i], at: Math.round(t), ...pick() }); i++; }
    if (i < times.length) requestAnimationFrame(tick); else res(out);
  };
  tick();
});`;

async function scenario(name, { params, clip, action, who, reduced = false, then }) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference', ...(VIDEO && name === 'midcall-join' ? { recordVideo: { dir: OUT, size: { width: 1000, height: 640 } } } : {}) });
  page.setDefaultTimeout(180_000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}?${params}`);
  await page.waitForSelector('[data-panel="server"]');
  await page.addScriptTag({ content: SAMPLER });
  await page.waitForTimeout(1800); // past the in-call tracker's LiveKit settle window
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
  await page.evaluate(WARP);
  const sampling = page.evaluate(([w, t]) => window.__sample(w, t), [who, TIMES]);
  const t0 = await page.evaluate(action);
  const frames = [];
  for (const t of TIMES) {
    const now = await page.evaluate(() => performance.now());
    const wait = t0 + t - now;
    if (wait > 0) await page.waitForTimeout(wait * SLOW);
    const at = Math.round((await page.evaluate(() => performance.now())) - t0);
    const file = `${name}-${String(t).padStart(3, '0')}.png`;
    await page.screenshot({ path: `${OUT}/${file}`, clip });
    frames.push({ t, at, file });
  }
  const samples = await sampling;
  let extra = null;
  if (then) extra = await then(page);
  results[name] = { samples, extra, errors };
  console.log(name, JSON.stringify(samples), extra ? JSON.stringify(extra) : '', errors.length ? 'ERR ' + errors.slice(0, 2) : '');
  strips.push({ name, frames, clip });
  await page.close();
}

const server = { x: 16, y: 16, width: 302, height: 260 };
const incall = { x: 334, y: 16, width: 302, height: 330 };
const both = { x: 16, y: 16, width: 620, height: 330 };
const fs = { x: 0, y: 0, width: 1000, height: 640 };
const set = ids => `(() => { const t = performance.now(); window.__set(${JSON.stringify(ids)}); return t; })()`;

await scenario('first-join', { params: 'ids=', clip: server, who: 'mira', action: set(['mira']) });
await scenario('midcall-join', { params: 'ids=me,mira', clip: both, who: 'jun', action: set(['me', 'mira', 'jun']) });
await scenario('midcall-leave', { params: 'ids=me,mira,jun', clip: both, who: 'mira', action: set(['me', 'jun']) });
await scenario('last-leave', { params: 'ids=mira', clip: server, who: 'mira', action: set([]) });
await scenario('dm-answer', { params: 'ids=me&ring=1', clip: incall, who: 'mira', action: set(['me', 'mira']) });
await scenario('group-rows-join', { params: 'ids=me,mira,jun&grid=rows', clip: both, who: 'sana', action: set(['me', 'mira', 'jun', 'sana']) });
await scenario('group-rows-leave', { params: 'ids=me,mira,jun,sana&grid=rows', clip: both, who: 'mira', action: set(['me', 'jun', 'sana']) });
await scenario('group-grid-leave', { params: 'ids=me,mira,jun,sana', clip: incall, who: 'jun', action: set(['me', 'mira', 'sana']) });
await scenario('rejoin-during-leave', {
  params: 'ids=me,mira,jun', clip: both, who: 'mira',
  action: `(() => { const t = performance.now(); window.__set(['me','jun']); setTimeout(() => window.__set(['me','mira','jun']), 120); return t; })()`,
});
await scenario('own-join', { params: 'ids=me', clip: { x: 650, y: 16, width: 302, height: 300 }, who: '@self', action: `(() => { const t = performance.now(); window.__self(true); return t; })()` });
await scenario('reduced-join', { params: 'ids=me,mira', clip: both, who: 'jun', reduced: true, action: set(['me', 'mira', 'jun']) });
await scenario('reduced-leave', { params: 'ids=me,mira,jun', clip: both, who: 'mira', reduced: true, action: set(['me', 'jun']) });

// Layout switch: jun joins, the join finishes, then the in-call view goes fullscreen and back.
// Every tile there REMOUNTS (new surface / same surface) — none may replay the join.
await scenario('layout-switch', {
  params: 'ids=me,mira,jun', clip: fs, who: 'jun',
  action: `(() => { const t = performance.now(); window.__layout('fs'); return t; })()`,
  then: async page => {
    const fsJoins = await page.evaluate(() => document.querySelectorAll('[data-panel="fs"] [data-presence-join]').length);
    await page.evaluate(() => window.__layout('side'));
    await page.waitForTimeout(50 * SLOW);
    const sideJoins = await page.evaluate(() => document.querySelectorAll('[data-panel="dm"] [data-presence-join]').length);
    // …but someone joining WHILE fullscreen is up does animate there.
    await page.evaluate(() => window.__layout('fs'));
    await page.waitForTimeout(400 * SLOW);
    const t0 = await page.evaluate(() => { const t = performance.now(); window.__set(['me', 'mira', 'jun', 'kenji']); return t; });
    await page.waitForTimeout(60 * SLOW);
    const kenjiJoin = await page.evaluate(() => document.querySelector('[data-tile="kenji"]')?.parentElement?.getAttribute('data-presence-join'));
    await page.screenshot({ path: `${OUT}/layout-switch-fs-join-060.png`, clip: fs });
    return { fsJoinsOnOpen: fsJoins, sideJoinsOnReturn: sideJoins, kenjiJoinInFullscreen: kenjiJoin };
  },
});
// The pane-switch case for jun's grid tile: jun joins, then at 120 ms the in-call grid's DOM node is
// reparented (what Dashboard does to the call roots); the animation must continue, not restart —
// and a reparent after it finished must not play anything.
await scenario('reparent', {
  params: 'ids=me,mira', clip: incall, who: 'jun',
  action: `(() => { const t = performance.now(); window.__set(['me','mira','jun']); setTimeout(() => window.__reparent(), 120); return t; })()`,
  then: async page => {
    await page.waitForTimeout(300 * SLOW);
    const before = await page.evaluate(() => getComputedStyle(document.querySelector('[data-tile="jun"]').parentElement).opacity);
    await page.evaluate(() => window.__reparent());
    const after = [];
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(40 * SLOW); after.push(await page.evaluate(() => getComputedStyle(document.querySelector('[data-tile="jun"]').parentElement).opacity)); }
    return { opacityBeforeSecondReparent: before, opacityAfterSecondReparent: after };
  },
});

writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));

// Overview: one labelled strip per scenario.
const ov = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
const rows = strips.map(s => {
  const scale = Math.min(1, 300 / s.clip.width);
  const imgs = s.frames.map(f => `<figure><figcaption>${f.t} ms <small>(${f.at})</small></figcaption><img src="data:image/png;base64,${readFileSync(`${OUT}/${f.file}`).toString('base64')}" style="width:${Math.round(s.clip.width * scale)}px"></figure>`).join('');
  return `<div class="row"><h2>${s.name}</h2><div class="frames">${imgs}</div></div>`;
}).join('');
await ov.setContent(`<body style="margin:0;padding:20px;background:#05070f;font:600 13px Nunito,sans-serif;color:#A7B3D4;width:max-content">${rows}<style>.row{margin-bottom:18px}h2{margin:0 0 6px;font:700 13px monospace;color:#25E0C8}.frames{display:flex;gap:10px}figure{margin:0}figcaption{margin:0 0 4px}small{color:#6B7699}img{display:block;border-radius:8px;outline:1px solid #2A3558}</style></body>`);
await ov.waitForTimeout(300);
await ov.screenshot({ path: `${OUT}/overview.png`, fullPage: true });
await browser.close();
