/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { setCallMedia, voiceChannelMediaKey, huddleCallMediaKey } from '../src/utils/callMediaPresence';

/**
 * Home "Happening now" harness: the REAL HomePanel (and so the real
 * HomeCallsTile + home-deck.css) with N live calls across servers.
 *   ?n=8        how many live calls (0–8)
 *   &mine=1     you are in "Build Stream" (it ranks first, shows "In call")
 *   &chrome=312 px of fake rail + sidebar on the left (0 = none)
 *   &backup=1   leave the backup nudge on (it pairs two-across with the calls
 *               tile at >= 880px); default mutes it, the owner's real setup
 *   &only=<id>  show just that call (overrides n): e.g. only=solo-mine (the
 *               owner's screenshot — your own call, alone in it; use with
 *               mine=1) or only=movie (someone else's 7-person call, sharing)
 *   &people=N   with only=: resize that call's roster to N
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 8);
const MINE = q.get('mine') === '1';
const CHROME = Number(q.get('chrome') ?? 312);

const reply = (config: any, data: any, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    if (url.startsWith('/billing/status')) return reply(config, { subscription_status: 'active', effective_status: 'active', has_subscription: true });
    if (url.startsWith('/auth/me')) return reply(config, { user_id: 'u-me', username: 'Shinobi', discriminator: 4821, display_name: 'Shinobi' });
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
const CONNECT = String((1n << 16n) | (1n << 24n));
type Def = { id: string; kind: 'voice' | 'huddle'; name: string; server: string; people: string[]; startedMinAgo?: number };
const DEFS: Def[] = [
    { id: 'raid', kind: 'voice', name: 'Raid Night', server: 'Guild Hall', people: ['mira', 'p1', 'p2', 'p3', 'p4'] },
    { id: 'lofi', kind: 'huddle', name: 'Lofi Study', server: 'Study Buddies', people: ['p5', 'p6', 'p7'], startedMinAgo: 20 },
    { id: 'ranked', kind: 'voice', name: 'Ranked Queue', server: 'Valorant Squad', people: ['jonas', 'p8', 'p9', 'p10'] },
    { id: 'movie', kind: 'huddle', name: 'Movie Night', server: 'Friends HQ', people: ['p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17'], startedMinAgo: 45 },
    { id: 'private', kind: 'voice', name: 'Private Testing', server: 'Cipherline Official', people: ['p18', 'p19'] },
    { id: 'build', kind: 'huddle', name: 'Build Stream', server: 'Maker Collective', people: ['u-me', 'p20'], startedMinAgo: 5 },
    { id: 'chill', kind: 'voice', name: 'late night chill — talk about anything and everything until sunrise', server: 'An Extremely Long Server Name That Has To Truncate First', people: ['p21', 'p22', 'p23'] },
    { id: 'standup', kind: 'huddle', name: 'Standup', server: 'Design Team', people: ['p24', 'p25', 'p26', 'p27', 'p28', 'p29'], startedMinAgo: 2 },
    { id: 'solo-mine', kind: 'huddle', name: "Shinobi's Call", server: 'Cipherline Official', people: ['u-me'], startedMinAgo: 3 },
];
const ONLY = q.get('only');
const PEOPLE = q.get('people');
const defs = ONLY
    ? DEFS.filter(d => d.id === ONLY).map(d => PEOPLE == null ? d : {
        ...d, people: Array.from({ length: Number(PEOPLE) }, (_, k) => d.people[k] ?? `px${k}`),
    })
    : DEFS.slice(0, N);
const servers = defs.map(d => ({ server_id: `S-${d.id}`, name: d.server, role: 'member' }));
const serverChannels: Record<string, any[]> = {};
const voiceParticipants: Record<string, string[]> = {};
const huddleCalls: Record<string, any[]> = {};
for (const d of defs) {
    const chId = `ch-${d.id}`;
    serverChannels[`S-${d.id}`] = [{
        channel_id: chId, server_id: `S-${d.id}`, kind: d.kind, name: d.kind === 'huddle' ? 'calls' : d.name,
        topic: null, icon_emoji: null, icon_name: null, position: 0, parent_category_id: null,
        active_call_session_id: null, member_limit: null, max_calls: null, my_permissions: CONNECT,
    }];
    if (d.kind === 'voice') voiceParticipants[chId] = d.people;
    else huddleCalls[chId] = [{
        call_id: `call-${d.id}`, huddle_id: chId, name: d.name, spawner_user_id: d.people[0],
        spawned_at: new Date(NOW - (d.startedMinAgo ?? 0) * MIN).toISOString(), participants: d.people,
    }];
}
// Media: someone sharing in Movie Night, a camera on in Build Stream.
setCallMedia(huddleCallMediaKey('call-movie'), 'p11', { screen_share: true });
setCallMedia(huddleCallMediaKey('call-build'), 'p20', { camera: true });
setCallMedia(voiceChannelMediaKey('ch-raid'), 'p1', { camera: true });
setCallMedia(voiceChannelMediaKey('ch-raid'), 'p2', { screen_share: true });

const names: Record<string, string> = { mira: 'Mira', jonas: 'Jonas', 'u-me': 'Shinobi' };
const friends = { accepted: [
    { user_id: 'mira', display_name: 'Mira', username: 'mira' },
    { user_id: 'jonas', display_name: 'Jonas', username: 'jonas' },
] };
const noop = () => {};

async function boot() {
    await secureLocalStore.hydrate();
    if (q.get('backup') !== '1') secureLocalStore.setItem('cipherline_home_backup_muted_u-me', '1');
    const [{ ToastProvider }, { UpdateProvider }, { NotificationProvider }, { SubscriptionProvider }, { HomePanel }] = await Promise.all([
        import('../src/contexts/ToastContext'), import('../src/contexts/UpdateContext'),
        import('../src/contexts/NotificationContext'), import('../src/contexts/SubscriptionContext'),
        import('../src/components/HomePanel'),
    ]);

    const App: React.FC = () => (
        <div data-layout="drift" className="w-screen h-screen flex bg-cl-abyss text-white overflow-hidden font-sans">
            {CHROME > 0 && (
                <div style={{ width: CHROME, flex: '0 0 auto', background: '#0E1426', borderRight: '1px solid #2A3558' }} />
            )}
            <div className="app-pane-solo" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', overflow: 'hidden' }}>
                <HomePanel
                    userId="u-me" displayName="Shinobi" token="harness-token"
                    conversations={[]} unreadCounts={{}} mentionCounts={{}}
                    presence={{ mira: true, jonas: true }}
                    friends={friends as any}
                    servers={servers as any} serverChannels={serverChannels as any}
                    voiceParticipants={voiceParticipants} huddleCalls={huddleCalls as any}
                    voiceUserNames={names}
                    serverBadges={{}} serverLastActivityAt={{}}
                    pinnedItems={[]} friendStatuses={{}}
                    localCallSession={MINE ? { voiceChannelId: null, huddleCallId: ONLY === 'solo-mine' ? 'call-solo-mine' : 'call-build' } : { voiceChannelId: null, huddleCallId: null }}
                    inAnyCall={MINE}
                    canPlayGame={() => 'ok' as any} onPlayGame={noop}
                    onSelectConversation={noop} onJoinVoiceChannel={noop} onJoinHuddleCall={noop}
                    onSelectServer={noop}
                    onPin={noop} onUnpin={noop} onOpenStorage={noop}
                    onReorderPins={noop as any}
                />
            </div>
        </div>
    );

    createRoot(document.getElementById('root')!).render(
        <ToastProvider><UpdateProvider><NotificationProvider><SubscriptionProvider>
            <App />
        </SubscriptionProvider></NotificationProvider></UpdateProvider></ToastProvider>,
    );
    (window as any).__booted = true;
}
void boot();
