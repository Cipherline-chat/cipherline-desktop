/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import '../src/index.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { ProWelcome } from '../src/components/ProWelcome';

/**
 * The real ProWelcome over a stand-in of the app's three-column layout.
 *   ?theme=light   sets <html data-theme="light"> (the desktop is dark-only today)
 *   ?name=...      the username printed on the card ('' = pending username)
 * window.__pcel: { closed, seek(ms) } for harness/pro-celebration-shots.mjs.
 */
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') document.documentElement.dataset.theme = 'light';
loadWebFonts();
const pcel = {
    closed: 0,
    seek(ms: number) { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } },
};
(window as any).__pcel = pcel;

const light = q.get('theme') === 'light';
const bg = light ? '#F4F7FD' : '#0B0F1E', panel = light ? '#FFFFFF' : '#131A30', fill = light ? '#E3EAF6' : '#1C2542', line = light ? '#D3DCEC' : '#2A3558';

const App = () => {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', background: bg }}>
            <nav style={{ width: 72, borderRight: `1px solid ${line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Array.from({ length: 7 }, (_, i) => <i key={i} style={{ width: 48, height: 48, borderRadius: 16, background: fill }} />)}
            </nav>
            <aside style={{ width: 248, background: panel, borderRight: `1px solid ${line}`, padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {Array.from({ length: 12 }, (_, i) => <b key={i} style={{ height: 14, borderRadius: 7, background: fill, width: `${60 + (i * 17) % 40}%` }} />)}
            </aside>
            <main style={{ flex: 1, padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>
                {Array.from({ length: 8 }, (_, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12 }}>
                        <i style={{ width: 38, height: 38, borderRadius: '50%', background: fill, flex: 'none' }} />
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <b style={{ height: 12, borderRadius: 6, background: fill, width: `${20 + (i * 13) % 30}%` }} />
                            <b style={{ height: 12, borderRadius: 6, background: fill, width: `${45 + (i * 29) % 45}%` }} />
                        </div>
                    </div>
                ))}
            </main>
            {open && <ProWelcome name={q.get('name') ?? 'dawson'} onClose={() => { pcel.closed++; setOpen(false); }} />}
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
