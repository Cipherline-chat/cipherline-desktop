import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderEnvelopesForInstall } from './channelKeyEnvelopes';

/**
 * 2026-10-20: a joiner acked its key envelopes in waves at +4, +8, +15, +32,
 * +104 and +200 s (one wave per pull, ~0.5 s per envelope on that machine).
 * The API lists the backlog by epoch number across ALL channels, so channel A's
 * history (epoch 20) was installed before channel B's newest (epoch 4), and no
 * request closed until its pull finished — every holder kept answering them.
 */

const env = (channel_id: string, epoch: number, id = `${channel_id}:${epoch}`) => ({ envelope_id: id, channel_id, epoch });

describe('orderEnvelopesForInstall', () => {
    it('every channel\'s newest epoch leads, then history newest-first', () => {
        // API order: epoch DESC across channels.
        const api = [env('A', 20), env('A', 19), env('A', 18), env('B', 4), env('B', 3), env('C', 12)];
        const { ordered, newestCount } = orderEnvelopesForInstall(api);
        expect(ordered.map(e => e.envelope_id)).toEqual(['A:20', 'B:4', 'C:12', 'A:19', 'A:18', 'B:3']);
        expect(newestCount).toBe(3);
    });

    it('several copies of a newest epoch all count as newest (in API order)', () => {
        const { ordered, newestCount } = orderEnvelopesForInstall([env('A', 5, 'x'), env('A', 5, 'y'), env('A', 4)]);
        expect(ordered.map(e => e.envelope_id)).toEqual(['x', 'y', 'A:4']);
        expect(newestCount).toBe(2);
    });

    it('empty and single inputs', () => {
        expect(orderEnvelopesForInstall([])).toEqual({ ordered: [], newestCount: 0 });
        expect(orderEnvelopesForInstall([env('A', 1)]).newestCount).toBe(1);
    });

    it('does not mutate its input', () => {
        const api = [env('A', 1), env('A', 2)];
        orderEnvelopesForInstall(api);
        expect(api.map(e => e.epoch)).toEqual([1, 2]);
    });
});

describe('wiring: the pull installs in that order and acks the newest before history', () => {
    const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
    const pull = dash.slice(dash.indexOf('const pullChannelKeysOnce = useCallback('), dash.indexOf('const [keyPullFlight]'));

    it('walks orderEnvelopesForInstall(envelopes), not the raw list', () => {
        expect(pull).toContain('const { ordered, newestCount } = orderEnvelopesForInstall(envelopes);');
        expect(pull).not.toContain('for (const env of envelopes)');
    });

    it('flushes the acks collected so far when the history part begins', () => {
        const at = pull.indexOf('if (envIdx === newestCount && ackIds.length) {');
        expect(at).toBeGreaterThan(0);
        expect(pull.slice(at, at + 200)).toContain('await ackInBatches(ackIds.splice(0, ackIds.length), postAcks);');
    });
});
