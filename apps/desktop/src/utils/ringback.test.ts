import { describe, it, expect, vi } from 'vitest';
import { ringbackWanted, createRingbackDriver, RINGBACK_MAX_MS, type RingbackInput } from './ringback';

/** Caller, start succeeded, room connected, alone, nobody answered yet. */
const ringingNow: RingbackInput = { isInitiator: true, noRinging: false, roomConnected: true, participantCount: 1, hasConnectedOnce: false };

describe('ringbackWanted', () => {
    it('positive control: a started call, connected, still alone → rings', () => {
        expect(ringbackWanted(ringingNow)).toBe(true);
    });
    it('not before the room is connected (instant join puts the UI up first)', () => {
        expect(ringbackWanted({ ...ringingNow, roomConnected: false })).toBe(false);
    });
    it('not unless we started the call (start success that created the session; failed start never sets this)', () => {
        expect(ringbackWanted({ ...ringingNow, isInitiator: false })).toBe(false);
    });
    it('never for server calls', () => {
        expect(ringbackWanted({ ...ringingNow, noRinging: true })).toBe(false);
    });
    it('stops once anyone else is in (answered), and stays off after they leave again', () => {
        expect(ringbackWanted({ ...ringingNow, participantCount: 2 })).toBe(false);
        expect(ringbackWanted({ ...ringingNow, participantCount: 1, hasConnectedOnce: true })).toBe(false);
    });
});

function harness() {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const play = vi.fn(() => { const s = vi.fn(); stops.push(s); return s; });
    let pending: { fn: () => void; ms: number } | null = null;
    const timers = {
        set: vi.fn((fn: () => void, ms: number) => { pending = { fn, ms }; return 1; }),
        clear: vi.fn(() => { pending = null; }),
    };
    const driver = createRingbackDriver(timers);
    const fireCap = () => { const p = pending; pending = null; p?.fn(); };
    return { play, stops, timers, driver, fireCap, pendingMs: () => pending?.ms ?? null };
}

/** The sequence a real outgoing call goes through, as CallAudioEffects feeds it. */
const sequence = (h: ReturnType<typeof harness>, steps: RingbackInput[]) => steps.forEach(s => h.driver.update(ringbackWanted(s), h.play));

describe('createRingbackDriver — every path', () => {
    it('click → starting → connected: silent until Connected, then rings (once), capped', () => {
        const h = harness();
        sequence(h, [
            { ...ringingNow, isInitiator: false, roomConnected: false }, // optimistic UI, start in flight
            { ...ringingNow, roomConnected: false },                      // start succeeded, room connecting
        ]);
        expect(h.play).not.toHaveBeenCalled();
        sequence(h, [ringingNow, ringingNow]);                           // connected (re-render does not restart)
        expect(h.play).toHaveBeenCalledTimes(1);
        expect(h.driver.ringing).toBe(true);
        expect(h.pendingMs()).toBe(RINGBACK_MAX_MS);
    });

    it('a failed start (no call object, never initiator, never connected) never plays', () => {
        const h = harness();
        sequence(h, [
            { ...ringingNow, isInitiator: false, roomConnected: false },
            { ...ringingNow, isInitiator: false, roomConnected: false },
        ]);
        h.driver.dispose(); // rolled back
        expect(h.play).not.toHaveBeenCalled();
    });

    it('answered → stops', () => {
        const h = harness();
        sequence(h, [ringingNow, { ...ringingNow, participantCount: 2, hasConnectedOnce: true }]);
        expect(h.stops[0]).toHaveBeenCalledTimes(1);
        expect(h.driver.ringing).toBe(false);
        expect(h.timers.clear).toHaveBeenCalled();
    });

    it('declined / cancelled / left / connection failed → CallPane unmounts → stops', () => {
        const h = harness();
        sequence(h, [ringingNow]);
        h.driver.dispose();
        expect(h.stops[0]).toHaveBeenCalledTimes(1);
        h.driver.dispose(); // idempotent
        expect(h.stops[0]).toHaveBeenCalledTimes(1);
    });

    it('left while still connecting → never started, nothing to stop', () => {
        const h = harness();
        sequence(h, [{ ...ringingNow, roomConnected: false }]);
        h.driver.dispose();
        expect(h.play).not.toHaveBeenCalled();
    });

    it('timeout: stops at the cap and does not restart while still alone', () => {
        const h = harness();
        sequence(h, [ringingNow]);
        h.fireCap();
        expect(h.stops[0]).toHaveBeenCalledTimes(1);
        sequence(h, [ringingNow, ringingNow]);
        expect(h.play).toHaveBeenCalledTimes(1);
    });
});
