/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { AloneLeaveDialog } from '../src/components/call/AloneLeaveDialog';
import { AloneLeaveRow } from '../src/components/settings/AloneLeaveRow';
import { ShareNotice } from '../src/components/ShareNotice';
import { captureBoundNotice } from '../src/utils/shareCaptureBound';

/** ?scene=dialog | setting | hint  — each in a call-like backdrop. */
loadWebFonts();
const scene = new URLSearchParams(location.search).get('scene') ?? 'dialog';

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ position: 'relative', minHeight: '100vh', background: 'linear-gradient(180deg,#10162b,#0B0F1E)', color: '#F4F7FF', fontFamily: 'Nunito, sans-serif' }}>
        <div style={{ padding: 24, opacity: .9 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Voice channel · General</div>
            <div style={{ marginTop: 12, width: 220, height: 120, borderRadius: 14, background: '#161d38', border: '1px solid #26305a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>You</div>
        </div>
        {children}
    </div>
);

const App = () => {
    if (scene === 'setting') {
        return (
            <div className="cl-kit" style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
                <div className="vv" style={{ display: 'block', containerType: 'inline-size', containerName: 'vv', ['--vv-lab' as string]: '210px' }}>
                    <AloneLeaveRow />
                </div>
            </div>
        );
    }
    if (scene === 'hint') {
        return (
            <Backdrop>
                <div style={{ width: 'min(420px, 100%)', padding: '0 12px', marginTop: 24 }}>
                    <ShareNotice tone="info" onDismiss={() => {}}>
                        {captureBoundNotice(24, 60, 'screen', false, 'windows', 'content')}
                    </ShareNotice>
                </div>
            </Backdrop>
        );
    }
    return <Backdrop><AloneLeaveDialog inline minutes={15} secondsLeft={47} onStay={() => {}} onLeaveNow={() => {}} /></Backdrop>;
};
createRoot(document.getElementById('root')!).render(<App />);
