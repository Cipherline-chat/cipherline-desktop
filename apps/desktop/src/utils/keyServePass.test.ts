import { describe, it, expect, vi } from 'vitest';
import {
    answeredElsewhere,
    rotateWalk,
    walkOffsetFor,
    pickServeJitterMs,
    pickJoinHandoffDelayMs,
    runMemberJoinDistribution,
    joinCheckRows,
    serveKeyRequestsPass,
    JOIN_HANDOFF_MIN_MS,
    JOIN_HANDOFF_RECHECK_MS,
    JOIN_HANDOFF_LAST_CHECK_MS,
    JOIN_HANDOFF_FINAL_CHECK_MS,
    type MemberJoinDeps,
    type PendingKeyRequest,
    type ServePassDeps,
} from './keyServePass';
import { DeliveryLedger, HandshakeBackoff, SingleFlight, keyRequestVersion } from './keyDistributionThrottle';

/**
 * Holder side, first responder wins (2026-10-11). The pass itself kept its
 * 1.0.21 behaviour (pinned by the wiring tests that now read this module);
 * these pin what is new: dropping a request another holder answered, the
 * per-device walk offset, and member_join handing off to the request path.
 */

const req = (channel: string, device = 'jd', created = '2026-10-11T20:00:00.000Z'): PendingKeyRequest => ({
    request_id: `r-${channel}-${device}`, channel_id: channel, requester_user_id: 'joiner', requester_device_id: device, created_at: created,
});

describe('answeredElsewhere', () => {
    const ledger = new DeliveryLedger();
    ledger.record('mine', 5, 'jd', 'v');

    it('still open → keep serving', () => {
        expect(answeredElsewhere({ channelId: 'x', deviceId: 'jd', newestEpoch: 5, openTargets: new Set(['x:jd']), owed: false, ledger })).toBe(false);
    });

    it('closed and we never delivered its newest epoch → someone else answered: drop it', () => {
        expect(answeredElsewhere({ channelId: 'x', deviceId: 'jd', newestEpoch: 5, openTargets: new Set(), owed: false, ledger })).toBe(true);
    });

    it('closed on OUR newest epoch → its history is ours to finish', () => {
        expect(answeredElsewhere({ channelId: 'mine', deviceId: 'jd', newestEpoch: 5, openTargets: new Set(), owed: false, ledger })).toBe(false);
    });

    it('owed history (a stopped pass of ours) is never dropped', () => {
        expect(answeredElsewhere({ channelId: 'x', deviceId: 'jd', newestEpoch: 5, openTargets: new Set(), owed: true, ledger })).toBe(false);
    });
});

describe('walk order', () => {
    it('is the channel-sorted list rotated to a per-device start (no coordination needed)', () => {
        const items = ['c', 'a', 'd', 'b'].map(c => ({ req: req(c) }));
        expect(rotateWalk(items, 0).map(i => i.req.channel_id)).toEqual(['a', 'b', 'c', 'd']);
        expect(rotateWalk(items, 2).map(i => i.req.channel_id)).toEqual(['c', 'd', 'a', 'b']);
        expect(rotateWalk(items, 6).map(i => i.req.channel_id)).toEqual(['c', 'd', 'a', 'b']);
        expect(rotateWalk([], 3)).toEqual([]);
    });

    it('walkOffsetFor is stable per device and differs between devices', () => {
        expect(walkOffsetFor('dev-1')).toBe(walkOffsetFor('dev-1'));
        const offsets = new Set(['dev-1', 'dev-2', 'dev-3', 'dev-4'].map(d => walkOffsetFor(d) % 97));
        expect(offsets.size).toBeGreaterThan(1);
    });
});

describe('jitters', () => {
    it('serve jitter is 150 ms – 1.2 s; join hand-off waits 1 – 2 s', () => {
        expect(pickServeJitterMs(() => 0)).toBe(150);
        expect(pickServeJitterMs(() => 0.9999)).toBeLessThanOrEqual(1_200);
        expect(pickJoinHandoffDelayMs(() => 0)).toBe(JOIN_HANDOFF_MIN_MS);
        expect(pickJoinHandoffDelayMs(() => 0.9999)).toBeLessThan(2_000);
    });
});

function joinDeps(pendingSeq: (PendingKeyRequest[] | Error)[]): { deps: MemberJoinDeps; calls: { serve: number; distribute: string[]; sleeps: number[] } } {
    const calls = { serve: 0, distribute: [] as string[], sleeps: [] as number[] };
    let i = 0;
    const deps: MemberJoinDeps = {
        sleep: async ms => { calls.sleeps.push(ms); },
        random: () => 0,
        listPending: async () => {
            const next = pendingSeq[Math.min(i++, pendingSeq.length - 1)];
            if (next instanceof Error) throw next;
            return next;
        },
        serve: async () => { calls.serve += 1; },
        getMemberDevices: async () => [{ device_id: 'jd', spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }],
        listChannels: async () => [{ channel_id: 'c1', kind: 'text' }, { channel_id: 'c2', kind: 'text' }],
        carriesSenderKeys: () => true,
        refreshProtectedEpochs: async () => new Map(),
        listHeldEpochs: async () => [1, 2],
        distribute: async (_s, channelId, epochs) => { calls.distribute.push(`${channelId}:${epochs.join(',')}`); return { status: 'done', posted: 1 }; },
    };
    return { deps, calls };
}

describe('runMemberJoinDistribution — hand off to the request path', () => {
    it('the joiner asked but the API routed it all to another holder (serve_now false): no empty pass', async () => {
        const { deps, calls } = joinDeps([[{ ...req('c1'), serve_now: false }, { ...req('c2'), serve_now: false }]]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
        expect(calls.serve).toBe(0);
        expect(calls.distribute).toEqual([]);
    });

    it('any of them ours to answer now (or an API that does not say) → the pass runs', async () => {
        const mixed = joinDeps([[{ ...req('c1'), serve_now: false }, { ...req('c2'), serve_now: true }]]);
        expect(await runMemberJoinDistribution(mixed.deps, 's', 'joiner')).toBe('handoff');
        expect(mixed.calls.serve).toBe(1);
    });

    it('a device that holds no key of the server (it just joined too) does nothing at all', async () => {
        const { deps, calls } = joinDeps([[req('c1')]]);
        let listed = 0;
        const list = deps.listPending;
        deps.listPending = async (sid, r) => { listed++; return list(sid, r); };
        deps.holdsNoKeys = async () => true;
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('nothing_held');
        expect([listed, calls.serve, calls.distribute.length, calls.sleeps.length]).toEqual([0, 0, 0, 0]);
    });

    it('holds keys (or cannot tell) → the hand-off runs as before', async () => {
        for (const holdsNoKeys of [async () => false, async () => { throw new Error('ipc'); }]) {
            const { deps, calls } = joinDeps([[req('c1')]]);
            deps.holdsNoKeys = holdsNoKeys;
            expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
            expect(calls.serve).toBe(1);
        }
    });

    it('asks the API about the JOINER\'s requests only (it may narrow the listing to them)', async () => {
        const { deps } = joinDeps([[req('c1')]]);
        const asked: string[] = [];
        const list = deps.listPending;
        deps.listPending = async (sid, requester) => { asked.push(`${sid}:${requester}`); return list(sid, requester); };
        await runMemberJoinDistribution(deps, 's', 'joiner');
        expect(asked).toEqual(['s:joiner']);
    });

    it('the joiner has asked → ONE serve pass, no blind push of every epoch', async () => {
        const { deps, calls } = joinDeps([[req('c1')]]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
        expect(calls.serve).toBe(1);
        expect(calls.distribute).toEqual([]);
        expect(calls.sleeps).toEqual([JOIN_HANDOFF_MIN_MS]);
    });

    it('asked a moment later → found on the re-check', async () => {
        const { deps, calls } = joinDeps([[], [req('c1')]]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
        expect(calls.sleeps).toEqual([JOIN_HANDOFF_MIN_MS, JOIN_HANDOFF_RECHECK_MS]);
        expect(calls.distribute).toEqual([]);
    });

    it('someone ELSE\'s request does not count', async () => {
        const other = { ...req('c1'), requester_user_id: 'someone-else' };
        const { deps, calls } = joinDeps([[other]]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('distributed');
        expect(calls.serve).toBe(0);
    });

    it('nothing asked (one listing failed, the others empty) → the old one-shot distribution, every channel\'s newest epoch first', async () => {
        const { deps, calls } = joinDeps([new Error('500'), []]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('distributed');
        expect(calls.distribute).toEqual(['c1:2', 'c2:2', 'c1:1', 'c2:1']);
    });

    it('asked only after ~5 s (a busy joiner) → still a hand-off, found on the LAST check', async () => {
        const { deps, calls } = joinDeps([[], [], [req('c1')]]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
        expect(calls.sleeps).toEqual([JOIN_HANDOFF_MIN_MS, JOIN_HANDOFF_RECHECK_MS, JOIN_HANDOFF_LAST_CHECK_MS]);
    });

    it('asked only after ~15 s (a very busy machine) → still a hand-off on the FINAL check', async () => {
        const { deps, calls } = joinDeps([[], [], [], [req('c1')]]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
        expect(calls.sleeps).toEqual([JOIN_HANDOFF_MIN_MS, JOIN_HANDOFF_RECHECK_MS, JOIN_HANDOFF_LAST_CHECK_MS, JOIN_HANDOFF_FINAL_CHECK_MS]);
        expect(calls.distribute).toEqual([]);
        expect(calls.distribute).toEqual([]);
    });

    it('every listing failed → nothing pushed blind (unknown), the request path covers it', async () => {
        const { deps, calls } = joinDeps([new Error('500')]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('unknown');
        expect(calls.distribute).toEqual([]);
        expect(calls.serve).toBe(0);
    });

    it('no device bundle → reported, nothing sent', async () => {
        const { deps, calls } = joinDeps([[]]);
        const onNoRecipientBundle = vi.fn();
        deps.getMemberDevices = async () => [];
        deps.onNoRecipientBundle = onNoRecipientBundle;
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('no_bundle');
        expect(onNoRecipientBundle).toHaveBeenCalledOnce();
        expect(calls.distribute).toEqual([]);
    });
});

describe('serveKeyRequestsPass — re-list drops what another holder answered', () => {
    function passDeps(listSeq: PendingKeyRequest[][], now: { t: number }) {
        let i = 0;
        const sent: string[] = [];
        const deps: ServePassDeps = {
            listPending: async () => listSeq[Math.min(i++, listSeq.length - 1)],
            listHeldEpochs: async () => [1, 2],
            getMemberDevices: async () => [{ device_id: 'jd', spk_pub_b64: 's', sig_b64: 'g', identity_pub_b64: 'i' }],
            refreshProtectedEpochs: async () => new Map(),
            distribute: async (_s, channelId, epochs, recipients, _r, opts) => {
                for (const e of epochs) {
                    sent.push(`${channelId}:${e}`);
                    deps.ledger.record(channelId, e, recipients[0].device_id, opts?.requestVersion);
                }
                now.t += 1_100; // each POST round takes a while → the next item re-lists
                return { status: 'done', posted: epochs.length };
            },
            backoff: new HandshakeBackoff(),
            ledger: new DeliveryLedger({ now: () => now.t }),
            flight: new SingleFlight(),
            scheduleResume: () => {},
            answered: new Set(),
            seenAt: new Map(),
            owed: new Map(),
            now: () => now.t,
        };
        return { deps, sent };
    }

    it('newest epochs of requests still open; a request closed by someone else is dropped — newest AND history', async () => {
        const now = { t: 1_000_000 };
        const a = req('a'), b = req('b'), c = req('c');
        // First list: a, b, c open. Every later list: only c open (a was closed
        // by OUR delivery, b by another holder's).
        const { deps, sent } = passDeps([[a, b, c], [c]], now);
        await serveKeyRequestsPass(deps, 's');
        // a: our newest went out before the re-list → its history is ours.
        // b: closed before we reached it, not by us → nothing.
        // c: still open → served.
        expect(sent).toEqual(['a:2', 'c:2', 'a:1', 'c:1']);
        expect(deps.answered.has(keyRequestVersion(b))).toBe(true);
    });

    it('relist: false (control) serves everything it first listed', async () => {
        const now = { t: 1_000_000 };
        const a = req('a'), b = req('b'), c = req('c');
        const { deps, sent } = passDeps([[a, b, c], [c]], now);
        deps.relist = false;
        await serveKeyRequestsPass(deps, 's');
        expect(sent).toEqual(['a:2', 'b:2', 'c:2', 'a:1', 'b:1', 'c:1']);
    });

    it('a failed re-list never drops anything', async () => {
        const now = { t: 1_000_000 };
        const a = req('a'), b = req('b');
        const { deps, sent } = passDeps([[a, b]], now);
        let calls = 0;
        const first = deps.listPending;
        deps.listPending = async (sid) => { calls += 1; if (calls > 1) throw new Error('503'); return first(sid); };
        await serveKeyRequestsPass(deps, 's');
        expect(sent).toEqual(['a:2', 'b:2', 'a:1', 'b:1']);
    });
});

describe('joinCheckRows — member_join reads either API\'s answer', () => {
    it('a row list (an API without summary) passes through', () => {
        const rows = [req('c1')];
        expect(joinCheckRows(rows, 'joiner')).toBe(rows);
    });
    it('{ asked: false } is "nothing asked"', () => {
        expect(joinCheckRows({ asked: false, serve_now: false }, 'joiner')).toEqual([]);
        expect(joinCheckRows(null, 'joiner')).toEqual([]);
    });
    it('{ asked, serve_now } is one stand-in row for the joiner', async () => {
        const rows = joinCheckRows({ asked: true, serve_now: false }, 'joiner');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ requester_user_id: 'joiner', serve_now: false });
        const { deps, calls } = joinDeps([rows]);
        expect(await runMemberJoinDistribution(deps, 's', 'joiner')).toBe('handoff');
        expect(calls.serve).toBe(0);
    });
});
