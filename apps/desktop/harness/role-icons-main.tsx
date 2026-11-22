/* eslint-disable -- harness, not shipped */
/**
 * ROLE ICONS + gradient role colours against an ISOLATED local API (own Postgres, Redis, MinIO on loopback; never the
 * shared dev stack, staging or prod). Everything role-side is REAL: the roster (GET /servers/:id/members + /roles), the
 * member list (ServerContextPanel), ChatPane's author names, Server Settings > Roles (RolesTabContainer + the new icon
 * picker / gradient control, uploading through /attachments/initiate + MinIO + PUT /roles/:rid/icon), the profile card's
 * role pills, and role icon images downloaded through /attachments/emoji-downloads and decrypted in the page.
 *
 * One stand-in: chat message CONTENT. ChatPane is handed a few plain text messages "from" the real test accounts (the
 * sender-key engine is not part of this feature; the server never sees message content either way). Author name
 * colours/gradients come from the real roster exactly as Dashboard wires them.
 *
 * Boot: #<base64 JSON from role-icons-setup.mjs>. ?as=maya|jules|... ?view=server|roles|profile ?theme=dark|light|hc-dark
 */
import { createRoot } from 'react-dom/client';
import React from 'react';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/formatting.css';
import '../src/styles/layout-drift.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/theme-light.css';
import '../src/styles/role-style.css';
import '../src/styles/theme-contrast.css';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import ChatPane from '../src/components/ChatPane';
import { ServerContextPanel } from '../src/components/server/ServerContextPanel';
import { RolesTabContainer } from '../src/components/server/roles/RolesTabContainer';
import { ProfileModal } from '../src/components/ProfileModal';
import { ToastProvider } from '../src/contexts/ToastContext';
import { useRetentionPolicy } from '../src/hooks/useRetentionPolicy';
import secureLocalStore from '../src/utils/secureLocalStore';
import { API_BASE } from '../src/constants';
import { refreshRoster } from '../src/utils/serverRosterCache';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';

loadWebFonts();
const q = new URLSearchParams(location.search);
const themeParam = q.get('theme') ?? 'dark';
{
    const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
    if (setPref) void setPref(themeParam, {}); else engine.applyTheme(themes.resolveTheme(themeParam));
}

// ── Safety: the isolated local API or nothing ────────────────────────────
const cfg = JSON.parse(atob(decodeURIComponent(location.hash.slice(1))));
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE) || API_BASE !== cfg.api) {
    document.body.textContent = `REFUSING TO START: API_BASE is ${API_BASE}, expected the isolated local API ${cfg.api}`;
    throw new Error('wrong API target');
}
const AS = q.get('as') ?? 'maya';
(window as any).__AS = AS;
(window as any).__HARNESS = cfg;
const ME = cfg[AS];
// No default Authorization header: the app never sets one, and it would break the presigned media GETs.
(window as any).electronAPI = { platform: 'linux', openExternal: async () => {} };

const SERVER: any = {
    server_id: cfg.server_id, name: cfg.server_name, description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: cfg.maya.user_id, created_at: '',
};
const CHANNEL: any = {
    channel_id: cfg.channels.general, server_id: cfg.server_id, kind: 'text', name: 'general', topic: null, icon_emoji: null, icon_name: null,
    position: 1000, parent_category_id: null, active_call_session_id: null, member_limit: null, max_calls: null,
};
const PEOPLE = ['maya', 'riley', 'ari', 'sam', 'jules'] as const;
const NAMES: Record<string, string> = Object.fromEntries(PEOPLE.map(p => [cfg[p].user_id, p]));
const LINES: Array<[typeof PEOPLE[number], string, number]> = [
    ['maya', 'Welcome to the collective! Roles got a glow-up today.', 50],
    ['riley', 'Moderators have a shield now. Very official.', 40],
    ['ari', 'The Artists gradient is gorgeous, gold into pink.', 30],
    ['sam', 'Can confirm, the member list looks great.', 20],
    ['jules', 'No roles for me yet, just plain old me.', 10],
];
const MESSAGES = LINES.map(([who, text, ago], i) => ({
    id: `m${i}`, content: { client_msg_id: `c${i}`, type: 'text', text }, sender_user_id: cfg[who].user_id,
    sender_device_id: cfg[who].device_id, timestamp: new Date(Date.now() - ago * 60_000).toISOString(), conversation_id: cfg.channels.general,
}));

// Presence normally arrives over the WS (not mounted here): everyone online, so names are not dimmed.
const ONLINE = Object.fromEntries(PEOPLE.map(p => [cfg[p].user_id, { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null }]));
const noop = () => {};
const NONE: never[] = [];
const EMPTY = {};
const SET = new Set<string>();

const Server: React.FC = () => {
    const retention = useRetentionPolicy(ME.user_id);
    const [roleColors, setRoleColors] = React.useState<Record<string, string | null>>({});
    const [profileFor, setProfileFor] = React.useState<{ userId: string; x: number; y: number } | null>(null);
    (window as any).__openProfile = (name: string) => setProfileFor({ userId: cfg[name].user_id, x: window.innerWidth - 320, y: 120 });
    const channel = { ...CHANNEL, my_permissions: ALL_PERMISSIONS.toString() };
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
            <nav style={{ width: 72, flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px', gap: 10 }}>
                <main id="chat" style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--cl-abyss)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ChatPane
                        bundleReady activeChat={{ id: CHANNEL.channel_id }} activeChannel={channel} emojisChangedEvent={null}
                        serverChannels={[CHANNEL]} serverCategories={[]} onNavigateToChannel={noop}
                        messages={MESSAGES as any} messagesFetching={false} onMessageSent={noop} onChannelMessageSent={noop} onPatchSentMessage={noop}
                        typingUsers={new Set()} sendTypingEvent={noop} readReceipts={{}} sendReadReceipt={noop} showReadReceipts
                        activeCall={null} onCallChange={noop} friendStatuses={{}} retention={retention}
                        serverSavedIds={[]} pinnedMsgIds={[]} onPinMessage={noop} onUnpinMessage={noop}
                        onServerSaveMessage={noop} onServerUnsaveMessage={noop}
                        pinnedSidebarExpanded={false} onTogglePinnedSidebar={noop} channelSearchOpen={false} onOpenPinnedCallOverlay={noop}
                        pinnedSearchQuery="" onOpenProfile={noop} avatarUpdatedEvent={null} memberRoleColors={roleColors} serverMemberNicknames={NAMES}
                        convType="server" servers={[{ id: cfg.server_id, server_id: cfg.server_id, name: cfg.server_name, owner_id: cfg.maya.user_id } as any]} onInviteJoin={noop} onInviteCodeClick={noop}
                        channelPermissions={ALL_PERMISSIONS} channelKeyMissing={false} channelKeyCoolingOff={false}
                        historyGaps={[]} historyStart onFillHistoryGap={async () => ({ shown: 0, progressed: false })}
                        myUserId={ME.user_id} onReport={noop}
                    />
                </main>
                <aside id="panel" style={{ width: 280, flex: 'none', background: 'var(--cl-deep)', border: '1px solid var(--cl-border)', borderRadius: 16, overflow: 'auto' }}>
                    <ServerContextPanel
                        server={SERVER} channel={CHANNEL} token={ME.token} userId={ME.user_id}
                        myPermissions={DEFAULT_EVERYONE_PERMISSIONS}
                        allChannels={[CHANNEL]} categories={NONE} dividers={NONE}
                        voiceParticipants={EMPTY} friendStatuses={ONLINE} presenceAuthoritative={true}
                        myStatus="online" myCurrentGame={null}
                        globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                        huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                        onOpenProfile={(userId: string, at: { x: number; y: number }) => setProfileFor({ userId, ...at })}
                        onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                        onMemberRoleColorsChange={setRoleColors}
                    />
                </aside>
            </div>
            {profileFor && (
                <ProfileModal
                    userId={profileFor.userId} onClose={() => setProfileFor(null)} token={ME.token} currentUserId={ME.user_id}
                    friendStatuses={{}} serverId={cfg.server_id} anchor={{ x: profileFor.x, y: profileFor.y }}
                />
            )}
        </div>
    );
};

const Roles: React.FC = () => (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--cl-deep)', color: 'var(--cl-text)' }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: 20 }}>
            <RolesTabContainer server={SERVER} token={ME.token} canManage={true} />
        </div>
    </div>
);

const App: React.FC = () => (q.get('view') === 'roles' ? <Roles /> : <Server />);

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', ME.user_id);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    void refreshRoster(cfg.server_id, ME.token).catch(() => {});
    createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
    (window as any).__booted = true;
})();
