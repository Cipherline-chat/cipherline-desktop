/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { ServerChannelList } from '../src/components/server/ServerChannelList';
import { ServerContextPanel } from '../src/components/server/ServerContextPanel';
import { ToastProvider } from '../src/contexts/ToastContext';
import { ChannelMuteProvider, type ChannelMuteApi } from '../src/contexts/ChannelMuteContext';
import { muteFor, unmute, isMuted, type MuteMap } from '../src/utils/channelMute';
import { applyTheme } from '../src/theme/engine';
import { THEMES } from '../src/theme/themes';
import { ALL_PERMISSIONS } from '@cipherline/shared';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * Channel mute (utils/channelMute.ts). The REAL ServerChannelList / Calls panel
 * with an in-page mute API (same pure functions Dashboard's hook uses).
 *   ?theme=dark|light   ?scene=list|calls   ?seed=1  (pre-muted: a channel 1 h, a category until unmuted)
 * Driven by harness/channel-mute-shots.mjs.
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'list';
applyTheme(THEMES[(q.get('theme') === 'light' ? 'light' : 'dark')]);
document.body.style.background = 'var(--cl-bg, #070B14)';

const SERVER = { server_id: 's1', name: 'Maker Collective', description: null, owner_user_id: 'owner', created_at: '' } as unknown as ServerInfo;
const cat = (id: string, name: string, position: number, kind = 'text'): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind, icon_name: null, parent_category_id: null, icon_emoji: null }) as CategoryInfo;
const ch = (id: string, parent: string | null, position: number, kind = 'text'): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind, name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
}) as ChannelInfo;
const categories = [cat('craft', 'Crafting', 1000), cat('events', 'Events', 2000), cat('hang', 'Hangouts', 3000, 'huddle')];
const channels = [
    ch('welcome', null, 1000), ch('general', null, 2000),
    ch('joinery', 'craft', 1000), ch('finishes', 'craft', 2000), ch('welding', 'craft', 3000),
    ch('build-nights', 'events', 1000), ch('off-topic', 'events', 2000),
    ch('lounge', 'hang', 1000, 'huddle'), ch('games', 'hang', 2000, 'huddle'),
];

axios.defaults.adapter = async (config) => ({ data: [], status: 200, statusText: 'OK', headers: {}, config } as any);

function Frame() {
    const [mutes, setMutes] = React.useState<MuteMap>(() => q.get('seed') ? {
        finishes: { until: Date.now() + 60 * 60_000 },
        events: { until: null },
    } : {});
    const [active, setActive] = React.useState<string | null>('general');
    const now = Date.now();
    const api: ChannelMuteApi = {
        mutes, now,
        isMuted: id => isMuted(mutes, id, now),
        mute: (id, d) => setMutes(m => muteFor(m, id, d, Date.now())),
        unmute: id => setMutes(m => unmute(m, id)),
    };
    React.useEffect(() => { (window as any).__ready = true; }, []);
    const noop = () => {}; const NONE: never[] = []; const EMPTY = {}; const SET = new Set<string>();
    return (
        <ChannelMuteProvider value={api}>
            <ToastProvider>
                <div style={{ padding: 28, display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: 300, height: 620, background: 'var(--cl-deep)', border: '1px solid var(--cl-border)', borderRadius: 16, overflow: 'auto' }}>
                        {scene === 'calls' ? (
                            <ServerContextPanel
                                server={SERVER} channel={ch('general', null, 1)} token="harness" userId="owner" myPermissions={ALL_PERMISSIONS}
                                allChannels={channels.filter(c => c.kind !== 'text')} categories={categories.filter(c => c.kind === 'huddle')} dividers={NONE}
                                voiceParticipants={EMPTY} friendStatuses={EMPTY} myStatus="online" myCurrentGame={null}
                                globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
                                huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
                                onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
                            />
                        ) : (
                            <ServerChannelList
                                server={SERVER} channels={channels.filter(c => c.kind === 'text')} categories={categories.filter(c => c.kind === 'text')}
                                loading={false} activeChannelId={active} onSelectChannel={c => setActive(c.channel_id)}
                                token="harness" userId="owner" myPermissions={ALL_PERMISSIONS}
                                unreadCounts={{ joinery: 4, finishes: 9, welding: 2, 'build-nights': 5, general: 0 }}
                                mentionCounts={{ welding: 1 }}
                                serverNotifMode="all" onMarkChannelRead={noop}
                            />
                        )}
                    </div>
                </div>
            </ToastProvider>
        </ChannelMuteProvider>
    );
}
createRoot(document.getElementById('root')!).render(<Frame />);
