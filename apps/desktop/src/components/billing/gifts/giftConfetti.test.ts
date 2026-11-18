import { describe, expect, it } from 'vitest';
import { CONFETTI_COLORS, confettiPieces } from './giftConfetti';

describe('confettiPieces', () => {
    it('is deterministic for a seed (stable harness frames, no Math.random in render)', () => {
        expect(confettiPieces(18, 7)).toEqual(confettiPieces(18, 7));
        expect(confettiPieces(18, 7)).not.toEqual(confettiPieces(18, 8));
    });

    it('makes exactly the requested count; nonsense counts make none', () => {
        expect(confettiPieces(18)).toHaveLength(18);
        expect(confettiPieces(0)).toHaveLength(0);
        expect(confettiPieces(-3)).toHaveLength(0);
        expect(confettiPieces(4.9)).toHaveLength(4);
    });

    it('flies upward-ish and stays near the box (never straight down into the text)', () => {
        const radius = 110;
        for (const p of confettiPieces(24, 3, radius)) {
            expect(Math.hypot(p.dx, p.dy / 0.85)).toBeLessThanOrEqual(radius * 1.06);
            // the arc is -190deg..10deg: at most a little below the horizontal
            expect(p.dy).toBeLessThanOrEqual(Math.ceil(radius * 0.2));
            expect(p.scale).toBeGreaterThanOrEqual(0.7);
            expect(p.scale).toBeLessThanOrEqual(1.3);
            expect(p.delay).toBeGreaterThanOrEqual(0);
            expect(p.delay).toBeLessThan(100);
            expect(CONFETTI_COLORS).toContain(p.color);
        }
    });

    it('spreads both ways', () => {
        const ps = confettiPieces(18);
        expect(ps.some((p) => p.dx < -20)).toBe(true);
        expect(ps.some((p) => p.dx > 20)).toBe(true);
    });
});
