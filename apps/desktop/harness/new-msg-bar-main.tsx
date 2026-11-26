/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/formatting.css';
import '../src/styles/theme-light.css';
import '../src/styles/theme-midnight.css';
import ChatPane from '../src/components/ChatPane';
import { ToastProvider } from '../src/contexts/ToastContext';
import { useRetentionPolicy } from '../src/hooks/useRetentionPolicy';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import secureLocalStore from '../src/utils/secureLocalStore';
import { ALL_PERMISSIONS } from '@cipherline/shared';

/**
 * "When someone joins or someone sends a message in a chat you're scrolled up
 * in, it jumps you down to the bottom" (owner, 2026-11-26). The REAL ChatPane
 * rendering a server text channel in a Dashboard-shaped frame (server rail |
 * channel list | chat | member panel), with in-page hooks that make the feed
 * change the ways the live app does:
 *
 *   __nmb.incoming(n)      n messages from other people land at the end
 *   __nmb.join()           a "X joined the server" member row lands at the end
 *   __nmb.ownRow()         a row from ME lands at the end (an own send's echo)
 *   __nmb.edit(id)         an existing message's text grows in place
 *   __nmb.react(id)        a reaction is added to an existing message
 *   __nmb.imageAbove(id)   an existing message gains an auto-loading image (it
 *                          decodes asynchronously, so its height changes twice)
 *   __nmb.typing(on)       the typing indicator appears / goes away
 *
 *   ?theme=dark|light|midnight|hc-dark|hc-light   (Settings > Appearance)
 *   ?panels=0   no side panels
 *   ?banner=1   a pinned-message strip above the feed (the bar must sit below it)
 */
const q = new URLSearchParams(location.search);
const panels = q.get('panels') !== '0';
engine.applyTheme(themes.resolveTheme(q.get('theme') ?? 'dark'));

const ok = (config: any, data: unknown) => Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config } as any);
const later = <T,>(ms: number, f: () => T) => new Promise<T>(r => setTimeout(() => r(f()), ms));
axios.defaults.adapter = (config: any) => {
    const url = String(config.url ?? '').replace(/^.*\/v1/, '');
    if (/\/me\/permissions$/.test(url)) return ok(config, { permissions: ALL_PERMISSIONS.toString() });
    if (/^\/channels\/c1\/saves$/.test(url)) return ok(config, { saved: [], pinned: [] });
    return ok(config, []);
};

// An auto-loaded image (i.imgur.com is a "known" host, so it loads without a click).
const pngB64 = (() => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 270;
    const g = c.getContext('2d')!; const gr = g.createLinearGradient(0, 0, 480, 270);
    gr.addColorStop(0, '#25E0C8'); gr.addColorStop(1, '#1d2b64'); g.fillStyle = gr; g.fillRect(0, 0, 480, 270);
    return c.toDataURL('image/png').split(',')[1];
})();
(window as any).electronAPI = {
    fetchBinary: (_u: string) => later(350, () => ({ mimeType: 'image/png', b64: pngB64 })),
};

const LINES = [
    'did anyone check the router config after the reboot?',
    'yeah, the DHCP lease table was full again. **cleared it**',
    'we should bump the pool size, it keeps happening on Mondays',
    'agreed. I can do it tonight after the backup finishes',
    'also the printer on floor 2 is back to printing everything twice',
    'classic. turn it off and on again?',
    'tried that. it printed the test page twice too 🙃',
    'ok I will look at it tomorrow morning',
    '> it printed the test page twice too\nthat is honestly impressive',
    'here are the notes from standup:\n- router pool size\n- printer\n- new laptops arrive Thursday',
];
const SENDERS = [
    { uid: 'u-mira', dev: 'd-mira', name: 'Mira' },
    { uid: 'u-jun', dev: 'd-jun', name: 'Jun' },
    { uid: 'me', dev: '11111111-1111-4111-8111-111111111111', name: 'Dawson' },
];
const NOW = Date.now();
const T0 = NOW - 3 * 3600_000;
const MESSAGES = Array.from({ length: 60 }, (_, i) => {
    const s = SENDERS[(i * 7 + (i >> 2)) % 3];
    return {
        id: `m${String(i).padStart(2, '0')}`,
        conversation_id: 'c1',
        channel_id: 'c1',
        sender_user_id: s.uid,
        sender_device_id: s.dev,
        sender_username: s.name,
        timestamp: new Date(T0 + i * 2 * 60_000).toISOString(),
        content: { type: 'text', text: LINES[i % LINES.length] },
    };
});

const SERVERS = [{ id: 's1', server_id: 's1', name: 'Office', owner_id: 'me', icon_url: null } as any];
const CHANNEL = { channel_id: 'c1', name: 'general', topic: 'day-to-day', server_id: 's1', my_permissions: ALL_PERMISSIONS.toString() };
const CHANNELS = [{ channel_id: 'c1', name: 'general', server_id: 's1', kind: 'text' } as any];

function paneWidths(W: number) {
    const max = Math.max(500, Math.round(W * 0.35));
    return { left: Math.max(200, Math.min(max, 0.18 * W)), right: Math.max(280, Math.min(max, 0.2 * W)) };
}
const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };

let seq = 0;
const App = () => {
    const retention = useRetentionPolicy('me');
    const [messages, setMessages] = useState<any[]>(MESSAGES);
    const [typing, setTyping] = useState<Set<string>>(new Set());
    const lastTs = (ms: any[]) => Date.parse(ms[ms.length - 1].timestamp);
    const append = (rows: (ts: number) => any[]) => setMessages(ms => [...ms, ...rows(lastTs(ms))]);
    (window as any).__nmb = {
        incoming: (n = 1) => append(ts => Array.from({ length: n }, (_, i) => {
            seq++;
            const s = SENDERS[seq % 2];
            return {
                id: `n${seq}`, conversation_id: 'c1', channel_id: 'c1',
                sender_user_id: s.uid, sender_device_id: s.dev, sender_username: s.name,
                timestamp: new Date(ts + (i + 1) * 30_000).toISOString(),
                content: { type: 'text', text: `new message ${seq} from ${s.name}` },
            };
        })),
        join: () => append(ts => [{
            id: `sys${++seq}`, conversation_id: 'c1', sender_device_id: '', sender_user_id: null,
            timestamp: new Date(ts + 30_000).toISOString(),
            content: { type: 'system', kind: 'member_event', event: 'member_join', subject_user_id: 'u-jun', actor_user_id: null },
        }]),
        ownRow: () => append(ts => [{
            id: `own${++seq}`, conversation_id: 'c1', channel_id: 'c1',
            sender_user_id: 'me', sender_device_id: SENDERS[2].dev, sender_username: 'Dawson',
            timestamp: new Date(ts + 30_000).toISOString(),
            content: { type: 'text', text: 'my own message' },
        }]),
        edit: (id: string) => setMessages(ms => ms.map(m => m.id === id
            ? { ...m, edited: true, content: { ...m.content, text: m.content.text + '\n\n(edited) and a much longer second paragraph that wraps over several lines so the row grows by a good amount when the edit lands in the feed.' } }
            : m)),
        react: (id: string) => setMessages(ms => ms.map(m => m.id === id
            ? { ...m, reactions: { '👍': ['u-mira', 'u-jun'] } }
            : m)),
        imageAbove: (id: string) => setMessages(ms => ms.map(m => m.id === id
            ? { ...m, content: { ...m.content, text: 'screenshot https://i.imgur.com/abc123.png' } }
            : m)),
        typing: (on: boolean) => setTyping(on ? new Set(['d-mira']) : new Set()),
    };
    const W = window.innerWidth;
    const { left: lw, right: rw } = paneWidths(W);
    const activeChannel = CHANNEL;
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
            <nav style={{ width: 72, flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px' }}>
                {panels && <aside style={{ ...card, width: lw, flex: 'none' }} />}
                {panels && <div style={{ width: 10, flex: 'none' }} />}
                <main id="chat" style={{ ...card, flex: 1, minWidth: 0, position: 'relative', background: 'var(--cl-abyss)' }}>
                    <ChatPane
                        bundleReady
                        activeChat={{ id: activeChannel.channel_id }}
                        activeChannel={activeChannel}
                        emojisChangedEvent={null}
                        serverChannels={CHANNELS}
                        serverCategories={[]}
                        onNavigateToChannel={() => {}}
                        messages={messages}
                        messagesFetching={false}
                        onMessageSent={() => {}}
                        onChannelMessageSent={() => {}}
                        onPatchSentMessage={() => {}}
                        typingUsers={typing}
                        sendTypingEvent={() => {}}
                        readReceipts={{}}
                        sendReadReceipt={() => {}}
                        showReadReceipts
                        activeCall={null}
                        onCallChange={() => {}}
                        retention={retention}
                        friendStatuses={{}}
                        serverSavedIds={[]}
                        pinnedMsgIds={q.get('banner') === '1' ? ['m10'] : []}
                        onPinMessage={() => {}}
                        onUnpinMessage={() => {}}
                        onServerSaveMessage={() => {}}
                        onServerUnsaveMessage={() => {}}
                        pinnedSidebarExpanded={false}
                        onTogglePinnedSidebar={() => {}}
                        onOpenPinnedCallOverlay={() => {}}
                        pinnedSearchQuery=""
                        onOpenProfile={() => {}}
                        avatarUpdatedEvent={null}
                        memberRoleColors={{}}
                        serverMemberNicknames={{ 'u-jun': 'Jun', 'u-mira': 'Mira' }}
                        convType="server"
                        servers={SERVERS}
                        onInviteJoin={() => {}}
                        onInviteCodeClick={() => {}}
                        channelPermissions={BigInt(activeChannel.my_permissions)}
                        channelKeyMissing={false}
                        channelKeyCoolingOff={false}
                        historyStart
                        myUserId="me"
                        onReport={() => {}}
                    />
                </main>
                {panels && <div style={{ width: 10, flex: 'none' }} />}
                {panels && <aside style={{ ...card, width: rw, flex: 'none' }} />}
            </div>
        </div>
    );
};

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', 'me');
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
    (window as any).__ready = true;
})();
