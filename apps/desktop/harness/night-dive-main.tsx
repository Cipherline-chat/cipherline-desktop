/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { NIGHT_DIVE_EVENT, applyDepth, type NightDiveDetail } from '../src/utils/nightDive';

/**
 * Night dive harness: REAL HomePanel / ChatPane / FriendsPane / SettingsScreen /
 * NightDiveSea inside a copy of Dashboard's drift shell (same element classes:
 * data-layout="drift", .drag-region, .app-mainrow, .app-rail, .app-pane2-sheet,
 * .app-pane3 > .app-pane3-sheet, .app-pane-solo), under <html data-depth>.
 *   ?view=home|dm|group|server|friends|settings   which surface (default home)
 *   ?depth=night                                  start in night mode (else day)
 *   ?bare=1                                       do NOT load night-dive.css (the
 *                                                 pre-feature baseline, for the
 *                                                 "day is pixel-identical" check)
 * window.__dive(active) flips the attribute exactly like hooks/useNightDive.ts
 * and dispatches the same `cipherline:night-dive` event, so the REAL
 * <NightDiveSea /> plays the descent / ascent.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'home';
const bare = q.has('bare');
applyDepth(document.documentElement, q.get('depth') === 'night');

(window as any).__events = [] as NightDiveDetail[];
window.addEventListener(NIGHT_DIVE_EVENT, (e) => (window as any).__events.push((e as CustomEvent).detail));
(window as any).__dive = (active: boolean) => {
    applyDepth(document.documentElement, active);
    window.dispatchEvent(new CustomEvent(NIGHT_DIVE_EVENT, { detail: { active, reason: active ? 'enter' : 'exit' } }));
};

const reply = (config: any, data: any, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    if (url.startsWith('/billing/status')) return reply(config, { subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false, trial_days_left: 0, current_period_end: null, has_subscription: true, stripe_customer_id: 'cus_x', period_ends_in_days: 21, plan_amount: 250, plan_currency: 'usd', automatic_tax: false });
    if (url.startsWith('/auth/me')) return reply(config, { user_id: 'u-me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson' });
    if (url.startsWith('/devices')) return reply(config, []);
    if (url.startsWith('/servers')) return reply(config, []);
    if (/\/members/.test(url)) return reply(config, []);
    if (url.startsWith('/friends/status/')) return reply(config, { status: 'accepted' });
    const who = url.match(/^\/auth\/users\/user-([a-z]+)/);
    if (who) return reply(config, { user_id: `user-${who[1]}`, username: who[1][0].toUpperCase() + who[1].slice(1) });
    return reply(config, {});
};

function installElectronStub() {
    const values: Record<string, unknown> = {
        getAutoStart: false, getStartMinimized: false, getMinimizeToTray: true, getUpdateChannel: 'latest',
        getPlatform: 'win32', platform: 'win32', getAppVersion: '1.0.23', gdriveAuthStatus: { linked: false },
        getDeviceName: 'DESK-PC', getRunningProcesses: [],
    };
    const excluded = new Set(['secureKvOpen', 'secureKvSeal', 'getLocalMasterKeyStatus', 'then']);
    (window as any).electronAPI = new Proxy({}, {
        get(_t, prop: string) {
            if (excluded.has(prop)) return undefined;
            if (prop === 'platform') return 'win32';
            if (/^on[A-Z]/.test(prop)) return () => () => {};
            return (..._args: unknown[]) => Promise.resolve(values[prop]);
        },
    });
}

const NOW = Date.now();
const MIN = 60_000;
const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira', other_user_id: 'user-mira', avatar_url: 'img-mira', last_message_at: new Date(NOW - 4 * MIN).toISOString() },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew', avatar_url: 'img-crew', last_message_at: new Date(NOW - 50 * MIN).toISOString() },
    { conversation_id: 'c3', type: 'dm', title: 'Jonas', other_user_id: 'user-jonas', avatar_url: null, last_message_at: new Date(NOW - 5 * 3600_000).toISOString() },
    { conversation_id: 'c4', type: 'dm', title: 'Priya', other_user_id: 'user-priya', avatar_url: null, last_message_at: new Date(NOW - 26 * 3600_000).toISOString() },
];
const servers = [{ server_id: 'S1', name: 'Neon Guild', role: 'owner' }, { server_id: 'S2', name: 'Design Team', role: 'member' }];
const serverChannels = {
    S1: [{ channel_id: 'n1', name: 'general', type: 'text', server_id: 'S1' }, { channel_id: 'n2', name: 'Lounge', type: 'voice', server_id: 'S1' }],
    S2: [{ channel_id: 'd1', name: 'crit', type: 'text', server_id: 'S2' }],
};
const t = (m: number) => NOW - m * MIN;
const dmMessages = [
    { id: 'm1', sender_user_id: 'user-mira', timestamp: t(190), content: { type: 'text', text: 'Did you see the build go green?' } },
    { id: 'm2', sender_user_id: 'u-me', timestamp: t(188), content: { type: 'text', text: 'Just now. The smoke test finally paints in under 30s.' } },
    { id: 'm3', sender_user_id: 'user-mira', timestamp: t(186), content: { type: 'text', text: 'Ship it before I lose my nerve.' } },
    { id: 'm4', sender_user_id: 'u-me', timestamp: t(120), content: { type: 'text', text: 'Staging first. The cuttlefish insists.' } },
    { id: 'm5', sender_user_id: 'user-mira', timestamp: t(30), content: { type: 'text', text: 'Also: it is past midnight. Are we really still doing this?' } },
    { id: 'm6', sender_user_id: 'u-me', timestamp: t(29), content: { type: 'text', text: 'One more thing, then sleep. Promise.' } },
    { id: 'm7', sender_user_id: 'user-mira', timestamp: t(5), content: { type: 'text', text: 'Sure you will. Check the new sign-in page when you are up, the animation is lovely.' } },
];
const groupMessages = [
    { id: 'g1', sender_user_id: 'user-jonas', timestamp: t(240), content: { type: 'text', text: 'Saturday: lake or the climbing gym?' } },
    { id: 'g2', sender_user_id: 'user-priya', timestamp: t(236), content: { type: 'text', text: 'Lake. It is the last warm weekend.' } },
    { id: 'g3', sender_user_id: 'user-mira', timestamp: t(230), content: { type: 'text', text: 'Lake, then gym if it rains.' } },
    { id: 'g4', sender_user_id: 'u-me', timestamp: t(90), content: { type: 'text', text: 'I will bring the big cooler and the bad speaker.' } },
    { id: 'g5', sender_user_id: 'user-jonas', timestamp: t(60), content: { type: 'text', text: 'The bad speaker is a tradition at this point.' } },
    { id: 'g6', sender_user_id: 'user-priya', timestamp: t(12), content: { type: 'text', text: 'Leaving at 9. Whoever is late buys breakfast.' } },
];
const serverMessages = [
    { id: 's1', sender_user_id: 'user-priya', timestamp: t(300), content: { type: 'text', text: 'Patch notes for the raid tonight are pinned.' } },
    { id: 's2', sender_user_id: 'user-jonas', timestamp: t(280), content: { type: 'text', text: 'Healers: stack on the left platform for phase two.' } },
    { id: 's3', sender_user_id: 'u-me', timestamp: t(200), content: { type: 'text', text: 'I can tank the adds if someone kites the boss.' } },
    { id: 's4', sender_user_id: 'user-mira', timestamp: t(40), content: { type: 'text', text: 'Lounge is open, hop in whenever.' } },
    { id: 's5', sender_user_id: 'user-priya', timestamp: t(8), content: { type: 'text', text: 'gg everyone, that was clean.' } },
];
const noop = () => {};

/* ── The drift shell (same element classes as Dashboard.tsx) ───────────── */
const Rail: React.FC = () => (
    <nav className="shrink-0 app-rail" style={{ width: 72, flex: 'none', background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--cl-rail-gap, 16px)', minHeight: 0, paddingTop: 8 }}>
        {['H', 'D', 'G', 'NG', 'DT'].map((l, i) => (
            <div key={l} className="relative">
                <div className={`${i === 3 ? 'bg-cl-lume/20 text-cl-lume' : 'bg-cl-surface text-cl-text'} border border-cl-border`} style={{ width: 46, height: 46, borderRadius: 16, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 14 }}>{l}</div>
                {i === 1 && <span className="absolute" style={{ right: -4, bottom: -4, minWidth: 18, height: 18, borderRadius: 99, background: 'var(--cl-flash)', color: 'var(--cl-on-flash)', border: '2px solid var(--cl-abyss)', boxSizing: 'border-box', fontSize: 10, fontWeight: 800, display: 'grid', placeItems: 'center', padding: '0 4px' }}>3</span>}
                {i === 3 && <div className="absolute -bottom-1 -right-1 z-10 pointer-events-none flex items-center justify-center rounded-full bg-cl-lume text-cl-on-lume ring-2 ring-[color:var(--cl-abyss)]" style={{ width: 16, height: 16, fontSize: 9, fontWeight: 900 }}>2</div>}
            </div>
        ))}
    </nav>
);

const ListCard: React.FC<{ title: string; items: { name: string; sub?: string; active?: boolean; badge?: number; hash?: boolean }[] }> = ({ title, items }) => (
    <div className="select-none app-pane2" style={{ width: 268, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <aside className="view-enter app-pane2-sheet w-full h-full bg-cl-deep flex flex-col rounded-l-2xl border-l border-white/[0.04] shadow-xl relative" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px 12px 10px' }}>
                <div className="text-cl-text font-display" style={{ fontSize: 17, fontWeight: 600, margin: '2px 6px 10px' }}>{title}</div>
                <div className="bg-cl-surface border border-cl-border text-cl-faint" style={{ borderRadius: 11, padding: '8px 12px', fontSize: 13, fontWeight: 600 }}>Search</div>
            </div>
            <div style={{ padding: '0 10px' }}>
                {items.map(it => (
                    <div key={it.name} className={it.active ? 'bg-cl-surface text-cl-text' : 'text-cl-muted'} style={{ padding: '9px 12px', borderRadius: 12, fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
                        {it.hash ? <span className="text-cl-faint" style={{ fontWeight: 800 }}>#</span> : <span className="bg-cl-raise" style={{ width: 30, height: 30, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--cl-text)' }}>{it.name[0]}</span>}
                        <span style={{ flex: 1, minWidth: 0 }}>{it.name}{it.sub && <span className="block text-cl-faint" style={{ fontSize: 11.5, fontWeight: 600 }}>{it.sub}</span>}</span>
                        {it.badge && <span className="bg-cl-flash text-cl-on-flash" style={{ fontSize: 11, fontWeight: 800, borderRadius: 99, padding: '1px 7px' }}>{it.badge}</span>}
                    </div>
                ))}
            </div>
        </aside>
    </div>
);

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div data-layout="drift" className="w-screen h-screen flex flex-col bg-cl-abyss text-white overflow-hidden font-sans relative">
        <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss">
            <span className="text-cl-faint" style={{ fontFamily: 'var(--cl-font-display)', fontSize: 13, fontWeight: 600 }}>cipherline</span>
        </div>
        <div className="flex flex-1 overflow-hidden app-mainrow">
            <Rail />
            {children}
        </div>
    </div>
);

const Divider = () => <div className="app-div1" style={{ width: 10, flexShrink: 0 }}><div className="w-full h-full" /></div>;

async function boot() {
    if (!bare) await import('../src/styles/night-dive.css');
    await secureLocalStore.hydrate();
    installElectronStub();
    const [{ ToastProvider }, { UpdateProvider }, { NotificationProvider }, { SubscriptionProvider }, { NightDiveSea }] = await Promise.all([
        import('../src/contexts/ToastContext'), import('../src/contexts/UpdateContext'),
        import('../src/contexts/NotificationContext'), import('../src/contexts/SubscriptionContext'),
        import('../src/components/NightDiveSea'),
    ]);
    let body: React.ReactNode = null;

    if (view === 'home') {
        const { HomePanel } = await import('../src/components/HomePanel');
        body = (
            <Shell>
                <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <HomePanel
                        userId="u-me" displayName="Dawson" token="harness-token"
                        conversations={conversations}
                        unreadCounts={{ c1: 3, c2: 1 }} mentionCounts={{ c1: 1 }}
                        lastActivityAt={{ c1: t(4), c2: t(50), c3: NOW - 5 * 3600_000, c4: NOW - 26 * 3600_000 }}
                        presence={{ 'user-mira': true, 'user-jonas': false }}
                        friends={{ accepted: [{ user_id: 'user-mira', display_name: 'Mira', username: 'mira' }, { user_id: 'user-jonas', display_name: 'Jonas', username: 'jonas' }] }}
                        servers={servers as any} serverChannels={serverChannels as any}
                        voiceParticipants={{ n2: ['user-mira'] }} huddleCalls={{}}
                        voiceUserNames={{ 'user-mira': 'Mira' }}
                        serverBadges={{ S1: { unread: 2, mentions: 0 } }} serverLastActivityAt={{ S1: t(8) }}
                        pinnedItems={[]} friendStatuses={{}}
                        onSelectConversation={noop} onJoinVoiceChannel={noop} onJoinHuddleCall={noop}
                        onPin={noop} onUnpin={noop} onOpenStorage={noop}
                    />
                </div>
            </Shell>
        );
    } else if (view === 'dm' || view === 'group' || view === 'server') {
        const [{ default: ChatPane }, { useRetentionPolicy }] = await Promise.all([
            import('../src/components/ChatPane'), import('../src/hooks/useRetentionPolicy'),
        ]);
        const list = view === 'server'
            ? { title: 'Neon Guild', items: [{ name: 'general', hash: true, active: true }, { name: 'raid-planning', hash: true }, { name: 'screenshots', hash: true }, { name: 'Lounge', sub: 'Mira in call' }] }
            : view === 'group'
                ? { title: 'Groups', items: [{ name: 'Weekend crew', sub: '4 members', active: true, badge: 1 }, { name: 'Design Team', sub: '6 members' }] }
                : { title: 'Direct messages', items: conversations.filter(c => c.type === 'dm').map((c, i) => ({ name: c.title, active: i === 0, badge: i === 0 ? 3 : undefined, sub: i === 0 ? 'Online' : undefined })) };
        const Chat: React.FC = () => {
            const retention = useRetentionPolicy('u-me');
            return (
                <Shell>
                    <ListCard {...list} />
                    <Divider />
                    <div className="app-pane3" style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
                        <main className="app-pane3-sheet w-full h-full bg-cl-abyss flex flex-col relative" style={{ overflow: 'hidden', flex: 1, minHeight: 0 }}>
                            <ChatPane
                                bundleReady
                                activeChat={view === 'dm'
                                    ? { id: 'c1', title: 'Mira', type: 'dm', other_user_id: 'user-mira', avatar_url: 'img-mira' }
                                    : view === 'group' ? { id: 'c2', title: 'Weekend crew', type: 'group', avatar_url: 'img-crew' }
                                    : { id: 'n1', title: 'general', type: 'channel' }}
                                activeChannel={view === 'server' ? { channel_id: 'n1', name: 'general', topic: 'Raids, patch notes and general chatter', server_id: 'S1', my_permissions: '8' } : null}
                                messages={(view === 'dm' ? dmMessages : view === 'group' ? groupMessages : serverMessages) as any}
                                onMessageSent={noop} typingUsers={new Set<string>()} sendTypingEvent={noop}
                                activeCall={null} onCallChange={noop}
                                retention={retention as any}
                                pinnedMsgIds={[]} onPinMessage={noop} onUnpinMessage={noop}
                                pinnedSidebarExpanded={false} onTogglePinnedSidebar={noop} onOpenPinnedCallOverlay={noop}
                                pinnedSearchQuery="" myUserId="u-me"
                                friendStatuses={{}}
                                {...({ memberNames: { 'user-mira': 'Mira', 'user-jonas': 'Jonas', 'user-priya': 'Priya', 'u-me': 'Dawson' } } as any)}
                            />
                        </main>
                    </div>
                </Shell>
            );
        };
        body = <Chat />;
    } else if (view === 'friends') {
        const { default: FriendsPane } = await import('../src/components/FriendsPane');
        const friends = {
            pending_incoming: [{ friendship_id: 'f9', requester_id: 'user-ren', username: 'ren', display_name: 'Ren' }],
            pending_outgoing: [],
            accepted: [
                { friendship_id: 'f1', user_id: 'user-mira', username: 'mira', display_name: 'Mira' },
                { friendship_id: 'f2', user_id: 'user-jonas', username: 'jonas', display_name: 'Jonas' },
                { friendship_id: 'f3', user_id: 'user-priya', username: 'priya', display_name: 'Priya' },
                { friendship_id: 'f4', user_id: 'user-sam', username: 'sam', display_name: 'Sam' },
            ],
            blocked: [],
        };
        body = (
            <Shell>
                <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <FriendsPane
                        onStartChat={noop} friends={friends as any} friendsStatus="ready"
                        onRefresh={() => Promise.resolve()}
                        friendStatuses={{ 'user-mira': { status: 'online' }, 'user-jonas': { status: 'idle' } } as any}
                    />
                </div>
            </Shell>
        );
    } else if (view === 'settings') {
        const [{ SettingsScreen }, { useRetentionPolicy }, { useKeybinds }, { useVoiceSettings }, { useGameSettings }, { usePrivacySettings }, { useScreenLock }, { useGifSettings }] = await Promise.all([
            import('../src/components/settings/SettingsScreen'), import('../src/hooks/useRetentionPolicy'), import('../src/hooks/useKeybinds'),
            import('../src/hooks/useVoiceSettings'), import('../src/hooks/useGameSettings'), import('../src/hooks/usePrivacySettings'),
            import('../src/hooks/useScreenLock'), import('../src/hooks/useGifSettings'),
        ]);
        const Host: React.FC = () => {
            const retention = useRetentionPolicy('u-me');
            const keybinds = useKeybinds({});
            const voice = useVoiceSettings();
            const gameSettings = useGameSettings('u-me');
            const privacy = usePrivacySettings();
            const screenLock = useScreenLock();
            const gif = useGifSettings();
            return (
                <SettingsScreen
                    initialTab={(q.get('tab') as any) ?? 'appearance'} onClose={noop} onLogout={noop}
                    retention={retention} messagesState={{}} onClearAllMessages={noop} conversations={conversations}
                    onPurgeConversation={noop} onPurgeTypeNow={noop}
                    serverStorage={{ servers: [], serverChannels: {}, channelMessages: {}, leftServerChannels: {}, protectedIds: {}, token: 'x', loading: false, error: false, onPurge: async () => ({ purged: 0, skippedChannels: 0 }) } as any}
                    keybinds={keybinds} voice={voice} gameSettings={gameSettings}
                    currentGame={null} currentGameProcess={null} onIgnoreCurrentGame={noop}
                    privacy={privacy} screenLock={screenLock} gif={gif}
                />
            );
        };
        body = <Shell><div style={{ flex: 1 }} /><Host /></Shell>;
    }

    createRoot(document.getElementById('root')!).render(
        <ToastProvider><UpdateProvider><NotificationProvider><SubscriptionProvider>
            {body}
            {!bare && <NightDiveSea />}
        </SubscriptionProvider></NotificationProvider></UpdateProvider></ToastProvider>,
    );
    (window as any).__booted = true;
}
boot();
