import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    KeyWaitTracker, KEY_UNANSWERED_MS, WsChurnCounter, WS_CHURN_THRESHOLD, WS_CHURN_WINDOW_MS,
    KeylessWaitTracker, KEYLESS_REPORT_MS, memoryHighCheck, MEMORY_HIGH_MB, watchPendingSend, PENDING_STUCK_MS,
    noteBetaKeyAsked, keyWaitTracker,
} from './detectors';
import { betaReporter } from './reporter';
import { decideRatingPrompt, parseRatingLedger, FRESH_LEDGER, RATING_MIN_GAP_MS } from './settings';

afterEach(() => {
    betaReporter.setServerEnabled(false);
    keyWaitTracker.clear();
    vi.useRealTimers();
});

describe('KeyWaitTracker (key_request_unanswered)', () => {
    it('reports once, after 2 min with no key installed, with waited_s and epoch_gap', () => {
        let t = 0;
        const out: unknown[] = [];
        const k = new KeyWaitTracker({ clock: () => t, emit: d => out.push(d), autoTimer: false });
        k.noteAsked('chan-a', { targetEpoch: 7, heldEpoch: 4 });
        k.noteAsked('chan-b', { targetEpoch: 3, heldEpoch: null });
        t = KEY_UNANSWERED_MS - 1; k.tick();
        expect(out).toHaveLength(0);
        k.noteReceived('chan-b');
        t = KEY_UNANSWERED_MS; k.tick();
        t = KEY_UNANSWERED_MS * 5; k.tick();
        expect(out).toEqual([{ waited_s: 120, epoch_gap: 3, keyless: false }]);
    });
    it('a re-ask does not restart the clock; a newer target raises the gap', () => {
        let t = 0;
        const out: Array<Record<string, unknown>> = [];
        const k = new KeyWaitTracker({ clock: () => t, emit: d => out.push(d), autoTimer: false });
        k.noteAsked('c', { targetEpoch: 2, heldEpoch: null });
        t = 60_000; k.noteAsked('c', { targetEpoch: 5, heldEpoch: null });
        t = KEY_UNANSWERED_MS; k.tick();
        expect(out).toEqual([{ waited_s: 120, epoch_gap: 5, keyless: true }]);
    });
    it('an unknown held epoch (stale channel, Dashboard only knows "not keyless") reports no gap / keyless', () => {
        let t = 0;
        const out: unknown[] = [];
        const k = new KeyWaitTracker({ clock: () => t, emit: d => out.push(d), autoTimer: false });
        k.noteAsked('c', { targetEpoch: 9, heldEpoch: undefined });
        t = KEY_UNANSWERED_MS; k.tick();
        expect(out).toEqual([{ waited_s: 120 }]);
    });
    it('noteBetaKeyAsked tracks nothing while beta diagnostics is off', () => {
        noteBetaKeyAsked('chan-x', { targetEpoch: 1 });
        expect(keyWaitTracker.size).toBe(0);
    });
});

describe('WsChurnCounter (ws_churn)', () => {
    it('reports at 5 drops inside 10 minutes, then not again for 10 minutes', () => {
        const c = new WsChurnCounter();
        const r: Array<number | null> = [];
        for (let i = 0; i < WS_CHURN_THRESHOLD; i++) r.push(c.noteDrop(i * 1000));
        expect(r).toEqual([null, null, null, null, WS_CHURN_THRESHOLD]);
        expect(c.noteDrop(6000)).toBeNull();
        expect(c.noteDrop(WS_CHURN_WINDOW_MS + 4000 + 1)).toBeNull(); // old drops aged out
    });
    it('slow, spread-out drops never report', () => {
        const c = new WsChurnCounter();
        for (let i = 0; i < 20; i++) expect(c.noteDrop(i * (WS_CHURN_WINDOW_MS / 3))).toBeNull(); // ≤ 4 per window
    });
});

describe('KeylessWaitTracker (call_keyless_wait)', () => {
    it('reports a long wait when the key arrives, nothing for a quick one', () => {
        const k = new KeylessWaitTracker();
        expect(k.update('call-1', true, 0)).toBeNull();
        expect(k.update('call-1', false, KEYLESS_REPORT_MS - 1)).toBeNull();
        expect(k.update('call-2', true, 10_000)).toBeNull();
        expect(k.update('call-2', false, 10_000 + 7_500)).toEqual({ waited_ms: 7_500, gave_up: false });
        expect(k.update('call-2', true, 30_000)).toBeNull(); // a later degrade is not a keyless wait
    });
    it('a call that ends while still waiting reports gave_up', () => {
        const k = new KeylessWaitTracker();
        k.update('call-1', true, 0);
        expect(k.update(null, false, 25_000)).toEqual({ waited_ms: 25_000, gave_up: true });
    });
    it('a call that had its key from the start never reports', () => {
        const k = new KeylessWaitTracker();
        expect(k.update('c', false, 0)).toBeNull();
        expect(k.update(null, false, 99_000)).toBeNull();
    });
});

describe('memoryHighCheck / watchPendingSend', () => {
    it('memory: MB above the line, null below or unknown', () => {
        expect(memoryHighCheck(() => (MEMORY_HIGH_MB + 1) * 1048576)).toBe(MEMORY_HIGH_MB + 1);
        expect(memoryHighCheck(() => 300 * 1048576)).toBeNull();
        expect(memoryHighCheck(() => null)).toBeNull();
    });
    it('pending send: arms nothing while off; reports once when still unsettled at 30 s', () => {
        vi.useFakeTimers();
        const setSpy = vi.fn(setTimeout);
        watchPendingSend(() => false, { kind: 'dm' }, { set: setSpy as unknown as typeof setTimeout, clear: clearTimeout });
        expect(setSpy).not.toHaveBeenCalled();

        betaReporter.setServerEnabled(true); betaReporter.setLocalEnabled(true); betaReporter.setSignedIn(true);
        let settled = false;
        watchPendingSend(() => settled, { kind: 'channel' });
        watchPendingSend(() => true, { kind: 'dm' });
        vi.advanceTimersByTime(PENDING_STUCK_MS);
        expect(betaReporter.peekQueue()).toEqual([{ kind: 'msg_pending_stuck', detail: { waited_s: 30, scope: 'channel' } }]);
        settled = true;
        betaReporter.setSignedIn(false);
    });
});

describe('rating card frequency (decideRatingPrompt)', () => {
    const MIN = 60_000;
    const T = 1_760_000_000_000;
    it('never for a call under 30 s', () => {
        expect(decideRatingPrompt(FRESH_LEDGER, 29, 0)).toEqual({ show: false, next: FRESH_LEDGER });
    });
    it('first eligible call shows; then at most once per 3 calls', () => {
        let l = { ...FRESH_LEDGER };
        const shown: boolean[] = [];
        for (let i = 0; i < 7; i++) {
            const d = decideRatingPrompt(l, 120, T + i * 30 * MIN);
            shown.push(d.show); l = d.next;
        }
        expect(shown).toEqual([true, false, false, true, false, false, true]);
    });
    it('never twice within 10 minutes, even when due', () => {
        let l = decideRatingPrompt(FRESH_LEDGER, 60, T).next;            // shown
        l = decideRatingPrompt(l, 60, T + 1 * MIN).next;                    // 1 since
        l = decideRatingPrompt(l, 60, T + 2 * MIN).next;                    // 2 since
        const due = decideRatingPrompt(l, 60, T + 3 * MIN);                 // due by count…
        expect(due.show).toBe(false);                                       // …but inside 10 min
        expect(decideRatingPrompt(due.next, 60, T + RATING_MIN_GAP_MS).show).toBe(true);
    });
    it('ledger parsing is defensive', () => {
        expect(parseRatingLedger('{"since":2,"lastShownAt":5}')).toEqual({ since: 2, lastShownAt: 5 });
        expect(parseRatingLedger('garbage')).toEqual(FRESH_LEDGER);
        expect(parseRatingLedger('{"since":-4,"lastShownAt":"x"}')).toEqual(FRESH_LEDGER);
    });
});
