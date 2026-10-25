import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveKeyRequestsPass, wholeRequestPhases, type PendingKeyRequest, type ServePassDeps } from './keyServePass';
import { DeliveryLedger, HandshakeBackoff, SingleFlight, latestFirstPhases } from './keyDistributionThrottle';

/**
 * With POST key-handshake/batch a channel's whole history rides ONE call, so a
 * pass serves each request whole (newest first inside it) instead of every
 * request's newest epoch first and then every request's history — which, with
 * batching, would only double the calls for the same outcome.
 */

const req = (channel: string): PendingKeyRequest => ({
    request_id: `r-${channel}`, channel_id: channel, requester_user_id: 'u', requester_device_id: 'jd', created_at: '2026-10-20T18:00:00.000Z',
});

function pass(batched: boolean | undefined) {
    const calls: { channel: string; epochs: number[] }[] = [];
    const deps: ServePassDeps = {
        listPending: async () => [req('a'), req('b'), req('c')],
        listHeldEpochs: async () => [1, 2, 3, 4],
        getMemberDevices: async () => [{ device_id: 'jd', spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }],
        refreshProtectedEpochs: async () => new Map(),
        distribute: async (_s, cid, epochs) => { calls.push({ channel: cid, epochs }); return { status: 'done', posted: 1 }; },
        backoff: new HandshakeBackoff(), ledger: new DeliveryLedger(), flight: new SingleFlight(),
        scheduleResume: () => {}, answered: new Set(), seenAt: new Map(), owed: new Map(), now: Date.now,
        relist: false,
        ...(batched === undefined ? {} : { batched: () => batched }),
    };
    return { deps, calls };
}

describe('serve pass with batching', () => {
    it('one call per request, all its epochs, newest first', async () => {
        const { deps, calls } = pass(true);
        await serveKeyRequestsPass(deps, 's');
        expect(calls).toEqual([
            { channel: 'a', epochs: [4, 3, 2, 1] },
            { channel: 'b', epochs: [4, 3, 2, 1] },
            { channel: 'c', epochs: [4, 3, 2, 1] },
        ]);
    });

    it('CONTROL — without it (or with an API that 404s the batch route): newest of every request first, then history', async () => {
        for (const b of [undefined, false]) {
            const { deps, calls } = pass(b);
            await serveKeyRequestsPass(deps, 's');
            expect(calls.map(c => c.epochs.length)).toEqual([1, 1, 1, 3, 3, 3]);
        }
    });

    it('wholeRequestPhases keeps each item whole and drops empty ones; latestFirstPhases splits', () => {
        const items = [{ epochs: [1, 3, 2, 3] }, { epochs: [] as number[] }];
        expect(wholeRequestPhases(items).map(p => p.epochs)).toEqual([[3, 2, 1]]);
        expect(latestFirstPhases(items).map(p => p.epochs)).toEqual([[3], [2, 1]]);
    });

    it('Dashboard turns it on exactly while the batch route is supported, for the serve pass AND member_join', () => {
        const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        expect(dash.match(/batched: \(\) => !handshakeBatchSupport\.unsupported,/g)?.length).toBe(2);
    });

    it('the serve pass asks for the ROUTED view (only what the API routed to this device, or escalated)', () => {
        const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        const fn = dash.slice(dash.indexOf('const serveKeyRequests = useCallback('));
        expect(fn.slice(0, 1500)).toContain('params: { epochs: 1, routed: 1 },');
    });

    it('member_join asks "did the joiner file requests?" INCLUDING ones routed to another holder (?all=1)', () => {
        const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        const fn = dash.slice(dash.indexOf('void runMemberJoinDistribution({'));
        expect(fn.slice(0, 2000)).toContain('params: { epochs: 1, all: 1, requester, summary: 1 },');
        expect(fn.slice(0, 2200)).toContain('return joinCheckRows(res.data, requester);');
        expect(fn.slice(0, 300)).toContain('listPending: async (sid, requester) => {');
    });

    it('a history ask that FAILED (not throttled) clears its gap back-off, so the next sweep asks again', () => {
        const dash = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        const fn = dash.slice(dash.indexOf('const finishKeyAsk = useCallback('));
        const failed = fn.slice(fn.indexOf("outcome = 'failed';"), fn.indexOf("outcome = 'failed';") + 400);
        expect(failed).toContain('if (ask.askEpochs) gapAskRef.current.delete(channelId);');
    });
});
