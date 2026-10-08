import { describe, it, expect, beforeEach, vi } from 'vitest';

// secureLocalStore is hydrated at app boot; swap in a plain map so these cases
// exercise the wrapper's keying and failure behaviour, not the encryption.
const mem = new Map<string, string>();
let failWrites = false;
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { if (failWrites) throw new Error('locked'); mem.set(k, v); },
        removeItem: (k: string) => { mem.delete(k); },
    },
}));

import { clearRejoinDescriptor, loadRejoinDescriptor, saveRejoinDescriptor } from './callRejoinStore';
import { DESCRIPTOR_VERSION, type CallRejoinDescriptor } from './callRejoinPolicy';

const d: CallRejoinDescriptor = {
    v: DESCRIPTOR_VERSION, kind: 'dm', sessionId: 's1', conversationId: 'c1',
    title: 'Sam', callKeyB64: 'a2V5', startedAt: 1, lastSeen: 2,
};

beforeEach(() => { mem.clear(); failWrites = false; });

describe('callRejoinStore', () => {
    it('round-trips a descriptor', () => {
        saveRejoinDescriptor('u1', d);
        expect(loadRejoinDescriptor('u1')).toEqual(d);
    });

    it('is scoped per account — another user never sees this user’s record', () => {
        saveRejoinDescriptor('u1', d);
        expect(loadRejoinDescriptor('u2')).toBeNull();
        // And the stored key is namespaced by the account id.
        expect([...mem.keys()]).toEqual(['cipherline_call_rejoin_u1']);
    });

    it('clear removes only that account’s record', () => {
        saveRejoinDescriptor('u1', d);
        saveRejoinDescriptor('u2', { ...d, sessionId: 's2' });
        clearRejoinDescriptor('u1');
        expect(loadRejoinDescriptor('u1')).toBeNull();
        expect(loadRejoinDescriptor('u2')).not.toBeNull();
    });

    it('a corrupt stored value reads as "no record", not an exception', () => {
        mem.set('cipherline_call_rejoin_u1', '{garbage');
        expect(loadRejoinDescriptor('u1')).toBeNull();
    });

    it('a write that the (locked) store rejects does not throw into the caller', () => {
        failWrites = true;
        expect(() => saveRejoinDescriptor('u1', d)).not.toThrow();
        expect(loadRejoinDescriptor('u1')).toBeNull();
    });

    it('an empty user id is a no-op everywhere (never writes a shared "cipherline_call_rejoin_" key)', () => {
        saveRejoinDescriptor('', d);
        expect(mem.size).toBe(0);
        expect(loadRejoinDescriptor('')).toBeNull();
        expect(() => clearRejoinDescriptor('')).not.toThrow();
    });
});
