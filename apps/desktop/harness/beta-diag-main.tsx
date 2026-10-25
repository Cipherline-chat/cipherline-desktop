/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import { CallRatingCardView } from '../src/components/diagnostics/CallRatingCard';
import { BetaDiagnosticsNotice } from '../src/components/diagnostics/BetaDiagnosticsNotice';
import { ReportProblemCard } from '../src/components/diagnostics/ReportProblemCard';
import { betaReporter } from '../src/utils/betaDiagnostics/reporter';
import { loadWebFonts } from '../src/utils/webFonts';

loadWebFonts();

/**
 * ?screen=
 *   rating          — the card as it appears after a call
 *   rating-picked   — 2 stars chosen, two tags on
 *   rating-sent     — "Thanks"
 *   notice          — the one-time beta diagnostics notice
 *   setting         — Settings → Advanced → Help & feedback with the toggle (server switch on)
 *   setting-off     — same card with the server switch OFF (no toggle at all)
 */
const screen = new URLSearchParams(location.search).get('screen') ?? 'rating';
const noop = () => {};

const FakeApp = () => (
    <div style={{ display: 'flex', height: '100vh', color: '#A7B3D4', font: '14px Nunito, sans-serif' }}>
        <div style={{ width: 72, background: '#131A30' }} />
        <div style={{ width: 240, background: '#1C2542', padding: 16 }}>
            {['general', 'random', 'design', 'voice-lounge'].map(c => <div key={c} style={{ padding: '6px 0' }}># {c}</div>)}
        </div>
        <div style={{ flex: 1, padding: 24 }}>
            {Array.from({ length: 8 }, (_, i) => <p key={i}>Message {i + 1} in the conversation…</p>)}
        </div>
    </div>
);

function Screen() {
    switch (screen) {
        case 'rating-picked': return <CallRatingCardView onSubmit={noop} onDismiss={noop} initialRating={2} initialTags={['echo', 'cut_out']} />;
        case 'rating-sent': return <CallRatingCardView onSubmit={noop} onDismiss={noop} initialRating={4} initialSent />;
        case 'notice': return <BetaDiagnosticsNotice onAcknowledge={noop} onTurnOff={noop} />;
        case 'setting':
        case 'setting-off':
            betaReporter.setServerEnabled(screen === 'setting');
            return (
                <div className="sd-root" style={{ position: 'fixed', inset: 0, background: '#0B0F1E', overflow: 'auto' }}>
                    <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 24px' }}>
                        <ReportProblemCard />
                    </div>
                </div>
            );
        case 'rating':
        default:
            return <CallRatingCardView onSubmit={noop} onDismiss={noop} />;
    }
}

createRoot(document.getElementById('root')!).render(<><FakeApp /><Screen /></>);
