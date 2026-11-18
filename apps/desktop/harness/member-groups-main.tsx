/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import { Pin } from 'lucide-react';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { ServerContextPanel } from '../src/components/server/ServerContextPanel';
import { ClButton } from '../src/components/ClButton';
import { ToastProvider } from '../src/contexts/ToastContext';
import secureLocalStore from '../src/utils/secureLocalStore';
import { memberGroupsCollapsedKey } from '../src/utils/memberGroupCollapse';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import type { ChannelInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * Collapsible member-list groups: the REAL ServerContextPanel against an
 * in-page fake roster API, plus the channel-header member-list button (the
 * same ClButton JSX ChatPane renders next to Pin).
 *
 *   ?seed=role:mods,offline   pre-store collapsed group ids for this account+server (a "restart")
 *   ?w=<px>                   right panel width (default 300)
 *   ?long=1                   a few long names / nicknames / many role groups, to stress ellipsis
 *   ?stalehidden=1            legacy cipherline_member_list_hidden_<uid>='1' in the store: the list must still show
 *   ?broken=1                 positive control: a deliberately overflowing child inside the panel
 *   ?deleted=1                the stored list also names a role that no longer exists (prune check)
 *
 * window.__remount() unmounts and remounts the panel (re-read from the store).
 * Driven by harness/member-groups-shots.mjs.
 */
const q = new URLSearchParams(location.search);
const ME = 'me';
/** ?w=240 sets the right panel's width (the Dashboard minimum is what is under test). */
const PANEL_W = Number(q.get('w') ?? 300);

const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '',
} as ServerInfo;
const CHANNEL: ChannelInfo = {
    channel_id: 'general', server_id: 's1', kind: 'text', name: 'general', topic: null, icon_emoji: null, icon_name: null,
    position: 1000, parent_category_id: null, active_call_session_id: null, member_limit: null, max_calls: null,
};

const roles = [
    { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, hoisted: false, color: -1, permissions: DEFAULT_EVERYONE_PERMISSIONS.toString() },
    { role_id: 'mods', name: 'Moderators', position: 5, is_everyone: false, hoisted: true, color: 0x25e0c8, permissions: '0' },
    { role_id: 'artists', name: 'Artists', position: 3, is_everyone: false, hoisted: true, color: 0xa78bfa, permissions: '0' },
];
let n = 0;
const member = (name: string, status: string, role_ids: string[] = []) => ({
    user_id: name === 'Dawson' ? ME : `u${++n}`, username: name, discriminator: 1000 + n, nickname: null, avatar_url: null,
    status, joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids,
});
// Roster-only presence (no friend entry, presenceAuthoritative=false): the idle rows (Sam, Pat)
// resolve to Offline in this fixture. Counts as shot: Moderators 3 / Artists 2 / Online 3 / Offline 8.
const members = [
    member('Dawson', 'online', ['mods']), member('Riley', 'online', ['mods']), member('Sam', 'idle', ['mods']), member('Noor', 'dnd', ['mods']),
    member('Ari', 'online', ['artists']), member('Kit', 'online', ['artists']),
    member('Jules', 'online'), member('Mika', 'online'), member('Pat', 'idle'), member('Quinn', 'online'),
    ...(q.get('long') ? [member('Bartholomew-Alexander Longname-Smythe', 'online', ['mods']), member('xX_the_extremely_long_username_without_spaces_Xx', 'online'), member('Wolfgang Amadeus Mozart The Third', 'dnd', ['artists'])] : []),
    member('Avery', 'offline'), member('Blake', 'offline', ['mods']), member('Casey', 'offline'), member('Devon', 'offline', ['artists']),
    member('Emery', 'offline'), member('Finley', 'offline'),
];
axios.defaults.adapter = async (config) => {
    const url = String(config.url ?? '');
    let data: unknown = [];
    if (/\/servers\/s1\/members$/.test(url)) data = members;
    else if (/\/servers\/s1\/roles$/.test(url)) data = roles;
    else if (/\/me\/permissions$/.test(url)) data = { permissions: DEFAULT_EVERYONE_PERMISSIONS.toString() };
    return { data, status: 200, statusText: 'OK', headers: {}, config } as any;
};

const noop = () => {};
const NONE: never[] = [];
const EMPTY = {};
const SET = new Set<string>();

function Frame() {
    const [mounted, setMounted] = React.useState(true);
    const [inCall, setInCall] = React.useState(q.get('call') === '1');
    React.useEffect(() => {
        (window as any).__remount = () => new Promise<void>(r => { setMounted(false); setTimeout(() => { setMounted(true); setTimeout(r, 50); }, 50); });
        (window as any).__stored = () => secureLocalStore.getItem(memberGroupsCollapsedKey(ME, 's1'));
        (window as any).__setCall = (v: boolean) => setInCall(v);
        (window as any).__ready = true;
    }, []);
    const channels = q.get('voice') ? [CHANNEL, { ...CHANNEL, channel_id: 'lounge', name: 'Lounge', kind: 'voice' } as ChannelInfo] : [CHANNEL];
    return (
        <div style={{ padding: 24, display: 'flex', gap: 8, alignItems: 'stretch', height: 900, boxSizing: 'content-box' }}>
            <div id="chat" style={{ flex: 1, minWidth: 0, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)', borderRadius: 16, display: 'flex', flexDirection: 'column' }}>
                {/* Channel header: the server-channel buttons exactly as ChatPane renders them. */}
                <div id="hdr" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', borderBottom: '1px solid var(--cl-border)' }}>
                    <span style={{ flex: 1, color: 'var(--cl-text)', fontWeight: 700, fontSize: 15 }}># general</span>
                    <ClButton icon onClick={noop} tooltip="Pinned messages" variant="ghost" active={false}>
                        <Pin className="w-5 h-5" />
                    </ClButton>
                </div>
                <div style={{ flex: 1, padding: '16px 18px', color: 'var(--cl-muted)', fontSize: 14, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10 }}>
                    <div><b style={{ color: '#25e0c8' }}>Riley</b> &nbsp;anyone up for build night?</div>
                    <div><b style={{ color: '#a78bfa' }}>Ari</b> &nbsp;yes! bringing the new printer</div>
                    <div><b style={{ color: 'var(--cl-text)' }}>Jules</b> &nbsp;same time as last week?</div>
                </div>
            </div>
            {(
                <div id="panel" style={{ width: PANEL_W, flexShrink: 0, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)', borderRadius: 16, overflow: 'auto' }}>
                    {inCall && (
                        /* Stand-in for the call section (#call-video-root / #call-sidebar-root in
                           Dashboard): the real CallPane needs LiveKit and is not mounted here. */
                        <div id="fake-call" style={{ margin: 8, padding: 12, borderRadius: 12, background: 'rgba(37,224,200,.08)', boxShadow: 'inset 0 0 0 1px rgba(37,224,200,.35)', color: 'var(--cl-text)', fontSize: 13 }}>
                            <div style={{ fontWeight: 700, color: '#25e0c8', marginBottom: 6 }}>● In call · Lounge</div>
                            <div style={{ color: 'var(--cl-muted)' }}>Dawson, Riley, Ari</div>
                        </div>
                    )}
                    {q.get('broken') && <div id="broken" style={{ width: 600, height: 20, background: 'red' }}>overflow</div>}
                    {mounted && (
                        <ServerContextPanel
                            server={SERVER} channel={CHANNEL} token="harness" userId={ME}
                            myPermissions={DEFAULT_EVERYONE_PERMISSIONS}
                            allChannels={channels} categories={NONE} dividers={NONE}
                            voiceParticipants={EMPTY} friendStatuses={EMPTY} presenceAuthoritative={false}
                            myStatus="online" myCurrentGame={null}
                            globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                            huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                            onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', ME);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    if (q.get('stalehidden')) secureLocalStore.setItem(`cipherline_member_list_hidden_${ME}`, '1');
    const seed = q.get('seed');
    if (seed) {
        const ids = seed.split(',').filter(Boolean);
        if (q.get('deleted')) ids.push('role:deleted-role');
        secureLocalStore.setItem(memberGroupsCollapsedKey(ME, 's1'), JSON.stringify(ids));
    }
    (window as any).__accountReady = secureLocalStore.isAccountReady(ME);
    loadWebFonts();
    createRoot(document.getElementById('root')!).render(<ToastProvider><Frame /></ToastProvider>);
})();
