/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import React from 'react';
import { ServerStoragePanel } from '../src/components/server/ServerStoragePanel';
// Mirrors the settings shell: a sticky pane header over a scrolling, overflow-clipped body.
const App = () => (
  <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#F4F7FF', fontFamily: 'Nunito, sans-serif' }}>
    <div className="cl-kit" style={{ width: 520, height: 420, background: '#10162b', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 50 }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 5, padding: '20px 24px', background: '#121a33', borderBottom: '1px solid #26305a', fontWeight: 800, fontSize: 22 }}>Storage<div style={{ fontSize: 13, fontWeight: 500, opacity: .7 }}>Saved storage, emojis &amp; limits</div></div>
      <div id="scroller" style={{ overflow: 'auto', flex: 1, padding: 24 }}>
        <ServerStoragePanel serverId="s1" token="t" />
        <div style={{ height: 600 }} />
      </div>
    </div>
  </div>
);
createRoot(document.getElementById('root')!).render(<App />);
