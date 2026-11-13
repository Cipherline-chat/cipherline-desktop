// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});
vi.mock('../../utils/eggProgress', async (orig) => ({ ...(await orig<typeof import('../../utils/eggProgress')>()), recordEggFound: () => {} }));

import { HomeKeys, type HomeKeysMirror } from './HomeKeys';
import { __resetWaveGuard } from './Keys';
import { applyMotionState } from '../../utils/idleMotion';
import { emitKeysBeat, beginKeysActivity, __resetKeysBeats } from '../../utils/keysBeats';
import { MOTIONS } from '../../utils/keysGestures';
import { __setShinyLaunch, markRareIdle, __resetRareIdle } from '../../utils/keysRare';
import {
    HATS, drawFor, lastHat, __resetWardrobe, WARDROBE_CHECK_MS, WARDROBE_MIN_MS, WARDROBE_CHANCE, PRO_SETTLE_MS,
    type Wear,
} from '../../utils/keysWardrobe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 30_000 });

/**
 * Keys' wardrobe on the Home deck, end to end in the DOM: the pick on every
 * Home visit, the idle change (only when he is free, never mid-gesture, never
 * just after a click), the crown for Pro only (and a late Pro status turning a
 * bare launch pick into the crown), costumes and head gear outranking it, and
 * reduced motion swapping without a gesture. The pure rules (odds, no repeat,
 * the idle decision) are in utils/keysWardrobe.test.ts.
 */

interface Rec { el: Element; frames: Keyframe[]; cancelled: boolean; done: (() => void)[] }
let recs: Rec[] = [];
let root: Root | null = null;
let host: HTMLDivElement;
let reduce = false;
/** performance.now follows the fake clock (so timers that fire mid-advance see their own time). */
const T0 = new Date('2026-10-20T14:00:00').getTime();
const perfNow = () => 10_000 + (Date.now() - T0);

const NEUTRAL: HomeKeysMirror = { status: 'online', gaming: false, inCall: false, unread: 0, pro: false };

/** A scripted rng: these draws in order, then "no" (0.999) for ever. */
const script = (...draws: number[]) => () => (draws.length ? draws.shift()! : 0.999);
const u = (w: Wear, pro = false, last: Wear = null) => drawFor(w, { pro, last });
const YES = WARDROBE_CHANCE / 4; // an idle check that says "change"

function render(mirror: Partial<HomeKeysMirror>, random: () => number, lively = true) {
    act(() => {
        root!.render(React.createElement(HomeKeys, {
            userId: 'u', signal: 'idle', speech: null, lively, random,
            onPoke: () => {}, canPlay: () => 'call' as const, onPlay: () => {},
            mirror: { ...NEUTRAL, ...mirror },
        }));
    });
}
const unmount = () => act(() => { root?.unmount(); root = createRoot(host); });
const hk = () => host.querySelector('.hk') as HTMLElement;
const hat = () => hk().dataset.hat ?? null;
const onHats = () => HATS.filter(h => host.querySelector(`.hkg-${h}`)?.classList.contains('is-on'));
const gestures = () => recs.filter(r => (r.el as HTMLElement).classList?.contains('hk-gest'));
const sameFrames = (r: Rec, m: keyof typeof MOTIONS) => JSON.stringify(r.frames.slice(1)) === JSON.stringify(MOTIONS[m].frames);
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** Up to the first idle check past WARDROBE_MIN_MS (they run every WARDROBE_CHECK_MS). */
const FIRST_IDLE = Math.ceil(WARDROBE_MIN_MS / WARDROBE_CHECK_MS) * WARDROBE_CHECK_MS;
const finishAll = () => act(() => { for (const r of recs) r.done.splice(0).forEach(f => f()); });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
    vi.spyOn(performance, 'now').mockImplementation(perfNow);
    reduce = false;
    recs = [];
    window.matchMedia = ((q: string) => ({
        matches: reduce && q.includes('prefers-reduced-motion: reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.requestAnimationFrame = vi.fn(() => 1);
    window.cancelAnimationFrame = vi.fn();
    (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
        const rec: Rec = { el: this, frames, cancelled: false, done: [] };
        recs.push(rec);
        return {
            cancel: () => { rec.cancelled = true; }, pause: () => {}, play: () => {}, finish: () => {},
            addEventListener: (type: string, f: () => void) => { if (type === 'finish') rec.done.push(f); },
        } as unknown as Animation;
    };
    applyMotionState(true);
    document.documentElement.removeAttribute('data-depth');
    __resetWaveGuard();
    __resetKeysBeats();
    __setShinyLaunch(false);
    __resetWardrobe();
    __resetRareIdle();
    markRareIdle(perfNow()); // no juggling across the long fast-forwards
    store.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the pick on a Home visit', () => {
    it.each(HATS.filter(h => h !== 'crown'))('%s: worn from the first frame (no gesture), and nothing else on his head', (h) => {
        render({}, script(u(h)));
        expect(hat()).toBe(h);
        expect(onHats()).toEqual([h]);
        expect(gestures()).toHaveLength(0);
    });
    it('bare: no hat at all', () => {
        render({}, script(u(null)));
        expect(hat()).toBeNull();
        expect(onHats()).toEqual([]);
    });
    it('every hat piece is mounted at rest (so it has a real entry and exit)', () => {
        render({}, script(u(null)));
        for (const h of HATS) expect(host.querySelector(`.hkg-on > .hkg-${h}`), h).not.toBeNull();
    });
    it('the next Home visit never repeats the last hat', () => {
        render({}, script(u('beanie')));
        expect(hat()).toBe('beanie');
        unmount();
        expect(lastHat()).toBe('beanie');
        // the very same draw now lands elsewhere: beanie is out of the table
        render({}, script(u('beanie')));
        expect(hat()).not.toBe('beanie');
    });
});

describe('Pro and the crown', () => {
    it('non-Pro never wears the crown, even on the draw that is the crown for Pro', () => {
        render({ pro: false }, script(u('crown', true)));
        expect(hat()).not.toBe('crown');
        expect(onHats()).not.toContain('crown');
    });
    it('Pro can draw the crown (and a click on it is the crown garnish)', () => {
        render({ pro: true }, script(u('crown', true)));
        expect(hat()).toBe('crown');
        expect(hk().dataset.play).toBe('crown');
    });
    it('Pro can draw the other hats too, and bare; those are neutral to a click', () => {
        render({ pro: true }, script(u('captain', true)));
        expect(hat()).toBe('captain');
        expect(hk().dataset.play).toBe('neutral');
    });
    it('Pro status landing just after mount (the launch billing load) turns a bare pick into the crown, with the proud bob', () => {
        const rng = script(u(null), 0.1);
        render({ pro: false }, rng);
        advance(800);
        render({ pro: true }, rng);
        expect(hat()).toBe('crown');
        expect(gestures()).toHaveLength(1);
        expect(sameFrames(gestures()[0], 'proud')).toBe(true);
    });
    it('…but not once the launch has settled (a purchase later: the next pick includes the crown)', () => {
        const rng = script(u(null), 0.1);
        render({ pro: false }, rng);
        advance(PRO_SETTLE_MS + 1);
        render({ pro: true }, rng);
        expect(hat()).toBeNull();
        expect(gestures()).toHaveLength(0);
    });
    it('losing Pro takes the crown off; other hats stay', () => {
        render({ pro: true }, script(u('crown', true)));
        render({ pro: false }, script());
        expect(hat()).toBeNull();
        expect(sameFrames(gestures()[0], 'dress')).toBe(true);
        unmount();
        render({ pro: true }, script(u('flower', true, 'crown')));
        render({ pro: false }, script());
        expect(hat()).toBe('flower');
    });
});

describe('changing while he is left alone', () => {
    it('after a few minutes he changes: the old hat comes off, the new one goes on, a dress bob', () => {
        const rng = script(u('shades'), YES, u('captain', false, 'shades'));
        render({}, rng);
        advance(FIRST_IDLE - WARDROBE_CHECK_MS);
        expect(hat()).toBe('shades');
        advance(WARDROBE_CHECK_MS);
        expect(hat()).toBe('captain');
        expect(onHats()).toEqual(['captain']);
        expect(gestures()).toHaveLength(1);
        expect(sameFrames(gestures()[0], 'dress')).toBe(true);
        expect(lastHat()).toBe('captain');
    });
    it('to bare, and from bare', () => {
        const rng = script(u('snorkel'), YES, u(null, false, 'snorkel'), YES, u('beanie'));
        render({}, rng);
        advance(FIRST_IDLE);
        expect(hat()).toBeNull();
        expect(sameFrames(gestures()[0], 'dress')).toBe(true);
        finishAll();
        advance(FIRST_IDLE);
        expect(hat()).toBe('beanie');
    });
    it('not before WARDROBE_MIN_MS, and only when the dice say so (no flicker)', () => {
        const rng = script(u('flower'), 0.9, 0.9, YES, u('beanie', false, 'flower'));
        render({}, rng);
        advance(FIRST_IDLE - WARDROBE_CHECK_MS); // checks before the minimum draw nothing
        expect(hat()).toBe('flower');
        advance(WARDROBE_CHECK_MS * 2); // two "no"s
        expect(hat()).toBe('flower');
        advance(WARDROBE_CHECK_MS);
        expect(hat()).toBe('beanie');
    });
    it('never mid-gesture: a gesture in flight holds the change until it has finished', () => {
        const rng = script(u('flower'), YES, u('captain', false, 'flower'));
        render({}, rng);
        advance(FIRST_IDLE - 5000);
        // the Home button mashed: he spins (a gesture that has not finished)
        for (let i = 0; i < 4; i++) emitKeysBeat('home');
        expect(gestures()).toHaveLength(1);
        advance(5000 + WARDROBE_CHECK_MS * 3);
        expect(hat()).toBe('flower');
        finishAll();
        advance(WARDROBE_CHECK_MS);
        expect(hat()).toBe('captain');
    });
    it('not right after a click on him', () => {
        const rng = script(u('flower'), YES, u('captain', false, 'flower'));
        render({}, rng);
        advance(FIRST_IDLE - 1000);
        act(() => { (host.querySelector('.k2-root') as HTMLElement).click(); });
        finishAll();
        advance(1000);
        expect(hat()).toBe('flower');
        advance(WARDROBE_CHECK_MS);
        expect(hat()).toBe('captain');
    });
    it('not while the pointer is on him', () => {
        const rng = script(u('flower'), YES, u('captain', false, 'flower'));
        render({}, rng);
        hk().classList.add('is-look');
        advance(FIRST_IDLE + WARDROBE_CHECK_MS);
        expect(hat()).toBe('flower');
        hk().classList.remove('is-look');
        advance(WARDROBE_CHECK_MS);
        expect(hat()).toBe('captain');
    });
    it('not while nobody is looking (window resting)', () => {
        const rng = script(u('flower'), YES, u('captain', false, 'flower'));
        render({}, rng);
        applyMotionState(false);
        advance(FIRST_IDLE + WARDROBE_CHECK_MS);
        expect(hat()).toBe('flower');
        applyMotionState(true);
        advance(WARDROBE_CHECK_MS);
        expect(hat()).toBe('captain');
    });
    it('not while something else has his head, nor while he naps (the pick waits underneath)', () => {
        const rng = script(u('flower'), YES, u('captain', false, 'flower'));
        render({ inCall: true }, rng);
        expect(onHats()).toEqual([]);
        advance(FIRST_IDLE + WARDROBE_CHECK_MS);
        render({ status: 'away' }, rng);
        expect(onHats()).toEqual(['flower']);
        advance(WARDROBE_CHECK_MS * 2);
        expect(hat()).toBe('flower');
    });
    it('not with the ambience off (lively = false): one look per visit', () => {
        render({}, script(u('flower'), YES, u('captain', false, 'flower')), false);
        advance(FIRST_IDLE * 3);
        expect(hat()).toBe('flower');
    });
    it('reduced motion: the swap still happens, instantly, with no gesture', () => {
        reduce = true;
        render({}, script(u('shades'), YES, u('beanie', false, 'shades')));
        advance(FIRST_IDLE);
        expect(hat()).toBe('beanie');
        expect(onHats()).toEqual(['beanie']);
        expect(gestures()).toHaveLength(0);
    });
});

describe('priority: whatever else claims his head wins', () => {
    const claims: [string, Partial<HomeKeysMirror>, (() => () => void)?][] = [
        ['call headset', { inCall: true }],
        ['DND headphones + mask', { status: 'dnd' }],
        ['camouflage', { status: 'offline' }],
    ];
    it.each(claims)('%s', (_n, m) => {
        render(m, script(u('beanie')));
        expect(onHats()).toEqual([]);
        expect(hat()).toBeNull();
        // when it lets go, the pick comes back
        render({}, script());
        expect(onHats()).toEqual(['beanie']);
    });
    it('the night lantern', () => {
        document.documentElement.setAttribute('data-depth', 'night');
        render({}, script(u('captain')));
        expect(host.querySelector('.hkg-lantern')!.classList.contains('is-on')).toBe(true);
        expect(onHats()).toEqual([]);
    });
    it('a calendar costume (Halloween: the witch hat)', () => {
        vi.setSystemTime(new Date('2026-10-31T14:00:00'));
        render({}, script(u('captain')));
        expect(host.querySelector('.k2-costume')?.getAttribute('data-costume')).toBe('witch');
        expect(onHats()).toEqual([]);
    });
    it('a hat stays on while he carries a box (hands are a different slot)', () => {
        const end = beginKeysActivity('transfer');
        try {
            render({}, script(u('captain')));
            expect(onHats()).toEqual(['captain']);
            expect(host.querySelector('.hkg-box')!.classList.contains('is-on')).toBe(true);
        } finally { end(); }
    });
});

describe('the stylesheet', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/home-keys-mirror.css'), 'utf8');
    it.each(HATS)('%s has its own way on and off (--hkg-off)', (h) => {
        expect(css).toMatch(new RegExp(`\\.hkg-${h}\\s*\\{[^}]*--hkg-off:`));
    });
    it('reduced motion: every gear piece swaps instantly (no transitions)', () => {
        const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(block).toMatch(/\.hkg,\s*\.hkg\.is-on[^{]*\{\s*transition:\s*none !important/);
    });
});
