import { describe, it, expect } from 'vitest';
import { parseRetentionOverride, pinnedIdsForChannel, serverRetentionKey, sweepPolicyFor } from './retentionResolve';
import { resolveChatMessageRetention, resolveChatAttachmentRetention, type StoragePolicy } from '../hooks/useRetentionPolicy';
import { sweepRetention } from './retentionSweeper';

const base = (over: Partial<StoragePolicy> = {}): StoragePolicy => ({
    messageRetention: '1y',
    attachmentRetention: '1mo',
    savedMessageIds: ['saved1'],
    unsavedMessageIds: [],
    savedAttachmentIds: [],
    unsavedAttachmentIds: [],
    unsavedMessageTimestamps: {},
    unsavedAttachmentTimestamps: {},
    ...over,
} as StoragePolicy);

describe('parseRetentionOverride', () => {
    it('reads either half', () => {
        expect(parseRetentionOverride('{"messageRetention":"1wk"}')).toEqual({ messageRetention: '1wk' });
        expect(parseRetentionOverride('{"attachmentRetention":"24h"}')).toEqual({ attachmentRetention: '24h' });
        expect(parseRetentionOverride('{"messageRetention":"never","attachmentRetention":"3mo"}'))
            .toEqual({ messageRetention: 'never', attachmentRetention: '3mo' });
    });
    it('ignores anything it cannot read instead of obeying it', () => {
        for (const bad of [null, undefined, '', '{', '[]', '"x"', '{"messageRetention":"2y"}', '{"messageRetention":7}',
                           '{"attachmentRetention":"24h "}', '{}']) {
            expect(parseRetentionOverride(bad as never)).toBeNull();
        }
    });
    it('keeps the valid half when the other half is garbage', () => {
        expect(parseRetentionOverride('{"messageRetention":"bogus","attachmentRetention":"1wk"}'))
            .toEqual({ attachmentRetention: '1wk' });
    });
    it('24h is an attachment window only', () => {
        expect(parseRetentionOverride('{"messageRetention":"24h"}')).toBeNull();
    });
});

describe('sweepPolicyFor — per-chat override > per-type default > global', () => {
    const p = base({ dmMessageRetention: '6mo', groupMessageRetention: '3mo', serverMessageRetention: '1mo',
                     serverAttachmentRetention: '1wk' });
    it('uses the per-type default when there is no override', () => {
        expect(sweepPolicyFor(p, 'dm').messageRetention).toBe('6mo');
        expect(sweepPolicyFor(p, 'group').messageRetention).toBe('3mo');
        expect(sweepPolicyFor(p, 'server').messageRetention).toBe('1mo');
        expect(sweepPolicyFor(p, 'server').attachmentRetention).toBe('1wk');
    });
    it('falls back to the global setting where a type has no default', () => {
        expect(sweepPolicyFor(p, 'dm').attachmentRetention).toBe('1mo');
    });
    it('an override beats the type default, per half', () => {
        const eff = sweepPolicyFor(p, 'server', { messageRetention: '1wk' });
        expect(eff.messageRetention).toBe('1wk');
        expect(eff.attachmentRetention).toBe('1wk');             // still the server default
    });
    it('keeps the account-level saved / unsaved lists', () => {
        expect(sweepPolicyFor(p, 'dm', { messageRetention: '1wk' }).savedMessageIds).toEqual(['saved1']);
    });
    it('AGREES with the chain the countdown and the saved indicator use', () => {
        // resolveChatMessageRetention is what ChatPane's badge and "saved" flag call.
        for (const type of ['dm', 'group', 'server'] as const) {
            for (const ov of [undefined, { messageRetention: '1wk' as const, attachmentRetention: '24h' as const }]) {
                const eff = sweepPolicyFor(p, type, ov);
                expect(eff.messageRetention).toBe(resolveChatMessageRetention(p, type, ov?.messageRetention));
                expect(eff.attachmentRetention).toBe(resolveChatAttachmentRetention(p, type, ov?.attachmentRetention));
            }
        }
    });
});

describe('pinnedIdsForChannel', () => {
    it('unions personal saves and server saves, tolerating either being absent', () => {
        expect([...pinnedIdsForChannel(['a'], ['b', 'a'])].sort()).toEqual(['a', 'b']);
        expect(pinnedIdsForChannel(undefined, undefined).size).toBe(0);
        expect([...pinnedIdsForChannel(undefined, ['z'])]).toEqual(['z']);
    });
});

describe('the purge-now flows protect pins (they used to delete them)', () => {
    const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
    const old = { id: 'pinned-old', timestamp: NOW - 40 * 24 * 3600_000, content: { type: 'text', text: 'keep me' } };
    const gone = { id: 'plain-old', timestamp: NOW - 40 * 24 * 3600_000, content: { type: 'text', text: 'drop me' } };

    it('a server-saved message survives a per-server "Purge now" and is not tombstoned', () => {
        const pol = sweepPolicyFor(base(), 'server', { messageRetention: '1wk', attachmentRetention: '1wk' });
        const pinned = pinnedIdsForChannel([], ['pinned-old']);
        const out = sweepRetention({ ch: [old, gone] }, pol, NOW, { ch: pinned });
        expect(out.prunedState.ch.map(m => m.id)).toEqual(['pinned-old']);
        expect(out.purgedMessageIds).toEqual({ ch: ['plain-old'] });
    });

    it('WITHOUT the pin set (the old purge-now behaviour) the saved message is lost', () => {
        const pol = sweepPolicyFor(base(), 'server', { messageRetention: '1wk', attachmentRetention: '1wk' });
        const out = sweepRetention({ ch: [old, gone] }, pol, NOW);
        expect(out.purgedMessageIds.ch).toContain('pinned-old');       // documents why the pin set is mandatory
    });
});

describe('serverRetentionKey', () => {
    it('matches the key ServerMemberOptionsModal writes and backupRegistry classifies', () => {
        expect(serverRetentionKey('u1', 's1')).toBe('cipherline_server_retention_u1_s1');
    });
});
