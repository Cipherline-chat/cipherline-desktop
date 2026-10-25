/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { UpdateRequiredScreen } from '../src/components/UpdateRequiredScreen';
import { AppSuspendedScreen } from '../src/components/AppSuspendedScreen';
import { loadWebFonts } from '../src/utils/webFonts';

loadWebFonts(); // Nunito / Fredoka / JetBrains Mono, as main.tsx does

/**
 * ?screen=
 *   update            — just shown, checking for the update
 *   update-downloading — 64% downloaded
 *   update-ready      — downloaded, "Restart & update"
 *   update-failed     — verification failed, "Try again"
 *   suspended         — shut down, with "expected back" + "since"
 *   suspended-plain   — shut down, no times (server default copy)
 *   back              — the "We're back!" beat
 * A fake app sits underneath in #root to show the screen covers (and inerts) it.
 */
const screen = new URLSearchParams(location.search).get('screen') ?? 'update';
const now = Date.now();

const FakeApp = () => (
    <div style={{ display: 'flex', height: '100vh', color: '#A7B3D4', font: '14px Nunito, sans-serif' }}>
        <div style={{ width: 72, background: '#131A30' }} />
        <div style={{ width: 240, background: '#1C2542', padding: 16 }}>
            {['general', 'random', 'design', 'voice-lounge'].map(c => <div key={c} style={{ padding: '6px 0' }}># {c}</div>)}
        </div>
        <div style={{ flex: 1, padding: 24 }}>
            <button id="under" style={{ padding: 10 }}>A button in the app underneath</button>
            {Array.from({ length: 8 }, (_, i) => <p key={i}>Message {i + 1} in the conversation…</p>)}
        </div>
    </div>
);

const noop = () => {};

function Screen() {
    switch (screen) {
        case 'update-downloading':
            return <UpdateRequiredScreen currentVersion="1.0.22" requiredVersion="1.0.23" update={{ phase: 'downloading', version: '1.0.23', percent: 64 }} checkPhase="idle" installing={false} onPrimary={noop} onOpenWebsite={noop} />;
        case 'update-ready':
            return <UpdateRequiredScreen currentVersion="1.0.22" requiredVersion="1.0.23" update={{ phase: 'ready', version: '1.0.23' }} checkPhase="idle" installing={false} onPrimary={noop} onOpenWebsite={noop} />;
        case 'update-failed':
            return <UpdateRequiredScreen currentVersion="1.0.22" requiredVersion="1.0.23" update={{ phase: 'failed', version: '1.0.23', stage: 'verify' }} checkPhase="idle" installing={false} onPrimary={noop} onOpenWebsite={noop} />;
        case 'suspended':
            return <AppSuspendedScreen
                notice={{
                    title: 'We’re patching a security issue',
                    message: 'Cipherline is paused while we roll out a fix. Your messages and keys are safe on your devices — nothing is lost.\nThis screen clears by itself the moment we’re back.',
                    until: new Date(now + 2 * 3600_000 + 5 * 60_000).toISOString(),
                    since: new Date(now - 14 * 60_000).toISOString(),
                }}
                nextCheckAt={now + 27_000}
                checking={false}
                onCheckAgain={noop}
            />;
        case 'suspended-plain':
            return <AppSuspendedScreen
                notice={{ title: 'Cipherline is temporarily unavailable', message: 'We’ve paused the app while we take care of something important. Your messages and keys are safe on your devices. This screen will clear by itself as soon as we’re back.', until: null, since: null }}
                nextCheckAt={now + 92_000}
                checking={false}
                onCheckAgain={noop}
            />;
        case 'back':
            return <AppSuspendedScreen notice={{ title: 'x', message: 'y', until: null, since: null }} nextCheckAt={null} checking={false} back onCheckAgain={noop} />;
        case 'update':
        default:
            return <UpdateRequiredScreen currentVersion="1.0.22" requiredVersion="1.0.23" update={{ phase: 'idle' }} checkPhase="checking" installing={false} onPrimary={noop} onOpenWebsite={noop} />;
    }
}

createRoot(document.getElementById('root')!).render(<><FakeApp /><Screen /></>);
