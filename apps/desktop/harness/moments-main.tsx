/* eslint-disable -- visual harness, not shipped */
import './easter-eggs-clock';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/dialog-frame.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useState } from 'react';
import axios from 'axios';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { MomentHost } from '../src/components/moments/MomentHost';
import { requestMoment, MOMENTS, type MomentId, type MomentContext } from '../src/utils/moments';
import { EGG_LEDGER_KEY } from '../src/utils/easterEggs';
import { AddFriendModal } from '../src/components/AddFriendModal';
import { ServerInviteModal } from '../src/components/server/ServerInviteModal';
import { useMomentInviteRequest } from '../src/hooks/useMomentInviteRequest';
import type { ServerInfo } from '../src/hooks/useServers';

/**
 * Moments harness. The REAL MomentHost (and, for ?scene=add-friend, the real AddFriendModal) over a
 * static stand-in of the app so each moment is seen where it will really play.
 *
 *   ?scene=play        window.__play(id, ctx?) asks for a moment exactly like a trigger does
 *   ?scene=call        like play, over a stand-in call stage (participant tiles + a control bar), to see a
 *                      moment in a call and that it never covers the controls
 *   ?scene=add-friend  the Add Friend dialog; type Dawson#1234 (the stub user's own tag) and send
 *   ?date=<ISO local>  freezes the clock (harness/easter-eggs-clock.ts), for the calendar moments
 *
 * Both scenes also mount Dashboard's invite path for real: useMomentInviteRequest → the real
 * ServerInviteModal for the server the request named (two stub servers, so "which server" is
 * observable). The rarity die is pinned to 0 (every roll plays) unless ?die=<0..1> says otherwise.
 *
 * window.__reset() clears the seen-ledger; window.__calls records every request the network saw;
 * window.__ids lists every registered moment; window.__inviteFor is the server the dialog opened for.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'play';
const die = Number(q.get('die') ?? '0');

const SERVERS: ServerInfo[] = ['s-reef', 's-kelp'].map((id, i) => ({
    server_id: id, name: i === 0 ? 'The Reef' : 'Kelp Forest', description: null,
    icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null,
    owner_user_id: 'u-dawson', created_at: '2026-01-01T00:00:00Z',
}));

(window as any).__calls = [] as string[];
axios.defaults.adapter = async (config: any) => {
    const line = `${String(config.method).toUpperCase()} ${config.url}`;
    (window as any).__calls.push(line);
    let data: unknown = {};
    if (/GET .*\/servers\/[^/]+\/invites$/.test(line)) data = [];
    else if (/POST .*\/servers\/([^/]+)\/invites$/.test(line)) {
        const sid = /servers\/([^/]+)\/invites/.exec(line)![1];
        data = { code: `${sid.slice(2)}42`, uses: 0, max_uses: null, expires_at: null, created_at: new Date().toISOString(), revoked_at: null };
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config };
};
(window as any).__reset = () => secureLocalStore.setItem(EGG_LEDGER_KEY, '{}');
(window as any).__play = (id: MomentId, ctx?: MomentContext) => requestMoment(id, ctx);

const bubble = (w: number, mine = false): React.CSSProperties => ({
    width: w, height: 34, borderRadius: 14, marginBottom: 12, alignSelf: mine ? 'flex-end' : 'flex-start',
    background: mine ? 'rgba(37,224,200,.18)' : 'var(--cl-surface)',
});

/** A quiet stand-in for the app: rail, channel list, a chat, a composer. */
const Backdrop: React.FC = () => (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--cl-abyss)', fontFamily: 'Nunito, sans-serif' }}>
        <div style={{ width: 72, background: '#080B17', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 10 }}>
            {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 0 ? 'var(--cl-lume)' : 'var(--cl-surface)' }} />)}
        </div>
        <div style={{ width: 240, background: 'var(--cl-deep)', padding: '18px 14px', color: 'var(--cl-muted, #9AA6C8)', fontSize: 14 }}>
            <div style={{ fontFamily: 'Fredoka', fontWeight: 600, color: 'var(--cl-text)', fontSize: 16, marginBottom: 16 }}>The Reef</div>
            {['# general', '# memes', '# announcements', '🔊 Lounge', '🔊 Gaming'].map(c => <div key={c} style={{ padding: '7px 8px' }}>{c}</div>)}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 52, borderBottom: '1px solid var(--cl-border)', display: 'flex', alignItems: 'center', padding: '0 20px', color: 'var(--cl-text)', fontFamily: 'Fredoka', fontWeight: 600 }}># general</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 24 }}>
                <div style={bubble(320)} /><div style={bubble(220)} /><div style={bubble(260, true)} /><div style={bubble(180)} /><div style={bubble(300, true)} />
            </div>
            <div style={{ margin: '0 20px 20px', height: 46, borderRadius: 14, background: 'var(--cl-surface)', color: 'var(--cl-faint, #6B7699)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message #general…</div>
        </div>
    </div>
);

/** A stand-in call stage: a grid of participant tiles and the control bar along the bottom. */
const CallBackdrop: React.FC = () => (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--cl-abyss)', fontFamily: 'Nunito, sans-serif' }}>
        <div style={{ position: 'absolute', left: 24, right: 24, top: 24, bottom: 110, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(2, 1fr)', gap: 14 }}>
            {['Mara', 'Jin', 'Dawson', 'Priya', 'Tomas', 'Lee'].map((n, i) => (
                <div key={n} style={{ background: i === 2 ? '#16203D' : 'var(--cl-deep)', borderRadius: 18, border: '1px solid var(--cl-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                    <div style={{ width: 84, height: 84, borderRadius: '50%', background: ['#25E0C8', '#FFC94D', '#FF8FB1', '#5e8ee0', '#4ADE80', '#FF6B5E'][i], opacity: .75 }} />
                    <div style={{ position: 'absolute', left: 14, bottom: 10, color: 'var(--cl-text)', fontWeight: 700, fontSize: 14 }}>{n}</div>
                </div>
            ))}
        </div>
        <div data-testid="harness-controls" style={{ position: 'absolute', left: '50%', bottom: 22, transform: 'translateX(-50%)', display: 'flex', gap: 12, padding: '12px 18px', borderRadius: 999, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)' }}>
            {['#25E0C8', '#5B6788', '#5B6788', '#5B6788', '#FF6B5E'].map((c, i) => <div key={i} style={{ width: 46, height: 46, borderRadius: '50%', background: c }} />)}
        </div>
    </div>
);

/** Dashboard's invite path, as it is wired there: the hook → the real dialog for the named server. */
const InviteHost: React.FC = () => {
    const [sid, setSid] = useState<string | null | undefined>(undefined);
    useMomentInviteRequest(s => { (window as any).__inviteFor = s; setSid(s); });
    if (sid === undefined) return null;
    const srv = SERVERS.find(s => s.server_id === (sid ?? 's-reef'));
    if (!srv) return null;
    return <ServerInviteModal server={srv} token="t" onClose={() => setSid(undefined)} />;
};

const App: React.FC = () => (
    <>
        {scene === 'call' ? <CallBackdrop /> : <Backdrop />}
        {scene === 'add-friend' && <AddFriendModal onClose={() => { (window as any).__closed = true; }} />}
        <InviteHost />
        <MomentHost random={() => die} />
    </>
);

(async () => {
    // main.tsx hydrates the encrypted store before first paint; the ledger lives in it.
    await secureLocalStore.hydrate();
    createRoot(document.getElementById('root')!).render(<App />);
    (window as any).__ids = Object.keys(MOMENTS);
})();
