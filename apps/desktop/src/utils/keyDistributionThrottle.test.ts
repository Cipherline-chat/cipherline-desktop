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

    it('a re-filed ask INSIDE the cool-down is not re-served (that re-ask loop was the storm)…', async () => {
        const { deps, posts, clock } = makeDeps();
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')], requestVersion: 'req@v1' });
        clock.advance(75_000); // the 75 s retry timer re-files
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')], requestVersion: 'req@v2' });
        expect(posts).toHaveLength(1);
    });

    it('…but IS re-served after the cool-down — a device that genuinely lost the key still gets it', async () => {
        const { deps, posts, clock } = makeDeps();
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')], requestVersion: 'req@v1' });
        clock.advance(REDELIVERY_COOLDOWN_MS + 1);
        await runKeyDistribution(deps, { serverId: SID, channelId: CID, epochs: [1], recipients: [recipient('u', 'd')], requestVersion: 'req@v2' });
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

    it('ResumeTimers keeps ONE pending resume per key', () => {
        vi.useFakeTimers();
        try {
            const t = new ResumeTimers();
            const fn = vi.fn();
            t.schedule('serve:s', 1_000, fn);
            t.schedule('serve:s', 10, fn);
            vi.advanceTimersByTime(2_000);
            expect(fn).toHaveBeenCalledTimes(1);
            t.schedule('serve:s', 10, fn);
            t.clearAll();
            vi.advanceTimersByTime(2_000);
            expect(fn).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
