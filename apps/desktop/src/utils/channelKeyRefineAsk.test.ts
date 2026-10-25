import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineQueuedAsk, KEY_ASK_DUP_GUARD_MS, type QueuedAsk } from './channelKeyPrefetch';

/**
 * 2026-10-20, channel-key harness (leave-then-join): a member joining 1 s after
 * another left got each channel's NEW epoch from the rotation itself (the
 * rotator's recipient list was fetched after the join). Its queued
 * "everything" asks then found the newest epoch held and were dropped as
 * moot — taking the history gap the repair sweep had merged into them along
 * — and the sweep's own gap ask had been swallowed by the 60 s dedup. 13 of 20
 * channels never received their history.
 */

const NOW = 1_000_000;
const ask = (a: Partial<QueuedAsk>): QueuedAsk => ({ serverId: 's', channelId: 'c', priority: 'keyless', ...a });

describe('refineQueuedAsk', () => {
    it('everything-ask, newest arrived meanwhile, known gap → becomes the gap ask (what is still missing)', () => {
        expect(refineQueuedAsk(ask({ targetEpoch: 16 }), { heldEpochs: [16, 3], knownGap: [1, 2, 3, 4], now: NOW }))
            .toEqual({ send: true, epochs: [1, 2, 4] });
    });

    it('CONTROL — everything-ask, newest arrived, no known gap → moot (as before)', () => {
        expect(refineQueuedAsk(ask({ targetEpoch: 16 }), { heldEpochs: [16], now: NOW })).toEqual({ send: false });
    });

    it('everything-ask still short of its target → sent as everything', () => {
        expect(refineQueuedAsk(ask({ targetEpoch: 16 }), { heldEpochs: [], now: NOW })).toEqual({ send: true });
    });

    it('everything-ask that another path made moments ago → moot; a forced one is not', () => {
        const ctx = { heldEpochs: [], lastAskedAt: NOW - KEY_ASK_DUP_GUARD_MS + 1, now: NOW };
        expect(refineQueuedAsk(ask({}), ctx)).toEqual({ send: false });
        expect(refineQueuedAsk(ask({ priority: 'forced' }), ctx)).toEqual({ send: true });
    });

    it('a precise ask is judged on what it names — a recent everything-ask elsewhere does NOT make it moot', () => {
        const r = refineQueuedAsk(ask({ priority: 'gap', epochs: [1, 2, 3] }), { heldEpochs: [2], lastAskedAt: NOW - 1, now: NOW });
        expect(r).toEqual({ send: true, epochs: [1, 3] });
        expect(refineQueuedAsk(ask({ priority: 'gap', epochs: [2] }), { heldEpochs: [2], now: NOW })).toEqual({ send: false });
    });

    it('the repair sweep enqueues its first gap ask without the 60 s dedup (decideGapReask is its limit)', () => {
        const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        const gap = dash.slice(dash.indexOf('if (gap.ask) {'));
        expect(gap.slice(0, 1500)).toContain("keyAskQueue.enqueue({ serverId, channelId: c.channel_id, priority: 'gap', epochs: [...missingEpochs] });");
        expect(gap.slice(0, 1500)).not.toContain('>= 60_000');
    });
});
