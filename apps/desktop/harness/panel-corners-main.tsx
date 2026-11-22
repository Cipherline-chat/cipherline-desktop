/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import axios from 'axios';
import { MessageSquare, MessagesSquare, Plus, Users, Search, Settings as SettingsIcon } from 'lucide-react';
import '../src/utils/clPhysics';
// CSS in the app's own order (src/main.tsx). Optional files go through
// import.meta.glob so the same harness runs on a checkout that predates them
// (origin/staging has no theme-light*.css and no src/theme/).
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import.meta.glob('../src/styles/theme-light-kit.css', { eager: true });
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/styles/night-dive.css';
import.meta.glob('../src/styles/theme-light.css', { eager: true });
import '../src/styles/formatting.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import { CARD_STYLE_TEMPLATES } from '../src/utils/cardStyle/cardStyleTemplates';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * Panel corners harness (2026-11-20, claude/panel-corners-dark). Unlike
 * light-theme-main.tsx, the shell here is a FAITHFUL copy of Dashboard.tsx's
 * container chain, every overflow:hidden box included:
 *   .app-mainrow > [nav.app-rail, div[data-banner-column] > content row >
 *     (.app-pane-solo | .app-callgroup grid > .app-pane2, .app-div1,
 *      right section > inner row > .app-pane3), .app-div2, .app-pane4 > aside >
 *      [data-call-scroll-zone] (+ #call-controlbar-root)]
 * The light-theme harness put the panes straight into .app-mainrow, which has
 * 10px of padding, so a pane's shadow had room to fade there; in the real app
 * every pane sits flush against an overflow:hidden box, which cuts its shadow
 * off along the pane's own edges. That cut is what draws a square corner.
 *   ?theme=dark|light   ?view=home|friends|server|dm|settings
 *   &p4=members|search|pinned|profile|call   (right panel mode)
 *   &rw=<px>  right panel width (240 = its minimum)   &lw=<px> left list width
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'home';
const p4 = q.get('p4') ?? (view === 'dm' ? 'profile' : 'members');
const themeParam = q.get('theme') ?? 'dark';
const themeMods = import.meta.glob(['../src/theme/engine.ts', '../src/theme/themes.ts']);
async function applyThemeParam() {
    const e = themeMods['../src/theme/engine.ts'], t = themeMods['../src/theme/themes.ts'];
    if (!e || !t) return; // base checkout: Dark only, straight from index.css
    const engine: any = await e(); const themes: any = await t();
    if (engine.setThemePreference) await engine.setThemePreference(themeParam, {});
    else engine.applyTheme(themes.resolveTheme(themeParam));
}
const ME = 'me';
const NOW = Date.now();
const MIN = 60_000;
const t = (m: number) => NOW - m * MIN;
const noop = () => {};
const NONE: never[] = [];
const EMPTY = {};
const SET = new Set<string>();

// ── Fake data ───────────────────────────────────────────────────────────────
const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null,
    icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: ME, created_at: '',
} as ServerInfo;
const ch = (id: string, parent: string | null, position: number, kind: 'text' | 'voice' = 'text'): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind, name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const cat = (id: string, name: string, position: number, parent: string | null = null, extra: Partial<CategoryInfo> = {}): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind: 'text', icon_name: null, parent_category_id: parent, ...extra });
const CATEGORIES: CategoryInfo[] = [
    cat('craft', 'Crafting', 1000),
    cat('wood', 'Woodworking', 2000, 'craft'),
    cat('d-label', 'Announcements', 2000, null, { header_style: 'label', header_color: '#25e0c8' }),
    cat('d-header', 'Game Nights', 3000, null, { header_style: 'header', header_color: '#ffc94d' }),
    cat('d-pill', 'Events', 4000, null, { header_style: 'pill', header_color: '#a78bfa' }),
];
const CHANNELS: ChannelInfo[] = [
    ch('welcome', null, 1000), ch('general', null, 2000),
    ch('crafting-chat', 'craft', 1000), ch('finishes', 'wood', 1000), ch('joinery', 'wood', 2000),
    ch('news', 'd-label', 1000), ch('lfg', 'd-header', 1000), ch('game-chat', 'd-header', 2000),
    ch('build-nights', 'd-pill', 1000), ch('Lounge', null, 3000, 'voice'),
];
const roles = [
    { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, hoisted: false, color: -1, permissions: DEFAULT_EVERYONE_PERMISSIONS.toString() },
    { role_id: 'mods', name: 'Moderators', position: 5, is_everyone: false, hoisted: true, color: 0x25e0c8, permissions: '0' },
    { role_id: 'artists', name: 'Artists', position: 3, is_everyone: false, hoisted: true, color: 0xa78bfa, permissions: '0' },
];
let n = 0;
const member = (name: string, status: string, role_ids: string[] = [], uid?: string) => ({
    user_id: uid ?? (name === 'Dawson' ? ME : `u${++n}`), username: name, discriminator: 1000 + n, nickname: null, avatar_url: null,
    status, joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids,
});
const members = [
    member('Dawson', 'online', ['mods']), member('Mira', 'online', ['mods'], 'u-mira'), member('Sam', 'idle', ['mods']), member('Noor', 'dnd', ['mods']),
    member('Jun', 'online', ['artists'], 'u-jun'), member('Kit', 'online', ['artists']),
    member('Jules', 'online'), member('Mika', 'idle'), member('Quinn', 'online'),
    member('Avery', 'offline'), member('Blake', 'offline', ['mods']), member('Casey', 'offline'), member('Devon', 'offline', ['artists']),
];
const reply = (config: any, data: any, status = 200) => Promise.resolve({ data, status, statusText: 'OK', headers: {}, config } as any);
axios.defaults.adapter = (config: any) => {
    const url = String(config.url ?? '').replace(/^.*\/v1/, '');
    const method = String(config.method ?? 'get').toLowerCase();
    if (/\/servers\/s1\/members$/.test(url)) return reply(config, members);
    if (/\/servers\/s1\/roles$/.test(url)) return reply(config, roles);
    if (/\/me\/permissions$/.test(url)) return reply(config, { permissions: ALL_PERMISSIONS.toString() });
    if (/\/overrides$/.test(url)) return reply(config, []);
    if (/^\/invites\/[^/]+\/preview$/.test(url)) return reply(config, {
        server_id: 's9', server_name: 'Woodshop Friends', server_description: 'Weekly builds, show and tell.',
        server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 1284, expires_at: null,
    });
    if (url.startsWith('/billing/status')) return reply(config, { subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false, trial_days_left: 0, current_period_end: null, has_subscription: true, stripe_customer_id: 'cus_x', period_ends_in_days: 21, plan_amount: 250, plan_currency: 'usd', automatic_tax: false });
    if (url.startsWith('/auth/me')) return reply(config, { user_id: ME, username: 'Dawson', discriminator: 4821, display_name: 'Dawson' });
    if (url.startsWith('/friends/status/')) return reply(config, { status: 'accepted' });
    const who = url.match(/^\/auth\/users\/(u-[a-z]+)/);
    if (who) return reply(config, { user_id: who[1], username: who[1].slice(2, 3).toUpperCase() + who[1].slice(3) });
    if (method !== 'get') return reply(config, { ok: true });
    return reply(config, []);
};

const pngB64 = (() => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 270;
    const g = c.getContext('2d')!; const gr = g.createLinearGradient(0, 0, 480, 270);
    gr.addColorStop(0, '#25E0C8'); gr.addColorStop(1, '#1d2b64'); g.fillStyle = gr; g.fillRect(0, 0, 480, 270);
    return c.toDataURL('image/png').split(',')[1];
})();
function installElectronStub() {
    const values: Record<string, unknown> = {
        getAutoStart: false, getStartMinimized: false, getMinimizeToTray: true, getUpdateChannel: 'latest',
        getPlatform: 'win32', platform: 'win32', getAppVersion: '0.1.2', gdriveAuthStatus: { linked: false },
        getDeviceName: 'DESK-PC', getRunningProcesses: [], getTheme: { id: themeParam === 'light' ? 'light' : 'dark', pref: themeParam },
        getUiScale: { percent: 100, effective: 100, max: 200, source: 'set' },
        getLoginItemState: { supported: true, enabled: true, needsApproval: false },
    };
    const excluded = new Set(['secureKvOpen', 'secureKvSeal', 'getLocalMasterKeyStatus', 'then', 'bootThemeId', 'bootCustomTheme', 'saveFileAs']);
    (window as any).electronAPI = new Proxy({}, {
        get(_t, prop: string) {
            if (excluded.has(prop)) return undefined;
            if (prop === 'platform') return 'win32';
            if (prop === 'fetchBinary') return (_u: string) => Promise.resolve({ mimeType: 'image/png', b64: pngB64 });
            if (prop === 'setTheme') return (p: string) => Promise.resolve({ id: p, pref: p });
            if (/^on[A-Z]/.test(prop)) return () => () => {};
            return (..._args: unknown[]) => Promise.resolve(values[prop]);
        },
    });
}

// ── The server feed: formatting, code, styled cards, replies, embeds, system rows ──
const CODE_TS = '```ts\n// Debounce a function — the classic.\nexport function debounce<T extends (...a: unknown[]) => void>(fn: T, ms = 200) {\n    let t: ReturnType<typeof setTimeout> | null = null;\n    return (...args: Parameters<T>) => {\n        if (t) clearTimeout(t);\n        t = setTimeout(() => fn(...args), ms);\n    };\n}\n```';
const BLOCKS = ['## Release notes', '- A formatting bar next to the paperclip', '- Markdown paste that asks first', '> Quotes for the bits worth repeating.', '-# subtext — the small print'].join('\n');
const INLINE = '**bold**, *italic*, __underline__, ~~strike~~, `inline code`, a ||spoiler|| and @Mira. A [masked link](https://example.com/docs).';
const rules = CARD_STYLE_TEMPLATES.find(x => x.id === 'rules')!;
const ann = CARD_STYLE_TEMPLATES.find(x => x.id === 'announcement')!;
const sys = (id: string, event: string, subject: string, at: number) => ({
    id, conversation_id: 'c-general', channel_id: 'general', sender_user_id: subject, sender_device_id: 'd',
    timestamp: new Date(at).toISOString(), content: { type: 'system', kind: 'member_event', event, subject_user_id: subject, actor_user_id: null },
});
const msg = (id: string, uid: string, at: number, content: any, extra: any = {}) => ({
    id, conversation_id: 'c-general', channel_id: 'general', sender_user_id: uid, sender_device_id: `d-${uid}`,
    sender_username: uid === ME ? 'Dawson' : uid === 'u-mira' ? 'Mira' : 'Jun', timestamp: new Date(at).toISOString(), content, ...extra,
});
const SERVER_MESSAGES = [
    sys('s0', 'member_join', 'u-jun', t(400)),
    msg('m1', 'u-mira', t(380), { type: 'text', text: ann.sample, card_style: ann.style }),
    msg('m2', 'u-jun', t(300), { type: 'text', text: INLINE }, { reactions: [{ emoji: '👍', count: 2, user_ids: ['u-mira', ME] }, { emoji: '🔥', count: 1, user_ids: ['u-jun'] }] }),
    msg('m3', ME, t(290), { type: 'text', text: BLOCKS }),
    msg('m4', 'u-mira', t(200), { type: 'text', text: 'quick one before standup:\n' + CODE_TS }),
    msg('m5', 'u-jun', t(190), { type: 'text', text: 'Looks right, ship it after lunch.', reply_to_id: 'm4' }),
    msg('m6', ME, t(120), { type: 'text', text: rules.sample, card_style: rules.style }),
    msg('m7', 'u-mira', t(60), { type: 'text', text: 'join us https://cipherline.chat/invite/woodshop42' }),
    msg('m8', 'u-jun', t(30), { type: 'text', text: 'screenshot of the new bar https://i.imgur.com/abc123.png' }),
    sys('s9', 'member_leave', 'u4', t(10)),
    msg('m9', ME, t(4), { type: 'text', text: 'ok **ship it** 🚀' }),
];
const DM_MESSAGES = [
    msg('d1', 'u-mira', t(190), { type: 'text', text: 'Did you see the build go green?' }),
    msg('d2', ME, t(188), { type: 'text', text: 'Just now. The smoke test finally paints in under 30s.' }),
    msg('d3', 'u-mira', t(186), { type: 'text', text: 'Ship it before I lose my nerve. `npm run release` is ready.' }),
    msg('d4', ME, t(120), { type: 'text', text: 'Staging first. The cuttlefish insists.', reply_to_id: 'd3' }),
    msg('d5', 'u-mira', t(30), { type: 'text', text: 'Also: it is past midnight. Are we **really** still doing this?' }, { reactions: [{ emoji: '😂', count: 1, user_ids: [ME] }] }),
    msg('d6', ME, t(29), { type: 'text', text: 'One more thing, then sleep. Promise.' }),
    msg('d7', 'u-mira', t(5), { type: 'text', text: 'Sure you will. Check the new sign-in page when you are up, the animation is lovely.' }),
];
const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira', other_user_id: 'u-mira', avatar_url: 'img-mira', last_message_at: new Date(t(4)).toISOString() },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew', avatar_url: 'img-crew', last_message_at: new Date(t(50)).toISOString() },
    { conversation_id: 'c3', type: 'dm', title: 'Jun', other_user_id: 'u-jun', avatar_url: null, last_message_at: new Date(NOW - 5 * 3600_000).toISOString() },
    { conversation_id: 'c4', type: 'dm', title: 'Priya', other_user_id: 'u-priya', avatar_url: null, last_message_at: new Date(NOW - 26 * 3600_000).toISOString() },
];


// ── The drift shell: Dashboard.tsx's container chain, verbatim styles ──────
function paneWidths(W: number) {
    // Dashboard: DEFAULT_LEFT_RATIO 0.18, right 0.20, floors 200 / 240, max sidebarMaxPx
    const max = Math.max(500, Math.round(W * 0.35));
    const lw = Number(q.get('lw')) || Math.max(200, Math.min(max, Math.round(0.18 * W)));
    const rw = Number(q.get('rw')) || Math.max(240, Math.min(max, Math.round(0.2 * W)));
    return { left: lw, right: rw };
}
async function boot() {
    await secureLocalStore.hydrate().catch(() => {});
    secureLocalStore.setItem('cipherline_user_id', ME);
    try { await (secureLocalStore as any).whenAccountReady?.(); } catch { /* */ }
    await applyThemeParam();
    installElectronStub();
    const [{ ToastProvider }, { UpdateProvider }, { NotificationProvider }, { RailTrack }, { RailTile }, { TitleBarWordmark }] = await Promise.all([
        import('../src/contexts/ToastContext'), import('../src/contexts/UpdateContext'), import('../src/contexts/NotificationContext'),
        import('../src/components/rail/RailTrack'), import('../src/components/rail/RailTile'), import('../src/components/TitleBarWordmark'),
    ]);
    const activeRail = view === 'dm' ? 0 : view === 'server' ? 3 : -1;
    // Many tiles so the scrolling deck really scrolls (top / middle / bottom).
    const extra = ['AB', 'CD', 'EF', 'GH', 'IJ', 'KL', 'MN', 'OP', 'QR', 'ST'];
    const Rail: React.FC = () => (
        <nav className="shrink-0 app-rail" style={{ width: 72, flex: 'none', background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--cl-rail-gap, 16px)', minHeight: 0 }}>
            <RailTrack scroll activeIndex={activeRail}>
                <RailTile icon={<MessageSquare size={19} />} title="Direct messages" active={activeRail === 0} badge={{ count: 3, tone: 'alert' }} />
                <RailTile icon={<MessagesSquare size={19} />} title="Group chats" active={activeRail === 1} />
                <RailTile label="NG" title="Neon Guild" badge={{ count: 2, tone: 'quiet' }} />
                <RailTile label="MC" title="Maker Collective" active={activeRail === 3} />
                <RailTile label="DT" title="Design Team" />
                {extra.map((l) => <RailTile key={l} label={l} title={l} />)}
                <RailTile icon={<Plus size={19} />} title="Add a server" accent />
            </RailTrack>
            <RailTrack activeIndex={view === 'friends' ? 0 : view === 'settings' ? 1 : -1}>
                <RailTile icon={<Users size={19} />} title="Friends" active={view === 'friends'} />
                <RailTile icon={<SettingsIcon size={19} />} title="Settings" active={view === 'settings'} />
            </RailTrack>
            <span style={{ marginTop: 'auto' }} />
        </nav>
    );
    const W = window.innerWidth;
    const { left: leftWidth, right: rightWidth } = paneWidths(W);
    const sidebarMax = Math.max(500, Math.round(W * 0.35));
    // Dashboard.tsx 14589-14628 + 15101 + 15207
    const Shell: React.FC<{ children: React.ReactNode; pane4?: React.ReactNode }> = ({ children, pane4 }) => (
        <div data-layout="drift" className="w-screen h-screen flex flex-col bg-cl-abyss text-white overflow-hidden font-sans relative">
            <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss"><TitleBarWordmark /></div>
            <div className="flex flex-1 overflow-hidden app-mainrow">
                <Rail />
                <div data-banner-column="" className="app-contentcol" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <div className="app-contentrow" style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
                        {children}
                        {pane4}
                    </div>
                </div>
            </div>
        </div>
    );
    let CallBar: React.FC = () => null;
    if (p4 === 'call') {
        const { JoiningControlBar } = await import('../src/components/call/JoiningControlBar');
        CallBar = () => <JoiningControlBar phase={'connecting' as any} muted={false} deafened={false} canSpeak onToggleMute={noop} onToggleDeafen={noop} onLeave={noop} />;
    }
    // Dashboard.tsx 13482-13500 (divider2El) + 13500-14480 (pane4El)
    const Pane4: React.FC<{ call?: boolean; children: React.ReactNode }> = ({ call, children }) => (
        <>
            <div style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20 }} className="group relative app-div2">
                <div data-drag-pill="right" className="w-[2px] h-16 rounded-full group-hover:bg-cl-lume/40 transition-colors" />
            </div>
            <div className="select-none app-pane4" style={{ width: rightWidth, minWidth: 240, maxWidth: sidebarMax, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
                <aside className="relative w-full h-full flex flex-col rounded-r-2xl border-r border-white/[0.04] shadow-xl" style={{ overflow: 'hidden' }}>
                    <div data-call-scroll-zone className={`flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col isolate bg-cl-deep${call ? ' pb-24' : ''}`}>
                        {children}
                    </div>
                    {call && <div id="call-controlbar-root" className="absolute bottom-0 left-0 right-0 z-10 px-2 pb-1 pointer-events-none"><CallBar /></div>}
                </aside>
            </div>
        </>
    );
    // A stand-in for SidebarConference's tiles (the real one needs LiveKit):
    // the same box Dashboard gives it, with tiles that paint to the edges.
    const CallSection: React.FC = () => (
        <div id="call-sidebar-root" className="shrink-0 w-full flex flex-col relative">
            <div style={{ padding: '12px 8px', display: 'grid', gap: 8 }}>
                {['Mira', 'Jun', 'Dawson', 'Sam'].map((n) => (
                    <div key={n} className="bg-cl-surface" style={{ aspectRatio: '16 / 9', borderRadius: 12, display: 'grid', placeItems: 'center', color: 'var(--cl-text)', fontWeight: 700 }}>{n}</div>
                ))}
            </div>
        </div>
    );
    const searchable = SERVER_MESSAGES.filter((m: any) => typeof m.content?.text === 'string').map((m: any) => ({ id: m.id, sender_user_id: m.sender_user_id, sender_display_name: m.sender_username, text: m.content.text, created_at: m.timestamp }));
    const homeProps = {
        userId: ME, displayName: 'Dawson', token: 'harness-token',
        conversations: conversations as any,
        unreadCounts: { c1: 3, c2: 1 }, mentionCounts: {},
        lastActivityAt: { c1: t(4), c2: t(50), c3: NOW - 5 * 3600_000, c4: NOW - 26 * 3600_000 },
        presence: { 'u-mira': true, 'u-jun': false },
        friends: { accepted: [{ user_id: 'u-mira', display_name: 'Mira', username: 'mira' }, { user_id: 'u-jun', display_name: 'Jun', username: 'jun' }] } as any,
        servers: [{ server_id: 'S1', name: 'Neon Guild', role: 'owner' }, { server_id: 'S2', name: 'Design Team', role: 'member' }] as any,
        serverChannels: { S1: [{ channel_id: 'n1', name: 'general', type: 'text', server_id: 'S1' }, { channel_id: 'n2', name: 'Lounge', type: 'voice', server_id: 'S1' }] } as any,
        voiceParticipants: { n2: ['u-mira'] }, huddleCalls: {},
        voiceUserNames: { 'u-mira': 'Mira' },
        serverBadges: { S1: { unread: 2, mentions: 0 } } as any, serverLastActivityAt: { S1: t(8) },
        pinnedItems: [], friendStatuses: {},
        onSelectConversation: noop, onJoinVoiceChannel: noop, onJoinHuddleCall: noop,
        onPin: noop, onUnpin: noop, onOpenStorage: noop,
    };

    let body: React.ReactNode = null;
    if (view === 'home' || view === 'settings') {
        const { HomePanel } = await import('../src/components/HomePanel');
        let settings: React.ReactNode = null;
        if (view === 'settings') {
            const [{ SettingsScreen }, { useRetentionPolicy }, { useKeybinds }, { useVoiceSettings }, { useGameSettings }, { usePrivacySettings }, { useScreenLock }, { useGifSettings }] = await Promise.all([
                import('../src/components/settings/SettingsScreen'), import('../src/hooks/useRetentionPolicy'), import('../src/hooks/useKeybinds'),
                import('../src/hooks/useVoiceSettings'), import('../src/hooks/useGameSettings'), import('../src/hooks/usePrivacySettings'),
                import('../src/hooks/useScreenLock'), import('../src/hooks/useGifSettings'),
            ]);
            const Host: React.FC = () => {
                const retention = useRetentionPolicy(ME);
                const keybinds = useKeybinds({});
                const voice = useVoiceSettings();
                const gameSettings = useGameSettings(ME);
                const privacy = usePrivacySettings();
                const screenLock = useScreenLock();
                const gif = useGifSettings();
                return (
                    <SettingsScreen
                        initialTab={(q.get('tab') as any) ?? 'appearance'} onClose={noop} onLogout={noop}
                        retention={retention} messagesState={{}} onClearAllMessages={noop} conversations={conversations as any}
                        onPurgeConversation={noop} onPurgeTypeNow={noop}
                        serverStorage={{ servers: [], serverChannels: {}, channelMessages: {}, leftServerChannels: {}, protectedIds: {}, token: 'x', loading: false, error: false, onPurge: async () => ({ purged: 0, skippedChannels: 0 }) } as any}
                        keybinds={keybinds} voice={voice} gameSettings={gameSettings}
                        currentGame={null} currentGameProcess={null} onIgnoreCurrentGame={noop}
                        privacy={privacy} screenLock={screenLock} gif={gif}
                    />
                );
            };
            settings = <Host />;
        }
        body = (
            <>
                <Shell>
                    <div className="view-enter app-pane-solo" data-ob-anchor="home-pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                        <HomePanel {...(homeProps as any)} />
                    </div>
                </Shell>
                {settings}
            </>
        );
    } else if (view === 'friends') {
        const [{ default: FriendsPane }, { FriendsActivityPanel }] = await Promise.all([
            import('../src/components/FriendsPane'), import('../src/components/FriendsActivityPanel'),
        ]);
        const accepted = ['Mira', 'Jun', 'Priya', 'Sam', 'Noor', 'Kit', 'Jules', 'Mika', 'Quinn', 'Avery', 'Blake', 'Casey', 'Devon', 'Ren', 'Lou', 'Ash']
            .map((n, i) => ({ friendship_id: `f${i}`, user_id: `u-${n.toLowerCase()}`, username: n.toLowerCase(), display_name: n }));
        const friends = { pending_incoming: [{ friendship_id: 'f99', requester_id: 'u-ren', username: 'ren', display_name: 'Ren' }], pending_outgoing: [], accepted, blocked: [] };
        const statuses: any = { 'u-mira': { status: 'online' }, 'u-jun': { status: 'idle' }, 'u-priya': { status: 'dnd' }, 'u-sam': { status: 'online' }, 'u-noor': { status: 'online' } };
        body = (
            <Shell pane4={
                <Pane4>
                    <div className="flex flex-col">
                        <FriendsActivityPanel
                            token="harness" friends={accepted as any} blockedIds={new Set()} loading={false}
                            friendStatuses={statuses} presence={{ 'u-mira': true, 'u-jun': true, 'u-sam': true, 'u-noor': true }}
                            entries={[]} voiceParticipants={{}} huddleCalls={{}} channels={[]} servers={[]}
                            localCallSession={null} onOpenProfile={noop} now={NOW}
                        />
                    </div>
                </Pane4>
            }>
                <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <FriendsPane onStartChat={noop} friends={friends as any} friendsStatus="ready" onRefresh={() => Promise.resolve()} friendStatuses={statuses} />
                </div>
            </Shell>
        );
    } else if (view === 'server' || view === 'dm') {
        const [{ default: ChatPane }, { useRetentionPolicy }, { ServerChannelList }, { ServerContextPanel }, { DmProfileCard }, { ClSearch }] = await Promise.all([
            import('../src/components/ChatPane'), import('../src/hooks/useRetentionPolicy'),
            import('../src/components/server/ServerChannelList'), import('../src/components/server/ServerContextPanel'),
            import('../src/components/profile/DmProfileCard'), import('../src/components/cl'),
        ]);
        const isDm = view === 'dm';
        const channel = { channel_id: 'general', name: 'general', topic: 'release talk', server_id: 's1', my_permissions: ALL_PERMISSIONS.toString() };
        const pinned = p4 === 'pinned';
        const call = p4 === 'call';
        const inVoice = call ? { Lounge: [ME, 'u-mira', 'u-jun'] } : {};
        // A long DM list so the left list scrolls (top / middle / bottom).
        const dmRows = [...conversations.filter(c => c.type === 'dm'), ...'ABCDEFGHIJKLMNOPQRST'.split('').map((l, i) => ({ conversation_id: `x${i}`, title: `${l}ucy ${l}.`, type: 'dm' }))];
        const Chat: React.FC = () => {
            const retention = useRetentionPolicy(ME);
            const [active, setActive] = useState('general');
            const [pq, setPq] = useState('');
            const pane4 = (
                <Pane4 call={call}>
                    {call && <CallSection />}
                    <div className="flex flex-col">
                        {isDm ? (
                            <div className="flex flex-col w-full">
                                <div className="shrink-0 px-2 py-2">
                                    <ClSearch icon={<Search size={15} />} className="text-[13px]" style={{ paddingTop: 8, paddingBottom: 8, borderRadius: 11 }} placeholder="Search in chat" type="text" defaultValue="" />
                                </div>
                                <div className="px-2 pt-1 shrink-0 mb-3.5">
                                    <DmProfileCard userId="u-mira" token="harness" currentUserId={ME} status={{ status: 'online' } as any} isFriend fallbackName="Mira" fallbackAvatarId={null} onOpenFull={noop} />
                                </div>
                            </div>
                        ) : (
                            <ServerContextPanel
                                server={SERVER} channel={CHANNELS[1]} token="harness" userId={ME}
                                myPermissions={DEFAULT_EVERYONE_PERMISSIONS}
                                allChannels={CHANNELS} categories={NONE} dividers={NONE}
                                voiceParticipants={inVoice} friendStatuses={EMPTY} presenceAuthoritative={false}
                                activeVoiceChannelId={call ? 'Lounge' : null}
                                myStatus="online" myCurrentGame={null}
                                globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                                huddleCalls={EMPTY} searchableMessages={searchable} channelPermissionsMap={EMPTY}
                                showPinnedPanel={pinned} onClosePinnedPanel={noop} pinnedCount={3}
                                pinnedSearchQuery={pq} onPinnedSearchChange={setPq}
                                onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                            />
                        )}
                    </div>
                </Pane4>
            );
            return (
                <Shell pane4={pane4}>
                    <div className="app-callgroup" data-focus-span="chat" style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'auto auto minmax(0, 1fr)', gridTemplateRows: 'auto minmax(0, 1fr)', overflow: 'hidden' }}>
                        <div className="select-none app-pane2" style={{ width: leftWidth, minWidth: 200, maxWidth: sidebarMax, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', gridColumn: 1, gridRow: '1 / 3' }}>
                            <aside className="view-enter app-pane2-sheet w-full h-full bg-cl-deep flex flex-col rounded-l-2xl border-l border-white/[0.04] shadow-xl relative" style={{ overflow: 'hidden' }}>
                                {isDm ? (
                                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar" style={{ padding: '14px 12px 10px' }}>
                                        <div className="text-cl-text font-display" style={{ fontSize: 17, fontWeight: 600, margin: '2px 6px 10px' }}>Direct messages</div>
                                        {dmRows.map((c, i) => (
                                            <div key={c.conversation_id} className={i === 0 ? 'bg-cl-surface text-cl-text cl-row-active' : 'text-cl-muted'} style={{ padding: '9px 12px', borderRadius: 12, fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <span className="bg-cl-raise" style={{ width: 30, height: 30, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--cl-text)' }}>{c.title[0]}</span>
                                                <span style={{ flex: 1 }}>{c.title}</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <ServerChannelList
                                        server={SERVER} channels={CHANNELS} categories={CATEGORIES} dividers={[]} loading={false}
                                        activeChannelId={active} onSelectChannel={(c: any) => setActive(c.channel_id)}
                                        token={null} userId={ME} myPermissions={ALL_PERMISSIONS}
                                        unreadCounts={{ lfg: 4, finishes: 2 }} mentionCounts={{ 'build-nights': 1 }} serverNotifMode="all"
                                        {...({ voiceParticipants: inVoice, activeVoiceChannelId: call ? 'Lounge' : null } as any)}
                                    />
                                )}
                            </aside>
                        </div>
                        <div style={{ width: 1, flexShrink: 0, cursor: 'col-resize', display: 'flex', zIndex: 20, gridColumn: 2, gridRow: '1 / 3' }} className="group relative app-div1">
                            <div className="w-full h-full bg-white/[0.04]"></div>
                            <div className="absolute top-0 bottom-0 -left-1 -right-1 z-30" />
                            <div data-drag-pill="left" className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-[2px] h-16 rounded-full opacity-0 group-hover:opacity-100 bg-cl-lume/40 transition-opacity z-40 pointer-events-none" />
                        </div>
                        <div className="app-pane3-col" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden', gridColumn: 3, gridRow: 2 }}>
                            <div className="app-pane3-row" style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
                                <div className="app-pane3" style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
                                    <main className="app-pane3-sheet w-full h-full bg-cl-abyss flex flex-col relative" style={{ overflow: 'hidden', flex: 1, minHeight: 0 }}>
                                        <ChatPane
                                            bundleReady
                                            activeChat={isDm ? { id: 'c1', title: 'Mira', type: 'dm', other_user_id: 'u-mira', avatar_url: 'img-mira' } : { id: 'general' }}
                                            activeChannel={isDm ? null : channel}
                                            serverChannels={isDm ? undefined : CHANNELS}
                                            serverCategories={[]}
                                            onNavigateToChannel={noop}
                                            messages={(isDm ? DM_MESSAGES : SERVER_MESSAGES) as any}
                                            messagesFetching={false}
                                            onMessageSent={noop} onChannelMessageSent={noop} onPatchSentMessage={noop}
                                            typingUsers={new Set<string>()} sendTypingEvent={noop}
                                            readReceipts={{}} sendReadReceipt={noop} showReadReceipts
                                            activeCall={null} onCallChange={noop}
                                            retention={retention as any}
                                            friendStatuses={{}}
                                            serverSavedIds={[]} pinnedMsgIds={pinned ? ['m3', 'm4', 'm6'] : []} onPinMessage={noop} onUnpinMessage={noop}
                                            onServerSaveMessage={noop} onServerUnsaveMessage={noop}
                                            pinnedSidebarExpanded={pinned} onTogglePinnedSidebar={noop} channelSearchOpen={false}
                                            onOpenPinnedCallOverlay={noop} pinnedSearchQuery="" onOpenProfile={noop}
                                            avatarUpdatedEvent={null}
                                            memberRoleColors={isDm ? {} : { 'u-mira': '#25e0c8', 'u-jun': '#a78bfa' }}
                                            serverMemberNicknames={{}}
                                            convType={isDm ? 'dm' : 'server'}
                                            servers={isDm ? [] : [{ id: 's1', server_id: 's1', name: 'Maker Collective', owner_id: ME, icon_url: null, message_styles: 'on' }] as any}
                                            onInviteJoin={noop} onInviteCodeClick={noop}
                                            channelPermissions={isDm ? undefined : ALL_PERMISSIONS}
                                            channelKeyMissing={false} channelKeyCoolingOff={false}
                                            historyStart
                                            myUserId={ME}
                                            onReport={noop}
                                            {...({ memberNames: { 'u-mira': 'Mira', 'u-jun': 'Jun', u4: 'Pat', [ME]: 'Dawson' } } as any)}
                                        />
                                    </main>
                                </div>
                            </div>
                        </div>
                    </div>
                </Shell>
            );
        };
        body = <Chat />;
    }
    createRoot(document.getElementById('root')!).render(
        <ToastProvider><UpdateProvider><NotificationProvider>
            {body}
        </NotificationProvider></UpdateProvider></ToastProvider>,
    );
    (window as any).__booted = true;
}
boot();
