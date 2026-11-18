/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useCallback, useRef, useState } from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/formatting.css';
import ChatPane from '../src/components/ChatPane';
import { ToastProvider } from '../src/contexts/ToastContext';
import { useRetentionPolicy } from '../src/hooks/useRetentionPolicy';
import { withId, withoutId } from '../src/utils/channelServerSaves';
import { withPersonalChannelSaves, attachmentIdsOf } from '../src/utils/personalChannelSaves';
import { useRetentionCoverageShrink } from '../src/hooks/useRetentionCoverageShrink';
import {
    HISTORY_PAGE_SIZE, addCoveredRange, rangeForPage, reachesHistoryStart, historyGaps,
    type ChannelCoverage, type HistoryGap,
} from '../src/utils/channelHistoryCoverage';
import { CARD_STYLE_TEMPLATES } from '../src/utils/cardStyle/cardStyleTemplates';
import secureLocalStore from '../src/utils/secureLocalStore';
import { ALL_PERMISSIONS } from '@cipherline/shared';

/**
 * "Saving a message in a chat with formatted text makes the chat jump"
 * (owner, 0.1.2-staging.242 and, for a split second, .245). The REAL ChatPane
 * rendering a server text channel of formatted messages (headings, lists,
 * syntax-highlighted code blocks, quotes, a long collapsed message, styled
 * cards, a link card, an invite card, an auto-loaded image, a reply), in a
 * frame shaped like Dashboard's (server rail | channel list | chat | member
 * panel at the default ratios).
 *
 * The parent mirrors Dashboard's channel ChatPane wiring, not a tidy version
 * of it: every prop Dashboard rebuilds on each render is rebuilt here too
 * (inline arrow handlers, `x || []`, `?? {}`, `new Set()`), and a save / pin
 * runs Dashboard's sequence: the optimistic id-list update
 * (handleServerSaveChannel / handleServerPinChannel), the POST, the storage
 * refresh key bump, then the `channel:saves_changed` / `pins_changed` push
 * that refetches GET /saves and applies FRESH arrays with the same ids
 * (applyChannelSaveState).
 *
 * "Save for me" runs through Dashboard's `channelRetention` (the retention hook
 * wrapped by withPersonalChannelSaves over `localChannelPins` state), and the
 * channel's history coverage is Dashboard's: the real retention-change hook
 * (useRetentionCoverageShrink) and coverage utils, with a gap fill answered as
 * an empty `before` page (round 3, 0.1.2-staging.247).
 *
 *   ?panels=0   no side panels (chat column = whole window minus the rail)
 *   ?ret=1mo    finite channel retention (rows count down; Save for me offered)
 *
 * window.__snj exposes the save handlers for the check script.
 */
const q = new URLSearchParams(location.search);
const panels = q.get('panels') !== '0';
const fresh = q.get('fresh') === '1';
// ?ret=1mo — a finite channel retention (Dashboard's activeChannelRetention), so
// rows carry expiry countdowns and "Save for me" is offered (the default
// 'never' keeps everything, and every row reads as already saved).
const ret = (q.get('ret') || undefined) as any;

// ── Network: answered in-page ───────────────────────────────────────────────
const store = { saved: [] as string[], pinned: [] as string[] };
const ok = (config: any, data: unknown) => Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config } as any);
const later = <T,>(ms: number, f: () => T) => new Promise<T>(r => setTimeout(() => r(f()), ms));
axios.defaults.adapter = (config: any) => {
    const url = String(config.url ?? '').replace(/^.*\/v1/, '');
    const method = String(config.method ?? 'get').toLowerCase();
    if (/\/me\/permissions$/.test(url)) return ok(config, { permissions: ALL_PERMISSIONS.toString() });
    if (/^\/invites\/[^/]+\/preview$/.test(url)) return later(30, () => ok(config, {
        server_id: 's9', server_name: 'Woodshop Friends', server_description: 'Weekly builds, show and tell.',
        server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 1284, expires_at: null,
    })).then(x => x);
    if (/^\/channels\/c1\/saves$/.test(url)) return later(40, () => ok(config, { saved: [...store.saved], pinned: [...store.pinned] })).then(x => x);
    if (method !== 'get') return later(60, () => ok(config, { ok: true })).then(x => x);
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
    fetchBinary: (_u: string) => later(80, () => ({ mimeType: 'image/png', b64: pngB64 })),
};

// ── The feed ────────────────────────────────────────────────────────────────
const CODE_TS = '```ts\n// Debounce a function — the classic.\nexport function debounce<T extends (...a: unknown[]) => void>(fn: T, ms = 200) {\n    let t: ReturnType<typeof setTimeout> | null = null;\n    return (...args: Parameters<T>) => {\n        if (t) clearTimeout(t);\n        t = setTimeout(() => fn(...args), ms);\n    };\n}\nconst ready = true, retries = 3;\n```';
const CODE_PY = '```python\n@dataclass\nclass Message:\n    sender: str\n    body: str = ""\n\n    def preview(self, n: int = 40) -> str:\n        # One line, cut at n characters\n        return self.body[:n] if self.body else None\n```';
const CODE_SQL = '```sql\nSELECT id, created_at FROM messages\nWHERE channel_id = $1 AND deleted_at IS NULL\nORDER BY created_at DESC LIMIT 50;\n```';
const BLOCKS = [
    '# Release notes',
    'Headings add weight and colour, never size.',
    '## What changed',
    '- A formatting bar next to the paperclip',
    '- Markdown paste that asks first',
    '  - tables turn into aligned code blocks',
    '  - `__bold__` from GitHub stays bold',
    '1. Pick some text',
    '2. Press **Ctrl+B**',
    '> Quotes for the bits worth repeating,',
    '> across as many lines as you like.',
    '### Known issues',
    'None **yet**.',
    '-# subtext — the small print',
].join('\n');
const INLINE = '**bold**, *italic*, __underline__, ~~strike~~, `inline code`, and a ||spoiler||. A [masked link](https://example.com/docs) and https://example.com/blog/post-1.';
// Past LONG_MESSAGE_THRESHOLD (3,000 characters): collapsed behind "Expand".
const LONG = 'pasted the whole migration, **careful** with step 3:\n```ts\n' + Array.from({ length: 96 }, (_, i) => (i % 8 === 0
    ? `// step ${i / 8 + 1}`
    : `const rows${i} = await db.page(cursor, ${i * 500});`)).join('\n') + '\n```';
const rules = CARD_STYLE_TEMPLATES.find(t => t.id === 'rules')!;
const ann = CARD_STYLE_TEMPLATES.find(t => t.id === 'announcement')!;

type Body = { text: string; card_style?: unknown; reply?: boolean };
const BODIES: Body[] = [
    { text: INLINE },
    { text: BLOCKS },
    { text: 'quick one before standup:\n' + CODE_TS },
    { text: 'and the model:\n' + CODE_PY },
    { text: rules.sample, card_style: rules.style },
    { text: CODE_SQL, reply: true },
    { text: 'join us https://cipherline.chat/invite/woodshop42' },
    { text: LONG },
    { text: 'screenshot of the new bar https://i.imgur.com/abc123.png' },
    { text: ann.sample, card_style: ann.style },
    { text: 'ok **ship it** 🚀' },
];
const SENDERS = [
    { uid: 'u-mira', dev: 'd-mira' },
    { uid: 'u-jun', dev: 'd-jun' },
    { uid: 'me', dev: '11111111-1111-4111-8111-111111111111' },
];
const NOW = Date.now();
const MESSAGES = Array.from({ length: 40 }, (_, i) => {
    const s = SENDERS[(i * 7 + (i >> 2)) % 3];
    const b = BODIES[i % BODIES.length];
    const content: any = { type: 'text', text: b.text };
    if (b.card_style) content.card_style = b.card_style;
    if (b.reply && i > 2) content.reply_to_id = `m${String(i - 2).padStart(2, '0')}`;
    return {
        id: `m${String(i).padStart(2, '0')}`,
        conversation_id: 'c1',
        channel_id: 'c1',
        sender_user_id: s.uid,
        sender_device_id: s.dev,
        sender_username: s.uid === 'me' ? 'Dawson' : s.uid === 'u-mira' ? 'Mira' : 'Jun',
        // 3 days ago onward (?fresh=1: today), a few minutes apart: inside the
        // 30-day expiry, so rows show countdowns.
        timestamp: new Date(NOW - (fresh ? 5 * 3600_000 : 3 * 86400_000) + i * 7 * 60_000).toISOString(),
        content,
        reactions: i % 4 === 1 ? [{ emoji: '👍', count: 2, user_ids: ['u-mira', 'u-jun'] }] : undefined,
    };
});

const SERVERS = [{ id: 's1', server_id: 's1', name: 'Woodshop', owner_id: 'me', icon_url: null, message_styles: 'on' } as any];
const CHANNEL = { channel_id: 'c1', name: 'general', topic: 'release talk', server_id: 's1', my_permissions: ALL_PERMISSIONS.toString() };
const CHANNELS = [{ channel_id: 'c1', name: 'general', server_id: 's1', kind: 'text' } as any];

function paneWidths(W: number) {
    const max = Math.max(500, Math.round(W * 0.35));
    return { left: Math.max(200, Math.min(max, 0.18 * W)), right: Math.max(280, Math.min(max, 0.2 * W)) };
}
const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };

const App = () => {
    const retention = useRetentionPolicy('me');
    // Dashboard state shapes: per-channel records.
    const [channelServerSaves, setChannelServerSaves] = useState<Record<string, string[]>>({ c1: [] });
    const [channelPinnedIds, setChannelPinnedIds] = useState<Record<string, string[]>>({ c1: [] });
    const [, setStorageRefreshKey] = useState(0);
    const [channelMessages] = useState<Record<string, any[]>>({ c1: MESSAGES });
    const savesRef = useRef(channelServerSaves); savesRef.current = channelServerSaves;
    // Dashboard's channel "Save for me" (handlePersonalChannelSave + channelRetention):
    // the retention save AND a synced personal channel save in `localChannelPins`.
    const [localChannelPins, setLocalChannelPins] = useState<Record<string, string[]>>({});
    const handlePersonalChannelSave = useCallback((cid: string, id: string, action: 'add' | 'remove') => {
        setLocalChannelPins(p => ({ ...p, [cid]: action === 'add' ? withId(p[cid], id) : withoutId(p[cid], id) }));
    }, []);
    const activeChannelId = CHANNEL.channel_id;
    const channelRetention = React.useMemo(() => {
        const saved = localChannelPins[activeChannelId] ?? [];
        const msgs: any[] = channelMessages[activeChannelId] ?? [];
        return withPersonalChannelSaves(retention, {
            savedMessageIds: saved,
            savedAttachmentIds: attachmentIdsOf(msgs, saved),
            messageIdForAttachment: (attId) => msgs.find(m => m?.content?.type === 'attachment' && m.content.attachment_id === attId)?.id,
            onToggle: (msgId, action) => handlePersonalChannelSave(activeChannelId, msgId, action),
        });
    }, [retention, activeChannelId, localChannelPins, channelMessages, handlePersonalChannelSave]);
    const channelRetentionRef = useRef(channelRetention); channelRetentionRef.current = channelRetention;

    // Dashboard's channel history coverage: the whole channel is loaded (its
    // first message included), so the feed opens on "This is the beginning of
    // #general". The retention-change hook is Dashboard's own; a gap fill is
    // answered like the API would for a channel with nothing older (an empty
    // `before` page, which reaches the start again).
    const [channelCoverage, setChannelCoverage] = useState<Record<string, ChannelCoverage>>({});
    const channelMessagesRef = useRef(channelMessages); channelMessagesRef.current = channelMessages;
    useRetentionCoverageShrink(retention.policy, '0:0', setChannelCoverage, channelMessagesRef);
    React.useEffect(() => { setChannelCoverage({ c1: [{ lo: null, hi: null }] }); }, []);
    const openChannelGaps = React.useMemo<HistoryGap[]>(
        () => historyGaps(channelCoverage.c1, channelMessages.c1 ?? []), [channelCoverage, channelMessages]);
    const fillChannelHistoryGap = useCallback(async (cid: string, gap: HistoryGap) => {
        if (!gap.newer) return { shown: 0, progressed: false };
        const range = await later(120, () => rangeForPage({ kind: 'before', limit: HISTORY_PAGE_SIZE, cursor: gap.newer! }, []));
        (window as any).__snjFills = ((window as any).__snjFills ?? 0) + 1;
        setChannelCoverage(prev => ({ ...prev, [cid]: addCoveredRange(prev[cid] ?? [], range) }));
        return { shown: 0, progressed: true };
    }, []);

    // Dashboard applyChannelSaveState: FRESH arrays from GET /saves.
    const applyChannelSaveState = useCallback((cid: string, st: { saved: string[]; pinned: string[] }) => {
        setChannelServerSaves(prev => ({ ...prev, [cid]: st.saved }));
        setChannelPinnedIds(prev => ({ ...prev, [cid]: st.pinned }));
    }, []);
    // The channel:saves_changed / pins_changed push every member (the actor too) gets.
    const pushSavesChanged = useCallback((cid: string) => {
        setTimeout(async () => {
            const r = await axios.get(`/v1/channels/${cid}/saves`);
            applyChannelSaveState(cid, r.data);
        }, 90);
    }, [applyChannelSaveState]);

    const handleServerSaveChannel = useCallback(async (cid: string, id: string) => {
        setChannelServerSaves(p => ({ ...p, [cid]: withId(p[cid], id) }));
        await axios.post(`/v1/channels/${cid}/saves/${id}`, { attachment_ids: [] });
        store.saved = withId(store.saved, id);
        setStorageRefreshKey(k => k + 1);
        pushSavesChanged(cid);
    }, [pushSavesChanged]);
    const handleServerUnsaveChannel = useCallback(async (cid: string, id: string) => {
        setChannelServerSaves(p => ({ ...p, [cid]: withoutId(p[cid], id) }));
        await axios.delete(`/v1/channels/${cid}/saves/${id}`);
        store.saved = withoutId(store.saved, id);
        setStorageRefreshKey(k => k + 1);
        pushSavesChanged(cid);
    }, [pushSavesChanged]);
    const handleServerPinChannel = useCallback(async (cid: string, id: string) => {
        setChannelPinnedIds(p => ({ ...p, [cid]: withId(p[cid], id) }));
        setChannelServerSaves(p => ({ ...p, [cid]: withId(p[cid], id) }));
        await axios.post(`/v1/channels/${cid}/pins/${id}`, { attachment_ids: [] });
        store.pinned = withId(store.pinned, id); store.saved = withId(store.saved, id);
        setStorageRefreshKey(k => k + 1);
        pushSavesChanged(cid);
    }, [pushSavesChanged]);
    const handleServerUnpinChannel = useCallback(async (cid: string, id: string) => {
        setChannelPinnedIds(p => ({ ...p, [cid]: withoutId(p[cid], id) }));
        await axios.delete(`/v1/channels/${cid}/pins/${id}`);
        store.pinned = withoutId(store.pinned, id);
        pushSavesChanged(cid);
    }, [pushSavesChanged]);

    (window as any).__snj = {
        save: (id: string) => handleServerSaveChannel('c1', id),
        unsave: (id: string) => handleServerUnsaveChannel('c1', id),
        pin: (id: string) => handleServerPinChannel('c1', id),
        unpin: (id: string) => handleServerUnpinChannel('c1', id),
        psave: (id: string) => channelRetentionRef.current.saveMessage(id),
        punsave: (id: string) => channelRetentionRef.current.unsaveMessage(id),
        psaved: (id: string) => channelRetentionRef.current.policy.savedMessageIds.includes(id)
            && !channelRetentionRef.current.policy.unsavedMessageIds.includes(id),
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
                    {/* Props as Dashboard passes them for a server text channel. */}
                    <ChatPane
                        bundleReady
                        activeChat={{ id: activeChannel.channel_id }}
                        activeChannel={activeChannel}
                        emojisChangedEvent={null}
                        serverChannels={CHANNELS}
                        serverCategories={[]}
                        onNavigateToChannel={() => {}}
                        messages={channelMessages[activeChannel.channel_id] || []}
                        messagesFetching={false}
                        onMessageSent={() => {}}
                        onChannelMessageSent={() => {}}
                        onPatchSentMessage={() => {}}
                        typingUsers={new Set()}
                        sendTypingEvent={() => {}}
                        readReceipts={{}}
                        sendReadReceipt={() => {}}
                        showReadReceipts
                        activeCall={null}
                        onCallChange={() => {}}
                        retention={channelRetention}
                        friendStatuses={{}}
                        serverSavedIds={channelServerSaves[activeChannel.channel_id] || []}
                        pinnedMsgIds={channelPinnedIds[activeChannel.channel_id] || []}
                        onPinMessage={(msgId) => handleServerPinChannel(activeChannel.channel_id, msgId)}
                        onUnpinMessage={(msgId) => handleServerUnpinChannel(activeChannel.channel_id, msgId)}
                        onServerSaveMessage={(msgId) => handleServerSaveChannel(activeChannel.channel_id, msgId)}
                        onServerUnsaveMessage={(msgId) => handleServerUnsaveChannel(activeChannel.channel_id, msgId)}
                        pinnedSidebarExpanded={false}
                        onTogglePinnedSidebar={() => {}}
                        channelSearchOpen={false}
                        onOpenPinnedCallOverlay={() => {}}
                        pinnedSearchQuery=""
                        onOpenProfile={() => {}}
                        avatarUpdatedEvent={null}
                        memberRoleColors={{}}
                        serverMemberNicknames={{}}
                        channelMessageRetention={ret}
                        channelAttachmentRetention={ret}
                        convType="server"
                        servers={SERVERS}
                        onInviteJoin={() => {}}
                        onInviteCodeClick={() => {}}
                        channelPermissions={BigInt(activeChannel.my_permissions)}
                        channelKeyMissing={false}
                        channelKeyCoolingOff={false}
                        historyGaps={openChannelGaps}
                        historyStart={reachesHistoryStart(channelCoverage[activeChannel.channel_id])}
                        onFillHistoryGap={fillChannelHistoryGap}
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
})();
