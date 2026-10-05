import { describe, it, expect } from 'vitest';
import { sweepRetention } from './retentionSweeper';
import type { StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * A KLIPY GIF message is MEDIA: it ages with the chat's ATTACHMENT window, not
 * its message window (owner's call, 2026-10-03). Saved / unsaved is still
 * tracked by message id, since a GIF has no attachment id and no blob.
 */

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const policy = (over: Partial<StoragePolicy> = {}): StoragePolicy => ({
    messageRetention: '1wk',
    attachmentRetention: '1wk',
    savedMessageIds: [],
    unsavedMessageIds: [],
    savedAttachmentIds: [],
    unsavedAttachmentIds: [],
    ...over,
} as StoragePolicy);

const gif = (id: string, ageHours: number) => ({
    id,
    timestamp: NOW - ageHours * HOUR,
    content: { type: 'klipy_gif' },
});

describe('sweepRetention — klipy_gif follows the ATTACHMENT window', () => {
    it('expires an old GIF on the attachment schedule, and keeps a fresh one', () => {
        const out = sweepRetention({ c1: [gif('old', 24 * 8), gif('fresh', 1)] }, policy(), NOW);
        expect(out.prunedState.c1.map(m => m.id)).toEqual(['fresh']);
        expect(out.purgedMessageIds).toEqual({ c1: ['old'] });
    });

    it('ignores the MESSAGE window: text expiring in a week does not take a month-window GIF with it', () => {
        const p = policy({ messageRetention: '1wk', attachmentRetention: '1mo' });
        const out = sweepRetention({ c1: [gif('g', 24 * 10), { id: 't', timestamp: NOW - 24 * 10 * HOUR, content: { type: 'text' } }] }, p, NOW);
        expect(out.prunedState.c1.map(m => m.id)).toEqual(['g']);
    });

    it('and the other way round: attachments on 1 week drop a GIF even when messages are Forever', () => {
        const p = policy({ messageRetention: 'never', attachmentRetention: '1wk' });
        const out = sweepRetention({ c1: [gif('g', 24 * 10)] }, p, NOW);
        expect(out.prunedState.c1).toEqual([]);
    });

    it('attachments Forever keeps every GIF, however old', () => {
        const out = sweepRetention({ c1: [gif('g', 24 * 400)] }, policy({ messageRetention: '1wk', attachmentRetention: 'never' }), NOW);
        expect(out.prunedState.c1.map(m => m.id)).toEqual(['g']);
    });

    it('keeps a GIF message the user saved, however old', () => {
        const out = sweepRetention({ c1: [gif('saved', 24 * 30)] }, policy({ savedMessageIds: ['saved'] }), NOW);
        expect(out.prunedState.c1.map(m => m.id)).toEqual(['saved']);
    });

    it('an unsaved GIF gets the 24 h grace on top of the attachment window', () => {
        const p = policy({ unsavedMessageIds: ['u'], unsavedMessageTimestamps: { u: NOW - 2 * HOUR } });
        const out = sweepRetention({ c1: [gif('u', 24 * 30)] }, p, NOW);
        expect(out.prunedState.c1.map(m => m.id)).toEqual(['u']);
    });
});
