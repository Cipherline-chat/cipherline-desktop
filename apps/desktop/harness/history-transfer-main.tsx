/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import '../src/styles/settings-descent.css';
import { SignInHistoryPrompt } from '../src/components/near/SignInHistoryPrompt';
import { MoveHistoryCard } from '../src/components/near/MoveHistoryCard';
import { NearTransferHost } from '../src/components/near/NearTransferHost';
import { openOwnTransferPicker, rememberAskedDevice } from '../src/utils/ownTransferPicker';
import { getTransferRunner } from '../src/utils/nearTransferRunner';
import type { NearSnapshot } from '../src/types/near';

/**
 * The sign-in history step (the local-network own-device transfer is the only way history moves between devices) and the
 * screens that follow it, rendered from the REAL components with a scripted near bridge. `?scene=` picks the state:
 *   signin | unavailable | picker | wait | wait-slow | holder | gate | progress | paused | details | done | nonet | declined |
 *   noanswer | space | peercancel | failed | settings
 * window.__log records bridge calls.
 */
loadWebFonts();
const log: any[] = ((window as any).__log = []);
const scene = new URLSearchParams(location.search).get('scene') ?? 'signin';

const transfer = { direction: 'receive' as const, bytesDone: 61_400_000, bytesTotal: 117_459_113, recordsDone: 4, recordsTotal: 8, attempt: 1, paused: false, interrupted: false };
const generic = { label: 'Your other device', platform: undefined as unknown as string, labelSealed: false };
const holderPeer = { label: 'This laptop · Linux · added Nov 24, 2026', platform: 'linux', labelSealed: false };
const snaps: Record<string, NearSnapshot | null> = {
    wait: { seq: 1, role: 'own_receiver', state: 'awaiting_approval', peer: generic },
    'wait-slow': { seq: 1, role: 'own_receiver', state: 'awaiting_approval', peer: generic },
    holder: { seq: 1, role: 'own_sender', state: 'awaiting_approval', peer: holderPeer },
    gate: { seq: 1, role: 'own_sender', state: 'approving', peer: holderPeer },
    progress: { seq: 2, role: 'own_receiver', state: 'transferring', peer: generic, transfer } as NearSnapshot,
    done: { seq: 3, role: 'own_receiver', state: 'done', peer: generic, transfer: { ...transfer, bytesDone: transfer.bytesTotal, recordsDone: 8 } } as NearSnapshot,
    nonet: { seq: 2, role: 'own_receiver', state: 'refused', peer: generic, error: { code: 'no_proximity', message: '' } },
    declined: { seq: 2, role: 'own_receiver', state: 'refused', peer: generic, error: { code: 'denied', message: '' } },
    noanswer: { seq: 2, role: 'own_receiver', state: 'expired', peer: generic, error: { code: 'own_no_answer', message: '' } },
    space: { seq: 3, role: 'own_receiver', state: 'failed', peer: generic, transfer, error: { code: 'near_error', message: 'storage: not enough free space for the transfer' } } as NearSnapshot,
    peercancel: { seq: 3, role: 'own_receiver', state: 'cancelled', peer: generic, error: { code: 'peer_cancelled', message: '' } },
    failed: { seq: 2, role: 'own_receiver', state: 'failed', peer: generic, error: { code: 'bad_answer', message: '' } },
    paused: { seq: 2, role: 'own_receiver', state: 'transferring', peer: generic, transfer: { ...transfer, paused: true, pausedBy: 'me' } } as NearSnapshot,
    details: { seq: 2, role: 'own_receiver', state: 'transferring', peer: generic, transfer } as NearSnapshot,
};
const fakePort: any = {
    estimate: async () => ({ totalBytes: 117_459_113, messages: 412, attachments: 37, attachmentBytes: 110_000_000 }),
    writeContainer: async () => undefined, importContainer: async () => ({ messages: 0, attachments: 0 }),
};
if (scene !== 'holder' && scene !== 'gate') rememberAskedDevice('Desk PC');

let gateCb: ((p: any) => void) | null = null;
(window as any).electronAPI = {
    nearProbe: async () => ({ available: scene !== 'unavailable', bluetooth: 'unsupported', lan: true, biometric: 'unavailable', gate: 'password' }),
    nearGetState: async () => snaps[scene] ?? { seq: 0, role: null, state: 'idle' },
    onNearState: () => () => undefined,
    onNearGatePrompt: (cb: any) => { gateCb = cb; return () => { gateCb = null; }; },
    nearTransferRequest: async (o: unknown) => { log.push(['nearTransferRequest', o]); return { seq: 1 }; },
    nearTransferPause: async () => undefined, nearTransferResume: async () => undefined,
    nearCancel: async () => { log.push(['nearCancel']); }, nearRefuse: async () => { log.push(['nearRefuse']); },
    nearApprove: async () => ({ result: 'approved', gate: 'password' }),
    nearGateSubmit: async () => 'ok', nearGateCancel: async () => undefined,
};

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100%', color: 'var(--cl-muted)', font: '14px Nunito, sans-serif', background: 'var(--cl-abyss, #0B0F1E)' }}>
        <div style={{ width: 72, background: '#131A30', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 0 ? '#25E0C8' : '#243056' }} />)}
        </div>
        <div style={{ width: 240, background: '#0F1528', padding: 16 }}>Direct messages</div>
        <div style={{ flex: 1, padding: 24 }}>No conversations yet</div>
    </div>
);

function App() {
    React.useEffect(() => {
        if (scene === 'picker') setTimeout(() => openOwnTransferPicker(), 300);
        if (scene === 'gate') setTimeout(() => gateCb?.({ ticket: 't-1', method: 'password' }), 500);
        if (scene === 'done') (getTransferRunner() as any).set({ direction: 'receive', device: 'Desk PC', counts: { messages: 412, attachments: 37 }, running: false, applying: false, finishedAt: 1 });
        if (scene === 'details') setTimeout(() => (Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Details') as HTMLButtonElement | undefined)?.click(), 900);
        if (scene === 'progress' || scene === 'paused' || scene === 'details') (getTransferRunner() as any).set({ direction: 'receive', device: 'Desk PC', running: true, startedAt: 1 });
    }, []);
    const signin = scene === 'signin' || scene === 'unavailable';
    return (
        <>
            <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ height: 34, background: '#0A0E1B' }} />
                <NearTransferHost reload={() => log.push(['reload'])} portFor={() => fakePort} />
                {scene === 'settings'
                    ? <div style={{ flex: 1, padding: 32, background: 'var(--cl-abyss, #0B0F1E)' }}><div style={{ maxWidth: 720 }}><h1 style={{ color: 'var(--cl-text)', font: '600 26px Fredoka, sans-serif' }}>Storage</h1><MoveHistoryCard /></div></div>
                    : <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><Backdrop /></div>}
            </div>
            {signin && (
                <SignInHistoryPrompt
                    userId="me" token="harness-token" deviceId="dev-new"
                    onOpenStorage={() => log.push(['openStorage'])}
                    hasHistory={async () => false}
                    listOtherDevices={async () => 3}
                />
            )}
        </>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
