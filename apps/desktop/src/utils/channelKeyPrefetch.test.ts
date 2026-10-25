import { describe, it, expect } from 'vitest';
import { Permissions } from '@cipherline/shared';
import {
    mayHoldChannelKey,
    planKeyPrefetch,
    PrefetchLedger,
    KeyAskLimiter,
    KeyAskQueue,
    noteKeyRequestError,
    KEY_ASK_SOFT_CEILING,
    KEY_ASK_HARD_CEILING,
    KEY_ASK_WINDOW_MS,
    KEY_ASK_MIN_GAP_MS,
    KEY_ASK_QUEUE_MAX_TRIES,
    KEY_ASK_QUEUE_SLEEP_SLICE_MS,
    KEY_REQUEST_API_LIMIT_PER_MIN,
    PREFETCH_REASK_DEDUP_MS,
    PREFETCH_NEWER_EPOCH_MIN_GAP_MS,
    type PrefetchChannelInput,
    type PlanArgs,
    type KeyAskOutcome,
    type QueuedAsk,
} from './channelKeyPrefetch';
import { gapReaskDelayMs } from './channelKeyDistribution';

/**
 * The requester side of channel keys, for EVERY channel the member can see
 * (owner report, stable 1.0.22: "some chats' channel keys don't load until I go
 * into the chat, and then I have to wait").
 *
 * Each rule has a control: the same input minus the thing that triggers it.
 */

const VIEW = Permissions.VIEW_CHANNEL;
const CONNECT = Permissions.CONNECT;
const SEND = Permissions.SEND_MESSAGES;

const ch = (id: string, over: Partial<PrefetchChannelInput> = {}): PrefetchChannelInput =>
    ({ channel_id: id, kind: 'text', latest_epoch: 3, my_permissions: (VIEW | SEND).toString(), ...over });

function plan(over: Partial<PlanArgs> & { channels: PrefetchChannelInput[] }) {
    const ledger = over.ledger ?? new PrefetchLedger();
    return planKeyPrefetch({
        serverId: 's1',
        held: {},
        ledger,
        lastAskedAt: () => undefined,
        isQueued: () => false,
        now: 1_000_000,
        mode: 'event',
        ...over,
    });
}

describe('mayHoldChannelKey — only ask for a key the API would hand us', () => {
    it('text needs VIEW_CHANNEL; a Calls channel needs VIEW_CHANNEL | CONNECT', () => {
        expect(mayHoldChannelKey('text', VIEW)).toBe(true);
        expect(mayHoldChannelKey('huddle', VIEW | CONNECT)).toBe(true);
        expect(mayHoldChannelKey('voice', VIEW | CONNECT)).toBe(true);
        // controls
        expect(mayHoldChannelKey('text', SEND)).toBe(false);
        expect(mayHoldChannelKey('huddle', VIEW)).toBe(false);
        expect(mayHoldChannelKey('voice', CONNECT)).toBe(false);
    });
    it('accepts the decimal string the channel list carries; unknown permissions never strand a channel', () => {
        expect(mayHoldChannelKey('text', VIEW.toString())).toBe(true);
        expect(mayHoldChannelKey('text', '0')).toBe(false);
        expect(mayHoldChannelKey('text', undefined)).toBe(true);
        expect(mayHoldChannelKey('text', 'not-a-number')).toBe(true);
    });
});

describe('planKeyPrefetch — exactly the viewable channels that lack their newest key', () => {
    it('picks the keyless and the stale channel, and nothing else', () => {
        const p = plan({
            channels: [
                ch('held-newest'),                                   // holds epoch 3 of 3
                ch('keyless'),                                       // holds nothing
                ch('stale'),                                         // holds epoch 2 of 3
                ch('unminted', { latest_epoch: 0 }),                 // nobody can answer: the mint path owns it
                ch('unknown', { latest_epoch: undefined }),          // an older API: no epoch to compare
                { channel_id: 'cat', kind: 'category', latest_epoch: 5 },
                { channel_id: 'announce-no-key-kind', kind: 'forum', latest_epoch: 2 },
            ],
            held: { 'held-newest': 3, stale: 2 },
        });
        expect(p.asks.map(a => a.channelId)).toEqual(['keyless', 'stale']);
        expect(p.asks.map(a => a.keyless)).toEqual([true, false]);
        expect(p.asks.map(a => a.targetEpoch)).toEqual([3, 3]);
        expect(p.satisfied).toEqual(['held-newest']);
        expect(p.unminted).toEqual(['unminted']);
        expect(p.skipped).toContainEqual({ channelId: 'unknown', reason: 'unknown_epoch' });
    });

    it('control: the same list with every key already held plans no ask at all', () => {
        const p = plan({
            channels: [ch('a'), ch('b'), ch('c', { kind: 'huddle', my_permissions: (VIEW | CONNECT).toString() })],
            held: { a: 3, b: 4, c: 3 },
        });
        expect(p.asks).toEqual([]);
        expect(p.satisfied.sort()).toEqual(['a', 'b', 'c']);
    });

    it('covers every channel kind that carries a Sender Key: text, Calls (huddle) and the legacy voice kind', () => {
        const calls = (VIEW | CONNECT).toString();
        const p = plan({
            channels: [
                ch('t'),
                ch('h', { kind: 'huddle', my_permissions: calls }),
                ch('v', { kind: 'voice', my_permissions: calls }),
            ],
        });
        expect(p.asks.map(a => a.channelId)).toEqual(['t', 'h', 'v']);
    });

    it('asks for nothing the member cannot VIEW (or, for Calls, CONNECT) - and says why', () => {
        const p = plan({
            channels: [
                ch('hidden', { my_permissions: '0' }),
                ch('calls-no-connect', { kind: 'huddle', my_permissions: VIEW.toString() }),
                ch('visible'),
            ],
        });
        expect(p.asks.map(a => a.channelId)).toEqual(['visible']);
        expect(p.skipped).toEqual(expect.arrayContaining([
            { channelId: 'hidden', reason: 'no_hold_permission' },
            { channelId: 'calls-no-connect', reason: 'no_hold_permission' },
        ]));
    });

    it('a permission change that GRANTS VIEW makes the channel plannable at once (re-plan on the same data + new perms)', () => {
        const before = plan({ channels: [ch('private', { my_permissions: '0' })] });
        expect(before.asks).toEqual([]);
        const after = plan({ channels: [ch('private', { my_permissions: (VIEW | SEND).toString() })] });
        expect(after.asks.map(a => a.channelId)).toEqual(['private']);
    });

    it('a channel created after the last plan (new row, new epoch) is asked about', () => {
        const ledger = new PrefetchLedger();
        const first = plan({ ledger, channels: [ch('old')], held: { old: 3 } });
        expect(first.asks).toEqual([]);
        const second = plan({ ledger, channels: [ch('old'), ch('brand-new', { latest_epoch: 1 })], held: { old: 3 } });
        expect(second.asks.map(a => a.channelId)).toEqual(['brand-new']);
    });

    it('keyless channels go first, then stale, each in list order (the member can read something in every channel soonest)', () => {
        const p = plan({
            channels: [ch('s1'), ch('k1'), ch('s2'), ch('k2')],
            held: { s1: 1, s2: 2 },
        });
        expect(p.asks.map(a => a.channelId)).toEqual(['k1', 'k2', 's1', 's2']);
    });

    it('does not plan a channel that is already waiting in the queue (no double-queueing)', () => {
        const p = plan({ channels: [ch('a'), ch('b')], isQueued: id => id === 'a' });
        expect(p.asks.map(a => a.channelId)).toEqual(['b']);
        expect(p.skipped).toContainEqual({ channelId: 'a', reason: 'queued' });
    });

    it('clears nothing it should not: a held-newest channel is reported satisfied so its ledger entry can go', () => {
        const ledger = new PrefetchLedger();
        ledger.noteSent('a', 3, 0);
        const p = plan({ ledger, channels: [ch('a')], held: { a: 3 } });
        expect(p.satisfied).toEqual(['a']);
    });
});

describe('planKeyPrefetch — dedupe and re-ask rules', () => {
    it('never asked: ask. Asked < 60 s ago by ANY path: not again. At 60 s: again (event trigger)', () => {
        const ledger = new PrefetchLedger();
        const now = 5_000_000;
        // asked by some other path (the open-channel ask) - no ledger entry yet
        const recent = plan({ ledger, now, channels: [ch('a')], lastAskedAt: () => now - (PREFETCH_REASK_DEDUP_MS - 1) });
        expect(recent.asks).toEqual([]);
        expect(recent.skipped).toContainEqual({ channelId: 'a', reason: 'recently_asked' });
        const due = plan({ ledger, now, channels: [ch('a')], lastAskedAt: () => now - PREFETCH_REASK_DEDUP_MS });
        expect(due.asks.map(a => a.reason)).toEqual(['new']);
        ledger.noteSent('a', 3, now - PREFETCH_REASK_DEDUP_MS);
        const again = plan({ ledger, now, channels: [ch('a')], lastAskedAt: () => now - PREFETCH_REASK_DEDUP_MS });
        expect(again.asks.map(a => a.reason)).toEqual(['reask']);
    });

    it('a NEWER newest epoch than the one last asked about is asked at once (inside the 60 s dedup), but not twice inside 10 s', () => {
        const ledger = new PrefetchLedger();
        const now = 9_000_000;
        ledger.noteSent('a', 3, now - 20_000);
        const p = plan({ ledger, now, channels: [ch('a', { latest_epoch: 4 })], held: { a: 2 }, lastAskedAt: () => now - 20_000 });
        expect(p.asks.map(a => [a.reason, a.targetEpoch])).toEqual([['newer_epoch', 4]]);
        // control: the same epoch again inside the dedup is NOT asked
        const same = plan({ ledger, now, channels: [ch('a', { latest_epoch: 3 })], held: { a: 2 }, lastAskedAt: () => now - 20_000 });
        expect(same.asks).toEqual([]);
        // guard: a newer epoch asked 5 s after the last ask waits
        ledger.noteSent('b', 3, now - (PREFETCH_NEWER_EPOCH_MIN_GAP_MS - 1));
        const tooSoon = plan({ ledger, now, channels: [ch('b', { latest_epoch: 4 })], held: { b: 2 }, lastAskedAt: () => now - (PREFETCH_NEWER_EPOCH_MIN_GAP_MS - 1) });
        expect(tooSoon.asks).toEqual([]);
    });

    it('the periodic tick re-asks a STALE channel only on the exponential back-off (2026-10-07 storm), never every cycle', () => {
        const ledger = new PrefetchLedger();
        const t0 = 100_000_000;
        ledger.noteSent('stale', 3, t0);                       // count 1
        const mk = (now: number) => plan({ ledger, now, mode: 'tick', channels: [ch('stale')], held: { stale: 2 }, lastAskedAt: () => ledger.get('stale')!.at });
        expect(mk(t0 + gapReaskDelayMs(1) - 1).asks).toEqual([]);
        expect(mk(t0 + gapReaskDelayMs(1) - 1).skipped).toContainEqual({ channelId: 'stale', reason: 'backoff' });
        const due = mk(t0 + gapReaskDelayMs(1));
        expect(due.asks.map(a => a.reason)).toEqual(['stale_backoff']);
        // second ask doubles the wait
        ledger.noteSent('stale', 3, t0 + gapReaskDelayMs(1));  // count 2
        const at2 = t0 + gapReaskDelayMs(1);
        expect(mk(at2 + gapReaskDelayMs(2) - 1).asks).toEqual([]);
        expect(mk(at2 + gapReaskDelayMs(2)).asks).toHaveLength(1);
        // and a long run of asks never exceeds the cap (2 h)
        for (let i = 0; i < 20; i++) ledger.noteSent('stale', 3, at2);
        expect(gapReaskDelayMs(ledger.get('stale')!.count)).toBe(2 * 60 * 60 * 1000);
    });

    it('control: the same stale channel on an EVENT trigger (reconnect, permission change) is asked after the plain 60 s dedup', () => {
        const ledger = new PrefetchLedger();
        const t0 = 100_000_000;
        ledger.noteSent('stale', 3, t0);
        const p = plan({ ledger, now: t0 + PREFETCH_REASK_DEDUP_MS, mode: 'event', channels: [ch('stale')], held: { stale: 2 }, lastAskedAt: () => t0 });
        expect(p.asks.map(a => a.reason)).toEqual(['reask']);
    });

    it('the tick re-asks a KEYLESS channel (nothing to read at all) on the 60 s dedup, not the back-off', () => {
        const ledger = new PrefetchLedger();
        const t0 = 100_000_000;
        ledger.noteSent('k', 3, t0);
        ledger.noteSent('k', 3, t0);
        ledger.noteSent('k', 3, t0);                           // count 3: the stale back-off would be 20 min
        const p = plan({ ledger, now: t0 + PREFETCH_REASK_DEDUP_MS, mode: 'tick', channels: [ch('k')], held: {}, lastAskedAt: () => t0 });
        expect(p.asks.map(a => a.reason)).toEqual(['reask']);
    });

    it('an unchanged ask is a fixed point: planning twice without new information plans the second time nothing', () => {
        const ledger = new PrefetchLedger();
        const now = 7_000_000;
        const channels = [ch('a'), ch('b'), ch('c')];
        const first = plan({ ledger, now, channels });
        expect(first.asks).toHaveLength(3);
        for (const a of first.asks) ledger.noteSent(a.channelId, a.targetEpoch, now);
        const second = plan({ ledger, now: now + 1000, channels, lastAskedAt: () => now });
        expect(second.asks).toEqual([]);
    });
});

describe('PrefetchLedger', () => {
    it('counts repeated asks for the same target, and restarts the count for a newer one', () => {
        const l = new PrefetchLedger();
        l.noteSent('c', 2, 10);
        l.noteSent('c', 2, 20);
        expect(l.get('c')).toEqual({ targetEpoch: 2, at: 20, count: 2 });
        l.noteSent('c', 3, 30);
        expect(l.get('c')).toEqual({ targetEpoch: 3, at: 30, count: 1 });
        l.delete('c');
        expect(l.get('c')).toBeUndefined();
        l.noteSent('x', 1, 1);
        l.clear();
        expect(l.size).toBe(0);
    });
});

// ── the limiter ─────────────────────────────────────────────────────────────

function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; }, sleep: async (ms: number) => { t += ms; } };
}

describe('KeyAskLimiter — one account-wide view of the key-request bucket', () => {
    it('background asks stop at the soft ceiling, forced ones at the hard ceiling, both below the API limit', () => {
        expect(KEY_ASK_SOFT_CEILING).toBeLessThan(KEY_ASK_HARD_CEILING);
        expect(KEY_ASK_HARD_CEILING).toBeLessThan(KEY_REQUEST_API_LIMIT_PER_MIN);
        const c = clock();
        const l = new KeyAskLimiter({ now: c.now });
        for (let i = 0; i < KEY_ASK_SOFT_CEILING; i++) { l.record(); c.advance(KEY_ASK_MIN_GAP_MS); }
        expect(l.waitMs(false)).toBeGreaterThan(0);          // background: wait for the window
        expect(l.waitMs(true)).toBe(0);                      // forced: still headroom
        for (let i = KEY_ASK_SOFT_CEILING; i < KEY_ASK_HARD_CEILING; i++) { l.record(); c.advance(KEY_ASK_MIN_GAP_MS); }
        expect(l.waitMs(true)).toBeGreaterThan(0);           // forced: now it waits too
    });

    it('the wait is exactly until the slot that frees the ceiling leaves the 60 s window', () => {
        const c = clock(0);
        const l = new KeyAskLimiter({ now: c.now });
        for (let i = 0; i < KEY_ASK_SOFT_CEILING; i++) { l.record(i * 100); }
        c.advance(KEY_ASK_SOFT_CEILING * 100);               // 5 s in
        // oldest stamp is at 0: the ceiling frees when it is 60 s old
        expect(l.waitMs(false)).toBe(KEY_ASK_WINDOW_MS - c.now());
    });

    it('spaces two POST starts by at least KEY_ASK_MIN_GAP_MS', () => {
        const c = clock();
        const l = new KeyAskLimiter({ now: c.now });
        l.record();
        expect(l.waitMs(false)).toBe(KEY_ASK_MIN_GAP_MS);
        c.advance(KEY_ASK_MIN_GAP_MS);
        expect(l.waitMs(false)).toBe(0);
    });

    it('a 429 pauses everything (forced too) until the back-off ends; Retry-After is honoured; an accepted ask resets it', () => {
        const c = clock();
        const l = new KeyAskLimiter({ now: c.now });
        const err = { response: { status: 429, headers: { 'retry-after': '20' } } };
        expect(noteKeyRequestError(l, err)).toBe('throttled');
        expect(l.isBlocked()).toBe(true);
        expect(l.waitMs(true)).toBeGreaterThanOrEqual(20_000);
        expect(l.waitMs(false)).toBeGreaterThanOrEqual(20_000);
        c.advance(l.blockedForMs());
        expect(l.isBlocked()).toBe(false);
        expect(l.waitMs(true)).toBe(0);
    });

    it('control: a 5xx or a network error is a failure, not a throttle - it must not pause the account', () => {
        const l = new KeyAskLimiter();
        expect(noteKeyRequestError(l, { response: { status: 503 } })).toBe('failed');
        expect(noteKeyRequestError(l, new Error('network'))).toBe('failed');
        expect(noteKeyRequestError(l, { response: { status: 403 } })).toBe('failed');
        expect(l.isBlocked()).toBe(false);
    });

    it('repeated 429s back off exponentially (5 s, 10 s, ... up to 60 s)', () => {
        const c = clock();
        const l = new KeyAskLimiter({ now: c.now });
        const waits: number[] = [];
        for (let i = 0; i < 6; i++) { waits.push(l.onThrottled()); c.advance(l.blockedForMs()); }
        expect(waits[3]).toBeGreaterThan(waits[0] * 2);
        expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
    });
});

// ── a fixed-window API like Nest's throttler: 60 / 60 s per user ────────────

class FixedWindowApi {
    private windowStart = -Infinity;
    private count = 0;
    accepted = 0;
    refused = 0;
    private readonly now: () => number;
    private readonly limit: number;
    constructor(now: () => number, limit: number = KEY_REQUEST_API_LIMIT_PER_MIN) {
        this.now = now;
        this.limit = limit;
    }
    hit(): 'ok' | 429 {
        const t = this.now();
        if (t - this.windowStart >= KEY_ASK_WINDOW_MS) { this.windowStart = t; this.count = 0; }
        this.count += 1;
        if (this.count > this.limit) { this.refused += 1; return 429; }
        this.accepted += 1;
        return 'ok';
    }
    retryAfterSec(): number { return Math.ceil((this.windowStart + KEY_ASK_WINDOW_MS - this.now()) / 1000); }
}

function makeQueue(c: ReturnType<typeof clock>, api: FixedWindowApi, opts: { held?: Set<string>; sentLog?: string[] } = {}) {
    const limiter = new KeyAskLimiter({ now: c.now });
    const sent = opts.sentLog ?? [];
    const accepted = new Set<string>();
    const queue: KeyAskQueue = new KeyAskQueue({
        limiter,
        now: c.now,
        sleep: c.sleep,
        send: async (ask: QueuedAsk): Promise<KeyAskOutcome> => {
            if (limiter.isBlocked()) { queue.enqueue({ ...ask, priority: 'forced' }); return 'throttled'; }
            limiter.record();
            sent.push(ask.channelId);
            if (api.hit() === 'ok') { limiter.onAccepted(); accepted.add(ask.channelId); return 'sent'; }
            limiter.onThrottled(api.retryAfterSec() * 1000);
            queue.enqueue({ ...ask, priority: 'forced' });
            return 'throttled';
        },
        stillWanted: (ask) => !opts.held?.has(ask.channelId),
    });
    return { queue, limiter, accepted, sent };
}

const asks = (n: number, priority: QueuedAsk['priority'] = 'keyless'): QueuedAsk[] =>
    Array.from({ length: n }, (_, i) => ({ serverId: `s${i % 4}`, channelId: `c${i}`, priority, targetEpoch: 2 }));

describe('KeyAskQueue — every planned ask is sent, none lost, none refused', () => {
    it('150 channels across servers: all 150 are accepted by a 60/min fixed-window API with ZERO 429s', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const { queue, accepted } = makeQueue(c, api);
        for (const a of asks(150)) queue.enqueue(a);
        await queue.whenIdle();
        expect(accepted.size).toBe(150);
        expect(api.refused).toBe(0);
    });

    it('control: the OLD inline loop (150 ms apart, 429 swallowed, stamped as asked) loses the tail of an 80-channel sweep', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const asked = new Set<string>();
        const refused: string[] = [];
        for (const a of asks(80)) {
            asked.add(a.channelId);                         // keyRequestDedupRef.set BEFORE the POST
            if (api.hit() === 429) refused.push(a.channelId);   // console.warn and move on
            await c.sleep(150);
        }
        expect(api.accepted).toBe(60);
        expect(refused).toHaveLength(20);                   // asked-for-nothing, and the 60 s dedup now blocks the retry
    });

    it('never sends more than the soft ceiling in any 60 s window, and finishes in a bounded time', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const stamps: number[] = [];
        const limiter = new KeyAskLimiter({ now: c.now });
        const queue = new KeyAskQueue({
            limiter, now: c.now, sleep: c.sleep,
            send: async () => { limiter.record(); stamps.push(c.now()); api.hit(); return 'sent'; },
        });
        const t0 = c.now();
        for (const a of asks(120)) queue.enqueue(a);
        await queue.whenIdle();
        let worst = 0;
        for (let i = 0, j = 0; i < stamps.length; i++) { while (stamps[i] - stamps[j] >= KEY_ASK_WINDOW_MS) j++; worst = Math.max(worst, i - j + 1); }
        expect(worst).toBeLessThanOrEqual(KEY_ASK_SOFT_CEILING);
        expect(stamps).toHaveLength(120);
        // 120 asks at <= 50/min: about 2.4 minutes, not "until the user opens each channel"
        expect(c.now() - t0).toBeLessThan(3 * 60_000);
    });

    it('a 429 that DOES happen (a second device spent the bucket) puts the ask back and it is sent after the back-off', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        // another device of the account has already used 55 of the 60 slots in this window
        for (let i = 0; i < 55; i++) api.hit();
        const { queue, accepted, limiter } = makeQueue(c, api);
        for (const a of asks(20)) queue.enqueue(a);
        await queue.whenIdle();
        expect(accepted.size).toBe(20);                     // every one eventually accepted
        expect(api.refused).toBeGreaterThan(0);             // the 429 really happened...
        expect(api.refused).toBeLessThan(10);               // ...and was backed off from, not hammered
        expect(limiter.isBlocked()).toBe(false);
    });

    it('control: without put-back, the same 429 would have lost those asks', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        for (let i = 0; i < 55; i++) api.hit();
        const limiter = new KeyAskLimiter({ now: c.now });
        const accepted = new Set<string>();
        const queue = new KeyAskQueue({
            limiter, now: c.now, sleep: c.sleep,
            send: async (a) => { limiter.record(); if (api.hit() === 'ok') { accepted.add(a.channelId); return 'sent'; } return 'failed'; },
        });
        for (const a of asks(20)) queue.enqueue(a);
        await queue.whenIdle();
        expect(accepted.size).toBeLessThan(20);
    });

    it('a forced ask (a genuine re-ask after an undecryptable envelope) jumps the queue', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const { queue, sent } = makeQueue(c, api);
        for (const a of asks(10)) queue.enqueue(a);
        queue.enqueue({ serverId: 's0', channelId: 'forced-one', priority: 'forced' });
        await queue.whenIdle();
        // the first ask has already started by the time enqueue returns control; the forced one is next
        expect(sent.indexOf('forced-one')).toBeLessThanOrEqual(1);
    });

    it('a forced ask may use the headroom between the soft and the hard ceiling that background asks may not', async () => {
        const c = clock();
        const limiter = new KeyAskLimiter({ now: c.now });
        const at = new Map<string, number>();
        const queue = new KeyAskQueue({
            limiter, now: c.now, sleep: c.sleep,
            send: async (a) => { limiter.record(); at.set(a.channelId, c.now()); return 'sent'; },
        });
        for (let i = 0; i < KEY_ASK_SOFT_CEILING; i++) { limiter.record(); c.advance(KEY_ASK_MIN_GAP_MS); }
        const t = c.now();
        queue.enqueue({ serverId: 's0', channelId: 'background', priority: 'keyless', targetEpoch: 2 });
        queue.enqueue({ serverId: 's0', channelId: 'forced', priority: 'forced' });
        await queue.whenIdle();
        expect(at.get('forced')! - t).toBeLessThanOrEqual(KEY_ASK_QUEUE_SLEEP_SLICE_MS);  // within one sleep slice, not a window
        expect(at.get('background')! - t).toBeGreaterThan(30_000);                   // the background ask waited for the window
    });

    it('priorities: forced, then keyless, then stale, then history-gap; FIFO inside a class', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const log: string[] = [];
        // hold the worker on the first item by blocking the limiter so everything is queued before any is sent
        const { queue, limiter } = makeQueue(c, api, { sentLog: log });
        limiter.onThrottled(5_000);
        queue.enqueue({ serverId: 's', channelId: 'gap1', priority: 'gap' });
        queue.enqueue({ serverId: 's', channelId: 'stale1', priority: 'stale', targetEpoch: 2 });
        queue.enqueue({ serverId: 's', channelId: 'key1', priority: 'keyless', targetEpoch: 2 });
        queue.enqueue({ serverId: 's', channelId: 'key2', priority: 'keyless', targetEpoch: 2 });
        queue.enqueue({ serverId: 's', channelId: 'forced1', priority: 'forced' });
        await queue.whenIdle();
        expect(log).toEqual(['forced1', 'key1', 'key2', 'stale1', 'gap1']);
    });

    it('one entry per channel: a second ask merges (best priority, newest target) instead of double-sending', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const { queue, limiter, sent } = makeQueue(c, api);
        limiter.onThrottled(5_000);
        expect(queue.enqueue({ serverId: 's', channelId: 'a', priority: 'stale', targetEpoch: 2 })).toBe('added');
        expect(queue.enqueue({ serverId: 's', channelId: 'a', priority: 'keyless', targetEpoch: 3 })).toBe('merged');
        expect(queue.size).toBe(1);
        expect(queue.has('a')).toBe(true);
        await queue.whenIdle();
        expect(sent).toEqual(['a']);
    });

    it('re-checks just before sending: a key that arrived while the ask waited is not asked for', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const held = new Set<string>();
        const { queue, limiter, sent } = makeQueue(c, api, { held });
        limiter.onThrottled(5_000);
        for (const a of asks(5)) queue.enqueue(a);
        held.add('c1'); held.add('c3');                     // a holder's push landed meanwhile
        await queue.whenIdle();
        expect(sent).toEqual(['c0', 'c2', 'c4']);
    });

    it('clear() (sign-out / account switch) drops everything queued', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const { queue, limiter, sent } = makeQueue(c, api);
        limiter.onThrottled(5_000);
        for (const a of asks(5)) queue.enqueue(a);
        queue.clear();
        expect(queue.size).toBe(0);
        await queue.whenIdle();
        expect(sent).toEqual([]);
    });

    it('a throttled ask is retried a bounded number of times, never forever', async () => {
        const c = clock();
        const limiter = new KeyAskLimiter({ now: c.now });
        let attempts = 0;
        const queue = new KeyAskQueue({
            limiter, now: c.now, sleep: c.sleep,
            send: async () => { attempts += 1; limiter.record(); return 'throttled'; },
        });
        queue.enqueue({ serverId: 's', channelId: 'a', priority: 'keyless', targetEpoch: 2 });
        await queue.whenIdle();
        expect(attempts).toBe(KEY_ASK_QUEUE_MAX_TRIES);
        expect(queue.size).toBe(0);
    });

    it('a send that throws is treated as failed (dropped), and the worker carries on with the rest', async () => {
        const c = clock();
        const limiter = new KeyAskLimiter({ now: c.now });
        const sent: string[] = [];
        const queue = new KeyAskQueue({
            limiter, now: c.now, sleep: c.sleep,
            send: async (a) => { limiter.record(); sent.push(a.channelId); if (a.channelId === 'boom') throw new Error('x'); return 'sent'; },
        });
        queue.enqueue({ serverId: 's', channelId: 'boom', priority: 'keyless' });
        queue.enqueue({ serverId: 's', channelId: 'fine', priority: 'keyless' });
        await queue.whenIdle();
        expect(sent).toEqual(['boom', 'fine']);
    });
});

describe('end to end: plan -> queue -> a 60/min API, member of 4 servers x 22 channels, nothing opened', () => {
    it('every channel is asked for exactly once, in the right order, with no 429', async () => {
        const c = clock();
        const api = new FixedWindowApi(c.now);
        const ledger = new PrefetchLedger();
        const { queue, accepted, sent } = makeQueue(c, api);
        const servers = Array.from({ length: 4 }, (_, s) => ({
            serverId: `srv${s}`,
            channels: Array.from({ length: 22 }, (_, i): PrefetchChannelInput =>
                i === 21
                    ? { channel_id: `srv${s}-calls`, kind: 'huddle', latest_epoch: 2, my_permissions: (VIEW | CONNECT).toString() }
                    : { channel_id: `srv${s}-t${i}`, kind: 'text', latest_epoch: 2, my_permissions: (VIEW | SEND).toString() }),
        }));
        // one private channel per server the member cannot see: the API would not list it, but even if it did we must not ask
        for (const s of servers) s.channels.push({ channel_id: `${s.serverId}-private`, kind: 'text', latest_epoch: 2, my_permissions: '0' });
        for (const s of servers) {
            const p = planKeyPrefetch({
                serverId: s.serverId, channels: s.channels, held: {}, ledger,
                lastAskedAt: () => undefined, isQueued: id => queue.has(id), now: c.now(), mode: 'event',
            });
            for (const a of p.asks) queue.enqueue({ serverId: s.serverId, channelId: a.channelId, priority: a.keyless ? 'keyless' : 'stale', targetEpoch: a.targetEpoch });
        }
        await queue.whenIdle();
        expect(accepted.size).toBe(88);
        expect(new Set(sent).size).toBe(sent.length);                    // each exactly once
        expect([...accepted].some(id => id.endsWith('-private'))).toBe(false);
        expect([...accepted].filter(id => id.endsWith('-calls'))).toHaveLength(4);   // Calls channels included
        expect(api.refused).toBe(0);
    });
});

describe('KeyAskQueue with sendMany — one call per server, not one per channel', () => {
    const realQueue = (deps: Partial<ConstructorParameters<typeof KeyAskQueue>[0]>) => new KeyAskQueue({
        limiter: new KeyAskLimiter(),
        send: async () => 'sent',
        sleep: async () => undefined,
        ...deps,
    });

    it('a joiner\'s 20 asks for one server go out as ONE call (best priority first); a lone ask keeps the single route', async () => {
        const calls: string[][] = [];
        const single: string[] = [];
        const q = realQueue({
            send: async (a) => { single.push(a.channelId); return 'sent'; },
            sendMany: async (batch) => { calls.push(batch.map(a => `${a.serverId}/${a.channelId}`)); return batch.map(() => 'sent'); },
        });
        for (let i = 0; i < 20; i++) q.enqueue({ serverId: 's1', channelId: `c${i}`, priority: i === 7 ? 'gap' : 'keyless' });
        q.enqueue({ serverId: 's2', channelId: 'x1', priority: 'keyless' });
        await q.whenIdle();
        expect(single).toEqual(['x1']);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveLength(20);
        expect(calls[0][19]).toBe('s1/c7'); // the gap ask after every keyless one
    });

    it('drops an ask that is no longer wanted from the batch', async () => {
        const calls: string[][] = [];
        const q = realQueue({
            stillWanted: (a) => a.channelId !== 'c2',
            sendMany: async (batch) => { calls.push(batch.map(a => a.channelId)); return batch.map(() => 'sent'); },
        });
        for (const c of ['c1', 'c2', 'c3']) q.enqueue({ serverId: 's1', channelId: c, priority: 'keyless' });
        await q.whenIdle();
        expect(calls).toEqual([['c1', 'c3']]);
    });

    it('an API without the batch route (null): the same asks go one per call, none lost', async () => {
        const single: string[] = [];
        let batchCalls = 0;
        const q = realQueue({
            send: async (a) => { single.push(a.channelId); return 'sent'; },
            sendMany: async () => { batchCalls++; return null; },
        });
        for (const c of ['c1', 'c2', 'c3']) q.enqueue({ serverId: 's1', channelId: c, priority: 'keyless' });
        await q.whenIdle();
        expect(batchCalls).toBe(1);
        expect(single.sort()).toEqual(['c1', 'c2', 'c3']);
    });

    it('a throttled ask in a batch goes back on the queue, the accepted ones do not', async () => {
        const sent: string[][] = [];
        const q = realQueue({
            sendMany: async (batch) => { sent.push(batch.map(a => a.channelId)); return batch.map(a => (a.channelId === 'c2' && sent.length === 1 ? 'throttled' : 'sent')); },
            send: async (a) => { sent.push([a.channelId]); return 'sent'; },
        });
        for (const c of ['c1', 'c2', 'c3']) q.enqueue({ serverId: 's1', channelId: c, priority: 'keyless' });
        await q.whenIdle();
        expect(sent).toEqual([['c1', 'c2', 'c3'], ['c2']]);
    });
});
