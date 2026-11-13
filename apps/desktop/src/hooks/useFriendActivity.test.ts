import { describe, it, expect } from 'vitest';
import { buildListeningSnapshot, buildPresenceSnapshot } from './useFriendActivity';
import type { FriendStatusEntry } from '../utils/userStatusModel';
import type { Listening } from '../utils/integrations/listening';

const NOW = 1_800_000_000_000;
const st = (status: FriendStatusEntry['status'], o: Partial<FriendStatusEntry> = {}): FriendStatusEntry =>
    ({ status, custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false, ...o });

describe('buildPresenceSnapshot', () => {
    it('resolves presence from both sources and strips everything from offline friends', () => {
        const snap = buildPresenceSnapshot(
            new Set(['a', 'b', 'c']),
            { a: st('online', { current_game: 'Hades' }), b: st('offline', { current_game: 'Leak', custom_status_text: 'leak' }), c: st('offline') },
            { c: true },
            NOW,
        );
        expect(snap.a).toEqual({ present: true, game: 'Hades', customText: null, customEmoji: null });
        expect(snap.b).toEqual({ present: false, game: null, customText: null, customEmoji: null });
        expect(snap.c.present).toBe(true); // live presence rescues a stale seeded 'offline'
    });

    it('an expired custom status is not a status; a phone-only friend has no game', () => {
        const snap = buildPresenceSnapshot(
            new Set(['a', 'b']),
            {
                a: st('online', { custom_status_text: 'gone', custom_status_expires_at: new Date(NOW - 1000).toISOString() }),
                b: st('online', { current_game: 'Hades', on_mobile: true }),
            },
            {},
            NOW,
        );
        expect(snap.a.customText).toBeNull();
        expect(snap.b.game).toBeNull();
    });

    it('only friends are in it', () => {
        expect(Object.keys(buildPresenceSnapshot(new Set(['a']), { a: st('online'), z: st('online') }, {}, NOW))).toEqual(['a']);
    });
});

describe('buildListeningSnapshot', () => {
    const l = (o: Partial<Listening> = {}): Listening => ({ kind: 'listening', source: 'spotify', track: 'T', artist: 'A', album: null, startedAt: NOW, durationMs: null, endsAt: NOW + 1000, ...o });
    it('friends only, present only, unexpired only (never yourself)', () => {
        const all = new Map([['a', l()], ['off', l()], ['old', l({ endsAt: NOW - 1 })], ['me', l()]]);
        const snap = buildListeningSnapshot(all, new Set(['a', 'off', 'old']), id => id !== 'off', NOW);
        expect([...snap.keys()]).toEqual(['a']);
    });
});
