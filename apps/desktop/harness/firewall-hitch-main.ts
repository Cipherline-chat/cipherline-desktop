// Firewall hitch harness (driven by firewall-hitch.mjs): the REAL game worker on an
// OffscreenCanvas, framed like the shell overlay, over a page whose main thread can be
// loaded in controlled ways. Measures the worker's own late frames (its hitch probe)
// against what the main thread did, to show whether main-thread work stalls the game.
//   ?block=70&every=3100   a busy main-thread task of `block` ms every `every` ms
//   ?anim=N                N mascot-like SVGs animating `transform` on their children
//                          (main-thread style + paint every frame) behind the overlay
//   ?hide=cv               the fix: content-visibility:hidden on what the overlay covers
//   ?dur=20000             how long to measure
// Results on window.__fw.
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const BLOCK = num('block', 0), EVERY = num('every', 3100), ANIM = num('anim', 0), DUR = num('dur', 20000);
const HIDE = q.get('hide') ?? '';

const bg = document.getElementById('bg') as HTMLDivElement;
if (ANIM > 0) {
    const css = document.createElement('style');
    css.textContent = `
      @keyframes hs-sway { 0%,100% { transform: rotate(-6deg) } 50% { transform: rotate(6deg) } }
      @keyframes hs-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
      .hs-k g { transform-box: fill-box; transform-origin: 50% 0; animation: hs-sway 2.4s ease-in-out infinite; }
      .hs-k g:nth-child(2n) { animation-duration: 3.1s } .hs-k g:nth-child(3n) { animation: hs-bob 1.7s ease-in-out infinite }
      .hs-card { display:inline-block; margin:6px; padding:8px; border-radius:12px; background:#121a30; color:#cfe; font:13px system-ui; width:180px; vertical-align:top }`;
    document.head.appendChild(css);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < ANIM; i++) {
        const card = document.createElement('div');
        card.className = 'hs-card';
        let g = '';
        for (let j = 0; j < 12; j++) g += `<g><rect x="${8 + j * 7}" y="${20 + (j % 3) * 4}" width="5" height="${30 + (j % 4) * 6}" rx="2.5" fill="#25E0C8"/></g>`;
        card.innerHTML = `<svg class="hs-k" width="96" height="72" viewBox="0 0 96 72"><circle cx="48" cy="20" r="18" fill="#25E0C8"/>${g}</svg><div>Card ${i} · some text that wraps a little so layout has work</div>`;
        frag.appendChild(card);
    }
    bg.appendChild(frag);
}
if (HIDE === 'cv') bg.style.contentVisibility = 'hidden';

const fw = document.getElementById('fw') as HTMLDivElement;
const c = document.getElementById('c') as HTMLCanvasElement;
const w = new Worker(new URL('../src/workers/loadingScreen.worker.ts', import.meta.url), { type: 'module' });
type Ev = { at: number; ms: number };
const out = {
    ok: false, done: false, params: { BLOCK, EVERY, ANIM, HIDE, DUR },
    gaps: [] as Ev[], pillars: [] as number[], blocks: [] as Ev[], loafs: [] as (Ev & { scripts: number; render: number })[],
    playingMs: 0, runs: 0, rates: [] as unknown[], mainFrames: 0, t0: 0,
};
(window as unknown as { __fw: typeof out }).__fw = out;
let playingSince = 0;
w.onmessage = (e) => {
    const m = e.data;
    const now = performance.now();
    if (m.type === 'ok') out.ok = true;
    else if (m.type === 'probe' && m.kind === 'gap') out.gaps.push({ at: m.at - performance.timeOrigin, ms: m.gap });
    else if (m.type === 'probe' && m.kind === 'pillar') out.pillars.push(m.at - performance.timeOrigin);
    else if (m.type === 'probe' && m.kind === 'rate') out.rates.push({ fps: Math.round(m.fps), maxGap: Math.round(m.maxGapMs), frames: m.frames });
    else if (m.type === 'game') {
        if (m.mode === 'playing' && !playingSince) { playingSince = now; out.runs++; }
        if (m.mode !== 'playing' && playingSince) { out.playingMs += now - playingSince; playingSince = 0; }
    }
};
const r = fw.getBoundingClientRect();
const off = c.transferControlToOffscreen();
w.postMessage({ type: 'init', canvas: off, w: r.width, h: r.height, dpr: 1, best: 0, reduced: false, probe: true, power: 'high-performance' }, [off]);

try {
    new PerformanceObserver((l) => {
        for (const x of l.getEntries() as (PerformanceEntry & { scripts?: { duration: number }[]; renderStart?: number })[]) {
            out.loafs.push({ at: x.startTime, ms: x.duration, scripts: (x.scripts ?? []).filter(s => s.duration >= 5).length, render: x.renderStart ? x.startTime + x.duration - x.renderStart : 0 });
        }
    }).observe({ type: 'long-animation-frame', buffered: false });
} catch { /* no LoAF */ }

const tick = () => { out.mainFrames++; requestAnimationFrame(tick); };
requestAnimationFrame(tick);

// Start once the first frame is up, then keep swimming: a stroke every 240 ms keeps a run
// going (or restarts it 0.5 s after a crash), so the worker spends most of the time in a run.
const start = () => {
    out.t0 = performance.now();
    const actIv = setInterval(() => w.postMessage({ type: 'act' }), 240);
    let blockIv: ReturnType<typeof setInterval> | null = null;
    if (BLOCK > 0) {
        blockIv = setInterval(() => {
            const s = performance.now();
            while (performance.now() - s < BLOCK) { /* spin: a main-thread task with no rendering */ }
            out.blocks.push({ at: s, ms: performance.now() - s });
        }, EVERY);
    }
    setTimeout(() => {
        clearInterval(actIv);
        if (blockIv) clearInterval(blockIv);
        if (playingSince) { out.playingMs += performance.now() - playingSince; playingSince = 0; }
        out.done = true;
    }, DUR);
};
const wait = setInterval(() => { if (out.ok) { clearInterval(wait); setTimeout(start, 800); } }, 50);
