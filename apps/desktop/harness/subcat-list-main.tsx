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
import '../src/styles/layout-drift.css';
import { ServerChannelList } from '../src/components/server/ServerChannelList';
import { DividerFormDialog } from '../src/components/server/DividerFormDialog';
import { CategoryFormDialog } from '../src/components/server/CategoryFormDialog';
import { ServerContextPanel } from '../src/components/server/ServerContextPanel';
import { ToastProvider } from '../src/contexts/ToastContext';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, Permissions } from '@cipherline/shared';
import type { ChannelInfo, CategoryInfo, DividerInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * Sub-categories + dividers (owner-approved concept: "Maker Collective").
 * The REAL components in a sidebar frame, with an in-page fake API (axios
 * adapter) so the permission-aware dialogs render fully.
 *
 *   ?scene=member          a member's view (no manage rights)
 *   ?scene=manager         MANAGE_CHANNELS: every divider drawn, would-be-hidden ones marked (eye-off), never dimmed
 *   ?scene=colour          a labelled divider in a custom colour

 *   ?scene=calls           the Calls (huddle) panel with dividers; &member=1 = a member's view
 *   ?scene=styles          manager view with every label style + an unknown style (draws as a line)
 *   ?scene=dialog&style=label|line|dots|space[&new=1]   the divider dialog
 *   ?scene=subcat-dialog   "Create sub-category" in Crafting
 *
 * Driven by harness/subcat-list-shots.mjs.
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'member';

const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '',
} as ServerInfo;

const cat = (id: string, name: string, position: number, parent: string | null = null, icon_name: string | null = null): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind: 'text', icon_name, parent_category_id: parent, icon_emoji: null });
const ch = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind: 'text', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const div = (id: string, parent: string | null, position: number, style: DividerInfo['style'], label: string | null = null, extra: Partial<DividerInfo> = {}): DividerInfo =>
    ({ divider_id: id, server_id: 's1', parent_category_id: parent, position, style, label, color: null, ...extra });

const manager = scene !== 'member' && !(scene === 'calls' && q.get('member'));
const categories: CategoryInfo[] = [
    cat('craft', 'Crafting', 1000),
    cat('wood', 'Woodworking', 2000, 'craft', 'Hammer'),
    cat('metal', 'Metalwork', 3000, 'craft', 'Cog'),
    cat('paper', 'Paper', 4000, 'craft', 'FileText'),
    cat('print', '3D Printing', 5000, 'craft', 'Package'),
    cat('events', 'Events', 2000),
    // A PRIVATE category with a sub-category (managers only): the delete-blocked case.
    ...(manager ? [cat('staff', 'Staff', 3000), cat('modtools', 'Mod tools', 2000, 'staff', 'Wrench')] : []),
];
const channels: ChannelInfo[] = [
    ch('welcome', null, 1000), ch('announcements', null, 2000),
    ch('general', null, 4000), ch('show-and-tell', null, 5000),
    ch('crafting-chat', 'craft', 1000),
    ch('joinery', 'wood', 1000), ch('finishes', 'wood', 2000),
    ch('welding', 'metal', 1000),
    ch('origami', 'paper', 1000), ch('bookbinding', 'paper', 2000),
    ch('print-help', 'print', 1000), ch('slicer-settings', 'print', 2000),
    ch('build-nights', 'events', 1000), ch('off-topic', 'events', 3000),
    ...(manager ? [ch('mod-chat', 'staff', 1000), ch('reports', 'modtools', 1000)] : []),
];
const dividers: DividerInfo[] = [
    div('community', null, 3000, 'label', 'Community'),
    div('closing', 'craft', 9000, 'line'),
    div('dots', 'events', 2000, 'dots'),
    // A labelled divider over a section this member cannot see (its channels
    // are simply absent from their list): members never see it.
    div('staffonly', null, 9000, 'label', 'Staff only'),
    ...(scene === 'styles' ? [
        div('s-header', null, 1500, 'header', 'Start here'),
        div('s-pill', null, 2500, 'pill', 'Chat', { color: '#25e0c8' }),
        div('s-text', null, 4500, 'text', 'Showcase', { color: '#a78bfa' }),
        div('s-unknown', 'events', 1500, 'wavy' as DividerInfo['style']),
    ] : []),
    ...(scene === 'colour' ? [div('tools', 'wood', 1500, 'label', 'Tools', { color: '#25e0c8' })] : []),
];

// ── Calls panel scene ───────────────────────────────────────────────────────
const hcat = (id: string, name: string, position: number): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind: 'huddle', icon_name: null, parent_category_id: null, icon_emoji: null });
const huddle = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind: 'huddle', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const callsCats: CategoryInfo[] = [hcat('hang', 'Hangouts', 1000), hcat('work', 'Work rooms', 2000)];
const callsChannels: ChannelInfo[] = [
    huddle('lounge', 'hang', 1000), huddle('games', 'hang', 3000), huddle('standup', 'work', 1000), huddle('pairing', 'work', 2000),
];
const cdiv = (id: string, parent: string | null, position: number, style: DividerInfo['style'], label: string | null = null, color: string | null = null): DividerInfo =>
    ({ divider_id: id, server_id: 's1', parent_category_id: parent, list_kind: 'calls', position, style, label, color });
const callsDividers: DividerInfo[] = [
    cdiv('c-chill', 'hang', 2000, 'header', 'After hours', '#a78bfa'),
    cdiv('c-line', 'work', 1500, 'line'),
    cdiv('c-trail', 'work', 9000, 'pill', 'Nothing below', '#25e0c8'),
    // A text-list divider must never be drawn in the Calls panel.
    { divider_id: 't-1', server_id: 's1', parent_category_id: null, list_kind: 'text', position: 1, style: 'label', label: 'TEXT LIST ONLY', color: null },
];

// ── In-page fake API ────────────────────────────────────────────────────────
const VIEW = Permissions.VIEW_CHANNEL;
const roles = [
    { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(), color: -1 },
    { role_id: 'mods', name: 'Moderators', position: 5, is_everyone: false, permissions: '0', color: 0x25e0c8 },
];
const overridesFor: Record<string, unknown[]> = {
    staff: [
        { target_kind: 'role', target_id: 'ev', allow_bits: '0', deny_bits: VIEW.toString() },
        { target_kind: 'role', target_id: 'mods', allow_bits: VIEW.toString(), deny_bits: '0' },
    ],
};
(window as any).__requests = [] as Array<{ method: string; url: string; body: unknown }>;
axios.defaults.adapter = async (config) => {
    const url = String(config.url ?? '');
    const method = (config.method ?? 'get').toUpperCase();
    (window as any).__requests.push({ method, url, body: config.data ? JSON.parse(config.data) : null });
    let data: unknown = [];
    if (/\/roles$/.test(url)) data = roles;
    else if (/\/me\/permissions$/.test(url)) data = { permissions: ALL_PERMISSIONS.toString() };
    else if (/\/categories\/([^/]+)\/overrides$/.test(url)) data = overridesFor[url.match(/\/categories\/([^/]+)\/overrides$/)![1]] ?? [];
    else if (method !== 'GET') data = { ok: true };
    return { data, status: 200, statusText: 'OK', headers: {}, config } as any;
};

function Frame() {
    const [active, setActive] = React.useState<string | null>('joinery');
    const [callsDivs, setCallsDivs] = React.useState<DividerInfo[]>([...dividers, ...callsDividers]);
    React.useEffect(() => { (window as unknown as { __ready: boolean }).__ready = true; }, []);
    if (scene === 'dialog') {
        const style = (q.get('style') ?? 'label') as DividerInfo['style'];
        return (
            <DividerFormDialog
                divider={q.get('new') ? null : div('x', 'craft', 1000, style, ['label', 'header', 'pill', 'text'].includes(style) ? 'Community' : null)}
                containerName="Crafting"
                onClose={() => {}}
                onSubmit={() => {}}
                onDelete={() => {}}
            />
        );
    }
    if (scene === 'calls') {
        const noop = () => {};
        const NONE: never[] = [];
        const EMPTY = {};
        const SET = new Set<string>();
        return (
            <div style={{ padding: 28, display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: 300, height: 760, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)', borderRadius: 16, overflow: 'auto' }}>
                    <ServerContextPanel
                        server={SERVER} channel={ch('general', null, 1)} token="harness" userId={manager ? 'owner' : 'member'}
                        myPermissions={manager ? ALL_PERMISSIONS : DEFAULT_EVERYONE_PERMISSIONS}
                        allChannels={callsChannels} categories={callsCats} dividers={callsDivs}
                        onApplyDividers={(fn: (l: DividerInfo[]) => DividerInfo[]) => setCallsDivs(fn)}
                        voiceParticipants={EMPTY} friendStatuses={EMPTY} myStatus="online" myCurrentGame={null}
                        globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                        huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                        onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                    />
                </div>
            </div>
        );
    }
    if (scene === 'subcat-dialog') {
        return (
            <CategoryFormDialog
                serverId="s1"
                token="harness"
                parentCategoryId="craft"
                kind="text"
                ownerUserId="owner"
                currentUserId="owner"
                myPermissions={ALL_PERMISSIONS}
                categories={categories}
                channels={channels}
                onClose={() => {}}
                onSaved={() => {}}
            />
        );
    }
    return (
        <div style={{ padding: 28, display: 'flex', justifyContent: 'center' }}>
            <div
                style={{
                    width: 280, height: 900, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
                    borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    boxShadow: '0 20px 60px rgba(0,0,0,.45)',
                }}
            >
                <ServerChannelList
                    server={SERVER}
                    channels={channels}
                    categories={categories}
                    dividers={dividers}
                    loading={false}
                    activeChannelId={active}
                    onSelectChannel={(c) => setActive(c.channel_id)}
                    token={manager ? 'harness' : null}
                    userId={manager ? 'owner' : null}
                    myPermissions={manager ? ALL_PERMISSIONS : 0n}
                    unreadCounts={{ general: 3, 'print-help': 12, origami: 3, bookbinding: 1 }}
                    mentionCounts={{ bookbinding: 1 }}
                    serverNotifMode="all"
                    onMarkChannelRead={() => {}}
                    onDeleteCategoryApi={async () => {}}
                    onDeleteChannelApi={async () => {}}
                />
            </div>
        </div>
    );
}

loadWebFonts();
createRoot(document.getElementById('root')!).render(<ToastProvider><Frame /></ToastProvider>);
