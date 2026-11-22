/* eslint-disable -- visual harness, not shipped */
import { serverAbbreviation } from '../src/utils/serverAbbreviation';
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import axios from 'axios';
import { MessageSquare, MessagesSquare, Plus, Users, Settings as SettingsIcon } from 'lucide-react';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/styles/night-dive.css';
import '../src/styles/formatting.css';
import '../src/styles/theme-light.css';
import '../src/styles/theme-midnight.css';
import '../src/styles/role-style.css';
import '../src/styles/theme-contrast.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import { CARD_STYLE_TEMPLATES } from '../src/utils/cardStyle/cardStyleTemplates';
import { ThemePreviewBar } from '../src/components/themeShare/ThemePreviewBar';
import { CUSTOM_THEME_PRESETS } from '../src/theme/customPresets';
import { decodeShareCode } from '../src/theme/customTheme';
import { buildThemeLink } from '../src/theme/themeLink';
import { customThemeLibraryKey, serializeThemeLibrary } from '../src/utils/customThemeSync';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * Light theme harness: the REAL HomePanel / ServerChannelList / ChatPane /
 * ServerContextPanel / FriendsPane / SettingsScreen / dialogs inside a copy of
 * Dashboard's drift shell (real RailTrack + RailTile + TitleBarWordmark), in
 * either theme.
 *   ?theme=dark|light|midnight|hc-dark|hc-light|system   which theme (default dark)
 *   ?use=ocean|forest|rose|mono        a custom theme preset instead; ?ct=<clth1. code> any custom theme
 *   ?lib=1                             seed the custom theme library (Settings → Appearance tiles)
 *   ?msgs=theme                        theme links in the DM / server feed (the chat's theme card)
 *   ?view=home|server|dm|friends|settings|modal|menu|auth|offline   (auth: &mode=register to open sign-up)
 *   &tab=appearance|accessibility      (settings) which pane
 *   ?pill=<state>                      the REAL Discord import pill in the title bar (only under
 *                                      harness/import-pill.vite.config.ts; states in import-pill-job-stub.ts)
 *   &caption=win                       a stand-in for Windows' native caption buttons (138 px, right)
 * window.__toast(kind) pushes a real toast (ToastContext).
 * Shot by harness/light-theme-shots.mjs.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'home';
// ?keysold=1: Keys as he was before the light-theme polish (alert body =
// --cl-glow, eyes = --cl-abyss), for before/after shots without a checkout.
if (q.get('keysold') === '1') {
    const st = document.createElement('style');
    st.textContent = 'html:root[data-theme]{--cl-keys-alert:var(--cl-glow);--cl-keys-ink:var(--cl-abyss)}';
    document.head.appendChild(st);
}
const themeParam = q.get('theme') ?? 'dark';
{
    // Works on the base branch too (Dark only there): unknown ids resolve to Dark.
    const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
    if (setPref) void setPref(themeParam, {});
    else engine.applyTheme(themes.resolveTheme(themeParam));
}
// Custom themes (custom-themes-shots.mjs): ?use=<preset key> applies a preset as the
// library theme `p-<key>`; ?ct=<clth1. code> applies any shared theme; ?lib=1 seeds
// the library with every preset so Settings shows the tiles.
{
    const use = q.get('use');
    const preset = use ? CUSTOM_THEME_PRESETS.find((p) => p.key === use) : undefined;
    if (preset) void engine.setCustomTheme(`p-${preset.key}`, preset.def, {});
    const ct = q.get('ct');
    const decoded = ct ? decodeShareCode(ct) : null;
    if (decoded?.ok) void engine.setCustomTheme('shared', decoded.def, {});
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
// ?fancy=1 (fancy-server-role-names): a decorative server name and role names (emoji, symbols, styled letters).
const FANCY = q.get('fancy') === '1';
const SERVER_NAME = FANCY ? '✦ ꒰ Moonlit Café ꒱ ✦' : 'Maker Collective';
const SERVER = {
    server_id: 's1', name: SERVER_NAME, description: null,
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
    { role_id: 'mods', name: FANCY ? '『 𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬 』' : 'Moderators', position: 5, is_everyone: false, hoisted: true, color: 0x25e0c8, permissions: '0' },
    { role_id: 'artists', name: FANCY ? '🌙✨ ᴀʀᴛɪꜱᴛꜱ ♡' : 'Artists', position: 3, is_everyone: false, hoisted: true, color: 0xa78bfa, permissions: '0' },
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
        getDeviceName: 'DESK-PC', getRunningProcesses: [], getTheme: { id: ((engine as any).resolveThemePreference?.(themeParam) ?? themes.resolveTheme(themeParam)).id, pref: themeParam },
        getUiScale: { percent: 100, effective: 100, max: 200, source: 'set' },
        getLoginItemState: { supported: true, enabled: true, needsApproval: false },
    };
    const excluded = new Set(['secureKvOpen', 'secureKvSeal', 'getLocalMasterKeyStatus', 'then', 'bootThemeId', 'bootCustomTheme', 'saveFileAs']);
    (window as any).electronAPI = new Proxy({}, {
        get(_t, prop: string) {
            if (excluded.has(prop)) return undefined;
            if (prop === 'platform') return 'win32';
            if (prop === 'fetchBinary') return (_u: string) => Promise.resolve({ mimeType: 'image/png', b64: pngB64 });
            if (prop === 'setTheme') return (p: string) => {
                const r = (engine as any).resolveThemePreference?.(p) ?? themes.resolveTheme(p);
                engine.applyTheme(r);
                return Promise.resolve({ id: r.id, pref: p });
            };
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
// ?msgs=theme (theme-share-shots.mjs): theme links in the feed — the chat's theme card.
const THEME_LINKS = q.get('msgs') === 'theme';
const themeLink = (key: string) => buildThemeLink(CUSTOM_THEME_PRESETS.find((p) => p.key === key)!.def);
const DUSK = buildThemeLink({ v: 1, name: 'Dusk', base: 'dark', glow: true, colors: {
    bg: '#160f1f', panel: '#1f1530', surface: '#2a1d40', text: '#f3ecff', muted: '#5b4d70',
    accent: '#f59e6b', onAccent: '#2a1406', danger: '#ff6b8b', border: '#3a2a55' } });
const THEME_DM_MESSAGES = [
    msg('d1', 'u-mira', t(190), { type: 'text', text: 'I made a theme for late nights. Deep blue, sea-glass accent.' }),
    msg('d2', 'u-mira', t(189), { type: 'text', text: `this one is for you\n${themeLink('ocean')}` }),
    msg('d3', ME, t(120), { type: 'text', text: 'Love it. Here is mine, for daytime:' }),
    msg('d4', ME, t(119), { type: 'text', text: themeLink('rose') }),
    msg('d5', 'u-mira', t(30), { type: 'text', text: `and the one I tweaked ${DUSK}` }),
    msg('d6', 'u-mira', t(5), { type: 'text', text: 'oops, this copy got cut off https://cipherline.chat/theme#clth1.eyJ2IjoxLCJuYW1lIjoiT2NlYW' }),
];
const THEME_SERVER_MESSAGES = [
    msg('m1', 'u-mira', t(380), { type: 'text', text: 'Theme swap thread! Post yours.' }),
    msg('m2', 'u-jun', t(300), { type: 'text', text: `forest vibes ${themeLink('forest')}` }),
    msg('m3', ME, t(120), { type: 'text', text: `**Mono**, for focus\n${themeLink('mono')}`, card_style: ann.style }),
    msg('m4', 'u-mira', t(4), { type: 'text', text: `[my ocean theme](${themeLink('ocean')}) (hyperlinked text stays)` }),
];
const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira', other_user_id: 'u-mira', avatar_url: 'img-mira', last_message_at: new Date(t(4)).toISOString() },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew', avatar_url: 'img-crew', last_message_at: new Date(t(50)).toISOString() },
    { conversation_id: 'c3', type: 'dm', title: 'Jun', other_user_id: 'u-jun', avatar_url: null, last_message_at: new Date(NOW - 5 * 3600_000).toISOString() },
    { conversation_id: 'c4', type: 'dm', title: 'Priya', other_user_id: 'u-priya', avatar_url: null, last_message_at: new Date(NOW - 26 * 3600_000).toISOString() },
];

// ── The drift shell (same element classes as Dashboard.tsx) ─────────────────
function paneWidths(W: number) {
    const max = Math.max(500, Math.round(W * 0.35));
    return { left: Math.max(200, Math.min(max, 0.18 * W)), right: Math.max(240, Math.min(max, 0.2 * W)) };
}

// ?preview=<preset key>: mounts the REAL ThemePreviewBar and starts a live preview of that preset
// (theme-preview-bar-corner-shots.mjs). &tlpleft=16px overrides --tlp-left (the "no rail offset" option).
const PREVIEW_BAR = q.get('preview');
const PreviewBarHost: React.FC = () => {
    React.useEffect(() => {
        const preset = CUSTOM_THEME_PRESETS.find((p) => p.key === PREVIEW_BAR) ?? CUSTOM_THEME_PRESETS[0];
        engine.startThemePreview(preset.def, {});
        const left = q.get('tlpleft');
        if (left) { const st = document.createElement('style'); st.textContent = `.tlp{--tlp-left:${left}!important}`; document.head.appendChild(st); }
    }, []);
    return <ThemePreviewBar />;
};
async function boot() {
    await secureLocalStore.hydrate().catch(() => {});
    secureLocalStore.setItem('cipherline_user_id', ME);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    if (q.get('lib') === '1') {
        secureLocalStore.setItem(customThemeLibraryKey(ME), serializeThemeLibrary(
            CUSTOM_THEME_PRESETS.filter((p) => p.key !== 'dark' && p.key !== 'light').map((p) => ({ id: `p-${p.key}`, ...p.def })),
        ));
    }
    installElectronStub();
    const [{ ToastProvider, useToast }, { UpdateProvider }, { NotificationProvider }, { RailTrack }, { RailTile }, { TitleBarWordmark }] = await Promise.all([
        import('../src/contexts/ToastContext'), import('../src/contexts/UpdateContext'), import('../src/contexts/NotificationContext'),
        import('../src/components/rail/RailTrack'), import('../src/components/rail/RailTile'), import('../src/components/TitleBarWordmark'),
    ]);
    const ImportHost = q.get('pill') ? (await import('../src/components/server/discordImport/DiscordImportHost')).DiscordImportHost : null;
    // Electron's Windows caption overlay is 3 x 46 px at the bar's right edge; the browser has none.
    const Caption: React.FC = () => (
        <div data-testid="caption-standin" aria-hidden="true" style={{ position: 'fixed', top: 0, right: 0, height: 34, width: 138, display: 'flex', zIndex: 10001, color: 'var(--cl-muted)' }}>
            {['—', '☐', '✕'].map((g) => <span key={g} style={{ width: 46, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>{g}</span>)}
        </div>
    );
    const activeRail = view === 'dm' ? 0 : view === 'server' || view === 'menu' || view === 'modal' ? 3 : -1;
    const Rail: React.FC = () => (
        <nav className="shrink-0 app-rail" style={{ width: 72, flex: 'none', background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--cl-rail-gap, 16px)', minHeight: 0, paddingTop: 8 }}>
            <RailTrack scroll activeIndex={activeRail}>
                <RailTile icon={<MessageSquare size={19} />} title="Direct messages" active={activeRail === 0} badge={{ count: 3, tone: 'alert' }} />
                <RailTile icon={<MessagesSquare size={19} />} title="Group chats" active={activeRail === 1} />
                <RailTile label="NG" title="Neon Guild" badge={{ count: 2, tone: 'quiet' }} />
                <RailTile label={serverAbbreviation(SERVER_NAME)} title={SERVER_NAME} active={activeRail === 3} />
                <RailTile label="DT" title="Design Team" />
                <RailTile icon={<Plus size={19} />} title="Add a server" accent />
            </RailTrack>
            <div style={{ flex: 1 }} />
            <RailTrack activeIndex={view === 'friends' ? 0 : view === 'settings' ? 1 : -1}>
                <RailTile icon={<Users size={19} />} title="Friends" active={view === 'friends'} />
                <RailTile icon={<SettingsIcon size={19} />} title="Settings" active={view === 'settings'} />
            </RailTrack>
            <div style={{ height: 12 }} />
        </nav>
    );
    const ToastHook: React.FC = () => {
        const toast = useToast();
        (window as any).__toast = (kind: any = 'success') => toast.push({ kind, title: kind === 'error' ? 'Could not send' : 'Saved', message: kind === 'error' ? 'Check your connection and try again.' : 'Your theme follows you to every window.', durationMs: 0 });
        return null;
    };
    const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
        <div data-layout="drift" className="w-screen h-screen flex flex-col bg-cl-abyss text-white overflow-hidden font-sans relative">
            <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss"><TitleBarWordmark />{ImportHost && <ImportHost onOpenServer={() => {}} />}{q.get('caption') === 'win' && <Caption />}</div>
            <div className="flex flex-1 overflow-hidden app-mainrow">
                <Rail />
                {children}
            </div>
        </div>
    );
    const Divider = () => <div className="app-div1" style={{ width: 10, flexShrink: 0 }}><div className="w-full h-full" /></div>;
    const Pane2: React.FC<{ w: number; children: React.ReactNode }> = ({ w, children }) => (
        <div className="select-none app-pane2" style={{ width: w, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <aside className="view-enter app-pane2-sheet w-full h-full bg-cl-deep flex flex-col rounded-l-2xl border-l border-white/[0.04] shadow-xl relative" style={{ overflow: 'hidden' }}>{children}</aside>
        </div>
    );
    const Pane3: React.FC<{ children: React.ReactNode }> = ({ children }) => (
        <div className="app-pane3" style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
            <main className="app-pane3-sheet w-full h-full bg-cl-abyss flex flex-col relative" style={{ overflow: 'hidden', flex: 1, minHeight: 0 }}>{children}</main>
        </div>
    );

    let body: React.ReactNode = null;
    const W = window.innerWidth;
    const { left: lw, right: rw } = paneWidths(W);

    if (view === 'home') {
        const { HomePanel } = await import('../src/components/HomePanel');
        body = (
            <Shell>
                <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <HomePanel
                        userId={ME} displayName="Dawson" token="harness-token"
                        conversations={conversations as any}
                        unreadCounts={{ c1: 3, c2: 1 }} mentionCounts={{ c1: 1 }}
                        lastActivityAt={{ c1: t(4), c2: t(50), c3: NOW - 5 * 3600_000, c4: NOW - 26 * 3600_000 }}
                        presence={{ 'u-mira': true, 'u-jun': false }}
                        friends={{ accepted: [{ user_id: 'u-mira', display_name: 'Mira', username: 'mira' }, { user_id: 'u-jun', display_name: 'Jun', username: 'jun' }] } as any}
                        servers={[{ server_id: 'S1', name: 'Neon Guild', role: 'owner' }, { server_id: 'S2', name: 'Design Team', role: 'member' }] as any}
                        serverChannels={{ S1: [{ channel_id: 'n1', name: 'general', type: 'text', server_id: 'S1' }, { channel_id: 'n2', name: 'Lounge', type: 'voice', server_id: 'S1' }] } as any}
                        voiceParticipants={{ n2: ['u-mira'] }} huddleCalls={{}}
                        voiceUserNames={{ 'u-mira': 'Mira' }}
                        serverBadges={{ S1: { unread: 2, mentions: 0 } } as any} serverLastActivityAt={{ S1: t(8) }}
                        pinnedItems={[]} friendStatuses={{}}
                        onSelectConversation={noop} onJoinVoiceChannel={noop} onJoinHuddleCall={noop}
                        onPin={noop} onUnpin={noop} onOpenStorage={noop}
                    />
                </div>
            </Shell>
        );
    } else if (view === 'server' || view === 'menu' || view === 'modal' || view === 'dm') {
        const [{ default: ChatPane }, { useRetentionPolicy }, { ServerChannelList }, { ServerContextPanel }, { CategoryFormDialog }] = await Promise.all([
            import('../src/components/ChatPane'), import('../src/hooks/useRetentionPolicy'),
            import('../src/components/server/ServerChannelList'), import('../src/components/server/ServerContextPanel'),
            import('../src/components/server/CategoryFormDialog'),
        ]);
        const isDm = view === 'dm';
        const channel = { channel_id: 'general', name: 'general', topic: 'release talk', server_id: 's1', my_permissions: ALL_PERMISSIONS.toString() };
        const Chat: React.FC = () => {
            const retention = useRetentionPolicy(ME);
            const [active, setActive] = useState('general');
            return (
                <Shell>
                    <Pane2 w={lw}>
                        {isDm ? (
                            <div style={{ padding: '14px 12px 10px' }}>
                                <div className="text-cl-text font-display" style={{ fontSize: 17, fontWeight: 600, margin: '2px 6px 10px' }}>Direct messages</div>
                                {conversations.filter(c => c.type === 'dm').map((c, i) => (
                                    <div key={c.title} className={i === 0 ? 'bg-cl-surface text-cl-text cl-row-active' : 'text-cl-muted'} style={{ padding: '9px 12px', borderRadius: 12, fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
                                        <span className="bg-cl-raise" style={{ width: 30, height: 30, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--cl-text)' }}>{c.title[0]}</span>
                                        <span style={{ flex: 1 }}>{c.title}</span>
                                        {i === 0 && <span className="bg-cl-flash text-cl-on-flash" style={{ fontSize: 11, fontWeight: 800, borderRadius: 99, padding: '1px 7px' }}>3</span>}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <ServerChannelList
                                server={SERVER} channels={CHANNELS} categories={CATEGORIES} dividers={[]} loading={false}
                                activeChannelId={active} onSelectChannel={(c) => setActive(c.channel_id)}
                                token={null} userId={ME} myPermissions={ALL_PERMISSIONS}
                                unreadCounts={{ lfg: 4, finishes: 2 }} mentionCounts={{ 'build-nights': 1 }} serverNotifMode="all"
                            />
                        )}
                    </Pane2>
                    <Divider />
                    <Pane3>
                        <ChatPane
                            bundleReady
                            activeChat={isDm ? { id: 'c1', title: 'Mira', type: 'dm', other_user_id: 'u-mira', avatar_url: 'img-mira' } : { id: 'general' }}
                            activeChannel={isDm ? null : channel}
                            serverChannels={isDm ? undefined : CHANNELS}
                            serverCategories={[]}
                            onNavigateToChannel={noop}
                            messages={(isDm ? (THEME_LINKS ? THEME_DM_MESSAGES : DM_MESSAGES) : (THEME_LINKS ? THEME_SERVER_MESSAGES : SERVER_MESSAGES)) as any}
                            messagesFetching={false}
                            onMessageSent={noop} onChannelMessageSent={noop} onPatchSentMessage={noop}
                            typingUsers={new Set<string>()} sendTypingEvent={noop}
                            readReceipts={{}} sendReadReceipt={noop} showReadReceipts
                            activeCall={null} onCallChange={noop}
                            retention={retention as any}
                            friendStatuses={{}}
                            serverSavedIds={[]} pinnedMsgIds={[]} onPinMessage={noop} onUnpinMessage={noop}
                            onServerSaveMessage={noop} onServerUnsaveMessage={noop}
                            pinnedSidebarExpanded={false} onTogglePinnedSidebar={noop} channelSearchOpen={false}
                            onOpenPinnedCallOverlay={noop} pinnedSearchQuery="" onOpenProfile={noop}
                            avatarUpdatedEvent={null}
                            memberRoleColors={isDm ? {} : { 'u-mira': '#25e0c8', 'u-jun': '#a78bfa' }}
                            serverMemberNicknames={{}}
                            convType={isDm ? 'dm' : 'server'}
                            servers={isDm ? [] : [{ id: 's1', server_id: 's1', name: SERVER_NAME, owner_id: ME, icon_url: null, message_styles: 'on' }] as any}
                            onInviteJoin={noop} onInviteCodeClick={noop}
                            channelPermissions={isDm ? undefined : ALL_PERMISSIONS}
                            channelKeyMissing={false} channelKeyCoolingOff={false}
                            historyStart
                            myUserId={ME}
                            onReport={noop}
                            {...({ memberNames: { 'u-mira': 'Mira', 'u-jun': 'Jun', u4: 'Pat', [ME]: 'Dawson' } } as any)}
                        />
                    </Pane3>
                    {!isDm && <Divider />}
                    {!isDm && (
                        <div className="app-pane4" style={{ width: rw, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                            <aside className="app-pane4-sheet w-full h-full bg-cl-deep flex flex-col rounded-r-2xl relative" style={{ overflowY: 'auto' }}>
                                <ServerContextPanel
                                    server={SERVER} channel={CHANNELS[1]} token="harness" userId={ME}
                                    myPermissions={DEFAULT_EVERYONE_PERMISSIONS}
                                    allChannels={CHANNELS.filter(c => c.kind === 'text')} categories={NONE} dividers={NONE}
                                    voiceParticipants={EMPTY} friendStatuses={EMPTY} presenceAuthoritative={false}
                                    myStatus="online" myCurrentGame={null}
                                    globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                                    huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                                    onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                                />
                            </aside>
                        </div>
                    )}
                    {view === 'modal' && (
                        <CategoryFormDialog
                            serverId="s1" token={null} kind="text" ownerUserId={ME} currentUserId={ME}
                            category={CATEGORIES[3]} categories={CATEGORIES}
                            onClose={noop} onSaved={noop}
                        />
                    )}
                </Shell>
            );
        };
        body = <Chat />;
    } else if (view === 'friends') {
        const { default: FriendsPane } = await import('../src/components/FriendsPane');
        const friends = {
            pending_incoming: [{ friendship_id: 'f9', requester_id: 'u-ren', username: 'ren', display_name: 'Ren' }],
            pending_outgoing: [],
            accepted: [
                { friendship_id: 'f1', user_id: 'u-mira', username: 'mira', display_name: 'Mira' },
                { friendship_id: 'f2', user_id: 'u-jun', username: 'jun', display_name: 'Jun' },
                { friendship_id: 'f3', user_id: 'u-priya', username: 'priya', display_name: 'Priya' },
                { friendship_id: 'f4', user_id: 'u-sam', username: 'sam', display_name: 'Sam' },
            ],
            blocked: [],
        };
        body = (
            <Shell>
                <div className="view-enter app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <FriendsPane onStartChat={noop} friends={friends as any} friendsStatus="ready" onRefresh={() => Promise.resolve()}
                        friendStatuses={{ 'u-mira': { status: 'online' }, 'u-jun': { status: 'idle' }, 'u-priya': { status: 'dnd' } } as any} />
                </div>
            </Shell>
        );
    } else if (view === 'keys') {
        // Keys gallery (light-theme polish): every state that sets his colour,
        // on the panel he usually sits on. 'alert' is the Home deck with an
        // unread @mention, the 2FA setup and the checkout's error face.
        const [{ Keys }, { MascotEmpty }, { TinyKeys }] = await Promise.all([
            import('../src/components/mascot/Keys'), import('../src/components/MascotEmpty'), import('../src/components/TinyKeys'),
        ]);
        const cell = (label: string, node: React.ReactNode) => (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '18px 14px', minWidth: 150 }}>
                <div style={{ height: 110, display: 'grid', placeItems: 'end center' }}>{node}</div>
                <div className="text-cl-muted" style={{ fontSize: 12, fontWeight: 700 }}>{label}</div>
            </div>
        );
        body = (
            <Shell>
                <div className="view-enter app-pane-solo bg-cl-deep" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden', padding: 28 }}>
                    <div className="text-cl-text font-display" style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Keys</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        {cell('idle', <Keys size={96} waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('pulse (unreads)', <Keys size={96} signal="pulse" waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('alert (@mention)', <Keys size={96} signal="alert" waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('alert 64', <Keys size={64} signal="alert" waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('alert 44', <Keys size={44} signal="alert" waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('alert 28', <Keys size={28} signal="alert" waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('sad (offline)', <Keys size={96} sad waveOnMount={false} interactive={false} idleSway={false} costume={null} />)}
                        {cell('title bar', <TinyKeys />)}
                    </div>
                    <div style={{ marginTop: 18, display: 'flex', gap: 24 }}>
                        <div className="bg-cl-surface" style={{ borderRadius: 16, padding: 18, width: 360 }}>
                            <MascotEmpty title="Nothing pinned yet" sub="Pin a message and it shows up here." />
                        </div>
                    </div>
                </div>
            </Shell>
        );
    } else if (view === 'auth') {
        // Theme coverage audit: the sign-in screen (the real AuthScreen; useAuth is stubbed).
        const { default: AuthScreen } = await import('../src/components/AuthScreen');
        body = <AuthScreen />;
    } else if (view === 'offline') {
        // Theme coverage audit: the offline overlay over the app shell.
        const { OfflineScreen } = await import('../src/components/OfflineScreen');
        body = <Shell><div style={{ flex: 1 }} /><OfflineScreen isOnline={false} /></Shell>;
    } else if (view === 'settings') {
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
        body = <Shell><div style={{ flex: 1 }} /><Host /></Shell>;
    }

    // "Send to a friend" (theme-share-shots.mjs): fake friends, a send that succeeds.
    const { ThemeShareActionsProvider } = await import('../src/components/themeShare/ThemeShareActionsContext');
    const shareActions = {
        available: true,
        friends: [
            { user_id: 'u-mira', username: 'Mira', discriminator: 1001, avatar_url: null, status: 'online' },
            { user_id: 'u-jun', username: 'Jun', discriminator: 1002, avatar_url: null, status: 'idle' },
            { user_id: 'u-priya', username: 'Priya', discriminator: 1003, avatar_url: null, status: 'offline' },
            { user_id: 'u-sam', username: 'Sam', discriminator: 1004, avatar_url: null, status: 'online' },
            { user_id: 'u-noor', username: 'Noor', discriminator: 1005, avatar_url: null, status: 'dnd' },
        ],
        conversations,
        lastActivityAt: { c1: t(4), c3: NOW - 5 * 3600_000 },
        sendText: (_id: string, text: string) => { (window as any).__sentTheme = text; return new Promise<boolean>((r) => setTimeout(() => r(true), 400)); },
    };
    createRoot(document.getElementById('root')!).render(
        <ToastProvider><UpdateProvider><NotificationProvider><ThemeShareActionsProvider value={shareActions as any}>
            <ToastHook />
            {body}
            {PREVIEW_BAR ? <PreviewBarHost /> : null}
        </ThemeShareActionsProvider></NotificationProvider></UpdateProvider></ToastProvider>,
    );
    (window as any).__booted = true;
}
boot();
