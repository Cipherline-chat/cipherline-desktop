// The real Firewall worker on a bare canvas (no React), probe on: how fast does it draw, vs the page's own rAF?
// ?power=high-performance|low-power. Results land on window.__fw (read by firewall-rate.mjs).
const q = new URLSearchParams(location.search);
const c = document.getElementById('c') as HTMLCanvasElement;
const w = new Worker(new URL('../src/workers/loadingScreen.worker.ts', import.meta.url), { type: 'module' });
const out: { rate?: unknown; gaps: number; mainRaf: number; mainMs: number; ok: boolean } = { gaps: 0, mainRaf: 0, mainMs: 0, ok: false };
(window as unknown as { __fw: typeof out }).__fw = out;
w.onmessage = e => {
    const m = e.data;
    if (m.type === 'ok') out.ok = true;
    if (m.type === 'probe' && m.kind === 'rate') out.rate = m;
    if (m.type === 'probe' && m.kind === 'gap') out.gaps++;
};
const off = c.transferControlToOffscreen();
const init: Record<string, unknown> = { type: 'init', canvas: off, w: 1000, h: 700, dpr: 1, best: 0, reduced: false, probe: true };
if (q.get('power')) init.power = q.get('power');
w.postMessage(init, [off]);
let first = 0;
const tick = (ts: number) => { if (!first) first = ts; out.mainRaf++; out.mainMs = ts - first; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
// Autopilot-less: start a run, then let Keys fall and crash (a rate report is posted at the run's end).
setTimeout(() => w.postMessage({ type: 'act' }), 1500);
setTimeout(() => w.postMessage({ type: 'act' }), 1600);
