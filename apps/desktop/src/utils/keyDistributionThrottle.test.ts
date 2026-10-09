import { describe, it, expect, vi } from 'vitest';
import {
    HandshakeBackoff,
    Pacer,
    DeliveryLedger,
    KeyedMutex,
    SingleFlight,
    ResumeTimers,
    runKeyDistribution,
    classifyHandshakeError,
    parseRetryAfterMs,
    keyRequestVersion,
    REDELIVERY_COOLDOWN_MS,
    PASS_CONTINUATION_DELAY_MS,
    SERVER_ERROR_GIVE_UP,
    latestFirstPhases,
    recordOwed,
    takeOwed,
    OWED_SERVE_TTL_MS,
    type KeyDistributionDeps,
    type DistributionRecipient,
} from './keyDistributionThrottle';

/**
 * 2026-10-09 key-handshake storm — client side.
 *
 * The pre-fix distributeChannelKeys (Dashboard) caught every POST failure,
 * 429 included, and carried on to the next chunk after a fixed 100 ms sleep;
 * nothing remembered what had been delivered, and every caller ran its own
 * loop. These tests drive the extracted loop with fakes and pin the
 * replacements: a 429 STOPS the pass and arms a back-off that honours
 * Retry-After; delivered epochs are not re-sent; concurrent callers never
 * interleave; a pass is budgeted. Each "control" comment names what the old
 * loop did that would fail the assertion.
 */

const SID = 'srv';
const CID = 'chan';

function recipient(user: string, device: string): DistributionRecipient {
    return { user_id: user, device_id: device, spk_pub_b64: 'spk', sig_b64: 'sig', identity_pub_b64: 'id' };
}

function axiosError(status: number, headers: Record<string, unknown> = {}) {
    return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });
}

/** A controllable clock shared by every collaborator. */
function makeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makeDeps(opts: {
    post?: KeyDistributionDeps['post'];
    clock?: ReturnType<typeof makeClock>;
} = {}) {
    const clock = opts.clock ?? makeClock();
    const posts: { recipient_user_id: string; epoch: number; devices: string[] }[] = [];
    const post = vi.fn(opts.post ?? (async () => ({ data: { ok: true } })));
    const deps: KeyDistributionDeps = {
        backoff: new HandshakeBackoff({ now: clock.now, random: () => 0 }),
        // Pacer with a fake sleep that advances the fake clock instead of waiting.
        pacer: new Pacer({ intervalMs: 350, now: clock.now, sleep: async (ms) => { clock.advance(ms); } }),
        ledger: new DeliveryLedger({ now: clock.now }),
        mutex: new KeyedMutex(),
        getChannelKey: vi.fn(async () => 'KEY'),
        wrap: vi.fn(async ({ epoch, device }) => `ct-${epoch}-${device.device_id}`),
        post: async (serverId, body) => {
            posts.push({ recipient_user_id: body.recipient_user_id, epoch: body.epoch, devices: body.envelopes.map(e => e.device_id) });
            return post(serverId, body);
        },
    };
    return { deps, posts, post, clock };
}

describe('runKeyDistribution — 429 stops the pass and backs off', () => {
    it('stops at the FIRST 429 instead of carrying on through every remaining epoch × recipient', async () => {
        let calls = 0;
        const { deps, posts } = makeDeps({
            post: async () => { calls += 1; if (calls === 2) throw axiosError(429); return {}; },
        });
        const recipients = ['u1', 'u2', 'u3', 'u4'].map(u => recipient(u, `${u}-d`));

        const out = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1, 2, 3], recipients });

        // Control: the old loop swallowed the 429 and made all 12 POSTs.
        expect(posts).toHaveLength(2);
        expect(out).toMatchObject({ status: 'deferred', reason: 'throttled', posted: 1 });
        expect(deps.backoff.isBlocked()).toBe(true);
    });

    it('honours Retry-After (including the per-bucket Retry-After-keyHandshake header) as the minimum wait', async () => {
        const { deps } = makeDeps({ post: async () => { throw axiosError(429, { 'retry-after-keyhandshake': '7' }); } });
        const out = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')] });
        expect(out.status).toBe('deferred');
        if (out.status === 'deferred') expect(out.retryInMs).toBeGreaterThanOrEqual(7_000);
    });

    it('does not POST at all while a back-off from ANY earlier pass is active', async () => {
        const { deps, posts, clock } = makeDeps();
        deps.backoff.onFailure(10_000);

        const out = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')] });

        expect(posts).toHaveLength(0);
        expect(out).toMatchObject({ status: 'deferred', reason: 'throttled' });
        // And resumes normally once it has passed.
        clock.advance(20_000);
        const again = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')] });
        expect(again).toMatchObject({ status: 'done', posted: 1 });
    });

    it('a 5xx / network failure also stops the pass (a struggling server is not hammered)', async () => {
        const { deps, posts } = makeDeps({ post: async () => { throw new Error('socket hang up'); } });
        const out = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1, 2], recipients: [recipient('u', 'd')] });
        expect(posts).toHaveLength(1);
        expect(out).toMatchObject({ status: 'deferred', reason: 'unavailable' });
    });

    it('a definitive 403 is NOT retried for the same ask, and does not stop the rest of the pass', async () => {
        const { deps, posts } = makeDeps({
            post: async (_s, body) => { if (body.epoch === 1) throw axiosError(403); return {}; },
        });
        const args = { serverId: SID, channelId: CID, epochs: [1, 2], recipients: [recipient('u', 'd')], requestVersion: 'r1@t1' };

        const first = await runKeyDistribution(deps, args);
        expect(first).toMatchObject({ status: 'done', posted: 1 });
        expect(posts.map(p => p.epoch)).toEqual([1, 2]);

        await runKeyDistribution(deps, args);
        // Control: the old serve loop re-sent the refused historical epoch on
        // every sweep, forever (a 403 every time).
        expect(posts.map(p => p.epoch)).toEqual([1, 2]);
    });
});

describe('HandshakeBackoff — exponential with jitter, reset on success', () => {
    it('doubles per consecutive failure, is capped, and resets after a success', () => {
        const clock = makeClock();
        const b = new HandshakeBackoff({ now: clock.now, random: () => 0, baseMs: 1_000, maxMs: 8_000 });
        expect(b.onFailure()).toBe(1_000);
        clock.advance(1_000);
        expect(b.onFailure()).toBe(2_000);
        clock.advance(2_000);
        expect(b.onFailure()).toBe(4_000);
        clock.advance(4_000);
        expect(b.onFailure()).toBe(8_000);
        clock.advance(8_000);
        expect(b.onFailure()).toBe(8_000); // capped
        clock.advance(8_000);
        b.onSuccess();
        expect(b.onFailure()).toBe(1_000);
    });

    it('adds up to +50 % jitter so devices released by the same window do not resume in lock-step', () => {
        const clock = makeClock();
        const b = new HandshakeBackoff({ now: clock.now, random: () => 0.999, baseMs: 2_000, maxMs: 60_000 });
        const wait = b.onFailure();
        expect(wait).toBeGreaterThan(2_000);
        expect(wait).toBeLessThanOrEqual(3_000);
    });
});

describe('parseRetryAfterMs / classifyHandshakeError', () => {
    it('reads seconds, HTTP dates, and the throttler\'s suffixed header; absent → undefined', () => {
        const now = Date.parse('2026-10-09T00:00:00Z');
        expect(parseRetryAfterMs(axiosError(429, { 'retry-after': '3' }), now)).toBe(3_000);
        expect(parseRetryAfterMs(axiosError(429, { 'retry-after-keyhandshake': 9 }), now)).toBe(9_000);
        expect(parseRetryAfterMs(axiosError(429, { 'retry-after': 'Fri, 09 Oct 2026 00:00:05 GMT' }), now)).toBe(5_000);
        expect(parseRetryAfterMs(axiosError(429, {}), now)).toBeUndefined();
        expect(parseRetryAfterMs(new Error('network'), now)).toBeUndefined();
    });

    it('classifies 429 / other 4xx / 5xx+network', () => {
        expect(classifyHandshakeError(axiosError(429))).toBe('throttled');
        expect(classifyHandshakeError(axiosError(403))).toBe('refused');
        expect(classifyHandshakeError(axiosError(400))).toBe('refused');
        expect(classifyHandshakeError(axiosError(503))).toBe('transient');
        expect(classifyHandshakeError(new Error('ECONNRESET'))).toBe('transient');
    });
});

describe('DeliveryLedger — no re-send of delivered epochs', () => {
    it('does not re-send an epoch already delivered to a device for the same request version', async () => {
        const { deps, posts, clock } = makeDeps();
        const args = { serverId: SID, channelId: CID, epochs: [1, 2, 3], recipients: [recipient('u', 'd')], requestVersion: 'req@v1' };

        await runKeyDistribution(deps, args);
        expect(posts).toHaveLength(3);

        // Same unchanged ask, much later (past the cool-down): still nothing.
        clock.advance(REDELIVERY_COOLDOWN_MS * 3);
        await runKeyDistribution(deps, args);
        // Control: the old serve loop re-sent all three on every sweep.
        expect(posts).toHaveLength(3);
        expect(deps.getChannelKey).toHaveBeenCalledTimes(3); // no IPC either
    });

    // ── A RE-ASK is a real need (regression in 1.0.20) ──────────────────────
    // The device asked again after our delivery: its envelope was purged (VIEW
    // revoked, then re-granted), refused, unusable, or the key was discarded.
    // 1.0.20 skipped ANY re-ask for 10 minutes after a delivery.

    it('a RE-ASK (new request version) shortly after a delivery is served at once', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: 'req@v1' });
        clock.advance(20_000); // access re-granted 20 s later; the device re-files
        const out = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: 'req@v2' });
        // Control: the 1.0.20 ledger (flat 10-min cool-down) made this 1, not 2.
        expect(posts).toHaveLength(2);
        expect(out).toEqual({ status: 'done', posted: 1 });
    });

    it('EVERY re-ask is served at once — an unacked delivery is never treated as received', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        let v = 0;
        const ask = () => runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: `req@v${++v}` });
        await ask();
        for (let i = 0; i < 5; i++) { clock.advance(5_000); await ask(); }
        // Control: 1.0.20 answered only the first (6 asks → 1 POST within 10 min).
        expect(posts).toHaveLength(6);
    });

    // ── 2026-10-09 prod incident: calls broke ───────────────────────────────
    // A participant's envelope for the call channel's epoch was UNDECRYPTABLE
    // (wrapped to a bundle it no longer had). It stays unacked, the device
    // re-files its request, and the holder must send a FRESH envelope — wrapped
    // to the device's CURRENT bundle — right away. Skipping because "already
    // sent" left participants on different epochs, so their derived call keys
    // did not match: nobody could hear anyone.
    it('incident: the earlier envelope was undecryptable; the re-request gets a FRESH envelope, to the CURRENT bundle, at once', async () => {
        const { deps, posts, clock } = makeDeps();
        const stale = { ...recipient('u', 'd'), spk_pub_b64: 'OLD-SPK' };
        const current = { ...recipient('u', 'd'), spk_pub_b64: 'NEW-SPK' };
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [7], recipients: [stale], requestVersion: 'req@t0' });
        clock.advance(3_000); // the device fails to decrypt it and re-files
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [7], recipients: [current], requestVersion: 'req@t3' });
        expect(posts.map(x => x.epoch)).toEqual([7, 7]);
        const wraps = vi.mocked(deps.wrap).mock.calls.map(c => c[0].device.spk_pub_b64);
        expect(wraps).toEqual(['OLD-SPK', 'NEW-SPK']);
    });

    it('incident (one-shot first): a rotation delivered an undecryptable envelope; the re-request is served at once', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [7], recipients: r }); // rotation fan-out
        clock.advance(2_000);
        const askSeenAt = clock.now(); // the re-filed request is first seen AFTER the delivery
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [7], recipients: r, requestVersion: 'req@t2', requestSeenAt: askSeenAt });
        expect(posts).toHaveLength(2);
    });

    it('one-shot paths (no request version) keep the duplicate-trigger cool-down', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r }); // member_join
        clock.advance(60_000);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r }); // a second trigger
        expect(posts).toHaveLength(1);
        clock.advance(REDELIVERY_COOLDOWN_MS);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r });
        expect(posts).toHaveLength(2);
    });

    it('a re-ask after a one-shot delivery (member_join) is served at once', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r }); // member_join
        clock.advance(5_000);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: 'req@v1' });
        expect(posts).toHaveLength(2);
    });

    it('a 403 for one ask is retried when the device asks again (access re-granted)', async () => {
        let refuse = true;
        const { deps, posts, clock } = makeDeps({
            post: async () => { if (refuse) throw axiosError(403); return {}; },
        });
        const r = [recipient('u', 'd')];
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: 'req@v1' });
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: 'req@v1' });
        expect(posts).toHaveLength(1); // same ask: not retried
        refuse = false;
        clock.advance(30_000);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: r, requestVersion: 'req@v2' });
        expect(posts).toHaveLength(2);
    });

    it('a NEW epoch (rotation) is never suppressed by an older delivery', async () => {
        const { deps, posts } = makeDeps();
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [4], recipients: [recipient('u', 'd')] });
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [5], recipients: [recipient('u', 'd')] });
        expect(posts.map(p => p.epoch)).toEqual([4, 5]);
    });

    it('a deferred pass resumes with ONLY what is still missing', async () => {
        let calls = 0;
        const { deps, posts, clock } = makeDeps({
            post: async () => { calls += 1; if (calls === 3) throw axiosError(429, { 'retry-after': '1' }); return {}; },
        });
        const args = { serverId: SID, channelId: CID, epochs: [1, 2, 3, 4], recipients: [recipient('u', 'd')] };

        const first = await runKeyDistribution(deps, args);
        expect(first.status).toBe('deferred');
        clock.advance(60_000);
        const second = await runKeyDistribution(deps, args);

        expect(second).toMatchObject({ status: 'done' });
        // 1,2 delivered; 3 throttled; resume sends 3,4 only.
        expect(posts.map(p => p.epoch)).toEqual([1, 2, 3, 3, 4]);
    });

    it('keyRequestVersion changes exactly when the server bumps created_at (a re-ask)', () => {
        expect(keyRequestVersion({ request_id: 'r', created_at: '2026-10-09T00:00:00.000Z' }))
            .not.toBe(keyRequestVersion({ request_id: 'r', created_at: '2026-10-09T00:01:15.000Z' }));
        expect(keyRequestVersion({ request_id: 'r', created_at: new Date('2026-10-09T00:00:00.000Z') }))
            .toBe(keyRequestVersion({ request_id: 'r', created_at: '2026-10-09T00:00:00.000Z' }));
    });
});

describe('HTTP 500 for one submission does not hold everyone else back', () => {
    it(`after ${SERVER_ERROR_GIVE_UP} consecutive 500s for the same POST it is skipped (for this ask) and the pass goes on`, async () => {
        const { deps, posts, clock } = makeDeps({
            post: async (_s, body) => { if (body.recipient_user_id === 'bad') throw axiosError(500); return {}; },
        });
        const args = { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('bad', 'b1'), recipient('ok', 'o1')], requestVersion: 'v1' };
        for (let i = 0; i < SERVER_ERROR_GIVE_UP - 1; i++) {
            const out = await runKeyDistribution(deps, args);
            expect(out).toMatchObject({ status: 'deferred', reason: 'unavailable' });
            clock.advance(10 * 60_000);
        }
        const last = await runKeyDistribution(deps, args);
        expect(last).toEqual({ status: 'done', posted: 1 });
        expect(posts.map(p => p.recipient_user_id)).toEqual([...Array(SERVER_ERROR_GIVE_UP).fill('bad'), 'ok']);
    });

    it('502/503/504 (a rollout, an overloaded ingress) never count toward that — they only back off', async () => {
        const { deps, posts, clock } = makeDeps({ post: async () => { throw axiosError(503); } });
        const args = { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')], requestVersion: 'v1' };
        for (let i = 0; i < SERVER_ERROR_GIVE_UP + 2; i++) {
            expect(await runKeyDistribution(deps, args)).toMatchObject({ status: 'deferred' });
            clock.advance(10 * 60_000);
        }
        expect(posts.length).toBe(SERVER_ERROR_GIVE_UP + 2);
    });
});

describe('latestFirstPhases — every channel usable before any history', () => {
    it('sends each channel\'s newest epoch first, then history newest-first, without changing the volume', () => {
        const items = [
            { id: 'a', epochs: [1, 2, 3] },
            { id: 'b', epochs: [5] },
            { id: 'c', epochs: [2, 1] },
            { id: 'empty', epochs: [] as number[] },
        ];
        const phases = latestFirstPhases(items).map(x => `${x.item.id}:${x.epochs.join(',')}`);
        expect(phases).toEqual(['a:3', 'b:5', 'c:2', 'a:2,1', 'c:1']);
        // Control: the 1.0.20 order was channel by channel, all epochs each.
        const sent = latestFirstPhases(items).flatMap(x => x.epochs.map(e => `${x.item.id}${e}`)).sort();
        expect(sent).toEqual(['a1', 'a2', 'a3', 'b5', 'c1', 'c2']);
    });

    it('20 channels × 3 epochs: the 20th channel is usable after 20 POSTs, not 58', () => {
        const items = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, epochs: [1, 2, 3] }));
        const order = latestFirstPhases(items).flatMap(x => x.epochs.map(e => ({ id: x.item.id, e })));
        const lastLatest = order.findIndex(x => x.id === 'c19' && x.e === 3);
        expect(lastLatest).toBe(19); // 0-based: the 20th POST
    });
});

describe('pass budget', () => {
    it('caps the POSTs one pass may make and defers the rest to a continuation', async () => {
        const { deps, posts } = makeDeps();
        const recipients = Array.from({ length: 10 }, (_, i) => recipient(`u${i}`, `d${i}`));
        const budget = { remaining: 4 };

        const out = await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients, budget });

        expect(posts).toHaveLength(4);
        expect(out).toMatchObject({ status: 'deferred', reason: 'budget', retryInMs: PASS_CONTINUATION_DELAY_MS });
    });
});

describe('single-flight / no concurrent loops', () => {
    it('two distributions for the SAME channel never interleave their POSTs', async () => {
        const order: string[] = [];
        const { deps } = makeDeps({
            post: async (_s, body) => {
                order.push(`${body.recipient_user_id}:start`);
                await new Promise(r => setTimeout(r, 1));
                order.push(`${body.recipient_user_id}:end`);
                return {};
            },
        });
        await Promise.all([
            runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('a', 'a1'), recipient('b', 'b1')] }),
            runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [2], recipients: [recipient('c', 'c1'), recipient('d', 'd1')] }),
        ]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end', 'd:start', 'd:end']);
    });

    it('Pacer: concurrent callers (different channels / loops) get distinct slots ≥ the interval apart', async () => {
        // Frozen clock: every caller arrives at t=0, so the sleeps requested are
        // exactly the slot offsets the pacer handed out.
        const sleeps: number[] = [];
        const pacer = new Pacer({ intervalMs: 350, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
        await Promise.all([pacer.wait(), pacer.wait(), pacer.wait(), pacer.wait()]);
        // First goes immediately; the rest queue at 350 ms spacing.
        expect(sleeps).toEqual([350, 700, 1050]);
    });

    it('every POST of concurrent distributions goes through the ONE shared pacer', async () => {
        const { deps } = makeDeps();
        const wait = vi.spyOn(deps.pacer, 'wait');
        await Promise.all([
            runKeyDistribution(deps, { serverId: SID, channelId: 'c1', epochs: [1], recipients: [recipient('a', 'a1'), recipient('b', 'b1')] }),
            runKeyDistribution(deps, { serverId: SID, channelId: 'c2', epochs: [1], recipients: [recipient('c', 'c1'), recipient('d', 'd1')] }),
        ]);
        expect(wait).toHaveBeenCalledTimes(4);
    });

    it('SingleFlight: a trigger during a run does not start a second loop — it gets ONE trailing re-run', async () => {
        const flight = new SingleFlight();
        let active = 0;
        let maxActive = 0;
        let runs = 0;
        const pass = async () => {
            runs += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(r => setTimeout(r, 5));
            active -= 1;
        };
        const p1 = flight.run('srv', pass);
        const p2 = flight.run('srv', pass); // connect sweep
        const p3 = flight.run('srv', pass); // key_requested push
        const p4 = flight.run('srv', pass); // resume timer
        await Promise.all([p1, p2, p3, p4]);
        expect(maxActive).toBe(1);
        expect(runs).toBe(2); // the original + exactly one trailing re-run
        expect(flight.isRunning('srv')).toBe(false);
    });

    it('SingleFlight.hasPendingRerun: true exactly while a trigger is queued behind the current run', async () => {
        const flight = new SingleFlight();
        const seen: boolean[] = [];
        let release!: () => void;
        let runs = 0;
        const p1 = flight.run('srv', async () => {
            if (++runs > 1) return;                            // the trailing re-run
            seen.push(flight.hasPendingRerun('srv'));          // nothing queued yet
            await new Promise<void>(r => { release = r; });
            seen.push(flight.hasPendingRerun('srv'));          // a push landed mid-run
        });
        const p2 = flight.run('srv', async () => undefined);
        release();
        await Promise.all([p1, p2]);
        expect(seen).toEqual([false, true]);
        expect(runs).toBe(2);
        expect(flight.hasPendingRerun('srv')).toBe(false);
    });

    it('SingleFlight: different servers run independently', async () => {
        const flight = new SingleFlight();
        const seen: string[] = [];
        await Promise.all([
            flight.run('a', async () => { seen.push('a'); }),
            flight.run('b', async () => { seen.push('b'); }),
        ]);
        expect(seen.sort()).toEqual(['a', 'b']);
    });

    it('KeyedMutex releases the key even when the work throws', async () => {
        const m = new KeyedMutex();
        await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(m.run('k', async () => 'next')).resolves.toBe('next');
    });

    it('ResumeTimers keeps ONE pending resume per key — the EARLIEST', () => {
        vi.useFakeTimers();
        try {
            const t = new ResumeTimers();
            const fn = vi.fn();
            t.schedule('serve:s', 1_000, fn);
            t.schedule('serve:s', 10, fn);
            // Control: 1.0.20 rode the first (1 s) timer, so at 50 ms nothing had run.
            vi.advanceTimersByTime(50);
            expect(fn).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(2_000);
            expect(fn).toHaveBeenCalledTimes(1);
            // A LATER request rides the pending earlier one.
            t.schedule('serve:s', 10, fn);
            t.schedule('serve:s', 5_000, fn);
            vi.advanceTimersByTime(100);
            expect(fn).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(10_000);
            expect(fn).toHaveBeenCalledTimes(2);
            t.schedule('serve:s', 10, fn);
            t.clearAll();
            vi.advanceTimersByTime(2_000);
            expect(fn).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('join race: an ask seen BEFORE our delivery was answered by it', () => {
    it('a request first seen before a member_join delivery is not re-served for the same epoch', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        const seenAt = clock.now();          // serve pass lists the joiner's request…
        clock.advance(2_000);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [3], recipients: r }); // …member_join posts epoch 3
        clock.advance(2_000);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [3], recipients: r, requestVersion: 'req@v1', requestSeenAt: seenAt });
        // Control: without requestSeenAt this is a "re-ask after a one-shot" and is re-sent.
        expect(posts).toHaveLength(1);
    });

    it('a request first seen AFTER our delivery is a re-ask and is served', async () => {
        const { deps, posts, clock } = makeDeps();
        const r = [recipient('u', 'd')];
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [3], recipients: r });
        clock.advance(2_000);
        const seenAt = clock.now();
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [3], recipients: r, requestVersion: 'req@v2', requestSeenAt: seenAt });
        expect(posts).toHaveLength(2);
    });
});

describe('recordOwed / takeOwed — a stopped pass finishes its history after the request closes', () => {
    const req = (channel_id: string, requester_device_id = 'dev') => ({ channel_id, requester_device_id });

    it('what a stopped pass still owed is served by the next pass even though the request is no longer listed', () => {
        const owed = new Map();
        const now = 1_000;
        recordOwed(owed, [
            { item: { req: req('c1'), version: 'r1@a', seenAt: 1 }, epochs: [2, 1] },
            { item: { req: req('c2'), version: 'r2@a', seenAt: 1 }, epochs: [5] },
        ], now);
        // Next pass: r1 closed server-side (the device acked the newest epoch), r2 still listed.
        const take = takeOwed(owed, [{ req: req('c2'), version: 'r2@a' }], new Set(), now + 1_000);
        expect(take).toEqual([{ req: req('c1'), version: 'r1@a', seenAt: 1, epochs: [2, 1] }]);
        // The listed one is dropped from `owed` — the server's view supersedes it.
        expect([...owed.keys()]).toEqual(['r1@a']);
    });

    it('drops owed work that was answered, expired, or superseded by a newer ask for the same channel+device', () => {
        const owed = new Map();
        recordOwed(owed, [
            { item: { req: req('c1'), version: 'r1@a', seenAt: 1 }, epochs: [1] },
            { item: { req: req('c2'), version: 'r2@a', seenAt: 1 }, epochs: [1] },
            { item: { req: req('c3'), version: 'r3@a', seenAt: 1 }, epochs: [1] },
        ], 0);
        const out = takeOwed(owed, [{ req: req('c3'), version: 'r3@b' }], new Set(['r1@a']), 1_000);
        expect(out.map(o => o.version)).toEqual(['r2@a']);
        expect(takeOwed(owed, [], new Set(), OWED_SERVE_TTL_MS + 10)).toEqual([]);
        expect(owed.size).toBe(0);
    });

    it('merges repeated stops for the same request', () => {
        const owed = new Map();
        recordOwed(owed, [{ item: { req: req('c1'), version: 'v', seenAt: 1 }, epochs: [3] }], 0);
        recordOwed(owed, [{ item: { req: req('c1'), version: 'v', seenAt: 1 }, epochs: [2, 1] }], 10);
        expect(owed.get('v')!.epochs).toEqual([3, 2, 1]);
    });
});
