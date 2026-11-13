/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import axios from 'axios';
import { HistoryRequestModal } from '../src/components/HistoryRequestModal';

/**
 * The approver-side "Send history to this device" dialog — the last button a user presses when
 * setting up a new device — over an app-like backdrop. window.__releaseExport() lets a held
 * "Packaging history…" step finish so the done state can be captured; window.__log records calls.
 */
loadWebFonts();
const log: any[] = ((window as any).__log = []);
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    log.push([config.method, url]);
    const data = url === '/history/backup' ? { backup_id: 'b-1' } : { ok: true };
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} } as any;
};

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', color: 'var(--cl-muted)', font: '14px Nunito, sans-serif', background: 'var(--cl-abyss, #0B0F1E)' }}>
        <div style={{ width: 72, background: '#131A30', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 0 ? '#25E0C8' : '#243056' }} />)}
        </div>
        <div style={{ width: 240, background: '#1C2542', padding: 16 }}>
            <div style={{ color: '#F4F7FF', fontWeight: 800, marginBottom: 12 }}>Design Crew</div>
            {['general', 'random', 'design', 'voice-lounge'].map(c => <div key={c} style={{ padding: '6px 0' }}># {c}</div>)}
        </div>
        <div style={{ flex: 1, padding: 24 }}>
            {['Morning! Anyone up for a call later?', 'Pushed the new build to staging', 'Looks great on my end', 'Setting up my new laptop now', 'Ping me when it asks to sync'].map((t, i) =>
                <p key={i} style={{ margin: '0 0 18px' }}><b style={{ color: '#F4F7FF' }}>{['Riley', 'Dawson', 'Sam', 'Dawson', 'Riley'][i]}</b><br />{t}</p>)}
        </div>
    </div>
);

createRoot(document.getElementById('root')!).render(
    <>
        <Backdrop />
        <HistoryRequestModal
            request={{ device_id: 'req-1', device_name: 'Dawson’s new laptop', platform: 'windows', requested_at: new Date().toISOString(), capability_sig_b64: 'x', capability_ts: 1 } as any}
            onClose={() => log.push(['close'])}
        />
    </>,
);
