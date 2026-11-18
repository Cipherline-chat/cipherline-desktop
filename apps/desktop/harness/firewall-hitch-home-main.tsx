/* eslint-disable -- harness, not shipped */
// The REAL Firewall overlay (placement "shell", as Dashboard mounts it) over the REAL Home
// deck's live parts (HomeAmbient motes, the lively HomeKeys, a few deck tiles), in a frame
// laid out like Dashboard (34 px titlebar, 72 px rail, content column). Driven by
// firewall-hitch.mjs (PAGE=home). A Space keydown every 240 ms keeps a run going.
//   ?cover=0   the overlay is NOT given the content column (what shipped before the fix)
//   ?cover=1   coverRef = the content column (Dashboard after the fix)
//   ?dur=20000 how long to measure
//   ?heap=300&nodes=20000  a retained JS heap (MB of small objects) and hidden DOM nodes, so the
//              page's heap is closer to the real app's (a signed-in Dashboard holds hundreds of MB)
// The worker is the real one; its messages are tapped (loadingWorkerHost's factory hook)
// for the hitch probe's late frames and pillar entries. Results on window.__fw.
import { createRoot } from 'react-dom/client';
import React, { useRef, useState } from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import '../src/styles/home-deck.css';
import { HomeKeys } from '../src/components/mascot/HomeKeys';
import { HomeAmbient } from '../src/components/HomeAmbient';
import { FirewallOverlay } from '../src/components/FirewallOverlay';
import { __setLoadingWorkerFactory, type WorkerLike } from '../src/components/loadingWorkerHost';
import { applyMotionState } from '../src/utils/idleMotion';

const q = new URLSearchParams(location.search);
const COVER = q.get('cover') === '1';
const DUR = Number(q.get('dur') ?? 20000);
const HEAP_MB = Number(q.get('heap') ?? 0), NODES = Number(q.get('nodes') ?? 0);
// Retained ballast: many small linked objects (what a chat app's caches look like to the GC).
const ballast: unknown[] = [];
for (let i = 0; i < HEAP_MB * 1024 * 1024 / 64; i++) ballast.push({ a: i, b: `m${i & 1023}`, c: null as unknown, d: i * 0.5 });
for (let i = 1; i < ballast.length; i++) (ballast[i] as { c: unknown }).c = ballast[i - 1];
(window as any).__ballast = ballast;
if (NODES > 0) {
    const box = document.createElement('div');
    box.style.display = 'none';
    for (let i = 0; i < NODES; i++) { const d = document.createElement('div'); d.className = 'msg'; d.textContent = `message ${i}`; box.appendChild(d); }
    document.body.appendChild(box);
}
type Ev = { at: number; ms: number };
const out = {
    ok: false, done: false, params: { COVER, DUR, page: 'home', HEAP_MB, NODES },
    gaps: [] as Ev[], pillars: [] as number[], blocks: [] as Ev[], loafs: [] as (Ev & { scripts: number; render: number })[],
    playingMs: 0, runs: 0, rates: [] as unknown[], mainFrames: 0, t0: 0, covered: [] as number[],
};
(window as any).__fw = out;
let playingSince = 0;
__setLoadingWorkerFactory(() => {
    const w = new Worker(new URL('../src/workers/loadingScreen.worker.ts', import.meta.url), { type: 'module', name: 'loading-screen' });
    w.addEventListener('message', (e: MessageEvent) => {
        const m = e.data, now = performance.now();
        if (m.type === 'ok') out.ok = true;
        else if (m.type === 'probe' && m.kind === 'gap') out.gaps.push({ at: m.at - performance.timeOrigin, ms: m.gap });
        else if (m.type === 'probe' && m.kind === 'pillar') out.pillars.push(m.at - performance.timeOrigin);
        else if (m.type === 'probe' && m.kind === 'rate') out.rates.push({ fps: Math.round(m.fps), maxGap: Math.round(m.maxGapMs), frames: m.frames });
        else if (m.type === 'game') {
            if (m.mode === 'playing' && !playingSince) { playingSince = now; out.runs++; }
            if (m.mode !== 'playing' && playingSince) { out.playingMs += now - playingSince; playingSince = 0; }
        }
    });
    return w as unknown as WorkerLike;
});
try {
    new PerformanceObserver((l) => {
        for (const x of l.getEntries() as any[]) {
            out.loafs.push({ at: x.startTime, ms: x.duration, scripts: (x.scripts ?? []).filter((s: any) => s.duration >= 5).length, render: x.renderStart ? x.startTime + x.duration - x.renderStart : 0 });
        }
    }).observe({ type: 'long-animation-frame', buffered: false });
} catch { /* no LoAF */ }
// The window is "in use" (idleMotion): decoration runs, as it does while someone plays.
applyMotionState(true);

const Tile: React.FC<{ i: number }> = ({ i }) => (
    <section className="hd-tile" style={{ minHeight: 120 }}>
        <div className="hd-tile-h"><span className="hd-dot" /> Tile {i} <span className="hd-live">live</span></div>
        <p>Something that happened while you were away, with a little text to lay out.</p>
    </section>
);

const App = () => {
    const column = useRef<HTMLDivElement>(null);
    // window.__open(bool): close / reopen the game (the cover check: focus and scroll come back).
    const [open, setOpen] = useState(q.get('closed') !== '1');
    (window as any).__open = setOpen;
    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} data-layout="drift">
            <div className="drag-region" style={{ height: 34, flexShrink: 0, background: '#0B0F1E' }} />
            <div className="app-mainrow" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                <nav className="app-rail" style={{ width: 72, flex: 'none', background: '#0B0F1E' }} />
                <div ref={column} data-banner-column="" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <div className="hd-frame">
                        <div className="hd-host custom-scrollbar" data-ambient="on">
                            <HomeAmbient enabled />
                            <div className="hd-inner">
                                <div className="hd-greet">
                                    <div>
                                        <span className="hd-eyebrow">Wednesday, November 18</span>
                                        <h1>Good evening, Dawson.</h1>
                                        <p>Quiet since you left.</p>
                                    </div>
                                    <div className="hd-mascotbtn hd-mascotslot">
                                        <HomeKeys userId="harness" lively signal="idle" speech={null} onPoke={() => {}} canPlay={() => 'ok' as any} onPlay={() => {}} />
                                    </div>
                                </div>
                                <input id="composer" placeholder="Message" style={{ margin: 12, padding: 8 }} />
                                <div className="hd-deck">{Array.from({ length: 8 }, (_, i) => <Tile key={i} i={i} />)}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {open && <FirewallOverlay userId="harness" placement="shell" onClose={() => setOpen(false)} coverRef={COVER ? column : undefined} />}
        </div>
    );
};
createRoot(document.getElementById('root')!).render(<App />);

const space = () => {
    for (const type of ['keydown', 'keyup'] as const) document.body.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', bubbles: true }));
};
const start = () => {
    out.t0 = performance.now();
    const iv = setInterval(space, 240);
    setTimeout(() => {
        out.covered.push(column_covered());
        clearInterval(iv);
        if (playingSince) { out.playingMs += performance.now() - playingSince; playingSince = 0; }
        out.done = true;
    }, DUR);
};
const column_covered = () => (document.querySelector('[data-banner-column]')?.hasAttribute('data-fw-covered') ? 1 : 0);
const wait = q.get('closed') === '1' ? 0 : setInterval(() => { if (out.ok) { clearInterval(wait); setTimeout(start, 1500); } }, 50);
