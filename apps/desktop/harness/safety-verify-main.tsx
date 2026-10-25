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
import { MomentHost } from '../src/components/moments/MomentHost';
import SafetyVerifyHint from '../src/components/SafetyVerifyHint';
import { TrustBadge } from '../src/components/TrustBadge';
import { deriveContactTrust } from '../src/utils/contactTrust';
import { markVerified, getKnownDevices } from '../src/utils/keyVerification';
import { requestCeremony } from '../src/utils/moments';
import { Phone, Video, MoreVertical } from 'lucide-react';

/**
 * Safety-verify harness. The REAL SafetyVerifyHint beside the REAL TrustBadge in a stand-in DM header, and the
 * REAL MomentHost; the account is bound for real (secureLocalStore) so the hint's once-ever record, the
 * pin store and the first-verification flag all behave exactly as in the app.
 *
 *   ?scene=hint      a DM with Mara (5 messages each way, nobody verified) -> the hint shows (the harness adds
 *                    70 s to performance.now() so the app's quiet first minute is over)
 *   ?scene=ceremony  window.__ceremony(peer) plays the ceremony directly
 *   ?scene=flow      the hint, and window.__verify() commits a verification through markVerified (hint goes,
 *                    ceremony follows 1.5 s later)
 *
 * window.__state() reports what is on screen and in the stores.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'hint';
const ME = 'u-me';
const THEM = 'u-mara';

// Past the app's quiet first minute, so the hint may show.
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + 70_000;

type Msg = { id: string; sender_user_id: string; content: { type: string } };
const thread: Msg[] = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, sender_user_id: i % 2 ? ME : THEM, content: { type: 'text' } }));

const bubble = (w: number, mine = false): React.CSSProperties => ({
    width: w, height: 34, borderRadius: 14, marginBottom: 12, alignSelf: mine ? 'flex-end' : 'flex-start',
    background: mine ? 'rgba(37,224,200,.18)' : 'var(--cl-surface)',
});
const iconBtn: React.CSSProperties = { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cl-muted, #9AA6C8)' };

const Chat: React.FC = () => {
    const trust = deriveContactTrust({ devices: [{ deviceId: 'dev-t', verified: false, legacy: false }] as never });
    return (
        <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--cl-abyss)', fontFamily: 'Nunito, sans-serif' }}>
            <div style={{ width: 72, background: '#080B17', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 10 }}>
                {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 0 ? 'var(--cl-lume)' : 'var(--cl-surface)' }} />)}
            </div>
            <div style={{ width: 260, background: 'var(--cl-deep)', padding: '18px 14px', color: 'var(--cl-muted, #9AA6C8)', fontSize: 14 }}>
                <div style={{ fontFamily: 'Fredoka', fontWeight: 600, color: 'var(--cl-text)', fontSize: 16, marginBottom: 16 }}>Messages</div>
                {['Mara', 'Jin', 'Priya', 'The Reef'].map((c, i) => <div key={c} style={{ padding: '9px 10px', borderRadius: 10, background: i === 0 ? 'var(--cl-surface)' : 'none', color: i === 0 ? 'var(--cl-text)' : undefined }}>{c}</div>)}
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div className="h-[54px] border-b border-cl-border bg-cl-deep flex flex-row items-center justify-between px-4 shrink-0 z-20 w-full">
                    <div className="flex items-center gap-3">
                        <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#FFC94D', opacity: .85 }} />
                        <div style={{ color: 'var(--cl-text)', fontFamily: 'Fredoka', fontWeight: 600, fontSize: 15 }}>Mara</div>
                    </div>
                    <div className="flex items-center gap-1">
                        <div style={iconBtn}><Phone size={18} /></div>
                        <div style={iconBtn}><Video size={18} /></div>
                        <span className="relative inline-flex">
                            <TrustBadge trust={trust} displayName="Mara" size={20} onClick={() => { (window as any).__compareOpened = true; }} className="px-2" />
                            <SafetyVerifyHint
                                userId={ME} peerUserId={THEM} peerName="Mara" isOneToOneDm isSelfChat={false} warningActive={false}
                                messages={thread} isMine={((m: Msg) => m.sender_user_id === ME) as (m: never) => boolean}
                                callActiveHere={false} onCompare={() => { (window as any).__compareOpened = true; }}
                            />
                        </span>
                        <div style={iconBtn}><MoreVertical size={18} /></div>
                    </div>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 24 }}>
                    <div style={bubble(320)} /><div style={bubble(220, true)} /><div style={bubble(260)} /><div style={bubble(180, true)} /><div style={bubble(300)} /><div style={bubble(240, true)} />
                </div>
                <div style={{ margin: '0 20px 20px', height: 46, borderRadius: 14, background: 'var(--cl-surface)', color: 'var(--cl-faint, #6B7699)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message Mara…</div>
            </div>
        </div>
    );
};

const App: React.FC = () => (
    <>
        <Chat />
        <MomentHost />
    </>
);

(async () => {
    await secureLocalStore.hydrate();
    secureLocalStore.setItem('cipherline_user_id', ME);
    await secureLocalStore.whenAccountReady();
    // Mara's device has been seen and pinned, never verified.
    secureLocalStore.setItem(`kv_verify_v2_${ME}_${THEM}`, JSON.stringify({ v: 2, devices: { 'dev-t': { pub: 'pubT==', verified: false, first_seen: 1, last_seen: 1 } } }));
    // Ceremony-only scenes: the hint is already finished, so it is not behind the overlay.
    if (scene === 'ceremony') secureLocalStore.setItem(`cipherline_safety_hint_done_${ME}`, '1');
    (window as any).__ceremony = (peer?: string) => requestCeremony('safety-verified', peer === undefined ? undefined : { peer });
    (window as any).__verify = () => markVerified(ME, THEM, 'pubT==', 'dev-t', 'Mara');
    (window as any).__reset = () => {
        secureLocalStore.removeItem(`cipherline_first_verify_played_${ME}`);
        if (scene !== 'ceremony') secureLocalStore.removeItem(`cipherline_safety_hint_done_${ME}`);
        secureLocalStore.setItem(`kv_verify_v2_${ME}_${THEM}`, JSON.stringify({ v: 2, devices: { 'dev-t': { pub: 'pubT==', verified: false, first_seen: 1, last_seen: 1 } } }));
    };
    (window as any).__state = () => ({
        hint: !!document.querySelector('[data-testid="safety-verify-hint"]'),
        moment: document.querySelector('[data-testid="moment"]')?.getAttribute('data-moment') ?? null,
        hintDone: secureLocalStore.getItem(`cipherline_safety_hint_done_${ME}`),
        played: secureLocalStore.getItem(`cipherline_first_verify_played_${ME}`),
        pins: getKnownDevices(ME, THEM),
    });
    createRoot(document.getElementById('root')!).render(<App />);
    (window as any).__ready = true;
})();
