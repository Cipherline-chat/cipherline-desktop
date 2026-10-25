import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeholderEpochsWantingKey } from './channelHistoryRetention';
import { channelPlaceholderContent } from './channelDecryptFailure';
import { decideGapReask, gapReaskDelayMs } from './channelKeyDistribution';

/**
 * 2026-10-20, shared prod/staging DB: 88,484 channel-key envelopes relayed in
 * 24 h for 5 joins. 86,971 of them (98%) re-sent a (channel, epoch) the
 * device had ALREADY acked; 81,490 followed a key request the device filed
 * after that ack. The asks came from pages / live messages with a locked row
 * (often an epoch nobody holds any more: three channels there have one since
 * 2026-10-07), re-filed on every open or re-read with NO epochs named — and
 * an ask that names nothing gets every epoch from every holder that answers.
 *
 * Now such an ask names the locked rows' epochs, and a history-only gap is
 * re-asked on the repair sweep's back-off.
 */

const pill = (id: string, epoch?: number, reason: 'key_missing' | 'history_restricted' | 'unverified' = 'key_missing') =>
    ({ id, content: channelPlaceholderContent(reason, epoch) });
const text = (id: string) => ({ id, content: { type: 'text', text: 'x' } });

describe('placeholderEpochsWantingKey', () => {
    it('the epochs of the key-waiting rows, deduped and sorted', () => {
        expect(placeholderEpochsWantingKey([pill('a', 17), text('b'), pill('c', 17), pill('d', 4)] as never)).toEqual([4, 17]);
    });
    it('rows no key will fix are not asked for', () => {
        expect(placeholderEpochsWantingKey([pill('a', 3, 'history_restricted'), pill('b', 5, 'unverified'), pill('c', 9)] as never)).toEqual([9]);
    });
    it('a purged row is not asked for', () => {
        expect(placeholderEpochsWantingKey([pill('a', 3), pill('b', 9)] as never, new Set(['a']))).toEqual([9]);
    });
    it('a waiting row WITHOUT its epoch → undefined (the old "everything" ask is the only honest one)', () => {
        expect(placeholderEpochsWantingKey([pill('a', 3), pill('b')] as never)).toBeUndefined();
    });
    it('nothing waiting → []', () => {
        expect(placeholderEpochsWantingKey([text('a')] as never)).toEqual([]);
    });
});

describe('an orphan history epoch on screen is not re-asked on every open', () => {
    it('same gap: once, then only after the back-off (5 min, doubling)', () => {
        let mem;
        let asks = 0;
        const t0 = 1_000_000;
        // Open / re-read the channel every 30 s for an hour.
        for (let t = t0; t < t0 + 3_600_000; t += 30_000) {
            const d = decideGapReask([17], mem, t);
            mem = d.next;
            if (d.ask) asks++;
        }
        // 0, 5, 15, 35 min → 4 asks in an hour (was: one per minute, 60).
        expect(asks).toBe(4);
        expect(gapReaskDelayMs(4)).toBe(40 * 60_000);
    });
});

describe('wiring (Dashboard): locked rows ask for their epochs', () => {
    const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');

    it('a history page with locked rows asks for exactly their epochs', () => {
        expect(dash).toContain('void channelKeyOpsRef.current.askForRowEpochs(serverId, channelId, placeholderEpochsWantingKey(sorted, purgedIds));');
    });
    it('a live message that could not be decrypted asks for its own epoch', () => {
        expect(dash).toContain("void channelKeyOpsRef.current.askForRowEpochs(evt.server_id, evt.channel_id, typeof evt.epoch === 'number' ? [evt.epoch] : undefined);");
    });
    it('an envelope that would not install re-asks for ITS epoch, not every epoch', () => {
        expect(dash).toContain('maybeFileKeyRequest(serverId, env.channel_id, [env.epoch])');
        expect(dash).not.toMatch(/maybeFileKeyRequest\(serverId, env\.channel_id\);/);
    });
    it('a held-but-stale channel on entry asks for the epochs above what it holds', () => {
        expect(dash).toContain('maybeFileKeyRequest(channel.server_id, channel.channel_id, askableEpochRange(existingEpoch, latestEpoch))');
    });
    it('askForRowEpochs: newer-than-held → asked now; older → the gap back-off (decideGapReask)', () => {
        const fn = dash.slice(dash.indexOf('const askForRowEpochs = useCallback('));
        const body = fn.slice(0, fn.indexOf('}, [maybeFileKeyRequest, keyAskQueue]);'));
        expect(body).toContain('if (missing.some(e => e > newestHeld)) {');
        expect(body).toContain('decideGapReask(missing, gapAskRef.current.get(channelId), Date.now())');
        expect(body).toContain("keyAskQueue.enqueue({ serverId, channelId, priority: 'gap', epochs: missing })");
    });
});
