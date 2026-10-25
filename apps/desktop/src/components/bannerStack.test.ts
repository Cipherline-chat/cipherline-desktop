import { describe, it, expect } from 'vitest';
import {
    MAX_VISIBLE_BANNERS, TONE_PRIORITY, liveRegionFor, rankBanners, splitBanners, type BannerEntry,
} from './bannerStack';

const e = (id: string, priority: number, seq: number): BannerEntry => ({ id, priority, seq });

describe('rankBanners', () => {
    it('orders by priority, highest first', () => {
        expect(rankBanners([e('a', 10, 1), e('b', 90, 2), e('c', 50, 3)]).map(x => x.id)).toEqual(['b', 'c', 'a']);
    });

    it('keeps registration order among equal priorities (stable between renders)', () => {
        expect(rankBanners([e('x', 5, 3), e('y', 5, 1), e('z', 5, 2)]).map(x => x.id)).toEqual(['y', 'z', 'x']);
    });

    it('does not mutate its input', () => {
        const input = [e('a', 1, 1), e('b', 2, 2)];
        rankBanners(input);
        expect(input.map(x => x.id)).toEqual(['a', 'b']);
    });
});

describe('splitBanners', () => {
    const five = [e('a', 5, 1), e('b', 4, 2), e('c', 3, 3), e('d', 2, 4), e('e', 1, 5)];

    it('shows the top two by default and counts the rest', () => {
        expect(MAX_VISIBLE_BANNERS).toBe(2);
        const s = splitBanners(five, false);
        expect(s.order).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(s.visibleCount).toBe(2);
        expect(s.hiddenCount).toBe(3);
    });

    it('expanded shows everything but still reports how many are beyond the cap (for "Show less")', () => {
        const s = splitBanners(five, true);
        expect(s.visibleCount).toBe(5);
        expect(s.hiddenCount).toBe(3);
    });

    it('two or fewer banners: nothing is folded', () => {
        expect(splitBanners([e('a', 1, 1), e('b', 2, 2)], false)).toMatchObject({ visibleCount: 2, hiddenCount: 0 });
        expect(splitBanners([], false)).toMatchObject({ order: [], visibleCount: 0, hiddenCount: 0 });
    });

    it('honours a custom cap, and a nonsensical one never goes negative', () => {
        expect(splitBanners(five, false, 3)).toMatchObject({ visibleCount: 3, hiddenCount: 2 });
        expect(splitBanners(five, false, -4)).toMatchObject({ visibleCount: 0, hiddenCount: 5 });
    });
});

describe('tone defaults', () => {
    it('danger outranks warning outranks info outranks success outranks neutral', () => {
        expect(TONE_PRIORITY.danger).toBeGreaterThan(TONE_PRIORITY.warning);
        expect(TONE_PRIORITY.warning).toBeGreaterThan(TONE_PRIORITY.info);
        expect(TONE_PRIORITY.info).toBeGreaterThan(TONE_PRIORITY.success);
        expect(TONE_PRIORITY.success).toBeGreaterThan(TONE_PRIORITY.neutral);
    });

    it('only danger is assertive', () => {
        expect(liveRegionFor('danger')).toBe('assertive');
        for (const t of ['info', 'warning', 'success', 'neutral'] as const) expect(liveRegionFor(t)).toBe('polite');
    });
});
