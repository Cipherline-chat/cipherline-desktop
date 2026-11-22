/* eslint-disable -- harness, not shipped */
/**
 * Discord import member roles / bans / nicknames / reactions: the REAL UI
 * against the ISOLATED local API that setup.ts filled (never the shared dev
 * stack, staging or prod).
 *
 *   ?as=sam|alex|importer  ?view=notice|chat|roles|settings  ?theme=dark|light  #<base64 setup JSON>
 *
 * notice   DiscordClaimNotices (sam): the claim confirm naming his roles
 * chat     ChatPane #general: imported reactions under the B6.2 rules
 * roles    Server Settings > Roles (importer): the import's people bar + Review
 * settings Settings > Profile > Discord (sam)
 *
 * One stand-in: the sender-key engine (rows sealed by setup.ts with a harness
 * AES-GCM key, opened here with it). VITE_API_HOST is pinned to loopback at
 * build time; the page refuses any other API.
 */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../../src/utils/clPhysics';
import { loadWebFonts } from '../../src/utils/webFonts';
import '../../src/index.css';
import '../../src/styles/cl-kit.css';
import '../../src/styles/cl-kit-fallback.css';
import '../../src/styles/cl-kit-ext.css';
import '../../src/styles/formatting.css';
import '../../src/styles/theme-light-kit.css';
import '../../src/styles/theme-light.css';
import '../../src/styles/settings-descent.css';
import * as engine from '../../src/theme/engine';
import * as themes from '../../src/theme/themes';
import ChatPane from '../../src/components/ChatPane';
import { ToastProvider } from '../../src/contexts/ToastContext';
import { useRetentionPolicy } from '../../src/hooks/useRetentionPolicy';
import secureLocalStore from '../../src/utils/secureLocalStore';
import { API_BASE } from '../../src/constants';
import { takeSealedFranking } from '../../src/utils/franking';
import { ProfileDiscordSection } from '../../src/components/settings/panes/ProfileDiscordSection';
import { DiscordClaimNotices } from '../../src/components/server/discordImport/DiscordClaimNotices';
import { RolesTabContainer } from '../../src/components/server/roles/RolesTabContainer';
import { ALL_PERMISSIONS, gateImportedFrom, importMarkOf } from '@cipherline/shared';

loadWebFonts();
const q = new URLSearchParams(location.search);
const themeParam = q.get('theme') ?? 'dark';
{
    const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
    if (setPref) void setPref(themeParam, {}); else engine.applyTheme(themes.resolveTheme(themeParam));
}
const cfg = JSON.parse(atob(decodeURIComponent(location.hash.slice(1))));
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE) || API_BASE !== cfg.api) {
    document.body.textContent = `REFUSING TO START: API_BASE is ${API_BASE}, expected the isolated local API ${cfg.api}`;
    throw new Error('wrong API target');
}
const AS = q.get('as') ?? 'sam';
(window as any).__AS = AS;
(window as any).__HARNESS = cfg;
const ME = cfg[AS];
axios.defaults.headers.common.Authorization = `Bearer ${ME.token}`;
(window as any).electronAPI = { platform: 'linux', openExternal: async () => {} };
const api = async (path: string) => {
    const r = await fetch(API_BASE + path, { headers: { authorization: `Bearer ${ME.token}` } });
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
};
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const keyP = crypto.subtle.importKey('raw', unb64(cfg.key_b64), 'AES-GCM', false, ['decrypt']);
async function loadChannel(cid: string) {
    const raw: any[] = await api(`/channels/${cid}/messages?limit=100`);
    const out: any[] = [];
    for (const r of raw) {
        if (r.kind === 'system' || r.deleted || !r.ciphertext_b64) continue;
        let content: any;
        try {
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.nonce_b64) }, await keyP, unb64(r.ciphertext_b64));
            content = takeSealedFranking(JSON.parse(new TextDecoder().decode(pt))).content;
        } catch { continue; }
        const mark = importMarkOf(r);
        out.push({ id: r.id, content: gateImportedFrom(content, mark), sender_user_id: r.sender_user_id, sender_device_id: r.sender_device_id,
            timestamp: r.created_at, conversation_id: cid, ...(mark ? { import_mark: mark } : {}) });
    }
    out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    (window as any).__chat = { rows: raw.length };
    return out;
}
const names: Record<string, string> = Object.fromEntries(Object.values(cfg)
    .filter((v: any) => v && typeof v === 'object' && typeof v.user_id === 'string' && typeof v.name === 'string')
    .map((v: any) => [v.user_id, v.name]));
let CHANNELS: any[] = [{ channel_id: cfg.channels.general, name: 'general', server_id: cfg.server_id, kind: 'text' }];

const Chat: React.FC<{ messages: any[] }> = ({ messages }) => {
    const retention = useRetentionPolicy(ME.user_id);
    const cid = cfg.channels.general;
    const channel = { channel_id: cid, name: 'general', topic: 'Moved here from Discord', server_id: cfg.server_id, my_permissions: ALL_PERMISSIONS.toString() };
    return (
        <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
            <nav style={{ width: 72, flex: 'none' }} />
            <main style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
                <ChatPane
                    bundleReady activeChat={{ id: cid }} activeChannel={channel} emojisChangedEvent={null}
                    serverChannels={CHANNELS as any} serverCategories={[]} onNavigateToChannel={() => {}}
                    messages={messages} messagesFetching={false} onMessageSent={() => {}} onChannelMessageSent={() => {}} onPatchSentMessage={() => {}}
                    typingUsers={new Set()} sendTypingEvent={() => {}} readReceipts={{}} sendReadReceipt={() => {}} showReadReceipts
                    activeCall={null} onCallChange={() => {}} friendStatuses={{}} retention={retention}
                    serverSavedIds={[]} pinnedMsgIds={[]} onPinMessage={() => {}} onUnpinMessage={() => {}}
                    onServerSaveMessage={() => {}} onServerUnsaveMessage={() => {}}
                    pinnedSidebarExpanded={false} onTogglePinnedSidebar={() => {}} channelSearchOpen={false} onOpenPinnedCallOverlay={() => {}}
                    pinnedSearchQuery="" onOpenProfile={() => {}} avatarUpdatedEvent={null} memberRoleColors={{}} serverMemberNicknames={names}
                    convType="server" servers={[{ id: cfg.server_id, server_id: cfg.server_id, name: cfg.server_name, owner_id: cfg.importer.user_id } as any]} onInviteJoin={() => {}} onInviteCodeClick={() => {}}
                    channelPermissions={ALL_PERMISSIONS} channelKeyMissing={false} channelKeyCoolingOff={false}
                    historyGaps={[]} historyStart onFillHistoryGap={async () => ({ shown: 0, progressed: false })}
                    myUserId={ME.user_id} onReport={() => {}}
                />
            </main>
        </div>
    );
};

const Roles: React.FC = () => (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--cl-deep)', color: 'var(--cl-text)' }}>
        <h2 style={{ margin: '18px 20px 10px', fontSize: 18, color: 'var(--cl-bright)' }}>Roles</h2>
        <div style={{ flex: 1, minHeight: 0 }}>
            <RolesTabContainer server={{ server_id: cfg.server_id, name: cfg.server_name, owner_id: cfg.importer.user_id } as any} token={ME.token} canManage />
        </div>
    </div>
);

const Settings: React.FC = () => (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--cl-deep)', color: 'var(--cl-text)', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: 'min(720px, 100% - 32px)', padding: '28px 0' }} className="pp-main">
            <h2 style={{ margin: '0 0 14px', fontSize: 20, color: 'var(--cl-bright)' }}>Profile</h2>
            <ProfileDiscordSection token={ME.token} />
        </div>
    </div>
);

const App: React.FC = () => {
    const view = q.get('view') ?? 'notice';
    const [messages, setMessages] = React.useState<any[] | null>(null);
    (window as any).__reload = async () => { setMessages(await loadChannel(cfg.channels.general)); };
    React.useEffect(() => { if (view === 'chat' || view === 'notice') void (window as any).__reload(); }, []);
    if (view === 'settings') return <Settings />;
    if (view === 'roles') return <Roles />;
    return (
        <>
            {messages ? <Chat messages={messages} /> : <div style={{ height: '100vh', background: 'var(--cl-abyss)' }} />}
            {view === 'notice' && <DiscordClaimNotices token={ME.token} userId={ME.user_id} changedTick={0} channelName={() => '#general'} />}
        </>
    );
};

(async () => {
    try { const r: any = await api(`/servers/${cfg.server_id}/channels`); const l = Array.isArray(r) ? r : r.channels ?? []; CHANNELS = l.filter((c: any) => c.kind === 'text'); } catch { /* keep the one channel */ }
    try { await secureLocalStore.hydrate(); } catch { /* */ }
    secureLocalStore.setItem('cipherline_user_id', ME.user_id);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
    (window as any).__booted = true;
})();
