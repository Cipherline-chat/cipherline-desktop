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
import '../src/styles/theme-light-kit.css';
import '../src/styles/layout-drift.css';
import '../src/styles/theme-light.css';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import { ServerChannelList } from '../src/components/server/ServerChannelList';
import { ServerContextPanel } from '../src/components/server/ServerContextPanel';
import { ToastProvider } from '../src/contexts/ToastContext';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, isLabelDividerStyle } from '@cipherline/shared';
import type { ChannelInfo, CategoryInfo, DividerInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * "All divider types can be placed anywhere and seen" (owner, 2026-11-24).
 * The REAL ServerChannelList / ServerContextPanel with an in-page fake API.
 * ONE divider style is placed in EVERY spot a channel or sub-category can go:
 *
 *   text list   top (first + last) · a category (first / between / last) ·
 *               a sub-category (first + last) · a category holding ONLY the divider
 *   Calls list  a Calls category (first / between / last) · a Calls category
 *               holding ONLY the divider · the top of the Calls list (first + last)
 *
 *   ?scene=text|calls   ?style=label|header|pill|text|line|dots|space   ?theme=dark|light
 *   &member=1           a member's view (no manage rights): they must see every one too
 *
 * Driven by harness/dividers-anywhere-shots.mjs.
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'text';
const style = (q.get('style') ?? 'label') as DividerInfo['style'];
const member = q.get('member') === '1';
void engine.setThemePreference((q.get('theme') ?? 'dark') as 'dark' | 'light', {} as any).catch(() => engine.applyTheme(themes.resolveTheme(q.get('theme') ?? 'dark')));

const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '',
} as ServerInfo;

const cat = (id: string, name: string, position: number, parent: string | null = null, kind: 'text' | 'huddle' = 'text'): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind, icon_name: null, parent_category_id: parent, icon_emoji: null });
const ch = (id: string, parent: string | null, position: number, kind: 'text' | 'huddle' = 'text'): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind, name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const div = (id: string, parent: string | null, position: number, list: 'text' | 'calls'): DividerInfo => ({
    divider_id: id, server_id: 's1', parent_category_id: parent, list_kind: list, position, style,
    label: isLabelDividerStyle(style) ? id : null, color: null,
});

const textCats = [cat('craft', 'Crafting', 1000), cat('wood', 'Woodworking', 2000, 'craft'), cat('quiet', 'Quiet corner', 2000), cat('events', 'Events', 3000)];
const textChannels = [
    ch('welcome', null, 1000), ch('general', null, 2000),
    ch('crafting-chat', 'craft', 1000), ch('joinery', 'wood', 1000), ch('build-nights', 'events', 1000),
];
const textDividers = [
    div('top-first', null, 500, 'text'), div('top-last', null, 9000, 'text'),
    div('craft-first', 'craft', 500, 'text'), div('craft-between', 'craft', 1500, 'text'), div('craft-last', 'craft', 9000, 'text'),
    div('wood-first', 'wood', 500, 'text'), div('wood-last', 'wood', 9000, 'text'),
    div('quiet-alone', 'quiet', 1000, 'text'),
];

const callsCats = [cat('hang', 'Hangouts', 1000, null, 'huddle'), cat('work', 'Work rooms', 2000, null, 'huddle')];
const callsChannels = [ch('lounge', 'hang', 1000, 'huddle'), ch('games', 'hang', 3000, 'huddle')];
const callsDividers = [
    div('hang-first', 'hang', 500, 'calls'), div('hang-between', 'hang', 2000, 'calls'), div('hang-last', 'hang', 9000, 'calls'),
    div('work-alone', 'work', 1000, 'calls'),
    div('top-first', null, 500, 'calls'), div('top-last', null, 9000, 'calls'),
];

(window as any).__requests = [] as Array<{ method: string; url: string; body: unknown }>;
axios.defaults.adapter = async (config) => {
    const url = String(config.url ?? '');
    const method = (config.method ?? 'get').toUpperCase();
    (window as any).__requests.push({ method, url, body: config.data ? JSON.parse(config.data) : null });
    let data: unknown = [];
    if (/\/me\/permissions$/.test(url)) data = { permissions: ALL_PERMISSIONS.toString() };
    else if (method !== 'GET') data = { ok: true };
    return { data, status: 200, statusText: 'OK', headers: {}, config } as any;
};

function Frame() {
    const [divs, setDivs] = React.useState<DividerInfo[]>(scene === 'calls' ? callsDividers : textDividers);
    React.useEffect(() => { (window as unknown as { __ready: boolean }).__ready = true; }, []);
    const frame: React.CSSProperties = {
        width: 280, height: 'calc(100vh - 40px)', background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
        borderRadius: 16, overflow: 'auto', display: 'flex', flexDirection: 'column',
    };
    if (scene === 'calls') {
        const noop = () => {};
        const NONE: never[] = [];
        const EMPTY = {};
        const SET = new Set<string>();
        return (
            <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
                <div style={frame} data-frame>
                    <ServerContextPanel
                        server={SERVER} channel={ch('general', null, 1)} token="harness" userId={member ? 'member' : 'owner'}
                        myPermissions={member ? DEFAULT_EVERYONE_PERMISSIONS : ALL_PERMISSIONS}
                        allChannels={callsChannels} categories={callsCats} dividers={divs}
                        onApplyDividers={(fn: (l: DividerInfo[]) => DividerInfo[]) => setDivs(fn)}
                        voiceParticipants={EMPTY} friendStatuses={EMPTY} myStatus="online" myCurrentGame={null}
                        globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                        huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                        onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                    />
                </div>
            </div>
        );
    }
    return (
        <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
            <div style={frame} data-frame>
                <ServerChannelList
                    server={SERVER} channels={textChannels} categories={textCats} dividers={divs} loading={false}
                    activeChannelId="joinery" onSelectChannel={() => {}}
                    token={member ? null : 'harness'} userId={member ? null : 'owner'}
                    myPermissions={member ? 0n : ALL_PERMISSIONS}
                    unreadCounts={{}} mentionCounts={{}} serverNotifMode="all"
                    onMarkChannelRead={() => {}} onDeleteCategoryApi={async () => {}} onDeleteChannelApi={async () => {}}
                />
            </div>
        </div>
    );
}

loadWebFonts();
createRoot(document.getElementById('root')!).render(<ToastProvider><Frame /></ToastProvider>);
