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
 * Voice gate "Automatic" harness: the REAL VoiceVideoSettings + useVoiceSettings + the settings CSS.
 *   npx vite --config harness/voice-gate.vite.config.ts      (serves :5312)
 *   ?auto=1 (default) | ?auto=0     &manual=-60
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
(window as any).electronAPI = new Proxy({}, { get: () => () => Promise.resolve(null) });

const Pane: React.FC = () => {
    const voice = useVoiceSettings('harness-user');
    React.useEffect(() => {
        voice.setVoiceGateAuto(q.get('auto') !== '0');
        voice.setVoiceGateThreshold(Number(q.get('manual') ?? -60));
    }, []);
    return (
        <div className="sd-root sd-win" style={{ minHeight: 0, height: 'auto', display: 'block', background: 'var(--cl-bg, #0B0F1E)' }}>
            <main className="sd-main" style={{ width: 720, margin: '0 auto', padding: 24 }}>
                <div className="sd-col"><section className="sd-pane"><VoiceVideoSettings voice={voice} /></section></div>
            </main>
        </div>
    );
};
createRoot(document.getElementById('root')!).render(<Pane />);
