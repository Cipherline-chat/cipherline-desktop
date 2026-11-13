// The encoder-overload offer, real card and real anchor, over a stand-in chat pane.
//   npx vite --config harness/share-notes.vite.config.ts   then   node harness/share-overload-offer-shots.mjs   (env OUT, BASE)
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { ShareOverloadOffer } from '../src/components/call/ShareOverloadOffer';

loadWebFonts();
const q = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(
    <div style={{ display: 'flex', height: '100vh' }}>
        <div style={{ width: 300, background: '#131A30' }} />
        <div className="app-pane3" style={{ flex: 1, background: '#0B0F1E' }} />
        <ShareOverloadOffer current={q.get('c') ?? 'Source at 90 fps'} suggested={q.get('s') ?? '1440p at 90 fps'} sizeChange={q.has('z') ? q.get('z') : '3024×1964 → 2216×1438'} onSwitch={() => {}} onDismiss={() => {}} />
    </div>,
);
