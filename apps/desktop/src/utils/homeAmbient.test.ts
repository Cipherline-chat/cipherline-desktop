import { describe, it, expect } from 'vitest';
import { moteCount, makeMotes } from './homeAmbient';

describe('moteCount', () => {
    it('clamps to [6, 14] and grows with width', () => {
        expect(moteCount(0)).toBe(6);
        expect(moteCount(600)).toBe(6);
        expect(moteCount(1800)).toBe(10);
        expect(moteCount(4000)).toBe(14);
        // monotonic non-decreasing across the range
        let prev = 0;
        for (let w = 0; w <= 4000; w += 100) {
            const c = moteCount(w);
            expect(c).toBeGreaterThanOrEqual(prev);
            prev = c;
        }
    });
});

describe('makeMotes', () => {
    it('is deterministic — two calls produce identical fields', () => {
        expect(makeMotes(14)).toEqual(makeMotes(14));
    });

    it('every mote is in spec: negative delay, sane ranges', () => {
        for (const m of makeMotes(14)) {
            expect(m.left).toBeGreaterThanOrEqual(2);
            expect(m.left).toBeLessThanOrEqual(98);
            expect(m.size).toBeGreaterThanOrEqual(2);
            expect(m.size).toBeLessThanOrEqual(5);
            expect(m.duration).toBeGreaterThanOrEqual(30);
            expect(m.duration).toBeLessThanOrEqual(50);
            expect(m.delay).toBeLessThanOrEqual(0);
            expect(Math.abs(m.delay)).toBeLessThanOrEqual(m.duration);
            expect(Math.abs(m.drift)).toBeLessThanOrEqual(26);
            expect(m.opacity).toBeGreaterThanOrEqual(0.2);
            expect(m.opacity).toBeLessThanOrEqual(0.5);
        }
    });

    it('motes are scattered, not stacked (no two share left+size+duration)', () => {
        const motes = makeMotes(14);
        const keys = new Set(motes.map(m => `${m.left}:${m.size}:${m.duration}`));
        expect(keys.size).toBe(motes.length);
    });
});
