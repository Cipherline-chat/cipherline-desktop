import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CLIENT_OTP_LOW_WATER,
    OTP_DRAIN_CHECK_EVERY,
    PREKEY_CHECK_EVENT,
    PREKEY_CHECK_MIN_SPACING_MS,
    WS_CONNECTED_EVENT,
    _resetPrekeyUsageCounter,
    mayRunTriggeredCheck,
    notePrekeyUsage,
    shouldUploadBundle,
    subscribePrekeyCheckTriggers,
} from './prekeyHealth';

/**
 * G3 — one-time-prekey exhaustion must be rare, and the signal that drives
 * replenishment must be local (no server logging of who messaged whom).
 *
 * The vitest environment is `node` with a no-op `window` stub (see
 * useAnnouncements.test.ts), so the hook cannot be rendered; its logic lives
 * in these pure/imperative helpers, and a source check pins the wiring.
 */

const g = globalThis as unknown as { window: Record<string, unknown> };
let bus: EventTarget;
let saved: Record<string, unknown>;

beforeEach(() => {
    bus = new EventTarget();
    saved = { ...g.window };
    g.window.addEventListener = bus.addEventListener.bind(bus);
    g.window.removeEventListener = bus.removeEventListener.bind(bus);
    g.window.dispatchEvent = bus.dispatchEvent.bind(bus);
    _resetPrekeyUsageCounter();
});
afterEach(() => {
    for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) g.window[k] = saved[k];
    vi.useRealTimers();
});

function countEvents(): { n: () => number } {
    let n = 0;
    bus.addEventListener(PREKEY_CHECK_EVENT, () => { n++; });
    return { n: () => n };
}

describe('shouldUploadBundle — client low-water mark on top of the server flag', () => {
    it('always honours the server flag (low pool or aging signed prekey)', () => {
        expect(shouldUploadBundle({ needs_rotation: true, otp_remaining: 180 })).toBe(true);
    });
    it('tops up below the client mark even when the server (< 20) would not', () => {
        expect(shouldUploadBundle({ needs_rotation: false, otp_remaining: CLIENT_OTP_LOW_WATER - 1 })).toBe(true);
        expect(shouldUploadBundle({ needs_rotation: false, otp_remaining: 20 })).toBe(true);
    });
    it('does not churn uploads at or above the mark', () => {
        expect(shouldUploadBundle({ needs_rotation: false, otp_remaining: CLIENT_OTP_LOW_WATER })).toBe(false);
        expect(shouldUploadBundle({ needs_rotation: false, otp_remaining: 100 })).toBe(false);
    });
    it('treats a missing / non-numeric count as "the server did not say" (no upload on that alone)', () => {
        expect(shouldUploadBundle({ needs_rotation: false })).toBe(false);
        expect(shouldUploadBundle({ needs_rotation: false, otp_remaining: Number.NaN })).toBe(false);
    });
    it('keeps a top-up inside the server upload cap: carried (< mark) + 100 new <= 200', () => {
        expect((CLIENT_OTP_LOW_WATER - 1) + 100).toBeLessThanOrEqual(200);
    });
});

describe('notePrekeyUsage — the recipient-side, telemetry-free signal', () => {
    it('an inbound DM that used NONE of our one-time prekeys requests a check immediately', () => {
        const ev = countEvents();
        notePrekeyUsage(false);
        expect(ev.n()).toBe(1);
    });
    it('a draining pool requests a check every OTP_DRAIN_CHECK_EVERY consumed prekeys', () => {
        const ev = countEvents();
        for (let i = 0; i < OTP_DRAIN_CHECK_EVERY - 1; i++) notePrekeyUsage(true);
        expect(ev.n()).toBe(0);
        notePrekeyUsage(true);
        expect(ev.n()).toBe(1);
        for (let i = 0; i < OTP_DRAIN_CHECK_EVERY; i++) notePrekeyUsage(true);
        expect(ev.n()).toBe(2);
    });
    it('ignores "unknown" (an older main process that does not report it)', () => {
        const ev = countEvents();
        for (let i = 0; i < 50; i++) notePrekeyUsage(undefined);
        expect(ev.n()).toBe(0);
    });
});

describe('subscribePrekeyCheckTriggers — spacing without dropping', () => {
    it('runs on an explicit request and on a WS reconnect', () => {
        let last: number | null = null;
        const run = vi.fn(() => { last = Date.now(); });
        const off = subscribePrekeyCheckTriggers(bus, run, () => last);
        bus.dispatchEvent(new Event(PREKEY_CHECK_EVENT));
        expect(run).toHaveBeenCalledTimes(1);
        last = Date.now() - PREKEY_CHECK_MIN_SPACING_MS; // pretend a minute passed
        bus.dispatchEvent(new Event(WS_CONNECTED_EVENT));
        expect(run).toHaveBeenCalledTimes(2);
        off();
    });

    it('DEFERS (not drops) a trigger inside the spacing window, and collapses a burst into one', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        let last: number | null = null;
        const run = vi.fn(() => { last = Date.now(); });
        const off = subscribePrekeyCheckTriggers(bus, run, () => last);

        bus.dispatchEvent(new Event(PREKEY_CHECK_EVENT)); // runs now
        expect(run).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 25; i++) bus.dispatchEvent(new Event(PREKEY_CHECK_EVENT)); // SPK-only burst
        expect(run).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(PREKEY_CHECK_MIN_SPACING_MS - 1);
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(run).toHaveBeenCalledTimes(2); // exactly one deferred check
        vi.advanceTimersByTime(10 * PREKEY_CHECK_MIN_SPACING_MS);
        expect(run).toHaveBeenCalledTimes(2);
        off();
    });

    it('unsubscribing cancels a pending deferred check and stops listening', () => {
        vi.useFakeTimers();
        let last: number | null = Date.now();
        const run = vi.fn(() => { last = Date.now(); });
        const off = subscribePrekeyCheckTriggers(bus, run, () => last);
        bus.dispatchEvent(new Event(PREKEY_CHECK_EVENT)); // deferred
        off();
        vi.advanceTimersByTime(2 * PREKEY_CHECK_MIN_SPACING_MS);
        bus.dispatchEvent(new Event(WS_CONNECTED_EVENT));
        expect(run).not.toHaveBeenCalled();
    });

    it('mayRunTriggeredCheck boundary', () => {
        expect(mayRunTriggeredCheck(null, 5)).toBe(true);
        expect(mayRunTriggeredCheck(0, PREKEY_CHECK_MIN_SPACING_MS - 1)).toBe(false);
        expect(mayRunTriggeredCheck(0, PREKEY_CHECK_MIN_SPACING_MS)).toBe(true);
    });
});

describe('wiring (source check — the hook cannot be rendered under vitest node)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

    it('useKeyRotation gates uploads on shouldUploadBundle and subscribes to the triggers', () => {
        const src = read('../hooks/useKeyRotation.ts');
        expect(src).toMatch(/!shouldUploadBundle\(data\)/);
        expect(src).not.toMatch(/!data\.needs_rotation\)/);
        expect(src).toMatch(/subscribePrekeyCheckTriggers\(window,/);
    });

    it('the DM pull path feeds every decrypt result to notePrekeyUsage', () => {
        const src = read('../components/Dashboard.tsx');
        expect(src).toMatch(/notePrekeyUsage\(decryptResult\.usedOneTimePrekey\)/);
    });

    it('useRealtime still emits the reconnect event the scheduler listens for', () => {
        expect(read('../hooks/useRealtime.ts')).toContain(`new CustomEvent('${WS_CONNECTED_EVENT}')`);
    });
});
