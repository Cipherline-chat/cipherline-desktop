import { describe, it, expect } from 'vitest';
import { sweepRetention } from './retentionSweeper';
import type { StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * `purgedMessageIds` is the half of the retention sweep that was missing.
 *
 * Dropping a row from the local cache is enough for a DM — the envelope is
 * poll-then-ACK and the server deleted it on ACK. It is NOT enough for a server
 * channel, whose `channel_messages` row outlives the cache: unless the sweeper
 * reports WHAT it deleted, the next `GET /v1/channels/:id/messages` hands the
 * same row back and foldChannelHistory reads "not cached" as "new".
 *
 * These cover the report shape only; the merge-side behaviour is in
 * channelHistoryMerge.test.ts and the store is retentionTombstones.ts.
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

const text = (id: string, ageHours: number) => ({
    id,
    timestamp: NOW - ageHours * HOUR,
    content: { type: 'text', text: id },
});

const attachment = (id: string, attId: string, ageHours: number) => ({
    id,
    timestamp: NOW - ageHours * HOUR,
    content: { type: 'attachment', attachment_id: attId, filename: `${attId}.png` },
});

describe('sweepRetention — purgedMessageIds', () => {
    it('reports nothing when nothing expired', () => {
        const state = { c1: [text('a', 1), attachment('b', 'att-b', 1)] };
        const out = sweepRetention(state, policy(), NOW);
        expect(out.prunedState).toBe(state);           // identity bail-out preserved
        expect(out.purgedMessageIds).toEqual({});
        expect(out.attachmentsToDelete).toEqual([]);
    });

    it('reports the id of an expired attachment message alongside its attachment id', () => {
        // 8 days old, policy is 1 week.
        const state = { c1: [text('keep', 1), attachment('old', 'att-old', 24 * 8)] };
        const out = sweepRetention(state, policy(), NOW);

        expect(out.prunedState.c1.map(m => m.id)).toEqual(['keep']);
        expect(out.attachmentsToDelete).toEqual(['att-old']);
        // Both halves must be reported: the blob id for the DELETE, the message
        // id for the tombstone. Reporting only the first is the original bug.
        expect(out.purgedMessageIds).toEqual({ c1: ['old'] });
    });

    it('reports expired plain text and system/call_event rows too', () => {
        const state = {
            c1: [
                text('t', 24 * 8),
                { id: 's', timestamp: NOW - 24 * 8 * HOUR, content: { type: 'system', text: 'joined' } },
                { id: 'ce', timestamp: NOW - 24 * 8 * HOUR, content: { type: 'call_event', event: 'ended' } },
                text('fresh', 1),
            ],
        };
        const out = sweepRetention(state, policy(), NOW);
        expect(out.prunedState.c1.map(m => m.id)).toEqual(['fresh']);
        expect(out.purgedMessageIds.c1.sort()).toEqual(['ce', 's', 't']);
    });

    it('reports per conversation, and only for conversations that changed', () => {
        const state = {
            c1: [attachment('old1', 'att-1', 24 * 8)],
            c2: [text('recent', 1)],
        };
        const out = sweepRetention(state, policy(), NOW);
        expect(out.purgedMessageIds).toEqual({ c1: ['old1'] });
        expect(out.purgedMessageIds.c2).toBeUndefined();
        expect(out.prunedState.c2).toBe(state.c2);
    });

    it('never reports a pinned message — pin is save-forever, so nothing is purged', () => {
        const state = { c1: [attachment('pinned', 'att-p', 24 * 30)] };
        const out = sweepRetention(state, policy(), NOW, { c1: new Set(['pinned']) });
        expect(out.purgedMessageIds).toEqual({});
        expect(out.attachmentsToDelete).toEqual([]);
    });

    it('never reports a saved attachment or a saved message', () => {
        const state = {
            c1: [attachment('savedAtt', 'att-s', 24 * 30), text('savedMsg', 24 * 30)],
        };
        const out = sweepRetention(
            state,
            policy({ savedAttachmentIds: ['att-s'], savedMessageIds: ['savedMsg'] }),
            NOW,
        );
        expect(out.purgedMessageIds).toEqual({});
    });

    it('reports an explicitly-unsaved attachment once its 24h grace has elapsed', () => {
        const state = { c1: [attachment('u', 'att-u', 24 * 30)] };
        const unsavedAt = NOW - 25 * HOUR;
        const out = sweepRetention(
            state,
            policy({
                attachmentRetention: 'never',
                unsavedAttachmentIds: ['att-u'],
                unsavedAttachmentTimestamps: { 'att-u': unsavedAt },
            } as Partial<StoragePolicy>),
            NOW,
        );
        expect(out.attachmentsToDelete).toEqual(['att-u']);
        expect(out.purgedMessageIds).toEqual({ c1: ['u'] });
    });

    it('drops an id-less expired row without inventing a tombstone for it', () => {
        // An un-identifiable row cannot be re-matched on a later fetch either,
        // so there is nothing to record — but it must still be swept.
        const state = { c1: [{ timestamp: NOW - 24 * 8 * HOUR, content: { type: 'text', text: 'x' } }] };
        const out = sweepRetention(state, policy(), NOW);
        expect(out.prunedState.c1).toEqual([]);
        expect(out.purgedMessageIds).toEqual({});
    });
});
