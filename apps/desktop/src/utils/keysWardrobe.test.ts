import { describe, it, expect, beforeEach } from 'vitest';
import {
    HATS, EVERYDAY_HATS, ODDS, wardrobeOdds, pickHat, drawFor, proArrived, wardrobeIdleDecision,
    lastHat, rememberHat, __resetWardrobe,
    WARDROBE_MIN_MS, WARDROBE_QUIET_MS, WARDROBE_SETTLE_MS, WARDROBE_CHANCE,
    type Wear, type Rng, type WardrobeIdleCtx,
} from './keysWardrobe';

/** A seeded PRNG (mulberry32): the same draws every run. */
function seeded(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const key = (w: Wear) => w ?? 'bare';
function tally(n: number, draw: (rng: Rng) => Wear, seed = 7): Record<string, number> {
    const rng = seeded(seed);
    const out: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const k = key(draw(rng)); out[k] = (out[k] ?? 0) + 1; }
    return out;
}
const sum = (t: [Wear, number][]) => t.reduce((s, [, p]) => s + p, 0);
const odds = (t: [Wear, number][]) => Object.fromEntries(t.map(([w, p]) => [key(w), p]));

beforeEach(() => __resetWardrobe());

describe('the wardrobe', () => {
    it('five everyday hats plus the crown; the crown is not everyday', () => {
        expect(EVERYDAY_HATS).toHaveLength(5);
        expect(EVERYDAY_HATS).not.toContain('crown');
        expect([...HATS].sort()).toEqual([...EVERYDAY_HATS, 'crown'].sort());
    });
});

describe('the odds', () => {
    it('non-Pro: bare 40%, each everyday hat 12%, never the crown', () => {
        const t = wardrobeOdds({ pro: false, last: null });
        expect(sum(t)).toBeCloseTo(1, 12);
        const o = odds(t);
        expect(o.bare).toBeCloseTo(0.4, 12);
        for (const h of EVERYDAY_HATS) expect(o[h]).toBeCloseTo(0.12, 12);
        expect(o.crown).toBeUndefined();
    });
    it('Pro: the crown takes half of bare (20% / 20%), a little likelier than any one other hat', () => {
        const o = odds(wardrobeOdds({ pro: true, last: null }));
        expect(o.crown).toBeCloseTo(0.2, 12);
        expect(o.bare).toBeCloseTo(0.2, 12);
        for (const h of EVERYDAY_HATS) {
            expect(o[h]).toBeCloseTo(0.12, 12);
            expect(o.crown).toBeGreaterThan(o[h]);
        }
        // and nothing is the most common single outcome for everyone else
        const n = odds(wardrobeOdds({ pro: false, last: null }));
        for (const h of EVERYDAY_HATS) expect(n.bare).toBeGreaterThan(n[h]);
    });
    it('the last hat is excluded and the rest renormalised; bare may repeat', () => {
        for (const pro of [false, true]) {
            for (const last of [...HATS, null] as Wear[]) {
                const t = wardrobeOdds({ pro, last });
                expect(sum(t)).toBeCloseTo(1, 12);
                if (last) expect(t.map(([w]) => w)).not.toContain(last);
                expect(t.map(([w]) => w)).toContain(null);
            }
        }
    });
    it('bare is always first (drawFor and tests rely on the order)', () => {
        expect(wardrobeOdds({ pro: true, last: 'beanie' })[0][0]).toBeNull();
        expect(pickHat({ pro: true, last: null }, () => 0)).toBeNull();
        expect(pickHat({ pro: false, last: null }, () => 0)).toBeNull();
    });
});

describe('pickHat: the distribution (seeded)', () => {
    const N = 60_000;
    it('non-Pro over many visits: bare ~40%, each hat ~12%, never a crown', () => {
        const t = tally(N, rng => pickHat({ pro: false, last: null }, rng));
        expect(t.crown).toBeUndefined();
        expect(t.bare / N).toBeCloseTo(0.4, 1);
        for (const h of EVERYDAY_HATS) expect(t[h] / N).toBeCloseTo(0.12, 1);
    });
    it('Pro: crown ~20%, bare ~20%, each other hat ~12%', () => {
        const t = tally(N, rng => pickHat({ pro: true, last: null }, rng));
        expect(t.crown / N).toBeCloseTo(0.2, 1);
        expect(t.bare / N).toBeCloseTo(0.2, 1);
        for (const h of EVERYDAY_HATS) expect(t[h] / N).toBeCloseTo(0.12, 1);
    });
    it('a chain of picks (each excluding the last) never repeats a hat, and rotates through all of them', () => {
        for (const pro of [false, true]) {
            const rng = seeded(pro ? 11 : 12);
            let last: Wear = null;
            const seen = new Set<string>();
            let bare = 0;
            for (let i = 0; i < 5000; i++) {
                const w = pickHat({ pro, last }, rng);
                if (w !== null) expect(w).not.toBe(last);
                if (w === null) bare++;
                seen.add(key(w));
                last = w;
            }
            expect(seen.size).toBe(pro ? 7 : 6);
            // "nothing fairly often", even with the no-repeat rule
            expect(bare / 5000).toBeGreaterThan(pro ? 0.18 : 0.36);
        }
    });
    it('a broken rng never throws and is clamped into range', () => {
        for (const r of [NaN, -1, 1, 2, Infinity, -Infinity]) {
            const w = pickHat({ pro: true, last: null }, () => r);
            expect([...HATS, null]).toContain(w);
        }
    });
});

describe('drawFor', () => {
    it('gives a draw that picks exactly that look, in every context', () => {
        for (const pro of [false, true]) {
            for (const last of [...HATS, null] as Wear[]) {
                for (const want of [...HATS, null] as Wear[]) {
                    const u = drawFor(want, { pro, last });
                    const drawable = want === null || (want !== last && (pro || want !== 'crown'));
                    if (!drawable) { expect(u).toBe(-1); continue; }
                    expect(pickHat({ pro, last }, () => u)).toBe(want);
                }
            }
        }
    });
});

describe('proArrived: Pro landing just after a non-Pro pick', () => {
    it('bare → crown with the crown\'s share; anything else stays; the crown never repeats', () => {
        expect(proArrived(null, null, () => 0)).toBe('crown');
        expect(proArrived(null, null, () => 0.49)).toBe('crown');
        expect(proArrived(null, null, () => 0.5)).toBeNull();
        expect(proArrived('beanie', null, () => 0)).toBe('beanie');
        expect(proArrived(null, 'crown', () => 0)).toBeNull();
    });
    it('non-Pro pick then proArrived = exactly the Pro odds (whatever the last hat was, bar the crown)', () => {
        for (const last of [null, ...EVERYDAY_HATS] as Wear[]) {
            const nonPro = odds(wardrobeOdds({ pro: false, last }));
            const pro = odds(wardrobeOdds({ pro: true, last }));
            expect(nonPro.bare * ODDS.crownShareOfBare).toBeCloseTo(pro.crown, 12);
            expect(nonPro.bare * (1 - ODDS.crownShareOfBare)).toBeCloseTo(pro.bare, 12);
            for (const h of EVERYDAY_HATS) if (h !== last) expect(nonPro[h]).toBeCloseTo(pro[h], 12);
        }
        const N = 60_000;
        const t = tally(N, rng => proArrived(pickHat({ pro: false, last: null }, rng), null, rng), 3);
        expect(t.crown / N).toBeCloseTo(0.2, 1);
        expect(t.bare / N).toBeCloseTo(0.2, 1);
    });
});

describe('wardrobeIdleDecision: when he changes while left alone', () => {
    const base: WardrobeIdleCtx = { now: 1_000_000, pickedAt: 1_000_000 - WARDROBE_MIN_MS, lastClickAt: -Infinity, sceneAt: 0, free: true };
    const yes = () => 0;
    it('changes once the look is old enough, he is free and the dice say so', () => {
        expect(wardrobeIdleDecision(base, yes)).toBe(true);
        expect(wardrobeIdleDecision(base, () => WARDROBE_CHANCE - 0.001)).toBe(true);
        expect(wardrobeIdleDecision(base, () => WARDROBE_CHANCE)).toBe(false);
    });
    it('never while he is busy (mid-gesture, mid-show, pointer on him: the caller folds these into `free`)', () => {
        expect(wardrobeIdleDecision({ ...base, free: false }, yes)).toBe(false);
    });
    it('not before WARDROBE_MIN_MS on one look (no flicker)', () => {
        expect(wardrobeIdleDecision({ ...base, pickedAt: base.now - WARDROBE_MIN_MS + 1 }, yes)).toBe(false);
    });
    it('not right after a click on him, nor while a scene change settles', () => {
        expect(wardrobeIdleDecision({ ...base, lastClickAt: base.now - WARDROBE_QUIET_MS + 1 }, yes)).toBe(false);
        expect(wardrobeIdleDecision({ ...base, lastClickAt: base.now - WARDROBE_QUIET_MS }, yes)).toBe(true);
        expect(wardrobeIdleDecision({ ...base, sceneAt: base.now - WARDROBE_SETTLE_MS + 1 }, yes)).toBe(false);
    });
    it('a clock that went backwards fails quiet', () => {
        expect(wardrobeIdleDecision({ ...base, pickedAt: base.now + 5 }, yes)).toBe(false);
        expect(wardrobeIdleDecision({ ...base, pickedAt: NaN }, yes)).toBe(false);
    });
});

describe('session memory', () => {
    it('remembers the last look of the session (and resets)', () => {
        expect(lastHat()).toBeNull();
        rememberHat('captain');
        expect(lastHat()).toBe('captain');
        __resetWardrobe();
        expect(lastHat()).toBeNull();
    });
});
