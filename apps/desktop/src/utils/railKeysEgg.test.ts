import { describe, it, expect } from 'vitest';
import { railClick, RAIL_EGG_START, RAIL_GAP_MS, RAIL_COOLDOWN_MS, RAIL_LADDER, type RailEggState, type RailMove } from './railKeysEgg';

/** Click at each time; the move each click earned. */
function run(times: number[], from: RailEggState = RAIL_EGG_START) {
    let s = from;
    return times.map(t => { const r = railClick(s, t); s = r.state; return r.move; });
}
const every = (gap: number, n: number, t0 = 1000) => Array.from({ length: n }, (_, i) => t0 + i * gap);

describe('railKeysEgg: the ladder', () => {
    it('is wiggle, hop, spin, squash, jelly, dizzy, escalating', () => {
        expect(RAIL_LADDER.map(r => r.move)).toEqual(['wiggle', 'hop', 'spin', 'squash', 'jelly', 'dizzy']);
        expect(RAIL_LADDER.map(r => r.at)).toEqual([...RAIL_LADDER.map(r => r.at)].sort((a, b) => a - b));
    });

    it('a steady spam plays each rung exactly once, on its click, then the finale', () => {
        const moves = run(every(150, 24));
        const played = moves.map((m, i) => (m ? [i + 1, m] : null)).filter(Boolean);
        expect(played).toEqual(RAIL_LADDER.map(r => [r.at, r.move]));
    });

    it('one move per rung however fast: 100 clicks in 2 s earn at most the six', () => {
        const moves = run(every(20, 100)).filter(Boolean) as RailMove[];
        expect(moves.length).toBeLessThanOrEqual(6);
        expect(moves[0]).toBe('wiggle');
    });
});

describe('railKeysEgg: the streak', () => {
    it('a gap of exactly the limit keeps it, one ms over resets it (positive control)', () => {
        expect(run(every(RAIL_GAP_MS, 4)).filter(Boolean)).toEqual(['wiggle']);
        expect(run(every(RAIL_GAP_MS + 1, 12)).filter(Boolean)).toEqual([]);
    });

    it('ordinary single clicks never animate', () => {
        expect(run(every(1500, 60)).every(m => m === null)).toBe(true);
    });

    it('after the finale he rests: clicks do nothing for the cooldown, then a new streak starts at 1', () => {
        const times = every(100, 24);
        const last = times[times.length - 1];
        const during = every(100, 30, last + 100); // 3 s of continued spam, inside the 3.2 s rest
        expect(run([...times, ...during]).slice(24).every(m => m === null)).toBe(true);
        const after = last + RAIL_COOLDOWN_MS + 10;
        const moves = run([...times, ...every(150, 4, after)]);
        expect(moves.slice(24).filter(Boolean)).toEqual(['wiggle']); // the streak restarted from click 1
    });

    it('a clock running backwards starts a new streak', () => {
        const r = railClick({ n: 20, last: 9000, coolUntil: -Infinity }, 8000);
        expect(r.state.n).toBe(1);
    });
});
