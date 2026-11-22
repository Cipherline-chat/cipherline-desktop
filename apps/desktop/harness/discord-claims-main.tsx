/* eslint-disable -- harness, not shipped */
/**
 * Discord CLAIMS (import phase 3) against an ISOLATED local API (own Postgres, Redis, MinIO on loopback; never the
 * shared dev stack, staging or prod), with a MOCK Discord OAuth provider and a self-signed TLS front for the API
 * (harness/discord-claims-mock.mjs). Everything Cipherline-side is REAL: ChatPane rendering imported history from
 * GET /channels/:cid/messages, the "Not on Cipherline yet" card and its claim slot, the Discord sign-in start
 * (POST /discord/link + the URL check + the external opener), the server-side OAuth flow the browser walks, the
 * claimable / review / claim routes, the confirm dialog, Settings > Profile > Discord and the auto-map notice.
 *
 * One stand-in: the sender-key engine. Rows were sealed by the setup script with a harness AES-GCM key (cfg.key_b64)
 * and are opened here with the same key; the API only ever sees ciphertext either way.
 *
 * Boot: #<base64 JSON from discord-claims-setup.mjs>. ?as=sam|alex ?view=chat|settings|notice ?theme=dark|light
 */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/formatting.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/theme-light.css';
import '../src/styles/settings-descent.css';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import ChatPane from '../src/components/ChatPane';
import { ToastProvider } from '../src/contexts/ToastContext';
import { useRetentionPolicy } from '../src/hooks/useRetentionPolicy';
import secureLocalStore from '../src/utils/secureLocalStore';
import { API_BASE } from '../src/constants';
import { takeSealedFranking } from '../src/utils/franking';
import { ProfileDiscordSection } from '../src/components/settings/panes/ProfileDiscordSection';
import { DiscordClaimNotices } from '../src/components/server/discordImport/DiscordClaimNotices';
import { ALL_PERMISSIONS, gateImportedFrom, importMarkOf } from '@cipherline/shared';
import { DISCORD_LINK_CHANGED_EVENT } from '../src/utils/discordLinkEvents';

loadWebFonts();
const q = new URLSearchParams(location.search);
const themeParam = q.get('theme') ?? 'dark';
{
    const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
    if (setPref) void setPref(themeParam, {}); else engine.applyTheme(themes.resolveTheme(themeParam));
}
const log: any[] = ((window as any).__log = []);
const note = (...a: any[]) => { log.push(a); };

// ── Safety: the isolated local API or nothing ────────────────────────────
const cfg = JSON.parse(atob(decodeURIComponent(location.hash.slice(1))));
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE) || API_BASE !== cfg.api) {
    document.body.textContent = `REFUSING TO START: API_BASE is ${API_BASE}, expected the isolated local API ${cfg.api}`;
    throw new Error('wrong API target');
}
const AS = q.get('as') ?? 'sam';
(window as any).__AS = AS;
(window as any).__HARNESS = cfg;
(window as any).__apiBase = API_BASE;
// Phase 3b: the harness has no socket; the shots script forwards a `discord:link_changed` it received on a REAL WS
// connection to the isolated API by firing the same window event useRealtime fires.
(window as any).__discordLinkChanged = () => window.dispatchEvent(new CustomEvent(DISCORD_LINK_CHANGED_EVENT));
const ME = cfg[AS];
axios.defaults.headers.common.Authorization = `Bearer ${ME.token}`;
const api = async (method: string, path: string) => {
    const r = await fetch(API_BASE + path, { method, headers: { authorization: `Bearer ${ME.token}` } });
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
    return r.json();
};
const opened: string[] = ((window as any).__opened = []);
(window as any).electronAPI = { platform: 'linux', openExternal: async (u: string) => { opened.push(u); note('open-external', u); } };

const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const keyP = crypto.subtle.importKey('raw', unb64(cfg.key_b64), 'AES-GCM', false, ['decrypt']);
async function openRow(row: any) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.nonce_b64) }, await keyP, unb64(row.ciphertext_b64));
    return new TextDecoder().decode(pt);
}
async function loadChannel(cid: string) {
    const raw: any[] = await api('GET', `/channels/${cid}/messages?limit=100`);
    const out: any[] = [];
    for (const r of raw) {
        if (r.kind === 'system' || r.deleted || !r.ciphertext_b64) continue;
        let content: any;
        try { content = takeSealedFranking(JSON.parse(await openRow(r))).content; } catch { continue; }
        const mark = importMarkOf(r);
        out.push({ id: r.id, content: gateImportedFrom(content, mark), sender_user_id: r.sender_user_id, sender_device_id: r.sender_device_id,
            timestamp: r.created_at, conversation_id: cid, ...(mark ? { import_mark: mark } : {}) });
    }
    out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    (window as any).__chat = { rows: raw.length, marked: raw.filter(r => r.import_id).length, claimed: raw.filter(r => r.import_claimed_user_id).map(r => r.import_claimed_user_id) };
    return out;
}

const CHANNELS = [
    { channel_id: cfg.channels.general, name: 'general', server_id: cfg.server_id, kind: 'text' },
    { channel_id: cfg.channels.announcements, name: 'announcements', server_id: cfg.server_id, kind: 'text' },
];
const Chat: React.FC<{ cid: string; messages: any[] }> = ({ cid, messages }) => {
    const retention = useRetentionPolicy(ME.user_id);
    // Every TEST account in the setup output (the link-move setup adds "alexalt").
    const names: Record<string, string> = Object.fromEntries(Object.values(cfg)
        .filter((v: any) => v && typeof v === 'object' && typeof v.user_id === 'string' && typeof v.name === 'string')
        .map((v: any) => [v.user_id, v.name]));
    const ch = CHANNELS.find(c => c.channel_id === cid)!;
    const channel = { channel_id: cid, name: ch.name, topic: 'Moved here from Discord', server_id: cfg.server_id, my_permissions: ALL_PERMISSIONS.toString() };
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
            <nav style={{ width: 72, flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px', gap: 10 }}>
                <main id="chat" style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--cl-abyss)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ChatPane
                        bundleReady activeChat={{ id: cid }} activeChannel={channel} emojisChangedEvent={null}
                        serverChannels={CHANNELS as any} serverCategories={[]} onNavigateToChannel={() => {}}
                        messages={messages} messagesFetching={false} onMessageSent={() => {}} onChannelMessageSent={() => {}} onPatchSentMessage={() => {}}
                        typingUsers={new Set()} sendTypingEvent={() => {}} readReceipts={{}} sendReadReceipt={() => {}} showReadReceipts
                        activeCall={null} onCallChange={() => {}} friendStatuses={{}} retention={retention}
                        serverSavedIds={[]} pinnedMsgIds={[]} onPinMessage={() => {}} onUnpinMessage={() => {}}
                        onServerSaveMessage={() => {}} onServerUnsaveMessage={() => {}}
                        pinnedSidebarExpanded={false} onTogglePinnedSidebar={() => {}} channelSearchOpen={false} onOpenPinnedCallOverlay={() => {}}
                        pinnedSearchQuery="" onOpenProfile={(id: string) => note('open-profile', id)} avatarUpdatedEvent={null} memberRoleColors={{}} serverMemberNicknames={names}
                        convType="server" servers={[{ id: cfg.server_id, server_id: cfg.server_id, name: cfg.server_name, owner_id: cfg.importer.user_id } as any]} onInviteJoin={() => {}} onInviteCodeClick={() => {}}
                        channelPermissions={ALL_PERMISSIONS} channelKeyMissing={false} channelKeyCoolingOff={false}
                        historyGaps={[]} historyStart onFillHistoryGap={async () => ({ shown: 0, progressed: false })}
                        myUserId={ME.user_id} onReport={(...a: any[]) => note('report', a[0])}
                    />
                </main>
            </div>
        </div>
    );
};

/** Settings > Profile, as the real pane hosts it (card width, settings sheets). */
const Settings: React.FC = () => (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--cl-deep)', color: 'var(--cl-text)', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: 'min(720px, 100% - 32px)', padding: '28px 0' }} className="pp-main">
            <h2 style={{ margin: '0 0 14px', fontSize: 20, color: 'var(--cl-bright)' }}>Profile</h2>
            <ProfileDiscordSection token={ME.token} />
        </div>
    </div>
);

const App: React.FC = () => {
    const view = q.get('view') ?? 'chat';
    const cid = q.get('channel') === 'announcements' ? cfg.channels.announcements : cfg.channels.general;
    const [messages, setMessages] = React.useState<any[] | null>(null);
    (window as any).__reload = async () => { setMessages(await loadChannel(cid)); };
    React.useEffect(() => { if (view !== 'settings') void (window as any).__reload(); }, []);
    // Claim / unclaim also fan out `import:author_claim` over the WS; the harness has no socket, so re-read history.
    React.useEffect(() => {
        const t = window.setInterval(() => { if (view === 'chat' && (window as any).__autoReload) void (window as any).__reload(); }, 1500);
        return () => window.clearInterval(t);
    }, []);
    if (view === 'settings') return <Settings />;
    return (
        <>
            {messages ? <Chat cid={cid} messages={messages} /> : <div style={{ height: '100vh', background: 'var(--cl-abyss)' }} />}
            {view === 'notice' && (
                <DiscordClaimNotices token={ME.token} userId={ME.user_id} changedTick={0}
                    channelName={(_s, c) => { const x = CHANNELS.find(y => y.channel_id === c); return x ? `#${x.name}` : null; }} />
            )}
        </>
    );
};

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', ME.user_id);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
    (window as any).__booted = true;
})();
