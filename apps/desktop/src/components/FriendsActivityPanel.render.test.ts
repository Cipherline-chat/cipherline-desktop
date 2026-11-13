// @vitest-environment jsdom
/**
 * The Friends page's right panel: "Active now" cards + the "Recent" timeline,
 * the empty / loading states, and that nothing about an invisible or blocked
 * person ever reaches the DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('./EncryptedAvatar', () => ({
    EncryptedAvatar: ({ userId }: { userId?: string }) => React.createElement('span', { 'data-avatar': userId }),
}));

import { FriendsActivityPanel, type FriendsActivityPanelProps } from './FriendsActivityPanel';
import { listeningStore, type Listening } from '../utils/integrations/listening';
import type { FriendActivityEntry } from '../utils/friendActivity';
import type { FriendStatusEntry } from '../utils/userStatusModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const NOW = Date.now();
const ID = {
    kenji: '11111111-1111-4111-8111-000000000001',
    zara: '11111111-1111-4111-8111-000000000002',
    marco: '11111111-1111-4111-8111-000000000003',
    ghost: '11111111-1111-4111-8111-000000000004', // appears offline
    blk: '11111111-1111-4111-8111-000000000005',
    ana: '11111111-1111-4111-8111-000000000006',
};
const st = (status: FriendStatusEntry['status'], o: Partial<FriendStatusEntry> = {}): FriendStatusEntry =>
    ({ status, custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false, ...o });
const song = (o: Partial<Listening> = {}): Listening => ({
    kind: 'listening', source: 'spotify', track: 'Teardrop', artist: 'Massive Attack', album: null,
    startedAt: NOW, durationMs: null, endsAt: NOW + 3_600_000, ...o,
});
const friends = [
    { user_id: ID.kenji, username: 'Kenji' },
    { user_id: ID.zara, username: 'Zara' },
    { user_id: ID.marco, username: 'Marco' },
    { user_id: ID.ghost, username: 'Ghost' },
    { user_id: ID.ana, username: 'Ana' },
];
const entry = (userId: string, kind: FriendActivityEntry['kind'], agoMin: number, extra: Partial<FriendActivityEntry> = {}): FriendActivityEntry =>
    ({ id: `${userId}:${kind}`, userId, kind, at: NOW - agoMin * 60_000, ...extra });

const base = (o: Partial<FriendsActivityPanelProps> = {}): FriendsActivityPanelProps => ({
    token: 't', friends, blockedIds: new Set(), loading: false,
    friendStatuses: {
        [ID.kenji]: st('online', { current_game: 'Elden Ring' }),
        [ID.zara]: st('online'),
        [ID.marco]: st('online'),
        [ID.ghost]: st('offline'),
        [ID.ana]: st('away'),
    },
    presence: {},
    entries: [],
    voiceParticipants: { v1: [ID.marco, 'stranger'] },
    huddleCalls: {},
    channels: [{ channel_id: 'v1', server_id: 's1', name: 'Lounge' }],
    servers: [{ server_id: 's1', name: 'Deep Sea Club' }],
    localCallSession: null,
    onOpenProfile: vi.fn(),
    onJoinCall: vi.fn(),
    now: NOW,
    ...o,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); listeningStore.clear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); listeningStore.clear(); });

const render = (p: FriendsActivityPanelProps) => act(() => root.render(h(FriendsActivityPanel, p)));
const cards = () => [...host.querySelectorAll('.fa-card')];

describe('FriendsActivityPanel — busy', () => {
    it('Active now: call first, then game, then music; idle friends get no card', () => {
        listeningStore.set(ID.zara, song());
        render(base());
        expect(cards().map(c => c.getAttribute('data-kind'))).toEqual(['call', 'game', 'listening']);
        const text = cards().map(c => c.textContent);
        expect(text[0]).toContain('Marco');
        expect(text[0]).toContain('Lounge');
        expect(text[0]).toContain('Deep Sea Club');
        expect(text[1]).toContain('Elden Ring');
        expect(text[2]).toContain('Teardrop');
        expect(text[2]).toContain('Massive Attack · Spotify');
        expect(host.textContent).not.toContain('Ana'); // away, doing nothing: the Friends page covers her
    });

    it('Join joins that call; the call you are in says so instead', () => {
        const p = base();
        render(p);
        const join = host.querySelector<HTMLButtonElement>('.fa-join')!;
        expect(join.getAttribute('aria-label')).toBe('Join Lounge in Deep Sea Club');
        act(() => join.click());
        expect(p.onJoinCall).toHaveBeenCalledWith(expect.objectContaining({ kind: 'voice', id: 'v1' }));
        render(base({ localCallSession: { voiceChannelId: 'v1', huddleCallId: null } }));
        expect(host.querySelector('.fa-join')).toBeNull();
        expect(host.querySelector('.fa-here')?.textContent).toBe("You're here");
    });

    it('an invisible (appear-offline) friend leaks nothing: no card, even with a game or a track on record', () => {
        listeningStore.set(ID.ghost, song({ track: 'Secret song' }));
        render(base({ friendStatuses: { ...base().friendStatuses, [ID.ghost]: st('offline', { current_game: 'Secret game' }) }, voiceParticipants: {} }));
        expect(host.textContent).not.toContain('Ghost');
        expect(host.textContent).not.toContain('Secret');
    });

    it('a blocked person never appears, in cards or the timeline', () => {
        const f = [...friends, { user_id: ID.blk, username: 'Blocky' }];
        render(base({
            friends: f, blockedIds: new Set([ID.blk]),
            friendStatuses: { ...base().friendStatuses, [ID.blk]: st('online', { current_game: 'Tetris' }) },
            entries: [entry(ID.blk, 'online', 1), entry(ID.kenji, 'online', 2)],
        }));
        expect(host.textContent).not.toContain('Blocky');
        expect(host.textContent).not.toContain('Tetris');
    });

    it('Recent: sentences, relative times, newest first; a click opens that profile', () => {
        const p = base({
            entries: [
                entry(ID.kenji, 'playing', 12, { title: 'Elden Ring' }),
                entry(ID.zara, 'listening', 3, { title: 'Teardrop', detail: 'Massive Attack' }),
                entry(ID.ana, 'new_friend', 90),
                entry(ID.marco, 'status', 30, { title: 'brb pizza', emoji: '🍕' }),
            ],
        });
        render(p);
        const rows = [...host.querySelectorAll('.fa-rrow')];
        expect(rows.map(r => r.querySelector('.fa-rline')?.textContent)).toEqual([
            'Zara started listening to Teardrop',
            'Kenji started playing Elden Ring',
            'Marco set a status',
            'You and Ana are now friends',
        ]);
        expect(rows.map(r => r.querySelector('time')?.textContent)).toEqual(['3m', '12m', '30m', '1h']);
        expect(rows[2].textContent).toContain('🍕');
        expect(rows[2].textContent).toContain('brb pizza');
        expect(rows[1].getAttribute('aria-label')).toBe('Kenji started playing Elden Ring, 12 minutes ago. Open profile');
        act(() => (rows[1] as HTMLButtonElement).click());
        expect(p.onOpenProfile).toHaveBeenCalledWith(ID.kenji, expect.any(Object));
    });

    it('a former friend\'s entries never render', () => {
        render(base({ entries: [entry('not-a-friend', 'online', 1), entry(ID.kenji, 'online', 2)] }));
        expect([...host.querySelectorAll('.fa-rrow')]).toHaveLength(1);
    });

    it('long timelines collapse to 10 with a "Show N more" toggle', () => {
        const many = Array.from({ length: 14 }, (_, i) => entry(`${ID.kenji.slice(0, -2)}${String(10 + i)}`, 'online', i + 1));
        const f = many.map(e => ({ user_id: e.userId, username: `F${e.userId.slice(-2)}` }));
        render(base({ friends: f, entries: many, voiceParticipants: {}, friendStatuses: {} }));
        expect(host.querySelectorAll('.fa-rrow')).toHaveLength(10);
        const more = host.querySelector<HTMLButtonElement>('.fa-more')!;
        expect(more.textContent).toBe('Show 4 more');
        act(() => more.click());
        expect(host.querySelectorAll('.fa-rrow')).toHaveLength(14);
        expect(more.getAttribute('aria-expanded')).toBe('true');
    });

    it('everything is a real button (keyboard reachable)', () => {
        render(base({ entries: [entry(ID.kenji, 'online', 1)] }));
        for (const el of host.querySelectorAll('.fa-card-btn, .fa-rrow, .fa-join')) expect(el.tagName).toBe('BUTTON');
    });
});

describe('FriendsActivityPanel — quiet / empty / loading', () => {
    it('nothing happening: the Keys empty state', () => {
        render(base({ voiceParticipants: {}, friendStatuses: {} }));
        const empty = host.querySelector('[data-testid="friends-activity-empty"]');
        expect(empty).not.toBeNull();
        expect(empty!.textContent).toContain('All quiet in the deep');
        expect(empty!.querySelector('svg')).not.toBeNull(); // Keys
    });

    it('no friends yet: an invitation, not a feed', () => {
        render(base({ friends: [] }));
        expect(host.textContent).toContain('No friends to follow yet');
    });

    it('friends not loaded yet: a busy skeleton', () => {
        render(base({ friends: [], loading: true }));
        expect(host.querySelector('[aria-busy="true"] .fa-skel')).not.toBeNull();
    });

    it('active but no recent entries: a hint in place of the timeline', () => {
        render(base());
        expect(host.textContent).toContain("What friends get up to while you're here will show up here.");
    });
});
