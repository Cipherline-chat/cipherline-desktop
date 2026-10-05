import { describe, it, expect } from 'vitest';
import {
    DRAG_THRESHOLD_PX,
    IDLE_DRAG,
    beginDrag,
    endDrag,
    isActive,
    isPanning,
    moveDrag,
    type DragState,
} from './dragGesture';

const P = 1; // pointerId

/** Walk a whole gesture, returning the total pan applied and the verdict. */
function play(steps: Array<[number, number]>, opts: { pointerId?: number } = {}) {
    const id = opts.pointerId ?? P;
    let s = beginDrag(id, steps[0][0], steps[0][1]);
    let dx = 0, dy = 0;
    let panCount = 0;
    for (const [x, y] of steps.slice(1)) {
        const r = moveDrag(s, id, x, y);
        s = r.state;
        if (r.pan) { dx += r.pan.dx; dy += r.pan.dy; panCount++; }
    }
    const e = endDrag(s, id);
    return { total: { dx, dy }, panCount, suppressClick: e.suppressClick, state: e.state };
}

describe('the click / pan decision', () => {
    it('treats a motionless press as a click', () => {
        const r = play([[100, 100]]);
        expect(r.panCount).toBe(0);
        expect(r.suppressClick).toBe(false);
    });

    it('treats sub-threshold wobble as a click', () => {
        // The hand-tremor case: 2px of drift while pressing the button.
        const r = play([[100, 100], [101, 100], [102, 100], [102, 101]]);
        expect(r.panCount).toBe(0);
        expect(r.suppressClick).toBe(false);
    });

    it('treats a deliberate drag as a pan and swallows the click', () => {
        const r = play([[100, 100], [140, 100]]);
        expect(r.panCount).toBe(1);
        expect(r.suppressClick).toBe(true);
    });
});

describe('the threshold boundary', () => {
    it('does not engage just under it', () => {
        const s = beginDrag(P, 0, 0);
        expect(moveDrag(s, P, DRAG_THRESHOLD_PX - 0.01, 0).pan).toBeNull();
    });

    it('engages exactly at it', () => {
        const s = beginDrag(P, 0, 0);
        const r = moveDrag(s, P, DRAG_THRESHOLD_PX, 0);
        expect(r.pan).toEqual({ dx: DRAG_THRESHOLD_PX, dy: 0 });
        expect(isPanning(r.state)).toBe(true);
    });

    it('is Euclidean, so it is the same in every direction', () => {
        // (2,2) is 2.83 away — under the threshold. Manhattan distance would
        // have called it 4 and engaged a pan the user never asked for.
        const s = beginDrag(P, 0, 0);
        expect(moveDrag(s, P, 2, 2).pan).toBeNull();
        // ...and the same distance straight down is equally not a pan.
        expect(moveDrag(s, P, 0, 2.83).pan).toBeNull();
        // A hair further in either direction does engage, identically.
        expect(moveDrag(s, P, 0, 3.01).pan).not.toBeNull();
        expect(moveDrag(s, P, 2.13, 2.13).pan).not.toBeNull();
    });
});

describe('measuring from the origin, not the last move', () => {
    it('crosses on an accumulation of 1px steps (the trackpad profile)', () => {
        // Each individual step is 1px — far under the threshold. Comparing
        // against the PREVIOUS position would never cross and the whole
        // gesture would be misread as a click.
        const r = play([[0, 0], [1, 0], [2, 0], [3, 0]]);
        expect(r.suppressClick).toBe(true);
        expect(r.total).toEqual({ dx: 3, dy: 0 });
    });

    it('crosses on one large step (the mouse profile)', () => {
        const r = play([[0, 0], [1, 0], [60, 0]]);
        expect(r.suppressClick).toBe(true);
        expect(r.total).toEqual({ dx: 60, dy: 0 });
    });

    it('gives both profiles the same total pan for the same travel', () => {
        const fine = play([[0, 0], ...Array.from({ length: 200 }, (_, i) => [i + 1, 0] as [number, number])]);
        const coarse = play([[0, 0], [1, 0], [67, 0], [134, 0], [200, 0]]);
        expect(fine.total).toEqual(coarse.total);
        expect(fine.total).toEqual({ dx: 200, dy: 0 });
        expect(fine.suppressClick).toBe(coarse.suppressClick);
    });
});

describe('no drift at the moment of engagement', () => {
    it('pans by the full travel from the press point', () => {
        const s = beginDrag(P, 500, 500);
        const r = moveDrag(s, P, 540, 530);
        // Not (40 - 3, 30 - 3): the content must sit exactly under the cursor,
        // with no residual threshold-sized offset between grab and picture.
        expect(r.pan).toEqual({ dx: 40, dy: 30 });
    });

    it('sums to the true total displacement across a whole gesture', () => {
        const r = play([[0, 0], [10, 5], [30, 25], [-20, 60]]);
        expect(r.total).toEqual({ dx: -20, dy: 60 });
    });
});

describe('the panning phase latches', () => {
    it('stays a pan after returning inside the threshold', () => {
        // Out past the threshold and back to the exact press point.
        const r = play([[100, 100], [160, 100], [100, 100]]);
        expect(r.suppressClick).toBe(true);
        expect(r.total).toEqual({ dx: 0, dy: 0 });
    });

    it('keeps emitting deltas for sub-threshold moves once panning', () => {
        let s = beginDrag(P, 0, 0);
        s = moveDrag(s, P, 50, 0).state;
        const r = moveDrag(s, P, 51, 0);
        expect(r.pan).toEqual({ dx: 1, dy: 0 });
    });
});

describe('pointer identity', () => {
    it('ignores moves from a different pointer', () => {
        const s = beginDrag(P, 0, 0);
        const r = moveDrag(s, 99, 500, 500);
        expect(r.pan).toBeNull();
        expect(r.state).toBe(s);
    });

    it('ignores a release from a different pointer', () => {
        let s = beginDrag(P, 0, 0);
        s = moveDrag(s, P, 80, 0).state;
        const other = endDrag(s, 99);
        expect(other.suppressClick).toBe(false);
        expect(isActive(other.state)).toBe(true);   // our gesture is still open
        // The real release still reports the pan.
        expect(endDrag(s, P).suppressClick).toBe(true);
    });
});

describe('idle state', () => {
    it('ignores moves and releases when no gesture is open', () => {
        expect(moveDrag(IDLE_DRAG, P, 100, 100).pan).toBeNull();
        expect(endDrag(IDLE_DRAG, P).suppressClick).toBe(false);
        expect(isActive(IDLE_DRAG)).toBe(false);
        expect(isPanning(IDLE_DRAG)).toBe(false);
    });

    it('returns to idle after a release', () => {
        const r = play([[0, 0], [90, 0]]);
        expect(r.state).toEqual(IDLE_DRAG);
        expect(isActive(r.state)).toBe(false);
    });

    it('a press is pending, not panning', () => {
        const s: DragState = beginDrag(P, 10, 10);
        expect(s.phase).toBe('pending');
        expect(isPanning(s)).toBe(false);
        expect(isActive(s)).toBe(true);
    });
});
