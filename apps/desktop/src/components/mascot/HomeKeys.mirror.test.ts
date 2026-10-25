// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

import { HomeKeys, type HomeKeysMirror } from './HomeKeys';
import { EYES_CLOSE_AFTER_MS } from './useKeysMirror';
import { __resetWaveGuard } from './Keys';
import { applyMotionState } from '../../utils/idleMotion';
import { BROWS } from '../../utils/keysBrain';
import { MOTIONS, PLANE_FRAMES } from '../../utils/keysGestures';
import { PLANE_COOLDOWN_MS, PLANE_FLIGHT_MS, PLANE_STARTLE_AT, STARTLE_MS, WAVE_SETTLE_MS } from '../../utils/keysMirror';
import {
    emitKeysBeat, setOwnCallMedia, beginKeysActivity, NIGHT_DIVE_EVENT, OWN_MEDIA_OFF, __resetKeysBeats,
} from '../../utils/keysBeats';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Keys mirroring you, end to end in the DOM: the scene lands on the root's
 * data attributes and the gear's `is-on`, each change plays its gesture on
 * the gesture wrapper (Web Animations, recorded here), and the beats (paper
 * plane, Home mash, call media, transfers, night dive) arrive through their
 * subscriptions — and leave with them on unmount. The pure rules are in
 * utils/keysMirror.test.ts.
 */

interface Rec { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; cancelled: boolean }
let recs: Rec[] = [];
let root: Root | null = null;
let host: HTMLDivElement;
let reduce = false;

const NEUTRAL: HomeKeysMirror = { status: 'online', gaming: false, inCall: false, unread: 0, pro: false };

function render(mirror: Partial<HomeKeysMirror> = {}) {
    act(() => {
        root!.render(React.createElement(HomeKeys, {
            userId: 'u', signal: 'idle', speech: null, lively: false,
            onPoke: () => {}, canPlay: () => 'ok' as const, onPlay: () => {},
            mirror: { ...NEUTRAL, ...mirror },
        }));
    });
}
const hk = () => host.querySelector('.hk') as HTMLElement;
const on = (cls: string) => host.querySelector(`.${cls}`)?.classList.contains('is-on') ?? false;
const label = () => host.querySelector('.k2-root')?.getAttribute('aria-label') ?? '';
const brows = () => [...host.querySelectorAll('.k2-brow')].map(p => p.getAttribute('d'));
const gestures = () => recs.filter(r => (r.el as HTMLElement).classList?.contains('hk-gest'));
const animsOn = (cls: string) => recs.filter(r => (r.el as HTMLElement).classList?.contains(cls));
const sameFrames = (r: Rec, m: keyof typeof MOTIONS) => JSON.stringify(r.frames.slice(1)) === JSON.stringify(MOTIONS[m].frames);
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-10-20T14:00:00') });
    reduce = false;
    recs = [];
    window.matchMedia = ((q: string) => ({
        matches: reduce && q.includes('prefers-reduced-motion: reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.requestAnimationFrame = vi.fn(() => 1);
    window.cancelAnimationFrame = vi.fn();
    (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
        const rec: Rec = { el: this, frames, opts, cancelled: false };
        recs.push(rec);
        return {
            cancel: () => { rec.cancelled = true; }, pause: () => {}, play: () => {}, finish: () => {},
            addEventListener: () => {},
        } as unknown as Animation;
    };
    applyMotionState(true);
    document.documentElement.removeAttribute('data-depth');
    document.documentElement.removeAttribute('data-cl-occluded');
    __resetWaveGuard();
    __resetKeysBeats();
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

describe('the scene reaches the DOM', () => {
    it('idle: asleep pose, Zzz, closed eyes, "napping" in his name — and no gesture on mount', () => {
        render({ status: 'away' });
        expect(hk().dataset.pose).toBe('asleep');
        expect(on('hkg-zzz')).toBe(true);
        expect(brows()).toEqual([BROWS.closedL, BROWS.closedR]);
        expect(label()).toBe('Keys, the Cipherline mascot, napping');
        expect(gestures()).toHaveLength(0);
    });
    it('DND: mask, headphones, sign; gaming: TV, controller, glow; call: headset + bubble', () => {
        render({ status: 'dnd' });
        expect(['hkg-mask', 'hkg-phones', 'hkg-sign'].every(on)).toBe(true);
        render({ gaming: true });
        expect(['hkg-tv', 'hkg-pad', 'hkg-tvglow'].every(on)).toBe(true);
        expect(on('hkg-mask')).toBe(false);
        render({ inCall: true });
        expect(['hkg-headset', 'hkg-callb'].every(on)).toBe(true);
    });
    it('the unread pile: 10 envelopes at 100+, 3 at 10+', () => {
        render({ unread: 120 });
        expect(hk().dataset.pile).toBe('3');
        expect(host.querySelectorAll('.hkg-env.is-on')).toHaveLength(10);
        render({ unread: 12 });
        expect(host.querySelectorAll('.hkg-env.is-on')).toHaveLength(3);
    });
    it('invisible: camouflaged with floating eyes', () => {
        render({ status: 'offline' });
        expect(hk().dataset.camo).toBe('on');
        expect(on('hkg-camoeyes')).toBe(true);
    });
});

describe('entry / exit gestures and interruption', () => {
    it('online → idle dozes; idle → online wakes; each from where the last one is', () => {
        render();
        render({ status: 'away' });
        expect(gestures()).toHaveLength(1);
        expect(sameFrames(gestures()[0], 'doze')).toBe(true);
        // back before he has curled up: the wake replaces the doze, mid-way
        render();
        expect(gestures()).toHaveLength(2);
        expect(sameFrames(gestures()[1], 'wake')).toBe(true);
        expect(gestures()[0].cancelled).toBe(true);
        expect(gestures()[1].frames[0].offset).toBe(0); // starts from the live transform
        expect(hk().dataset.pose).toBe('awake');
        expect(on('hkg-zzz')).toBe(false);
    });
    it('his eyes close at the end of the yawn, not before he has moved', () => {
        render();
        advance(4000); // past the hello wave
        render({ status: 'away' });
        expect(brows()).toEqual([BROWS.awakeL, BROWS.awakeR]);
        advance(EYES_CLOSE_AFTER_MS);
        expect(brows()).toEqual([BROWS.closedL, BROWS.closedR]);
        // waking opens them at once
        render();
        expect(brows()).toEqual([BROWS.awakeL, BROWS.awakeR]);
    });
    it('DND entry also puffs a "shh"', () => {
        render();
        render({ status: 'dnd' });
        expect(sameFrames(gestures()[0], 'shh')).toBe(true);
        expect(animsOn('hkg-shh')).toHaveLength(1);
    });
    it('an unchanged scene plays nothing (a re-render is not a transition)', () => {
        render({ gaming: true });
        render({ gaming: true });
        render({ gaming: true, unread: 3 });
        expect(gestures()).toHaveLength(0);
    });
    it('reduced motion: states swap with no gesture at all', () => {
        reduce = true;
        render();
        render({ status: 'away' });
        render({ gaming: true });
        expect(hk().dataset.pose).toBe('gaming');
        expect(gestures()).toHaveLength(0);
    });
    it('window resting: the state still changes, the gesture is skipped', () => {
        render();
        act(() => applyMotionState(false));
        render({ status: 'away' });
        expect(hk().dataset.pose).toBe('asleep');
        expect(gestures()).toHaveLength(0);
    });
});

describe('the paper plane', () => {
    it('flies, startles him at the pass (wide eyes + "!"), then he settles back', () => {
        render();
        advance(4000); // past the once-per-session hello wave (happy brows)
        act(() => emitKeysBeat('message'));
        expect(animsOn('hkg-plane')).toHaveLength(1);
        expect(animsOn('hkg-plane')[0].frames).toBe(PLANE_FRAMES);
        advance(Math.round(PLANE_FLIGHT_MS * PLANE_STARTLE_AT));
        expect(sameFrames(gestures()[0], 'startle')).toBe(true);
        expect(animsOn('hkg-bang')).toHaveLength(1);
        expect(brows()).toEqual([BROWS.wideL, BROWS.wideR]);
        advance(STARTLE_MS);
        expect(brows()).toEqual([BROWS.awakeL, BROWS.awakeR]);
    });
    it('a burst is one plane; another after the cooldown', () => {
        render();
        act(() => { emitKeysBeat('message'); emitKeysBeat('message'); emitKeysBeat('message'); });
        advance(PLANE_COOLDOWN_MS - 1);
        act(() => emitKeysBeat('message'));
        expect(animsOn('hkg-plane')).toHaveLength(1);
        advance(1);
        act(() => emitKeysBeat('message'));
        expect(animsOn('hkg-plane')).toHaveLength(2);
    });
    it('a startled napper wakes for a moment and goes back to his closed eyes', () => {
        render({ status: 'away' });
        act(() => emitKeysBeat('message'));
        advance(Math.round(PLANE_FLIGHT_MS * PLANE_STARTLE_AT));
        expect(brows()).toEqual([BROWS.wideL, BROWS.wideR]);
        advance(STARTLE_MS);
        expect(brows()).toEqual([BROWS.closedL, BROWS.closedR]);
        expect(hk().dataset.pose).toBe('asleep');
    });
    it('not on DND, not while nobody is looking', () => {
        render({ status: 'dnd' });
        act(() => emitKeysBeat('message'));
        render();
        act(() => applyMotionState(false));
        act(() => emitKeysBeat('message'));
        expect(animsOn('hkg-plane')).toHaveLength(0);
    });
    it('reduced motion: a still plane parked beside him, no flight, no jump', () => {
        reduce = true;
        render();
        act(() => emitKeysBeat('message'));
        expect(animsOn('hkg-plane')).toHaveLength(0);
        expect(host.querySelector('.hkg-plane')!.classList.contains('is-static')).toBe(true);
        advance(2000);
        expect(host.querySelector('.hkg-plane')!.classList.contains('is-static')).toBe(false);
        expect(gestures()).toHaveLength(0);
    });
});

describe('the other beats', () => {
    it('Home mashed 4× → dizzy spin with stars', () => {
        render();
        for (let i = 0; i < 4; i++) { act(() => emitKeysBeat('home')); advance(200); }
        expect(sameFrames(gestures()[0], 'dizzy')).toBe(true);
        expect(animsOn('hkg-stars')).toHaveLength(1);
    });
    it('call media: speaking lights the bubble; sharing puts a frame in his hands', () => {
        render({ inCall: true });
        act(() => setOwnCallMedia({ speaking: true, sharing: false, video: false }));
        expect(hk().dataset.speaking).toBe('on');
        act(() => setOwnCallMedia({ speaking: false, sharing: true, video: true }));
        expect(hk().dataset.speaking).toBeUndefined();
        expect(on('hkg-frame')).toBe(true);
        expect(on('hkg-ring')).toBe(true);
        act(() => setOwnCallMedia(OWN_MEDIA_OFF));
        expect(on('hkg-frame')).toBe(false);
    });
    it('call media is ignored outside a call', () => {
        render();
        act(() => setOwnCallMedia({ speaking: true, sharing: true, video: true }));
        expect(hk().dataset.speaking).toBeUndefined();
        expect(on('hkg-frame')).toBe(false);
    });
    it('a big upload: he carries a box until it ends', () => {
        render();
        let end = () => {};
        act(() => { end = beginKeysActivity('transfer'); });
        expect(on('hkg-box')).toBe(true);
        expect(sameFrames(gestures()[0], 'pickup')).toBe(true);
        act(() => end());
        expect(on('hkg-box')).toBe(false);
    });
    it('a backup: papers into the safe', () => {
        render();
        let end = () => {};
        act(() => { end = beginKeysActivity('backup'); });
        expect(on('hkg-papers') && on('hkg-safe')).toBe(true);
        act(() => end());
        expect(on('hkg-safe')).toBe(false);
    });
    it('night dive: the lantern comes on with a yawn, goes away with a stretch', () => {
        render();
        act(() => { window.dispatchEvent(new CustomEvent(NIGHT_DIVE_EVENT, { detail: { active: true, reason: 'enter' } })); });
        expect(on('hkg-lantern')).toBe(true);
        expect(sameFrames(gestures()[0], 'yawn')).toBe(true);
        act(() => { window.dispatchEvent(new CustomEvent(NIGHT_DIVE_EVENT, { detail: { active: false, reason: 'exit' } })); });
        expect(on('hkg-lantern')).toBe(false);
        expect(sameFrames(gestures()[1], 'stretch')).toBe(true);
    });
    it('night dive already on at mount: the lantern is simply there (no animation)', () => {
        document.documentElement.setAttribute('data-depth', 'night');
        render({ status: 'away' });
        expect(on('hkg-lantern')).toBe(true);
        expect(host.querySelector('.hkg-lantern')!.classList.contains('is-dim')).toBe(true);
        expect(gestures()).toHaveLength(0);
    });
    it('a friend coming online gets a wave (after the settle window, not for a snapshot)', () => {
        render({ onlineFriends: new Set(['a']) });
        advance(WAVE_SETTLE_MS);
        render({ onlineFriends: new Set(['a', 'b', 'c', 'd', 'e']) }); // a snapshot: no
        expect(host.querySelector('.k2-wave')).toBeNull();
        render({ onlineFriends: new Set(['a', 'b', 'c', 'd', 'e', 'f']) });
        advance(500);
        expect(host.querySelector('.k2-wave')).not.toBeNull();
    });
    it('a call starting somewhere: a perk and a ping (not when it is yours)', () => {
        render({ liveCalls: 0 });
        render({ liveCalls: 1 });
        expect(sameFrames(gestures()[0], 'callPerk')).toBe(true);
        expect(animsOn('hkg-ping')).toHaveLength(1);
    });
});

describe('subscriptions come and go with him', () => {
    it('unmount removes the night-dive listener and stops reacting to beats', () => {
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');
        render();
        const nightAdds = add.mock.calls.filter(c => c[0] === NIGHT_DIVE_EVENT);
        expect(nightAdds).toHaveLength(1);
        act(() => { root!.unmount(); });
        root = null;
        expect(remove.mock.calls.some(c => c[0] === NIGHT_DIVE_EVENT && c[1] === nightAdds[0][1])).toBe(true);
        const before = recs.length;
        act(() => { emitKeysBeat('message'); emitKeysBeat('home'); setOwnCallMedia({ speaking: true, sharing: true, video: true }); });
        advance(PLANE_FLIGHT_MS);
        expect(recs.length).toBe(before);
    });
});
