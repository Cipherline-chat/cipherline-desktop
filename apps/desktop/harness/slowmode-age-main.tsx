// ?scene=gate | settings | chat   &theme=dark|light
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import { Clock, Hash, SendHorizontal } from 'lucide-react';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { AgeGatePane } from '../src/components/server/AgeGatePane';
import { ChannelModerationSection } from '../src/components/server/ChannelModerationSection';
import { slowmodeShort, slowmodeLabel } from '@cipherline/shared';
import { formatCountdown } from '../src/utils/channelModeration';

const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'gate';
const theme = q.get('theme') ?? 'dark';
document.documentElement.setAttribute('data-theme', theme);
document.body.style.background = 'var(--cl-deep, #070B14)';
void loadWebFonts();

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ display: 'flex', height: '100vh', color: 'var(--cl-text)' }}>
        <div style={{ width: 'max(200px,18vw)', borderRight: '1px solid var(--cl-border)', padding: 12, flexShrink: 0, fontSize: 13 }}>
            <div style={{ opacity: .6, marginBottom: 8 }}>Text channels</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Hash size={16} /> general</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}><Hash size={16} /> spicy
                <span role="img" aria-label="Age-restricted channel" style={{ color: 'var(--cl-glow-text)' }}>🔞</span></div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
);

const Settings = () => {
    const [s, setS] = useState(30);
    const [a, setA] = useState(true);
    return (
        <div style={{ padding: 24, maxWidth: 560, margin: '0 auto', color: 'var(--cl-text)' }}>
            <h3 style={{ margin: '0 0 12px' }}>Edit #spicy</h3>
            <ChannelModerationSection slowmode={s} onSlowmode={setS} ageRestricted={a} onAgeRestricted={setA} />
            <div style={{ marginTop: 10, fontSize: 12, opacity: .7 }}>Slowmode: {slowmodeLabel(s)}</div>
        </div>
    );
};

const Chat = () => {
    const left = 23_000;
    return (
        <Frame>
            <div style={{ height: 54, borderBottom: '1px solid var(--cl-border)', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8 }}>
                <h3 className="font-display" style={{ margin: 0, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>spicy</span>
                    <span className="cl-chan-chip" data-testid="age-chip">18+</span>
                    <span className="cl-chan-chip" data-testid="slowmode-chip-header"><Clock className="w-2.5 h-2.5" />{slowmodeShort(30)}</span>
                </h3>
            </div>
            <div style={{ flex: 1, padding: 16, fontSize: 13, opacity: .7 }}>messages...</div>
            <div className="mx-2 mb-1 px-3 py-1.5 rounded-lg bg-cl-glow/10 border border-cl-glow/20 flex items-center gap-2" role="status" data-testid="slowmode-strip">
                <Clock className="w-3 h-3 text-cl-glow-text shrink-0" />
                <span className="text-cl-glow-text text-[11px] font-semibold tabular-nums">Slowmode: {formatCountdown(left)}</span>
                <span className="text-cl-glow-text/70 text-[11px]">— you can send again then. Keep typing.</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 8px 12px', padding: '8px 12px', border: '1px solid var(--cl-border)', borderRadius: 12 }}>
                <div style={{ flex: 1, fontSize: 13 }}>my next message (draft stays editable)</div>
                <div style={{ minWidth: 40, textAlign: 'center', color: 'var(--cl-glow-text)', fontWeight: 800, fontSize: 12 }} data-testid="slowmode-chip">{formatCountdown(left)}</div>
                <SendHorizontal size={16} style={{ opacity: .3 }} />
            </div>
        </Frame>
    );
};

const App = () => scene === 'settings' ? <Settings />
    : scene === 'chat' ? <Chat />
    : <Frame><AgeGatePane channelName="spicy" onConfirm={async () => { await new Promise(r => setTimeout(r, 300)); }} onBack={() => {}} /></Frame>;

createRoot(document.getElementById('root')!).render(<App />);
