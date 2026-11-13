/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/dialog-frame.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { SafetyNumberEmbed } from '../src/components/SafetyNumberEmbed';
import { computeContactCode } from '../src/utils/verificationCode';

/**
 * The REAL SafetyNumberEmbed as the receiver sees it, in a stand-in message row. Only the send is stubbed
 * (it resolves or rejects under the harness's control); everything on screen is the shipped component and CSS.
 *
 *   ?scene=receive   Mara's card, nothing shared yet
 *   ?scene=settled   the same card when the conversation already shows the viewer's share (a reopen)
 *   ?scene=mine      the viewer's own sent card
 *
 * window.__send: 'ok' | 'fail' | 'review' picks what the next click does; window.__sends counts clicks that sent.
 */
loadWebFonts();
const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'receive';
const NAME = params.get('name') ?? 'Mara';
const ME = 'u-me';
const THEM = 'u-mara';
/** Mara's key as the page's stubbed directory serves it, so Check reaches a real match. */
const THEIR_PUB = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
let CODE = '';
const w = window as any;
w.__send = 'ok';
w.__sends = 0;

const shareBack = () => new Promise<'sent' | 'needs_review'>((resolve, reject) => {
    w.__settle = () => {
        if (w.__send === 'fail') reject(new Error('offline'));
        else if (w.__send === 'review') resolve('needs_review');
        else { w.__sends++; resolve('sent'); }
    };
});

const App: React.FC = () => {
    const mine = scene === 'mine';
    return (
        <div style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box', background: 'linear-gradient(180deg, var(--cl-deep) 0%, var(--cl-abyss) 100%)', fontFamily: 'Nunito, sans-serif' }}>
            <div data-testid="row" style={{ display: 'flex', gap: 12, width: 'fit-content', padding: 8 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: mine ? '#25E0C8' : '#FFC94D', opacity: .85, flexShrink: 0 }} />
                <div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                        <span style={{ color: 'var(--cl-text)', fontWeight: 700, fontSize: 14 }}>{mine ? 'You' : 'Mara'}</span>
                        <span style={{ color: 'var(--cl-faint)', fontSize: 11 }}>Today at 4:12 PM</span>
                    </div>
                    <SafetyNumberEmbed
                        code={CODE}
                        claimedUserId={mine ? ME : THEM}
                        deviceCount={2}
                        senderUserId={mine ? ME : THEM}
                        myUserId={ME}
                        senderName={mine ? 'You' : NAME}
                        token="harness"
                        onShareBack={shareBack}
                        alreadySharedBack={scene === 'settled'}
                    />
                </div>
            </div>
        </div>
    );
};

(async () => {
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', ME);
    await secureLocalStore.whenAccountReady();
    CODE = await computeContactCode(scene === 'mine' ? ME : THEM, [THEIR_PUB]);
    createRoot(document.getElementById('root')!).render(<App />);
    w.__ready = true;
})();
