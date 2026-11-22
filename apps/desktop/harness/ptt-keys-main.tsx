/* eslint-disable -- visual harness, not shipped */
// ?pane=voice|keybinds|toast  &state=ok|unmapped|wayland|macos|mouse  &theme=dark|light
// The REAL VoiceVideoSettings / KeybindSettings (+ useVoiceSettings / useKeybinds) and ToastProvider. Only main's
// answer to hold-key:check is stubbed, with the value electron/global-ptt.ts holdKeySupport returns for that state.
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
import { useKeybinds } from '../src/hooks/useKeybinds';
import { VoiceVideoSettings } from '../src/components/VoiceVideoSettings';
import { KeybindSettings } from '../src/components/KeybindSettings';
import { ToastProvider, useToast } from '../src/contexts/ToastContext';
import { ELEVATED_GAME_HINT } from '../src/utils/holdKeys';
import { applyTheme } from '../src/theme/engine';
import { THEMES } from '../src/theme/themes';

const q = new URLSearchParams(location.search);
const pane = q.get('pane') ?? 'voice';
const state = q.get('state') ?? 'unmapped';
applyTheme(THEMES[(q.get('theme') === 'light' ? 'light' : 'dark')]);
document.body.style.background = 'var(--cl-deep, #070B14)';
loadWebFonts();

// What the key is and what main answers, per state.
const SCENES: Record<string, { key: string; platform: string; support: unknown }> = {
    ok:       { key: 'numpad1',  platform: 'Win32',    support: { status: 'ok', backend: 'win32' } },
    mouse:    { key: 'mouse4',   platform: 'Win32',    support: { status: 'ok', backend: 'win32' } },
    unmapped: { key: 'shift+!',  platform: 'Win32',    support: { status: 'focused-only', backend: 'win32', reason: 'unmapped-key' } },
    wayland:  { key: 'alt',      platform: 'Linux x86_64', support: { status: 'focused-only', backend: 'portal', reason: 'wayland-modifier' } },
    macos:    { key: 'altright', platform: 'MacIntel', support: { status: 'focused-only', backend: 'none', reason: 'unsupported-os' } },
};
const sc = SCENES[state] ?? SCENES.unmapped;
Object.defineProperty(navigator, 'platform', { get: () => sc.platform });
const api: Record<string, unknown> = {
    checkGlobalHoldKey: () => Promise.resolve(sc.support),
    syncGlobalShortcuts: () => Promise.resolve({ failed: [], status: { mode: 'native', reason: 'ok', desktop: 'harness' } }),
};
(window as any).electronAPI = new Proxy(api, { get: (t, k: string) => (k in t ? t[k] : () => Promise.resolve(null)) });

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="sd-root sd-win" style={{ minHeight: 0, height: 'auto', display: 'block', background: 'var(--cl-bg, #0B0F1E)' }}>
        <main className="sd-main" style={{ width: 'min(720px, calc(100vw - 48px))', margin: '0 auto', padding: 24 }}>
            <div className="sd-col"><section className="sd-pane">{children}</section></div>
        </main>
    </div>
);

const Settings: React.FC = () => {
    const voice = useVoiceSettings('harness-user');
    const keybinds = useKeybinds({});
    React.useEffect(() => { voice.setPushToTalk(true); voice.setPushToTalkKey(sc.key); }, []);
    return <Shell>{pane === 'keybinds' ? <KeybindSettings keybinds={keybinds} voice={voice} /> : <VoiceVideoSettings voice={voice} />}</Shell>;
};

const ToastScene: React.FC = () => {
    const toast = useToast();
    React.useEffect(() => { toast.push({ kind: 'warning', title: 'Push to talk', message: ELEVATED_GAME_HINT, durationMs: 600_000 }); }, []);
    return (
        <div style={{ minHeight: '100vh', color: 'var(--cl-text)', padding: 24, fontFamily: 'Nunito, sans-serif' }}>
            <div style={{ fontWeight: 700 }}>Voice channel · General</div>
            <div style={{ marginTop: 12, width: 220, height: 120, borderRadius: 14, background: 'var(--cl-surface, #161d38)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>You</div>
        </div>
    );
};

createRoot(document.getElementById('root')!).render(
    pane === 'toast' ? <ToastProvider><ToastScene /></ToastProvider> : <Settings />,
);
