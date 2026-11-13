/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import axios from 'axios';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { moveVisiblePin, pinKey, type PinnedHomeItem } from '../src/utils/homePins';

/**
 * Home pins reorder harness: the REAL HomePanel (and so the real PinCard +
 * HomePinsGrid) with stubbed data, its pins held in local state and reordered
 * through utils/homePins' moveVisiblePin exactly like Dashboard does.
 *   window.__pins()  → current pin keys, in order (for the shots script)
 */
loadWebFonts();

const reply = (config: any, data: any, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    if (url.startsWith('/billing/status')) return reply(config, { subscription_status: 'active', effective_status: 'active', has_subscription: true });
    if (url.startsWith('/auth/me')) return reply(config, { user_id: 'u-me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson' });
    return reply(config, Array.isArray(config.data) ? [] : {});
};
(window as any).electronAPI = new Proxy({}, {
    get(_t, prop: string) {
        if (['secureKvOpen', 'secureKvSeal', 'getLocalMasterKeyStatus', 'then'].includes(prop)) return undefined;
        if (prop === 'platform') return 'win32';
        if (/^on[A-Z]/.test(prop)) return () => () => {};
        return () => Promise.resolve(undefined);
    },
});

const NOW = Date.now();
const MIN = 60_000;
const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira', other_user_id: 'user-mira', avatar_url: null, last_message_at: new Date(NOW - 4 * MIN).toISOString() },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew', avatar_url: null, last_message_at: new Date(NOW - 50 * MIN).toISOString() },
    { conversation_id: 'c3', type: 'dm', title: 'Jonas', other_user_id: 'user-jonas', avatar_url: null, last_message_at: new Date(NOW - 5 * 3600_000).toISOString() },
];
const servers = [{ server_id: 'S1', name: 'Neon Guild', role: 'owner' }, { server_id: 'S2', name: 'Design Team', role: 'member' }];
const serverChannels = {
    S1: [{ channel_id: 'n1', name: 'raid-planning', kind: 'text', type: 'text', server_id: 'S1' }],
    S2: [{ channel_id: 'd1', name: 'crit', kind: 'text', type: 'text', server_id: 'S2' }],
};
const INITIAL: PinnedHomeItem[] = [
    { type: 'conversation', id: 'c1' },
    { type: 'server', serverId: 'S1' },
    { type: 'channel', channelId: 'n1', serverId: 'S1' },
    { type: 'conversation', id: 'c2' },
    { type: 'server', serverId: 'S2' },
    { type: 'conversation', id: 'c3' },
    { type: 'channel', channelId: 'd1', serverId: 'S2' },
];
const noop = () => {};

async function boot() {
    await secureLocalStore.hydrate();
    const [{ ToastProvider }, { UpdateProvider }, { NotificationProvider }, { SubscriptionProvider }, { HomePanel }] = await Promise.all([
        import('../src/contexts/ToastContext'), import('../src/contexts/UpdateContext'),
        import('../src/contexts/NotificationContext'), import('../src/contexts/SubscriptionContext'),
        import('../src/components/HomePanel'),
    ]);

    const App: React.FC = () => {
        const [pins, setPins] = useState(INITIAL);
        (window as any).__pins = () => pins.map(pinKey);
        return (
            <div data-layout="drift" className="w-screen h-screen flex bg-cl-abyss text-white overflow-hidden font-sans">
                <div className="app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    <HomePanel
                        userId="u-me" displayName="Dawson" token="harness-token"
                        conversations={conversations}
                        unreadCounts={{ c1: 3, c2: 1 }} mentionCounts={{ c1: 1 }}
                        lastActivityAt={{ c1: NOW - 4 * MIN, c2: NOW - 50 * MIN }}
                        presence={{ 'user-mira': true }}
                        friends={{ accepted: [{ user_id: 'user-mira', display_name: 'Mira', username: 'mira' }] }}
                        servers={servers as any} serverChannels={serverChannels as any}
                        voiceParticipants={{}} huddleCalls={{}}
                        serverBadges={{}} serverLastActivityAt={{}}
                        pinnedItems={pins} friendStatuses={{}}
                        onSelectConversation={noop} onJoinVoiceChannel={noop} onJoinHuddleCall={noop}
                        onPin={noop} onUnpin={noop} onOpenStorage={noop}
                        onReorderPins={(key, to, visible) => setPins(prev => moveVisiblePin(prev, visible, key, to) ?? prev)}
                    />
                </div>
            </div>
        );
    };

    createRoot(document.getElementById('root')!).render(
        <ToastProvider><UpdateProvider><NotificationProvider><SubscriptionProvider>
            <App />
        </SubscriptionProvider></NotificationProvider></UpdateProvider></ToastProvider>,
    );
    (window as any).__booted = true;
}
void boot();
