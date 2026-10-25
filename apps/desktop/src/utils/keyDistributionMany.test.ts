import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    HandshakeBackoff, Pacer, DeliveryLedger, KeyedMutex, SingleFlight, runKeyDistributionMany,
    type KeyDistributionDeps, type DistributionRecipient, type KeyHandshakeBatchBody,
} from './keyDistributionThrottle';
import { serveKeyRequestsPass, groupPhasesByRequester, type PendingKeyRequest, type ServePassDeps } from './keyServePass';

/**
 * 2026-10-20, harness: ten joiners at once needed one key-handshake call per
 * (joiner, channel) — 200 through the API's 3-per-server bulkhead — and that
 * queue set the last joiner's wait (current-epoch p95 ~30 s on one pod). One
 * device's requests for several channels now go out in as few calls as the
 * API takes, every channel's newest epoch first.
 */

const SID = 'srv';
const rcpt = (u: string, d: string): DistributionRecipient => ({ user_id: u, device_id: d, spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers: {} } });

function setup(postBatch?: (b: KeyHandshakeBatchBody) => Promise<unknown>) {
    let t = 1_000_000;
    const now = () => t;
    const singles: { channel: string; epoch: number }[] = [];
    const batches: KeyHandshakeBatchBody[] = [];
    const batchSupport = { unsupported: false };
    const deps: KeyDistributionDeps = {
        backoff: new HandshakeBackoff({ now, random: () => 0 }),
        pacer: new Pacer({ intervalMs: 350, now, sleep: async (ms) => { t += ms; } }),
        ledger: new DeliveryLedger({ now }),
        mutex: new KeyedMutex(),
        getChannelKey: vi.fn(async () => 'KEY'),
        wrap: vi.fn(async ({ channelId, epoch, device }) => `ct-${channelId}-${epoch}-${device.device_id}`),
        post: async (_s, body) => { singles.push({ channel: body.channel_id, epoch: body.epoch }); return {}; },
        postBatch: async (_s, body) => { batches.push(body); return postBatch ? postBatch(body) : {}; },
        batchSupport,
    };
    return { deps, singles, batches, batchSupport };
}
const entry = (channelId: string, n: number, v = `${channelId}@1`) => ({ channelId, epochs: Array.from({ length: n }, (_, i) => i + 1), requestVersion: v });

describe('runKeyDistributionMany', () => {
    it('three channels x five epochs for one device: ONE call, every channel\'s newest epoch first, each item naming its channel', async () => {
        const { deps, batches, singles } = setup();
        const out = await runKeyDistributionMany(deps, { serverId: SID, recipient: [rcpt('u', 'd')], entries: [entry('a', 5), entry('b', 5), entry('c', 5)] });
        expect(out).toEqual({ status: 'done', posted: 1 });
        expect(singles).toHaveLength(0);
        expect(batches).toHaveLength(1);
        expect(batches[0].items.slice(0, 3).map(i => `${i.channel_id}/${i.epoch}`)).toEqual(['a/5', 'b/5', 'c/5']);
        expect(batches[0].items).toHaveLength(15);
        expect(batches[0].items[0].envelopes).toEqual([{ device_id: 'd', ciphertext_b64: 'ct-a-5-d' }]);
    });

    it('the ledger is per channel AND per request version: the same asks again post nothing', async () => {
        const { deps, batches } = setup();
        const args = { serverId: SID, recipient: [rcpt('u', 'd')], entries: [entry('a', 3), entry('b', 3)] };
        await runKeyDistributionMany(deps, args);
        await runKeyDistributionMany(deps, args);
        expect(batches).toHaveLength(1);
    });

    it('more than the API takes in one call → split (≤100 items), newest-of-each still in the first call', async () => {
        const { deps, batches } = setup();
        await runKeyDistributionMany(deps, { serverId: SID, recipient: [rcpt('u', 'd')], entries: Array.from({ length: 8 }, (_, i) => entry(`c${i}`, 15)) });
        expect(batches.map(b => b.items.length)).toEqual([100, 20]);
        expect(new Set(batches[0].items.slice(0, 8).map(i => i.epoch))).toEqual(new Set([15]));
    });

    it('an API without the route (404): falls back to per-channel distribution, nothing lost', async () => {
        const { deps, singles, batchSupport } = setup(async () => { throw httpError(404); });
        const out = await runKeyDistributionMany(deps, { serverId: SID, recipient: [rcpt('u', 'd')], entries: [entry('a', 2), entry('b', 2)] });
        expect(out.status).toBe('done');
        expect(batchSupport.unsupported).toBe(true);
        expect(singles.map(s => `${s.channel}/${s.epoch}`).sort()).toEqual(['a/1', 'a/2', 'b/1', 'b/2']);
    });

    it('a 429 defers (flow control unchanged); the budget counts one per call', async () => {
        const { deps } = setup(async () => { throw httpError(429); });
        const budget = { remaining: 5 };
        const out = await runKeyDistributionMany(deps, { serverId: SID, recipient: [rcpt('u', 'd')], entries: [entry('a', 2), entry('b', 2)], budget });
        expect(out).toMatchObject({ status: 'deferred', reason: 'throttled' });
        expect(budget.remaining).toBe(4);
    });
});

describe('serve pass: one call per requesting DEVICE (with distributeMany)', () => {
    const req = (channel: string, device: string): PendingKeyRequest => ({
        request_id: `r-${channel}-${device}`, channel_id: channel, requester_user_id: `u-${device}`, requester_device_id: device, created_at: '2026-10-20T20:00:00.000Z',
    });
    it('groups each device\'s requests and answers them together', async () => {
        const calls: { device: string; channels: string[] }[] = [];
        const deps: ServePassDeps = {
            listPending: async () => [req('a', 'd1'), req('a', 'd2'), req('b', 'd1'), req('c', 'd1'), req('b', 'd2')],
            listHeldEpochs: async () => [1, 2, 3],
            getMemberDevices: async (_s, uid) => [{ device_id: uid.slice(2), spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }],
            refreshProtectedEpochs: async () => new Map(),
            distribute: async () => { throw new Error('per-channel distribute must not be used'); },
            distributeMany: async (_s, recipient, entries) => { calls.push({ device: recipient[0].device_id, channels: entries.map(e => e.channelId) }); return { status: 'done', posted: 1 }; },
            backoff: new HandshakeBackoff(), ledger: new DeliveryLedger(), flight: new SingleFlight(),
            scheduleResume: () => {}, answered: new Set(), seenAt: new Map(), owed: new Map(), now: Date.now,
            relist: false, batched: () => true,
        };
        await serveKeyRequestsPass(deps, SID);
        expect(calls.map(c => `${c.device}:${c.channels.sort().join(',')}`).sort()).toEqual(['d1:a,b,c', 'd2:a,b']);
    });

    it('groupPhasesByRequester keeps first-appearance order and makes each device\'s items adjacent', () => {
        const ph = (d: string, c: string) => ({ item: { req: { requester_device_id: d, channel_id: c } } });
        const out = groupPhasesByRequester([ph('x', '1'), ph('y', '1'), ph('x', '2'), ph('y', '2'), ph('z', '1')]);
        expect(out.map(p => `${p.item.req.requester_device_id}${p.item.req.channel_id}`)).toEqual(['x1', 'x2', 'y1', 'y2', 'z1']);
    });

    it('Dashboard passes distributeMany (runKeyDistributionMany with the session\'s batch support)', () => {
        const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        expect(dash).toContain('distributeMany: distributeChannelKeysMany,');
        const fn = dash.slice(dash.indexOf('const distributeChannelKeysMany = useCallback('));
        expect(fn.slice(0, 3000)).toContain('return runKeyDistributionMany({');
        expect(fn.slice(0, 3000)).toContain('batchSupport: handshakeBatchSupport,');
        // the wrap uses the CHANNEL OF THE ITEM, not a closed-over one
        expect(fn.slice(0, 3000)).toContain('wrap: async ({ channelId, epoch, keyB64, device: dev }) => {');
    });
});
