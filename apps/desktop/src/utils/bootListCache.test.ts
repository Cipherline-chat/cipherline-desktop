import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mem, fakeStore } = vi.hoisted(() => {
    const mem = new Map<string, string>();
    return { mem, fakeStore: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } } };
});
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

import { readCachedConversations, cacheConversations, readCachedFriends, cacheFriends, MAX_CACHE_CHARS } from './bootListCache';
import { classifyKvKey } from '../services/backupRegistry';

describe('bootListCache (fast cold start)', () => {
    beforeEach(() => mem.clear());

    it('round-trips per account, and another account reads nothing', () => {
        cacheConversations('u1', [{ conversation_id: 'c1' }]);
        cacheFriends('u1', { accepted: [{ user_id: 'f1', username: 'pal' }], pending_incoming: [], pending_outgoing: [], blocked: [] } as never);
        expect(readCachedConversations('u1')).toEqual([{ conversation_id: 'c1' }]);
        expect(readCachedFriends('u1')?.accepted).toEqual([{ user_id: 'f1', username: 'pal' }]);
        expect(readCachedConversations('u2')).toBeNull();
        expect(readCachedFriends('u2')).toBeNull();
        expect(readCachedConversations(null)).toBeNull();
    });

    it('a corrupt, wrong-shaped or oversized cache reads as nothing', () => {
        mem.set('cipherline_conv_cache_u1', '{not json');
        mem.set('cipherline_friends_cache_u1', JSON.stringify({ accepted: 'nope' }));
        expect(readCachedConversations('u1')).toBeNull();
        expect(readCachedFriends('u1')).toBeNull();
        mem.set('cipherline_conv_cache_u1', JSON.stringify({ not: 'an array' }));
        expect(readCachedConversations('u1')).toBeNull();
        cacheConversations('u1', [{ big: 'x'.repeat(MAX_CACHE_CHARS) }]);
        expect(readCachedConversations('u1')).toBeNull();
    });

    it('both keys are excluded from backups (a cache, rebuilt from the server)', () => {
        expect(classifyKvKey('cipherline_conv_cache_u1', 'u1')).toBe('exclude');
        expect(classifyKvKey('cipherline_friends_cache_u1', 'u1')).toBe('exclude');
    });
});
