// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { PILE_UP_AT, createPileUpGate, crossedPileUp } from './reactionAnim';
import { BURST_SPECKS, burstReactionPill } from './reactionBurst';

describe('crossedPileUp', () => {
    it('is true only for a live step from below ten to ten or more', () => {
        expect(PILE_UP_AT).toBe(10);
        expect(crossedPileUp(9, 10)).toBe(true);
        expect(crossedPileUp(9, 12)).toBe(true);
        expect(crossedPileUp(1, 10)).toBe(true);
    });
    it('is false on mount (no previous count), at ten already, and below ten', () => {
        expect(crossedPileUp(null, 10)).toBe(false);
        expect(crossedPileUp(null, 40)).toBe(false);
        expect(crossedPileUp(10, 11)).toBe(false);
        expect(crossedPileUp(11, 10)).toBe(false);
        expect(crossedPileUp(8, 9)).toBe(false);
        expect(crossedPileUp(0, 1)).toBe(false);
    });
});

describe('createPileUpGate', () => {
    it('lets each chip burst once', () => {
        const g = createPileUpGate();
        expect(g.claim('m1:x')).toBe(true);
        expect(g.claim('m1:x')).toBe(false);
        expect(g.claim('m1:y')).toBe(true);
    });
    it('is bounded', () => {
        const g = createPileUpGate(3);
        for (const k of ['a', 'b', 'c', 'd']) g.claim(k);
        expect(g.has('a')).toBe(false);
        expect(g.has('d')).toBe(true);
    });
});

describe('burstReactionPill', () => {
    const mk = () => {
        const host = document.createElement('span');
        const chip = document.createElement('button');
        host.appendChild(chip);
        document.body.appendChild(host);
        const animate = vi.fn(() => ({ addEventListener: () => {}, cancel: () => {} }));
        (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
        return { host, chip, animate };
    };

    it('draws a ring, the specks, and pops the chip', () => {
        const { host, chip, animate } = mk();
        const n = burstReactionPill({ host, chip, reduced: false });
        expect(n).toBe(1 + BURST_SPECKS + 1);
        expect(animate).toHaveBeenCalledTimes(1 + BURST_SPECKS + 1);
        expect(host.querySelectorAll(':scope > span[aria-hidden="true"]').length).toBe(1 + BURST_SPECKS);
    });

    it('does nothing under reduced motion, or without a host', () => {
        const { host, chip, animate } = mk();
        expect(burstReactionPill({ host, chip, reduced: true })).toBe(0);
        expect(burstReactionPill({ host: null, chip, reduced: false })).toBe(0);
        expect(animate).not.toHaveBeenCalled();
        expect(host.querySelectorAll('span').length).toBe(0);
    });

    it('cleans its debris up', () => {
        vi.useFakeTimers();
        const { host, chip } = mk();
        burstReactionPill({ host, chip, reduced: false });
        expect(host.querySelectorAll('span').length).toBeGreaterThan(0);
        vi.advanceTimersByTime(2000);
        expect(host.querySelectorAll('span').length).toBe(0);
        vi.useRealTimers();
    });

    it('only animates transform and opacity', () => {
        const { host, chip, animate } = mk();
        burstReactionPill({ host, chip, reduced: false });
        for (const call of animate.mock.calls as unknown as Array<[Keyframe[]]>) {
            for (const frame of call[0]) {
                for (const key of Object.keys(frame)) expect(['transform', 'opacity', 'offset']).toContain(key);
            }
        }
    });
});
