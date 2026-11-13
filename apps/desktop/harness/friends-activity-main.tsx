/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { FriendsActivityPanel } from '../src/components/FriendsActivityPanel';
import { listeningStore } from '../src/utils/integrations/listening';
import { HARNESS_COVER_REF } from './friends-activity-art-stub';
import type { FriendActivityEntry } from '../src/utils/friendActivity';

// ?w=<panel width px>&s=busy|quiet|loading|nofriends
loadWebFonts();
const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 320);
const S = q.get('s') ?? 'busy';
const NOW = Date.now();
const MIN = 60_000;
const twoYearsAgoToday = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 2); d.setHours(12, 0, 0, 0); return d.toISOString(); })();

const id = (n: number) => `11111111-1111-4111-8111-0000000000${String(n).padStart(2, '0')}`;
const F = {
    marco: id(1), kenji: id(2), zara: id(3), elena: id(4), mira: id(5), jun: id(6), sana: id(7), okoye: id(8), ghost: id(9),
};
const friends = [
    { user_id: F.marco, username: 'Marco', avatar_url: 'img-marco' },
    { user_id: F.kenji, username: 'Kenji', avatar_url: 'img-kenji' },
    { user_id: F.zara, username: 'Zara', avatar_url: 'img-zara' },
    { user_id: F.elena, username: 'Elena', avatar_url: 'img-elena' },
    { user_id: F.mira, username: 'mira', avatar_url: 'img-mira', friends_since: S === 'busy' ? twoYearsAgoToday : null },
    { user_id: F.jun, username: 'Jun_the_Extremely_Long_Name', avatar_url: 'img-jun' },
    { user_id: F.sana, username: 'sana', avatar_url: 'img-sana' },
    { user_id: F.okoye, username: 'Okoye-Adeyemi', avatar_url: 'img-okoye' },
    { user_id: F.ghost, username: 'Ghost', avatar_url: null },
];
const st = (status: string, o: any = {}) => ({ status, custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false, ...o });

const busy = S === 'busy';
const statuses: Record<string, any> = busy ? {
    [F.marco]: st('online'),
    [F.kenji]: st('online', { current_game: 'Elden Ring Nightreign' }),
    [F.zara]: st('online'),
    [F.elena]: st('dnd', { current_game: 'Baldur\'s Gate 3' }),
    [F.mira]: st('away'),
    [F.jun]: st('online'),
    [F.sana]: st('online', { custom_status_text: 'brb, pizza', custom_status_emoji: '🍕' }),
    [F.okoye]: st('online'),
    [F.ghost]: st('offline'), // appear-offline: nothing about them may show
} : Object.fromEntries(friends.map(f => [f.user_id, st(f.user_id === F.mira ? 'online' : 'offline')]));

if (busy) {
    listeningStore.set(F.zara, { kind: 'listening', source: 'spotify', track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', startedAt: NOW - 90_000, durationMs: 330_000, endsAt: NOW + 3_600_000, artRef: HARNESS_COVER_REF });
    listeningStore.set(F.jun, { kind: 'watching', source: 'youtube', track: 'How octopuses dream', artist: 'Kurzgesagt', album: null, startedAt: NOW - 200_000, durationMs: null, endsAt: NOW + 3_600_000 });
    listeningStore.set(F.ghost, { kind: 'listening', source: 'spotify', track: 'SHOULD NOT SHOW', artist: 'x', album: null, startedAt: NOW, durationMs: null, endsAt: NOW + 3_600_000 });
}
const e = (userId: string, kind: FriendActivityEntry['kind'], ago: number, extra: Partial<FriendActivityEntry> = {}): FriendActivityEntry =>
    ({ id: `${userId}:${kind}`, userId, kind, at: NOW - ago * MIN, ...extra });
const entries: FriendActivityEntry[] = busy ? [
    e(F.zara, 'listening', 2, { title: 'Teardrop', detail: 'Massive Attack' }),
    e(F.kenji, 'playing', 12, { title: 'Elden Ring Nightreign' }),
    e(F.sana, 'status', 19, { title: 'brb, pizza', emoji: '🍕' }),
    e(F.marco, 'online', 26),
    e(F.okoye, 'high_five', 41, { count: 3 }),
    e(F.jun, 'watching', 55, { title: 'How octopuses dream', detail: 'Kurzgesagt' }),
    e(F.elena, 'avatar', 95),
    e(F.okoye, 'new_friend', 180),
    e(F.kenji, 'online', 240),
    e(F.jun, 'renamed', 300, { title: 'Jun_the_Extremely_Long_Name' }),
    e(F.elena, 'online', 420),
    e(F.sana, 'online', 600),
] : [];

const props: any = {
    token: 't',
    friends: S === 'nofriends' || S === 'loading' ? [] : friends,
    blockedIds: new Set<string>(),
    loading: S === 'loading',
    friendStatuses: statuses,
    presence: {},
    entries,
    voiceParticipants: busy ? { v1: [F.marco, F.okoye, 'u-stranger'] } : {},
    huddleCalls: busy ? { h1: [{ call_id: 'c1', huddle_id: 'h1', name: 'Raid night', spawner_user_id: F.elena, spawned_at: '', participants: [F.elena, 'u-me'] }] } : {},
    channels: [{ channel_id: 'v1', server_id: 's1', name: 'Lounge' }, { channel_id: 'h1', server_id: 's2', name: 'Calls' }],
    servers: [{ server_id: 's1', name: 'Deep Sea Club' }, { server_id: 's2', name: 'Kelp Forest Co-op' }],
    localCallSession: { voiceChannelId: null, huddleCallId: 'c1' },
    onOpenProfile: (uid: string, a: any) => console.log('open profile', uid, a),
    onJoinCall: (c: any) => console.log('join', c.id),
    now: NOW,
};

createRoot(document.getElementById('root')!).render(
    // The right panel: bg-cl-deep, rounded top-right, the app's 1px hairline on its left.
    <div id="host" style={{ width: W, height: 1000, display: 'flex', flexDirection: 'column', background: 'var(--cl-deep)', borderTopRightRadius: 16, borderLeft: '1px solid rgba(255,255,255,0.04)', overflowY: 'auto', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
        <FriendsActivityPanel {...props} />
    </div>
);
