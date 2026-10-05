import { describe, it, expect } from 'vitest';
import {
    resolveActiveStatus,
    isActiveNow,
    selectActiveFriends,
    type StatusMap,
    type PresenceMap,
} from './activeNow';

const ALICE = 'user-alice';
const BOB = 'user-bob';

const friends = [{ user_id: ALICE }, { user_id: BOB }];

/**
 * The two asynchronous sources, reproduced exactly as the app builds them.
 *
 * `seededStatuses` is what useUserStatus writes the instant the friends list
 * resolves: an entry for EVERY accepted friend, defaulting to 'offline'. This
 * is the state that used to poison the section, because it made `fs?.status`
 * non-nullish and so short-circuited the `??` presence fallback forever.
 */
const seededStatuses = (): StatusMap => ({
    [ALICE]: { status: 'offline', current_game: null },
    [BOB]: { status: 'offline', current_game: null },
});

/** What the WS `user:friends_status_batch` snapshot corrects it to. */
const batchStatuses = (): StatusMap => ({
    [ALICE]: { status: 'online', current_game: null },
    [BOB]: { status: 'offline', current_game: null },
});

/** What the `GET /v1/gateway/presence` poll reports: Alice is connected. */
const livePresence = (): PresenceMap => ({ [ALICE]: true, [BOB]: false });

const NO_STATUSES: StatusMap = {};
const NO_PRESENCE: PresenceMap = {};

describe('activeNow — arrival ordering', () => {
    // The regression. Both orderings must produce the same non-empty section;
    // previously the first one silently produced an empty "Active Now".
    it('finds the online friend when the friends-list seed lands BEFORE presence', () => {
        // t0: friends list resolves -> everyone seeded 'offline'. Nothing known yet.
        const statuses = seededStatuses();
        expect(selectActiveFriends(friends, statuses, NO_PRESENCE)).toEqual([]);

        // t1: the presence poll comes back and says Alice is connected.
        // The stale seeded 'offline' must NOT suppress her.
        const active = selectActiveFriends(friends, statuses, livePresence());
        expect(active.map(f => f.user_id)).toEqual([ALICE]);
    });

    it('finds the online friend when presence lands BEFORE the friends-list seed', () => {
        // t0: presence known, but the friends list has not resolved, so there
        // is nothing to render yet.
        expect(selectActiveFriends([], NO_STATUSES, livePresence())).toEqual([]);

        // t1: friends list resolves and seeds everyone 'offline'. Alice must
        // still be picked up from the presence map that arrived first.
        const active = selectActiveFriends(friends, seededStatuses(), livePresence());
        expect(active.map(f => f.user_id)).toEqual([ALICE]);
    });

    it('agrees across every interleaving in which some source knows Alice is up', () => {
        // As soon as EITHER source carries the signal, the section must contain
        // exactly Alice — no matter which source it was or what order it
        // arrived in. (The seed-only state is excluded on purpose: at that
        // point nothing has reported her yet, so empty is the correct answer.)
        const states = [
            { label: 'seed + presence', statuses: seededStatuses(), presence: livePresence() },
            { label: 'batch only', statuses: batchStatuses(), presence: NO_PRESENCE },
            { label: 'batch + presence', statuses: batchStatuses(), presence: livePresence() },
            { label: 'presence before any status', statuses: NO_STATUSES, presence: livePresence() },
        ];
        for (const { label, statuses, presence } of states) {
            const active = selectActiveFriends(friends, statuses, presence);
            expect(active.map(f => f.user_id), label).toEqual([ALICE]);
        }
    });

    it('renders empty only while neither source has reported anyone', () => {
        // The one legitimately-empty window: the friends list has resolved and
        // seeded everyone 'offline', but no presence or status data has landed.
        expect(selectActiveFriends(friends, seededStatuses(), NO_PRESENCE)).toEqual([]);
    });

    it('recovers a friend the status batch omitted entirely', () => {
        // The batch only carries rows the server found; a friend missing from
        // it keeps the seeded 'offline'. Live presence must still surface them.
        const partialBatch: StatusMap = { [BOB]: { status: 'offline' } };
        expect(selectActiveFriends(friends, partialBatch, livePresence()).map(f => f.user_id))
            .toEqual([ALICE]);
    });
});

describe('activeNow — status semantics', () => {
    it('counts away and dnd as active, not just online', () => {
        // The old `status === 'online'` test hid friends who were merely idle
        // or on Do Not Disturb, which reads as "Active Now stopped working".
        for (const status of ['online', 'away', 'dnd'] as const) {
            expect(isActiveNow(ALICE, { [ALICE]: { status } }, NO_PRESENCE)).toBe(true);
            expect(resolveActiveStatus(ALICE, { [ALICE]: { status } }, NO_PRESENCE)).toBe(status);
        }
    });

    it('preserves away/dnd even when the presence poll also says connected', () => {
        // Presence is a boolean and must not flatten a richer status to 'online'.
        expect(resolveActiveStatus(ALICE, { [ALICE]: { status: 'dnd' } }, { [ALICE]: true }))
            .toBe('dnd');
    });

    it('keeps a genuinely offline friend out when neither source claims them', () => {
        expect(isActiveNow(BOB, seededStatuses(), livePresence())).toBe(false);
        expect(resolveActiveStatus(BOB, seededStatuses(), livePresence())).toBe('offline');
    });

    it('treats an unknown or malformed status as no information, deferring to presence', () => {
        const junk: StatusMap = { [ALICE]: { status: 'invisible' }, [BOB]: { status: null } };
        expect(resolveActiveStatus(ALICE, junk, { [ALICE]: true })).toBe('online');
        expect(resolveActiveStatus(ALICE, junk, NO_PRESENCE)).toBe('offline');
        expect(resolveActiveStatus(BOB, junk, { [BOB]: true })).toBe('online');
    });

    it('handles friends absent from both maps', () => {
        expect(resolveActiveStatus('nobody', NO_STATUSES, NO_PRESENCE)).toBe('offline');
        expect(selectActiveFriends(friends, NO_STATUSES, NO_PRESENCE)).toEqual([]);
    });

    it('does not treat a falsy presence entry as active', () => {
        expect(isActiveNow(ALICE, NO_STATUSES, { [ALICE]: false })).toBe(false);
        expect(isActiveNow(ALICE, NO_STATUSES, { [ALICE]: undefined })).toBe(false);
    });

    it('preserves the input order of the friends list', () => {
        const many = [{ user_id: 'c' }, { user_id: 'a' }, { user_id: 'b' }];
        const presence: PresenceMap = { a: true, b: true, c: true };
        expect(selectActiveFriends(many, NO_STATUSES, presence).map(f => f.user_id))
            .toEqual(['c', 'a', 'b']);
    });
});
