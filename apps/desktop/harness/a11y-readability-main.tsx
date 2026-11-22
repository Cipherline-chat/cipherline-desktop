/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/formatting.css';
import ChatPane from '../src/components/ChatPane';
import { ToastProvider } from '../src/contexts/ToastContext';
import { A11yRuntime } from '../src/components/a11y/A11yRuntime';
import { AccessibilityPane } from '../src/components/settings/panes/AccessibilityPane';
import '../src/styles/home-deck.css';
import { StatusIcon } from '../src/components/StatusIcon';
import { HomeStatusDot } from '../src/components/HomeStatusDot';
import { READABILITY_SPECS, GROUP_GAP_KEY } from '../src/utils/a11y/readability';
import { useRetentionPolicy } from '../src/hooks/useRetentionPolicy';
import secureLocalStore from '../src/utils/secureLocalStore';
import { ALL_PERMISSIONS } from '@cipherline/shared';

/**
 * Accessibility readability harness (harness/a11y-readability-shots.mjs).
 * The REAL ChatPane (Dashboard-shaped frame) and the REAL Accessibility pane,
 * with A11yRuntime mounted so the stored settings apply exactly as in the app.
 *   ?view=chat|settings|status
 *   ?density= &font= &leading= &tracking= &focus= &links= &time= &toast=  (stored before mount)
 *   &gap=<0-24>  &text=<px>
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'chat';

axios.defaults.adapter = (config: any) => {
    const url = String(config.url ?? '').replace(/^.*\/v1/, '');
    const data = /\/me\/permissions$/.test(url) ? { permissions: ALL_PERMISSIONS.toString() } : [];
    return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config } as any);
};

const LONG = 'pasting the whole plan so nobody has to ask twice:\n' + Array.from({ length: 70 }, (_, i) => `Step ${i + 1}: check the thing, then check the other thing that depends on it, and write down what changed.`).join('\n');
const S = {
    mira: { uid: 'u-mira', dev: 'd-mira', name: 'Mira' },
    jun: { uid: 'u-jun', dev: 'd-jun', name: 'Jun' },
    me: { uid: 'me', dev: '11111111-1111-4111-8111-111111111111', name: 'Dawson' },
};
const NOW = Date.now();
// [sender, minutes ago, text]: consecutive messages from one sender within 30 min group.
const FEED: Array<[keyof typeof S, number, string]> = [
    ['mira', 52, 'Morning! The release notes are ready for a read.'],
    ['mira', 51, 'I put the draft here: https://example.com/release-notes-0-1-2'],
    ['mira', 50, 'Two things to check: the install steps and the **known issues** list.'],
    ['jun', 44, 'On it. Reading now.'],
    ['jun', 43, 'Typo in step 3: "recieve". Everything else looks right to me.'],
    ['me', 38, 'Thanks both. I will fix the typo and ship the notes after lunch.'],
    ['mira', 30, 'Sounds good 🎉'],
    ['jun', 26, LONG],
    ['me', 20, 'That is the whole plan. Ping me if anything is unclear.'],
    ['me', 19, 'Back at 2.'],
    ['mira', 8, 'See you then.'],
    ['mira', 7, 'Oh, and the new status shapes look great in the member list.'],
];
const MESSAGES = FEED.map(([who, ago, text], i) => ({
    id: `m${String(i).padStart(2, '0')}`,
    conversation_id: 'c1', channel_id: 'c1',
    sender_user_id: S[who].uid, sender_device_id: S[who].dev, sender_username: S[who].name,
    timestamp: new Date(NOW - ago * 60_000).toISOString(),
    content: { type: 'text', text },
}));
const SERVERS = [{ id: 's1', server_id: 's1', name: 'Woodshop', owner_id: 'me', icon_url: null } as any];
const CHANNEL = { channel_id: 'c1', name: 'general', topic: 'release talk', server_id: 's1', my_permissions: ALL_PERMISSIONS.toString() };
const CHANNELS = [{ channel_id: 'c1', name: 'general', server_id: 's1', kind: 'text' } as any];

const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };

const PEOPLE: Array<[string, 'online' | 'away' | 'dnd' | 'offline', string]> = [
    ['Mira', 'online', '#25E0C8'], ['Jun', 'away', '#FFC94D'], ['Dawson', 'dnd', '#FF8FB1'], ['Theo', 'offline', '#9AA6C8'],
];

/** Status dots as the member list draws them: a ringed avatar with the dot at its corner. */
const MemberList: React.FC = () => (
    <aside style={{ ...card, flex: 'none', width: 220, padding: 14, gap: 10 }} aria-label="Members">
        <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--cl-faint)', letterSpacing: '.08em' }}>MEMBERS</div>
        {PEOPLE.map(([name, status, color]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ position: 'relative', width: 32, height: 32, borderRadius: '50%', background: color, flex: 'none' }}>
                    <span style={{ position: 'absolute', right: -3, bottom: -3, borderRadius: '50%', padding: 2.5, background: 'var(--cl-deep)', display: 'flex' }}>
                        <StatusIcon status={status} size={8} />
                    </span>
                </div>
                <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{name}</div>
                    <div style={{ fontSize: 11, color: 'var(--cl-faint)' }}>{{ online: 'Online', away: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' }[status]}</div>
                </div>
            </div>
        ))}
    </aside>
);

const StatusSheet: React.FC = () => (
    <div style={{ padding: 24, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <MemberList />
        <div style={{ ...card, padding: 18, gap: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--cl-faint)' }}>SIZES (8, 10, 14, 24 px)</div>
            {PEOPLE.map(([name, status]) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                    <span style={{ width: 70, fontSize: 13 }}>{status}</span>
                    {[8, 10, 14, 24].map(sz => <StatusIcon key={sz} status={status} size={sz} />)}
                    <span style={{ position: 'relative', width: 34, height: 34, borderRadius: '50%', background: '#27304f' }}><HomeStatusDot status={status} /></span>
                </div>
            ))}
        </div>
    </div>
);

const Chat: React.FC = () => {
    const retention = useRetentionPolicy('me');
    return (
    <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
        <nav style={{ width: 72, flex: 'none' }} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px', gap: 10 }}>
            <main id="chat" style={{ ...card, flex: 1, minWidth: 0, position: 'relative', background: 'var(--cl-abyss)' }}>
                <ChatPane
                    bundleReady activeChat={{ id: CHANNEL.channel_id }} activeChannel={CHANNEL} emojisChangedEvent={null}
                    serverChannels={CHANNELS} serverCategories={[]} onNavigateToChannel={() => {}}
                    messages={MESSAGES} messagesFetching={false} onMessageSent={() => {}} onChannelMessageSent={() => {}} onPatchSentMessage={() => {}}
                    typingUsers={new Set()} sendTypingEvent={() => {}} readReceipts={{}} sendReadReceipt={() => {}} showReadReceipts
                    activeCall={null} onCallChange={() => {}} friendStatuses={{}} retention={retention}
                    serverSavedIds={[]} pinnedMsgIds={[]} onPinMessage={() => {}} onUnpinMessage={() => {}}
                    onServerSaveMessage={() => {}} onServerUnsaveMessage={() => {}}
                    pinnedSidebarExpanded={false} onTogglePinnedSidebar={() => {}} channelSearchOpen={false} onOpenPinnedCallOverlay={() => {}}
                    pinnedSearchQuery="" onOpenProfile={() => {}} avatarUpdatedEvent={null} memberRoleColors={{}} serverMemberNicknames={{ 'u-mira': 'Mira', 'u-jun': 'Jun', me: 'Dawson' }}
                    convType="server" servers={SERVERS} onInviteJoin={() => {}} onInviteCodeClick={() => {}}
                    channelPermissions={BigInt(CHANNEL.my_permissions)} channelKeyMissing={false} channelKeyCoolingOff={false}
                    historyGaps={[]} historyStart onFillHistoryGap={async () => ({ shown: 0, progressed: false })}
                    myUserId="me" onReport={() => {}}
                />
            </main>
            {q.get('members') !== '0' && <MemberList />}
        </div>
    </div>
    );
};

const Settings: React.FC = () => (
    <div className="sd-root sd-win" style={{ position: 'relative', width: '100%', height: '100vh', maxWidth: 'none' }}>
        <div className="sd-deck" style={{ height: '100%' }}>
            <main className="sd-main" style={{ overflowY: 'auto', height: '100%' }}>
                <div className="sd-col">
                    <header className="sd-chead"><h1>Accessibility</h1></header>
                    <section className="sd-pane"><AccessibilityPane /></section>
                </div>
            </main>
        </div>
    </div>
);

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', 'me');
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    for (const [id, spec] of Object.entries(READABILITY_SPECS)) {
        const v = q.get(id);
        if (v) secureLocalStore.setItem(spec.key, v);
    }
    if (q.get('gap')) secureLocalStore.setItem(GROUP_GAP_KEY, q.get('gap')!);
    if (q.get('text')) secureLocalStore.setItem('cipherline_msg_text_px', q.get('text')!);
    createRoot(document.getElementById('root')!).render(
        <ToastProvider>
            <A11yRuntime />
            {view === 'settings' ? <Settings /> : view === 'status' ? <StatusSheet /> : <Chat />}
        </ToastProvider>,
    );
    (window as any).__booted = true;
})();
