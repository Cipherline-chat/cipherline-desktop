import { describe, it, expect, beforeEach } from 'vitest';
import {
    rememberIdentities,
    rememberUserAvatarId,
    rememberDeviceAvatarId,
    rememberUserName,
    rememberDeviceName,
    snapshotUserAvatarIds,
    snapshotDeviceAvatarIds,
    snapshotUserNames,
    snapshotDeviceNames,
    knownAvatarIds,
    lookupUserAvatarId,
    lookupUserName,
    __resetPeerIdentityCache,
    __peerIdentityTuning,
} from './peerIdentityCache';

beforeEach(__resetPeerIdentityCache);

describe('recording a directory response', () => {
    it('indexes a row by BOTH its user id and its device id, on both facets', () => {
        rememberIdentities([{ user_id: 'u1', device_id: 'd1', avatar_url: 'att-1', username: 'alice' }]);
        expect(snapshotUserAvatarIds()).toEqual({ u1: 'att-1' });
        expect(snapshotDeviceAvatarIds()).toEqual({ d1: 'att-1' });
        expect(snapshotUserNames()).toEqual({ u1: 'alice' });
        expect(snapshotDeviceNames()).toEqual({ d1: 'alice' });
    });

    it('ignores rows with no avatar rather than storing an empty id', () => {
        rememberIdentities([
            { user_id: 'u1', avatar_url: 'att-1', username: 'alice' },
            { user_id: 'u2', avatar_url: null, username: 'bob' },
            { user_id: 'u3', username: 'carol' },
        ]);
        expect(snapshotUserAvatarIds()).toEqual({ u1: 'att-1' });
        // ...but their names are still learned — the two facets are independent.
        expect(snapshotUserNames()).toEqual({ u1: 'alice', u2: 'bob', u3: 'carol' });
    });

    it('a later row wins — an avatar change is not shadowed by the old id', () => {
        rememberUserAvatarId('u1', 'att-old');
        rememberUserAvatarId('u1', 'att-new');
        expect(lookupUserAvatarId('u1')).toBe('att-new');
    });

    it('a later row wins for the name too — a rename is not shadowed', () => {
        rememberUserName('u1', 'alice');
        rememberUserName('u1', 'alice_2');
        expect(lookupUserName('u1')).toBe('alice_2');
    });

    it('tolerates missing keys without throwing', () => {
        expect(() => {
            rememberUserAvatarId(null, 'att-1');
            rememberUserAvatarId(undefined, 'att-1');
            rememberDeviceAvatarId('', 'att-1');
            rememberUserName(null, 'alice');
            rememberDeviceName('', 'alice');
            rememberIdentities([]);
        }).not.toThrow();
        expect(knownAvatarIds()).toEqual([]);
        expect(snapshotUserNames()).toEqual({});
    });
});

describe('the two facets clear differently, on purpose', () => {
    it('an explicit avatar clear DELETES the avatar', () => {
        // Keeping a stale id would re-paint a picture the user deleted on the
        // next remount, which is worse than one round-trip of fallback.
        rememberUserAvatarId('u1', 'att-1');
        rememberUserAvatarId('u1', null);
        expect(lookupUserAvatarId('u1')).toBeNull();
    });

    it('a missing NAME is a no-op, never a clear', () => {
        // Every account has a username, so an absent one means the response did
        // not carry it — not "this person has no name". Clearing would put
        // "Unknown User" back on the row, which is the flash this cache deletes.
        rememberUserName('u1', 'alice');
        rememberUserName('u1', undefined);
        rememberUserName('u1', '');
        rememberIdentities([{ user_id: 'u1', avatar_url: 'att-1' }]);
        expect(lookupUserName('u1')).toBe('alice');
    });

    it('clearing the avatar keeps the name, and vice versa', () => {
        rememberIdentities([{ user_id: 'u1', avatar_url: 'att-1', username: 'alice' }]);
        rememberUserAvatarId('u1', null);
        expect(lookupUserAvatarId('u1')).toBeNull();
        expect(lookupUserName('u1')).toBe('alice');
    });

    it('an identity with neither facet left is dropped entirely', () => {
        rememberUserAvatarId('u1', 'att-1');
        rememberUserAvatarId('u1', null);
        expect(snapshotUserAvatarIds()).toEqual({});
        expect(snapshotUserNames()).toEqual({});
    });
});

describe('the warm set', () => {
    it('de-duplicates the same attachment reached via several devices', () => {
        rememberIdentities([
            { user_id: 'u1', device_id: 'd1', avatar_url: 'att-1' },
            { user_id: 'u1', device_id: 'd2', avatar_url: 'att-1' },
            { user_id: 'u2', device_id: 'd3', avatar_url: 'att-2' },
        ]);
        expect(knownAvatarIds().sort()).toEqual(['att-1', 'att-2']);
    });
});

describe('the cache is bounded — and the bound counts PEOPLE', () => {
    it('evicts the least recently seen identity past the cap', () => {
        const cap = __peerIdentityTuning.MAX_ENTRIES;
        for (let i = 0; i < cap; i++) rememberIdentities([{ user_id: `u${i}`, avatar_url: `att-${i}`, username: `n${i}` }]);
        // Touch the oldest so it is no longer the eviction candidate.
        rememberUserAvatarId('u0', 'att-0');
        rememberIdentities([{ user_id: 'overflow', avatar_url: 'att-overflow', username: 'over' }]);

        const avatars = snapshotUserAvatarIds();
        expect(Object.keys(avatars)).toHaveLength(cap);
        expect(avatars['u0']).toBe('att-0');          // refreshed, survives
        expect(avatars['u1']).toBeUndefined();        // now the oldest, evicted
        expect(avatars['overflow']).toBe('att-overflow');
    });

    it('storing a NAME as well does not double the entry count', () => {
        // The whole reason the two facets share one record: four independently
        // capped maps would hold 4x the cap and the number would stop meaning
        // anything a reader can reason about.
        const cap = __peerIdentityTuning.MAX_ENTRIES;
        for (let i = 0; i < cap + 50; i++) {
            rememberIdentities([{ user_id: `u${i}`, avatar_url: `att-${i}`, username: `n${i}` }]);
        }
        expect(Object.keys(snapshotUserAvatarIds())).toHaveLength(cap);
        expect(Object.keys(snapshotUserNames())).toHaveLength(cap);
    });

    it('eviction drops a person WHOLE — never a name without its avatar', () => {
        const cap = __peerIdentityTuning.MAX_ENTRIES;
        for (let i = 0; i < cap + 10; i++) {
            rememberIdentities([{ user_id: `u${i}`, avatar_url: `att-${i}`, username: `n${i}` }]);
        }
        const avatars = snapshotUserAvatarIds();
        const names = snapshotUserNames();
        // A half-evicted identity would render a named row with a placeholder
        // face (or the reverse) — stranger to look at than being fully cold.
        expect(Object.keys(avatars).sort()).toEqual(Object.keys(names).sort());
    });
});

describe('nicknames are never written here', () => {
    it('only exposes an account username, so it cannot outrank a server nickname', () => {
        // ChatPane resolves: server nickname -> device username -> account
        // username. The nickname lives in a Dashboard-owned prop that survives
        // the remount and is consulted FIRST, so this cache can only ever fill
        // the two slots the network fetch used to fill. This test pins the
        // other half of that: the cache's own API has no nickname input, so
        // there is no path by which a server-scoped nickname could be cached
        // globally and mislabel the same person in a different server.
        rememberIdentities([{ user_id: 'u1', username: 'alice', avatar_url: 'att-1' }]);
        expect(lookupUserName('u1')).toBe('alice');
        expect(Object.keys(snapshotUserNames())).toEqual(['u1']);
    });
});
