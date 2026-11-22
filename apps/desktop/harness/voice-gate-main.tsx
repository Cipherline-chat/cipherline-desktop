/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { useVoiceSettings } from '../src/hooks/useVoiceSettings';
import { VoiceVideoSettings } from '../src/components/VoiceVideoSettings';

/**
 * Voice gate harness: the REAL VoiceVideoSettings + useVoiceSettings + the settings CSS. (The Automatic gate it was
 * built for was removed 2026-11-17; it now shows the new engine's MANUAL noise gate.)
 *   npx vite --config harness/voice-gate.vite.config.ts      (serves :5312)
 *   ?gate=1 (manual gate on) | 0 (default)     &db=-55      (the new audio engine is the only engine now)
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
(window as any).electronAPI = new Proxy({}, { get: () => () => Promise.resolve(null) });

const Pane: React.FC = () => {
    const voice = useVoiceSettings('harness-user');
    React.useEffect(() => {
        voice.setVoiceGateManual(q.get('gate') === '1');
        voice.setVoiceGateManualDb(Number(q.get('db') ?? -55));
    }, []);
    return (
        <div className="sd-root sd-win" style={{ minHeight: 0, height: 'auto', display: 'block', background: 'var(--cl-bg, #0B0F1E)' }}>
            <main className="sd-main" style={{ width: 'min(720px, calc(100vw - 48px))', margin: '0 auto', padding: 24 }}>
                <div className="sd-col"><section className="sd-pane"><VoiceVideoSettings voice={voice} /></section></div>
            </main>
        </div>
    );
};
createRoot(document.getElementById('root')!).render(<Pane />);
