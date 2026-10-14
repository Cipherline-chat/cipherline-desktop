/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { InAppCheckout } from '../src/components/billing/InAppCheckout';

/**
 * The real InAppCheckout over a stand-in app.
 *   ?link=expanded   Link's "Save my information" box open (taller iframe)
 *   ?tax=0           the quote has no tax (Pay goes straight through)
 * window.__chk: { closed, success } for harness/checkout-layout-shots.mjs.
 */
loadWebFonts();
const chk = { closed: 0, success: 0 };
(window as any).__chk = chk;
const fill = '#1C2542', line = '#2A3558';

const App = () => {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', background: '#0B0F1E' }}>
            <nav style={{ width: 72, borderRight: `1px solid ${line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Array.from({ length: 7 }, (_, i) => <i key={i} style={{ width: 48, height: 48, borderRadius: 16, background: fill }} />)}
            </nav>
            <main style={{ flex: 1, padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>
                <button id="opener" onClick={() => setOpen(true)} style={{ width: 120, height: 36 }}>Upgrade</button>
                {Array.from({ length: 8 }, (_, i) => <b key={i} style={{ height: 12, borderRadius: 6, background: fill, width: `${30 + (i * 29) % 55}%` }} />)}
            </main>
            {open && <InAppCheckout context="upgrade" authToken="harness" onSuccess={() => { chk.success++; }} onClose={() => { chk.closed++; setOpen(false); }} />}
        </div>
    );
};
createRoot(document.getElementById('root')!).render(<App />);
