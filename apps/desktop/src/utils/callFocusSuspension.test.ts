import { describe, it, expect } from 'vitest';
import { stepFocusSuspension } from './callFocusSuspension';

type F = { identity: string; source: string };
const BOB: F = { identity: 'bob', source: 'camera' };
const AMY: F = { identity: 'amy', source: 'screen_share' };

/** Drives the reducer the way the component does: apply the result, feed it back. */
function run(
    start: { suppressed: boolean; callActive: boolean; current: F | null; saved: F | null },
    steps: Array<Partial<{ suppressed: boolean; callActive: boolean; current: F | null }>>,
) {
    let state = { ...start };
    for (const step of steps) {
        state = { ...state, ...step };
        const r = stepFocusSuspension<F>(state);
        state = { ...state, saved: r.saved, current: r.apply !== undefined ? r.apply : state.current };
    }
    return state;
}

describe('stepFocusSuspension', () => {
    it('parks and clears the focus when entering a suppressed view', () => {
        const r = stepFocusSuspension<F>({ suppressed: true, callActive: true, current: BOB, saved: null });
        expect(r.saved).toEqual(BOB);
        expect(r.apply).toBeNull();
    });

    it('restores the same focus on leaving the suppressed view', () => {
        const r = stepFocusSuspension<F>({ suppressed: false, callActive: true, current: null, saved: BOB });
        expect(r.saved).toBeNull();
        expect(r.apply).toEqual(BOB);
    });

    it('round-trips the identical participant/track through Home', () => {
        const end = run(
            { suppressed: false, callActive: true, current: BOB, saved: null },
            [{ suppressed: true }, { suppressed: false }],
        );
        // Suspended, not destroyed: the same stream comes back.
        expect(end.current).toEqual(BOB);
        expect(end.saved).toBeNull();
    });

    it('collapses the focus into the panel for the whole time on Home', () => {
        let state = { suppressed: false, callActive: true, current: BOB as F | null, saved: null as F | null };
        state = { ...state, suppressed: true };
        const entered = stepFocusSuspension<F>(state);
        state = { ...state, saved: entered.saved, current: entered.apply !== undefined ? entered.apply : state.current };
        expect(state.current).toBeNull(); // banner unmounts, tile returns to the sidebar

        // Idle re-renders while still on Home must not disturb anything.
        const idle = stepFocusSuspension<F>(state);
        expect(idle.saved).toEqual(BOB);
        expect(idle.apply).toBeUndefined();
    });

    it('parks a focus picked from the context panel while already suppressed', () => {
        const r = stepFocusSuspension<F>({ suppressed: true, callActive: true, current: AMY, saved: BOB });
        expect(r.saved).toEqual(AMY); // newest pick wins
        expect(r.apply).toBeNull();
    });

    it('stays suppressed across Friends → Home without re-running a restore', () => {
        // Both tabs suppress, so the boolean never flips; the park survives.
        const end = run(
            { suppressed: false, callActive: true, current: BOB, saved: null },
            [{ suppressed: true }, { suppressed: true }, { suppressed: false }],
        );
        expect(end.current).toEqual(BOB);
    });

    it('drops a parked focus when the call ends', () => {
        const r = stepFocusSuspension<F>({ suppressed: true, callActive: false, current: null, saved: BOB });
        expect(r.saved).toBeNull();
        expect(r.apply).toBeUndefined(); // teardown owns clearing focusedStream
    });

    it('does not resurrect a previous call’s focus into a new call', () => {
        const end = run(
            { suppressed: false, callActive: true, current: BOB, saved: null },
            [
                { suppressed: true },        // park Bob on Home
                { callActive: false },       // call ends while still on Home
                { callActive: true },        // a new call starts
                { suppressed: false },       // back to a DM
            ],
        );
        expect(end.current).toBeNull();
        expect(end.saved).toBeNull();
    });

    it('is a no-op when nothing is focused and nothing is parked', () => {
        expect(stepFocusSuspension<F>({ suppressed: false, callActive: true, current: null, saved: null }))
            .toEqual({ saved: null });
        expect(stepFocusSuspension<F>({ suppressed: true, callActive: true, current: null, saved: null }))
            .toEqual({ saved: null });
    });

    it('leaves an un-suppressed focus completely alone', () => {
        const r = stepFocusSuspension<F>({ suppressed: false, callActive: true, current: BOB, saved: null });
        expect(r.apply).toBeUndefined();
        expect(r.saved).toBeNull();
    });
});
