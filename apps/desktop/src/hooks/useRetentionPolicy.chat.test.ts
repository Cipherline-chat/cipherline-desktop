import { describe, it, expect } from 'vitest';
import { resolveChatMessageRetention, resolveChatAttachmentRetention } from './useRetentionPolicy';
import type { StoragePolicy } from './useRetentionPolicy';

const policy = (over: Partial<StoragePolicy> = {}): StoragePolicy => ({
    messageRetention: 'never',
    attachmentRetention: 'never',
    savedMessageIds: [], unsavedMessageIds: [], savedAttachmentIds: [], unsavedAttachmentIds: [],
    ...over,
} as StoragePolicy);

describe('resolveChatMessageRetention — one chain for countdown, sweep and the "saved" indicator', () => {
    it('a DM with its own shorter retention is NOT "never" even when the global setting is keep-forever', () => {
        // This is the reported bug: global "never" made every DM message (GIFs included)
        // read as saved while the sweep and the countdown were about to expire it.
        expect(resolveChatMessageRetention(policy({ dmMessageRetention: '1wk' } as Partial<StoragePolicy>), 'dm')).toBe('1wk');
    });

    it('falls back to the global setting when the chat type has no override of its own', () => {
        expect(resolveChatMessageRetention(policy({ messageRetention: '1mo' }), 'group')).toBe('1mo');
        expect(resolveChatMessageRetention(policy({ messageRetention: '1mo' }), undefined)).toBe('1mo');
    });

    it('a per-server override beats the per-type default', () => {
        const p = policy({ serverMessageRetention: '1mo' } as Partial<StoragePolicy>);
        expect(resolveChatMessageRetention(p, 'server', '1wk')).toBe('1wk');
        expect(resolveChatMessageRetention(p, 'server', null)).toBe('1mo');
    });

    it('attachments follow the same chain', () => {
        const p = policy({ dmAttachmentRetention: '1wk' } as Partial<StoragePolicy>);
        expect(resolveChatAttachmentRetention(p, 'dm')).toBe('1wk');
        expect(resolveChatAttachmentRetention(p, 'group')).toBe('never');
    });
});
