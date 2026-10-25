import { describe, it, expect } from 'vitest';
import {
    planKeyPrefetch,
    PrefetchLedger,
    KeyAskLimiter,
    KeyAskQueue,
    askableEpochRange,
    requestEpochList,
    mergeAskEpochs,
    KEY_REQUEST_EPOCHS_MAX,
    type QueuedAsk,
} from './channelKeyPrefetch';
import { serveKeyRequestsPass, epochsToServe, type PendingKeyRequest, type ServePassDeps } from './keyServePass';
import { DeliveryLedger, HandshakeBackoff, SingleFlight, keyRequestVersion } from './keyDistributionThrottle';
import { Permissions } from '@cipherline/shared';

/**
 * Precise key asks (2026-10-19). An ask names what the device is missing;
 * holders send only that. See channelKeyAskChurn.test.ts for the day-long
 * before/after, and the API's channel-key-request-epochs.spec.ts for the
 * server half (stored, merged, fulfilled per epoch, listed to old holders only
 * as long as an old request would have lived).
 */

const VIEW = Permissions.VIEW_CHANNEL.toString();

describe('askableEpochRange / requestEpochList / mergeAskEpochs', () => {
    it('a stale device asks for every epoch above the newest it holds', () => {
        expect(askableEpochRange(18, 21)).toEqual([19, 20, 21]);
        expect(askableEpochRange(20, 21)).toEqual([21]);
    });
    it('never more than the API accepts — the NEWEST are kept', () => {
        const r = askableEpochRange(1, 500);
        expect(r).toHaveLength(KEY_REQUEST_EPOCHS_MAX);
        expect(r[r.length - 1]).toBe(500);
        expect(requestEpochList(Array.from({ length: 150 }, (_, i) => i + 1))).toHaveLength(KEY_REQUEST_EPOCHS_MAX);
    });
    it('cleans a list for the wire (ints ≥ 1, deduped, ascending); empty → "everything"', () => {
        expect(requestEpochList([17, 3, 17, 0, -2, 1.5])).toEqual([3, 17]);
        expect(requestEpochList([])).toBeUndefined();
        expect(requestEpochList(undefined)).toBeUndefined();
    });
    it('merging: "everything" absorbs a list; two lists union', () => {
        expect(mergeAskEpochs([17], undefined)).toBeUndefined();
        expect(mergeAskEpochs(undefined, [17])).toBeUndefined();
        expect(mergeAskEpochs([21], [17])).toEqual([17, 21]);
    });
});

describe('planKeyPrefetch names the epochs of a stale channel, never of a keyless one', () => {
    const plan = (held: Record<string, number | null>) => planKeyPrefetch({
        serverId: 's',
        channels: [
            { channel_id: 'stale', kind: 'text', latest_epoch: 21, my_permissions: VIEW },
            { channel_id: 'keyless', kind: 'text', latest_epoch: 21, my_permissions: VIEW },
            { channel_id: 'fine', kind: 'text', latest_epoch: 21, my_permissions: VIEW },
        ],
        held,
        ledger: new PrefetchLedger(),
        lastAskedAt: () => undefined,
        isQueued: () => false,
        now: 10_000_000,
        mode: 'event',
    });

    it('stale → [held+1 … latest]; keyless → every epoch (history included); held-newest → nothing', () => {
        const p = plan({ stale: 18, keyless: null, fine: 21 });
        const byId = Object.fromEntries(p.asks.map(a => [a.channelId, a]));
        expect(byId.stale.epochs).toEqual([19, 20, 21]);
        expect(byId.keyless.epochs).toBeUndefined();
        expect(byId.fine).toBeUndefined();
        expect(p.satisfied).toEqual(['fine']);
    });
});

describe('KeyAskQueue carries the epochs, merging them per channel', () => {
    const queueWith = (asks: QueuedAsk[]) => {
        const sent: QueuedAsk[] = [];
        // The bucket is full for the first look, so both asks are queued
        // before the worker sends anything (as behind a real 60/min bucket).
        let looks = 0;
        const limiter = { waitMs: () => (looks++ === 0 ? 1_000 : 0) } as unknown as KeyAskLimiter;
        const q = new KeyAskQueue({
            limiter,
            send: async (a) => { sent.push({ ...a }); return 'sent'; },
            now: () => 0,
            sleep: async () => {},
        });
        for (const a of asks) q.enqueue(a);
        return { q, sent };
    };

    it('a gap ask and a stale ask for one channel → ONE request naming both', async () => {
        const { q, sent } = queueWith([
            { serverId: 's', channelId: 'c', priority: 'gap', epochs: [17] },
            { serverId: 's', channelId: 'c', priority: 'stale', targetEpoch: 21, epochs: [21] },
        ]);
        await q.whenIdle();
        expect(sent).toHaveLength(1);
        expect(sent[0].epochs).toEqual([17, 21]);
        expect(sent[0].priority).toBe('stale');
    });

    it('an "everything" ask for the same channel absorbs the list', async () => {
        const { q, sent } = queueWith([
            { serverId: 's', channelId: 'c', priority: 'gap', epochs: [17] },
            { serverId: 's', channelId: 'c', priority: 'forced' },
        ]);
        await q.whenIdle();
        expect(sent).toHaveLength(1);
        expect(sent[0].epochs).toBeUndefined();
    });
});

describe('serve pass: a holder sends only the epochs a request names', () => {
    const req = (channel: string, epochs?: number[] | null): PendingKeyRequest => ({
        request_id: `r-${channel}`, channel_id: channel, requester_user_id: 'u', requester_device_id: 'jd',
        created_at: '2026-10-19T00:00:00.000Z', ...(epochs !== undefined ? { epochs } : {}),
    });
    const passDeps = (pending: PendingKeyRequest[], held: number[]) => {
        const sent: string[] = [];
        let deviceLookups = 0;
        const deps: ServePassDeps = {
            listPending: async () => pending,
            listHeldEpochs: async () => held,
            getMemberDevices: async () => { deviceLookups += 1; return [{ device_id: 'jd', spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }]; },
            refreshProtectedEpochs: async () => new Map(),
            distribute: async (_s, cid, epochs, recipients, _r, opts) => {
                for (const e of epochs) { sent.push(`${cid}:${e}`); deps.ledger.record(cid, e, recipients[0].device_id, opts?.requestVersion); }
                return { status: 'done', posted: epochs.length };
            },
            backoff: new HandshakeBackoff(),
            ledger: new DeliveryLedger(),
            flight: new SingleFlight(),
            scheduleResume: () => {},
            answered: new Set(),
            seenAt: new Map(),
            owed: new Map(),
            now: Date.now,
        };
        return { deps, sent, lookups: () => deviceLookups };
    };

    it('epochsToServe: a list → the held ones it names; null / absent → everything held', () => {
        expect(epochsToServe([1, 2, 3, 20], [17, 20])).toEqual([20]);
        expect(epochsToServe([1, 2, 3], null)).toEqual([1, 2, 3]);
        expect(epochsToServe([1, 2, 3], undefined)).toEqual([1, 2, 3]);
    });

    it('a gap request for an epoch this holder has: exactly that epoch goes out', async () => {
        const { deps, sent } = passDeps([req('c', [17])], Array.from({ length: 20 }, (_, i) => i + 1));
        await serveKeyRequestsPass(deps, 's');
        expect(sent).toEqual(['c:17']);
    });

    it('a gap request for an epoch NOBODY online has: nothing goes out, no device lookup, marked answered', async () => {
        const r = req('c', [17]);
        const { deps, sent, lookups } = passDeps([r], [1, 2, 3, 18, 19, 20]);
        await serveKeyRequestsPass(deps, 's');
        expect(sent).toEqual([]);
        expect(lookups()).toBe(0);
        expect(deps.answered.has(keyRequestVersion(r))).toBe(true);
    });

    it('CONTROL — a request that names nothing (old requester / old API) still gets every held epoch, newest first', async () => {
        const { deps, sent } = passDeps([req('c')], [1, 2, 3]);
        await serveKeyRequestsPass(deps, 's');
        expect(sent).toEqual(['c:3', 'c:2', 'c:1']);
    });
});
