/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { NativeSharePreview } from '../src/components/call/NativeSharePreview';
import { nativePreviewHub } from '../src/utils/nativeSharePreview';

// A stand-in for what the helper sends: a 512x214 picture of a "desktop" (title bar, a window, text-ish lines).
function desktopPicture(w: number, h: number) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d')!;
    g.fillStyle = '#1b2236'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0f1424'; g.fillRect(0, 0, w, 14);
    g.fillStyle = '#26304d'; g.fillRect(18, 28, 300, 160);
    g.fillStyle = '#3b82f6'; g.fillRect(18, 28, 300, 12);
    g.fillStyle = '#8aa0d6'; for (let i = 0; i < 9; i++) g.fillRect(28, 52 + i * 14, 120 + ((i * 37) % 140), 6);
    g.fillStyle = '#2f9e6e'; g.fillRect(340, 28, 150, 70); g.fillStyle = '#c2622d'; g.fillRect(340, 110, 150, 78);
    return g.getImageData(0, 0, w, h);
}

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'live';

function Old() {   // the pre-fix tile: the long explanation, no picture
    return (
        <div className="relative overflow-hidden bg-cl-abyss flex items-center justify-center w-full shrink-0 min-h-[80px] aspect-video rounded-xl ring-inset ring-1 ring-white/5">
            <span className="text-[11px] font-semibold text-cl-text/35 text-center px-4 leading-snug">Sharing your screen at 3440x1440 with hardware encoding. This preview is off so it costs nothing.</span>
        </div>
    );
}

function App() {
    React.useEffect(() => {
        if (mode !== 'live') return;
        nativePreviewHub.setSource({ request: (on) => { (window as any).__asked = ((window as any).__asked ?? []).concat(on); } });
        const id = setInterval(() => { const d = desktopPicture(512, 214); nativePreviewHub.push({ w: d.width, h: d.height, rgba: d.data }); }, 100);
        return () => clearInterval(id);
    }, []);
    return (
        <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start' }}>
            <div style={{ width: 320 }} data-testid="docked">{mode === 'old' ? <Old /> : <NativeSharePreview fillsParent={false} />}</div>
            {mode !== 'old' && <div style={{ width: 640, height: 300 }} data-testid="focused"><NativeSharePreview fillsParent isFilled /></div>}
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<App />);
