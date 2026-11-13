import { describe, it, expect } from 'vitest';
import {
    countGridColumns, describePinMove, gridMoveTarget, moveVisiblePin, pinKey, pinReorderDirection,
    type PinnedHomeItem,
} from './homePins';

/** Owner request 2026-11-12: rearrange your pinned stuff on Home. The order is
 *  the persisted array's order, so all of the reorder's correctness lives in
 *  these pure functions. */

const conv = (id: string): PinnedHomeItem => ({ type: 'conversation', id });
const chan = (channelId: string, serverId = 'S1'): PinnedHomeItem => ({ type: 'channel', channelId, serverId });
const srv = (serverId: string): PinnedHomeItem => ({ type: 'server', serverId });
const keysOf = (xs: PinnedHomeItem[] | null) => xs?.map(pinKey) ?? null;

describe('moveVisiblePin — every pin type, arrayMove semantics', () => {
    const all = [conv('a'), chan('b'), srv('c'), conv('d')];
    const vis = all.map(pinKey); // c:a ch:b s:c c:d

    it('moves forward (to = final index)', () => {
        expect(keysOf(moveVisiblePin(all, vis, 'c:a', 2))).toEqual(['ch:b', 's:c', 'c:a', 'c:d']);
    });
    it('moves backward', () => {
        expect(keysOf(moveVisiblePin(all, vis, 'c:d', 1))).toEqual(['c:a', 'c:d', 'ch:b', 's:c']);
    });
    it('to the very start and the very end', () => {
        expect(keysOf(moveVisiblePin(all, vis, 's:c', 0))).toEqual(['s:c', 'c:a', 'ch:b', 'c:d']);
        expect(keysOf(moveVisiblePin(all, vis, 'ch:b', 3))).toEqual(['c:a', 's:c', 'c:d', 'ch:b']);
    });
    it('clamps an out-of-range target instead of dropping the pin', () => {
        expect(keysOf(moveVisiblePin(all, vis, 'c:a', 99))).toEqual(['ch:b', 's:c', 'c:d', 'c:a']);
        expect(keysOf(moveVisiblePin(all, vis, 'c:d', -5))).toEqual(['c:d', 'c:a', 'ch:b', 's:c']);
    });
    it('a no-op (same slot, unknown key, single pin) returns null', () => {
        expect(moveVisiblePin(all, vis, 'ch:b', 1)).toBeNull();
        expect(moveVisiblePin(all, vis, 'c:nope', 0)).toBeNull();
        expect(moveVisiblePin([conv('a')], ['c:a'], 'c:a', 0)).toBeNull();
    });
    it('never mutates its input and keeps the same item objects', () => {
        const before = JSON.stringify(all);
        const out = moveVisiblePin(all, vis, 'c:a', 3)!;
        expect(JSON.stringify(all)).toBe(before);
        expect(out).not.toBe(all);
        expect(out).toHaveLength(all.length);
        for (const p of out) expect(all).toContain(p);
    });
});

describe('moveVisiblePin — pins Home cannot show right now keep their slot', () => {
    // ch:x is pinned but hidden (its server's channel list not loaded yet).
    const all = [conv('a'), chan('x'), conv('b'), srv('c')];
    const vis = ['c:a', 'c:b', 's:c'];

    it('a visual move only refills the visible slots', () => {
        // Visible c:a c:b s:c → s:c c:a c:b; ch:x stays at index 1.
        expect(keysOf(moveVisiblePin(all, vis, 's:c', 0))).toEqual(['s:c', 'ch:x', 'c:a', 'c:b']);
    });
    it('the hidden pin reappears where it was once it resolves', () => {
        const out = moveVisiblePin(all, vis, 'c:a', 2)!;
        expect(out.findIndex(p => pinKey(p) === 'ch:x')).toBe(1);
        expect(out).toHaveLength(4);
    });
    it('POSITIVE CONTROL: a naive whole-array move WOULD displace the hidden pin', () => {
        // Same user intent ("s:c to the front") done on the raw array: the hidden
        // pin shifts — the exact bug moveVisiblePin exists to avoid. If this ever
        // stopped differing, the test above would not be proving anything.
        const naive = all.slice();
        naive.unshift(naive.splice(3, 1)[0]);
        expect(naive.findIndex(p => pinKey(p) === 'ch:x')).toBe(2);
        expect(keysOf(moveVisiblePin(all, vis, 's:c', 0))).not.toEqual(keysOf(naive));
    });
    it('stale / duplicate visible keys are ignored rather than corrupting the array', () => {
        const out = moveVisiblePin(all, ['c:gone', 'c:a', 'c:b', 'c:b', 's:c'], 's:c', 0);
        expect(keysOf(out)).toEqual(['s:c', 'ch:x', 'c:a', 'c:b']);
    });
});

describe('gridMoveTarget — wrapping row-major grid', () => {
    // 3 columns, 7 pins:
    //   0 1 2
    //   3 4 5
    //   6
    const N = 7, C = 3;
    it('left/right step one place and wrap across a row end', () => {
        expect(gridMoveTarget(4, N, C, 'left')).toBe(3);
        expect(gridMoveTarget(4, N, C, 'right')).toBe(5);
        expect(gridMoveTarget(2, N, C, 'right')).toBe(3); // end of row 1 → start of row 2
        expect(gridMoveTarget(3, N, C, 'left')).toBe(2);
    });
    it('up/down jump a whole row', () => {
        expect(gridMoveTarget(4, N, C, 'up')).toBe(1);
        expect(gridMoveTarget(1, N, C, 'down')).toBe(4);
        expect(gridMoveTarget(3, N, C, 'down')).toBe(6);
    });
    it('down into a short last row lands on the last pin', () => {
        expect(gridMoveTarget(4, N, C, 'down')).toBe(6);
        expect(gridMoveTarget(5, N, C, 'down')).toBe(6);
    });
    it('edges are no-ops (null)', () => {
        expect(gridMoveTarget(0, N, C, 'left')).toBeNull();
        expect(gridMoveTarget(6, N, C, 'right')).toBeNull();
        expect(gridMoveTarget(1, N, C, 'up')).toBeNull();
        expect(gridMoveTarget(6, N, C, 'down')).toBeNull();
    });
    it('a single-column layout behaves like a list', () => {
        expect(gridMoveTarget(2, 4, 1, 'up')).toBe(1);
        expect(gridMoveTarget(2, 4, 1, 'down')).toBe(3);
        expect(gridMoveTarget(3, 4, 1, 'down')).toBeNull();
    });
    it('everything on one row: up/down are no-ops, left/right still move', () => {
        expect(gridMoveTarget(1, 3, 3, 'down')).toBeNull();
        expect(gridMoveTarget(1, 3, 3, 'up')).toBeNull();
        expect(gridMoveTarget(1, 3, 3, 'right')).toBe(2);
    });
    it('fewer than two pins or a bad index never moves', () => {
        expect(gridMoveTarget(0, 1, 3, 'right')).toBeNull();
        expect(gridMoveTarget(-1, 4, 2, 'right')).toBeNull();
        expect(gridMoveTarget(4, 4, 2, 'left')).toBeNull();
    });
});

describe('countGridColumns', () => {
    it('counts the first run of equal tops', () => {
        expect(countGridColumns([0, 0, 0, 48, 48, 96])).toBe(3);
        expect(countGridColumns([0, 48, 96])).toBe(1);
        expect(countGridColumns([10, 10])).toBe(2);
        expect(countGridColumns([])).toBe(1);
    });
    it('sub-pixel rounding does not split a row', () => {
        expect(countGridColumns([0, 0.4, 0.2, 52])).toBe(3);
    });
});

describe('pinReorderDirection', () => {
    const ev = (key: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
        ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    it('Alt+Arrow and Ctrl+Arrow map to a direction', () => {
        expect(pinReorderDirection(ev('ArrowLeft', { altKey: true }))).toBe('left');
        expect(pinReorderDirection(ev('ArrowRight', { ctrlKey: true }))).toBe('right');
        expect(pinReorderDirection(ev('ArrowUp', { altKey: true }))).toBe('up');
        expect(pinReorderDirection(ev('ArrowDown', { altKey: true }))).toBe('down');
    });
    it('plain arrows, Shift/Meta chords, Alt+Ctrl and other keys are not reorders', () => {
        expect(pinReorderDirection(ev('ArrowLeft'))).toBeNull();
        expect(pinReorderDirection(ev('ArrowLeft', { altKey: true, shiftKey: true }))).toBeNull();
        expect(pinReorderDirection(ev('ArrowLeft', { altKey: true, metaKey: true }))).toBeNull();
        expect(pinReorderDirection(ev('ArrowLeft', { altKey: true, ctrlKey: true }))).toBeNull();
        expect(pinReorderDirection(ev('Enter', { altKey: true }))).toBeNull();
    });
});

it('describePinMove is 1-based', () => {
    expect(describePinMove('Mira', 2, 6)).toBe('Moved Mira to position 3 of 6.');
});
