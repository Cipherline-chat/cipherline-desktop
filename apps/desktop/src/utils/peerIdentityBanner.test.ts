/**
 * The banner-id facet of peerIdentityCache: what lets a profile card start —
 * or paint from the encrypted blob cache — a user's banner on the click,
 * including after a restart, instead of after the profile round trip.
 *
 * Pinned: it persists (encrypted, via secureLocalStore, like the rest of the
 * record), old records without it still load, newer records still load in the
 * old reader's shape, null clears it, a missing field is a no-op, and banner
 * ids never leak into the AVATAR boot-warm set.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, string>();
vi.mock('./secureLocalStore', () => {
    const store = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: (u: string) => !!u,
        whenAccountReady: async () => {},
    };
    return { default: store, secureLocalStore: store };
});

import {
    rememberUserBannerId,
    rememberUserAvatarId,
    rememberIdentities,
    lookupUserBannerId,
    lookupUserAvatarId,
    knownAvatarIds,
    hydratePeerIdentityCache,
    flushPeerIdentityCache,
    __resetPeerIdentityCache,
    __peerIdentityTuning,
} from './peerIdentityCache';

const ME = 'me';
const KEY = __peerIdentityTuning.STORE_PREFIX + ME;

beforeEach(() => {
    kv.clear();
    __resetPeerIdentityCache();
    hydratePeerIdentityCache(ME);
});

async function restart() {
    await flushPeerIdentityCache();
    __resetPeerIdentityCache();
    hydratePeerIdentityCache(ME);
}

describe('banner ids', () => {
    it('survive a restart, alongside the avatar id', async () => {
        rememberIdentities([{ user_id: 'u1', avatar_url: 'av-1', username: 'alice' }]);
        rememberUserBannerId('u1', 'bn-1');
        await restart();
        expect(lookupUserBannerId('u1')).toBe('bn-1');
        expect(lookupUserAvatarId('u1')).toBe('av-1');
    });

    it('a banner id alone is enough to keep the identity', async () => {
        rememberUserBannerId('u2', 'bn-2');
        await restart();
        expect(lookupUserBannerId('u2')).toBe('bn-2');
    });

    it('null clears it (they removed their banner); undefined learns nothing', async () => {
        rememberUserBannerId('u1', 'bn-1');
        rememberUserBannerId('u1', undefined);
        expect(lookupUserBannerId('u1')).toBe('bn-1');
        rememberUserBannerId('u1', null);
        expect(lookupUserBannerId('u1')).toBeNull();
        await restart();
        expect(lookupUserBannerId('u1')).toBeNull();
    });

    it('an avatar change does not drop the banner, and vice versa', () => {
        rememberUserBannerId('u1', 'bn-1');
        rememberUserAvatarId('u1', 'av-2');
        expect(lookupUserBannerId('u1')).toBe('bn-1');
        rememberUserBannerId('u1', 'bn-2');
        expect(lookupUserAvatarId('u1')).toBe('av-2');
    });

    it('is never part of the AVATAR boot-warm set', () => {
        rememberUserAvatarId('u1', 'av-1');
        rememberUserBannerId('u1', 'bn-1');
        expect(knownAvatarIds()).toEqual(['av-1']);
    });

    it('a record written before banner ids existed (3-tuples) still loads', () => {
        kv.set(KEY, JSON.stringify({ v: 1, savedAt: Date.now(), u: [['u1', 'av-1', 'alice']], d: [] }));
        __resetPeerIdentityCache();
        hydratePeerIdentityCache(ME);
        expect(lookupUserAvatarId('u1')).toBe('av-1');
        expect(lookupUserBannerId('u1')).toBeNull();
    });

    it('a newer record keeps the old 3-field shape for entries with no banner, so an older client reads it', async () => {
        rememberIdentities([{ user_id: 'u1', avatar_url: 'av-1', username: 'alice' }]);
        rememberUserBannerId('u2', 'bn-2');
        await flushPeerIdentityCache();
        const rec = JSON.parse(kv.get(KEY)!);
        expect(rec.v).toBe(1);
        expect(rec.u).toEqual(expect.arrayContaining([['u1', 'av-1', 'alice'], ['u2', '', '', 'bn-2']]));
    });
});
