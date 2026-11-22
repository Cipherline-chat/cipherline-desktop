/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import StorageReadFailedScreen from '../src/components/StorageReadFailedScreen';
import StorageOpeningScreen from '../src/components/StorageOpeningScreen';
import { ShrinkBackupModal } from '../src/components/ShrinkBackupModal';
import { describeShrink } from '../src/services/backupShrinkGuard';

/**
 * ?scene=failed&platform=windows|mac|linux   "Couldn't read your data on this device" (boot)
 * ?scene=opening                             "Opening your data…" (shown only while the load retries)
 * ?scene=shrink                              "Replace your backup with a much smaller one?" (Back up now)
 * plus ?theme=dark|light|midnight|hc-dark|hc-light|custom-<preset> (harness/theme-param.ts)
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'failed';
(window as any).__relaunched = 0;
(window as any).__continued = 0;
(window as any).electronAPI = {
    platform: q.get('platform') ?? 'windows',
    relaunchApp: async () => { (window as any).__relaunched++; return new Promise(() => {}); },
};

const App = () => {
    if (scene === 'opening') return <StorageOpeningScreen />;
    if (scene === 'shrink') {
        const w = describeShrink([
            { label: 'local', conversations: 48, bytes: 52_000_000 },
            { label: 'drive', conversations: 48, bytes: 52_000_000 },
        ], 0);
        return (
            <div style={{ minHeight: '100vh', background: 'var(--cl-abyss)' }}>
                <ShrinkBackupModal warning={w} onDecide={(ok) => { (window as any).__decided = ok; }} />
            </div>
        );
    }
    return <StorageReadFailedScreen onContinue={() => { (window as any).__continued++; }} />;
};

createRoot(document.getElementById('root')!).render(<App />);
