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
const eggs = vi.hoisted(() => [] as string[]);
vi.mock('../../utils/eggProgress', () => ({ recordEggFound: (id: string) => { eggs.push(id); } }));

import { HomeKeys, type HomeKeysMirror } from './HomeKeys';
import { __resetWaveGuard } from './Keys';
import { applyMotionState } from '../../utils/idleMotion';
import { beginKeysActivity, __resetKeysBeats } from '../../utils/keysBeats';
import { PLAYS, NUDGE, FINALE_COOLDOWN_MS, WALL_WAIT_MS, finaleEggId, type PlayState } from '../../utils/keysPlay';
import { __setShinyLaunch, SHINY_EGG } from '../../utils/keysRare';
import { SPAM_GAP_MS } from '../../utils/keysBurst';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Each case renders the whole rig dozens of times; on a loaded box the
// default 5 s is a timing artefact, not a verdict.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Keys' click reactions end to end in the DOM: real clicks on the real
 * button, the mirrored state deciding who answers, three beats per state
 * with no immediate repeat, the spam finale (its egg, its cooldown, the DND
 * wall you knock over), the neutral egg untouched underneath a garnish,
 * reduced motion, Shiny Keys, and the hover parallax's frame loop. The pure
 * rules are in utils/keysPlay.test.ts, keysRare.test.ts, keysParallax.test.ts.
 */

interface Rec { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; cancelled: boolean }
let recs: Rec[] = [];
let root: Root | null = null;
let host: HTMLDivElement;
let reduce = false;
let now = 0;
let rafQ: FrameRequestCallback[] = [];
const ends: (() => void)[] = [];

const NEUTRAL: HomeKeysMirror = { status: 'online', gaming: false, inCall: false, unread: 0, pro: false };

function render(mirror: Partial<HomeKeysMirror> = {}, extra: { onPoke?: () => void; onReact?: () => void } = {}) {
    act(() => {
        root!.render(React.createElement(HomeKeys, {
            userId: 'u', signal: 'idle', speech: null, lively: false,
            onPoke: extra.onPoke ?? (() => {}), onReact: extra.onReact, canPlay: () => 'call' as const, onPlay: () => {},
            mirror: { ...NEUTRAL, ...mirror },
        }));
    });
}
const hk = () => host.querySelector('.hk') as HTMLElement;
const rig = () => host.querySelector('.k2-root') as HTMLElement;
const beat = () => hk().dataset.beat ?? null;
const speech = () => host.querySelector('.k2-speech')?.textContent ?? null;
const advance = (ms: number) => { now += ms; act(() => { vi.advanceTimersByTime(ms); }); };
const click = () => act(() => { rig().click(); });
/** n clicks, `gap` ms apart (time moves after each). */
function clicks(n: number, gap: number) {
    for (let i = 0; i < n; i++) { click(); advance(gap); }
}
const gestures = () => recs.filter(r => (r.el as HTMLElement).classList?.contains('hk-gest'));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-10-20T14:00:00') });
    now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    reduce = false;
    recs = [];
    rafQ = [];
    eggs.length = 0;
    window.matchMedia = ((q: string) => ({
        matches: reduce && q.includes('prefers-reduced-motion: reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => { rafQ.push(cb); return rafQ.length; });
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
    __resetWaveGuard();
    __resetKeysBeats();
    __setShinyLaunch(false);
    store.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    ends.splice(0).forEach(f => f());
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const STATES: [Exclude<PlayState, 'neutral'>, Partial<HomeKeysMirror>, (() => () => void)?][] = [
    ['gaming', { gaming: true }],
    ['call', { inCall: true }],
    ['dnd', { status: 'dnd' }],
    ['asleep', { status: 'away' }],
    ['camo', { status: 'offline' }],
    ['box', {}, () => beginKeysActivity('transfer')],
    ['safe', {}, () => beginKeysActivity('backup')],
];

describe('HomeKeys: he is a real button, named for what he is doing', () => {
    it('a <button> with an aria-label that follows the mirror', () => {
        render({ gaming: true });
        expect(rig().tagName).toBe('BUTTON');
        expect(rig().getAttribute('type')).toBe('button');
        expect(rig().getAttribute('aria-label')).toBe('Keys, the Cipherline mascot, gaming');
        render({ status: 'dnd' });
        expect(rig().getAttribute('aria-label')).toBe('Keys, the Cipherline mascot, do not disturb');
        render({});
        expect(rig().getAttribute('aria-label')).toBe('Keys, the Cipherline mascot');
    });
});

describe('HomeKeys: three reactions per claiming state, never the same twice in a row', () => {
    it.each(STATES)('%s', (state, mirror, setup) => {
        if (setup) ends.push(setup());
        const onPoke = vi.fn();
        const onReact = vi.fn();
        render(mirror, { onPoke, onReact });
        expect(hk().dataset.play).toBe(state);
        const ids = PLAYS[state].beats({ video: false, sharing: false }).map(b => b.id);
        const seen: string[] = [];
        for (let i = 0; i < 12; i++) {
            click();
            seen.push(beat()!);
            advance(3200); // past any beat, and slow enough never to be a burst
        }
        expect(new Set(seen)).toEqual(new Set(ids));
        for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
        expect(onPoke).not.toHaveBeenCalled(); // the activity answers, not the poke ladder
        expect(onReact).toHaveBeenCalledTimes(12);
        expect(eggs).toEqual([]);
        // every beat moved him through the gesture runner
        expect(gestures().length).toBeGreaterThanOrEqual(8);
    });
});

describe('HomeKeys: the spam finale', () => {
    it.each(STATES)('%s: six clicks inside 2.5 s is the finale, once per cooldown, and its egg', (state, mirror, setup) => {
        if (setup) ends.push(setup());
        render(mirror);
        const fin = PLAYS[state].finale({ video: false, sharing: false });
        clicks(6, 150);
        expect(beat()).toBe(fin.id);
        expect(eggs).toEqual([finaleEggId(state)]);
        // clicks during the finale are its own (or knock the DND wall down)
        if (!fin.hold) {
            click();
            expect(beat()).toBe(fin.id);
        }
        advance(Math.max(fin.ms, fin.hold ? fin.ms + WALL_WAIT_MS + fin.hold.release.ms : 0) + 500);
        // spam again inside the cooldown: beats and nudges, no second finale
        clicks(8, 150);
        expect(beat()).not.toBe(fin.id);
        // after the cooldown: again
        advance(FINALE_COOLDOWN_MS);
        clicks(6, 150);
        expect(beat()).toBe(fin.id);
        expect(eggs.filter(e => e === finaleEggId(state))).toHaveLength(2); // recordEggFound itself dedupes
    });

    it('DND: the wall goes up and waits; your next click knocks it over', () => {
        render({ status: 'dnd' });
        clicks(6, 150);
        expect(beat()).toBe('wall');
        expect(speech()).toBe('No.');
        advance(800); // up and holding
        const wall = host.querySelector('.hkp-wall')!;
        const up = recs.filter(r => r.el === wall);
        expect(up).toHaveLength(1);
        expect(up[0].opts.fill).toBe('both');
        click();
        expect(beat()).toBe('wallDown');
        const down = recs.filter(r => r.el === wall);
        expect(down).toHaveLength(2);
        expect(up[0].cancelled).toBe(true);
        // it started from where the wall was, and falls over
        expect(String(down[1].frames[down[1].frames.length - 1].transform)).toContain('rotateX(-90deg)');
        advance(600);
        expect(speech()).toBe('Rude.');
    });

    it('DND: left alone, the wall comes down by itself', () => {
        render({ status: 'dnd' });
        clicks(6, 150);
        advance(PLAYS.dnd.finale({ video: false, sharing: false }).ms + WALL_WAIT_MS + 50);
        expect(beat()).toBe('wallDown');
    });

    it('a rapid click on a beat still playing is a nudge, blended by the runner', () => {
        render({ gaming: true });
        click();
        const first = beat();
        advance(200);
        const before = gestures().length;
        click();
        expect(beat()).toBe(first);
        const g = gestures();
        expect(g.length).toBe(before + 1);
        expect(JSON.stringify(g[g.length - 1].frames.slice(1))).toBe(JSON.stringify(NUDGE.frames));
        // every gesture starts from where he is (the runner prepends it)
        expect(g[g.length - 1].frames[0].offset).toBe(0);
    });

    it('asleep: the finale moves his bed, and waking up puts it back', () => {
        render({ status: 'away' });
        clicks(6, 150);
        advance(600);
        expect(hk().dataset.bed).toBe('moved');
        render({ status: 'online' });
        expect(hk().dataset.bed).toBeUndefined();
        render({ status: 'away' });
        expect(hk().dataset.bed).toBeUndefined();
    });
});

describe('HomeKeys: garnish states keep the neutral egg', () => {
    it('crown: a click still runs the poke ladder AND spins the crown; spam still builds the show, plus the crown finale', () => {
        const onPoke = vi.fn();
        render({ pro: true }, { onPoke });
        expect(hk().dataset.play).toBe('crown');
        click();
        expect(onPoke).toHaveBeenCalledTimes(1);
        expect(PLAYS.crown.beats({ video: false, sharing: false }).map(b => b.id)).toContain(beat());
        advance(150);
        // keep spamming: the neutral show starts (data-spam) and the crown finale lands on the 6th click
        clicks(5, 150);
        expect(hk().getAttribute('data-spam')).not.toBeNull();
        expect(beat()).toBe('fling');
        expect(eggs).toEqual([finaleEggId('crown')]);
        expect(onPoke).toHaveBeenCalledTimes(1);
    });

    it('neutral: no reactions of ours, just the poke ladder', () => {
        const onPoke = vi.fn();
        render({}, { onPoke });
        expect(hk().dataset.play).toBe('neutral');
        click();
        advance(SPAM_GAP_MS + 400);
        click();
        expect(onPoke).toHaveBeenCalledTimes(2);
        expect(beat()).toBeNull();
    });
});

describe('HomeKeys: reduced motion', () => {
    it('beats still answer with their line, but nothing moves', () => {
        reduce = true;
        render({ status: 'dnd' });
        click();
        const id = beat()!;
        const b = PLAYS.dnd.beats({ video: false, sharing: false }).find(x => x.id === id)!;
        if (b.line) expect(speech()).toBe(b.line);
        expect(gestures()).toHaveLength(0);
        expect(recs.filter(r => (r.el as HTMLElement).closest?.('.hk'))).toHaveLength(0);
        // the finale still counts, without the wall waiting for a click
        advance(3000);
        clicks(6, 150);
        expect(eggs).toEqual([finaleEggId('dnd')]);
        advance(1000);
        click();
        expect(beat()).not.toBe('wallDown');
    });
});

describe('HomeKeys: Shiny Keys', () => {
    it('a shiny launch: the colourway, his name says so, and the egg', () => {
        __setShinyLaunch(true);
        render({});
        expect(hk().dataset.shiny).toBe('on');
        expect(rig().getAttribute('aria-label')).toBe('Keys, the Cipherline mascot, in a rare color');
        expect(eggs).toEqual([SHINY_EGG]);
    });
    it('an ordinary launch: none of it', () => {
        render({});
        expect(hk().dataset.shiny).toBeUndefined();
        expect(eggs).toEqual([]);
    });
});

describe('HomeKeys: the hover parallax', () => {
    const pointer = (type: string, x: number, y: number) => {
        const e = new Event(type, { bubbles: false }) as Event & { clientX: number; clientY: number };
        Object.assign(e, { clientX: x, clientY: y });
        act(() => { hk().dispatchEvent(e); });
    };
    const frames = (n: number) => { for (let i = 0; i < n; i++) { const q = rafQ.splice(0); now += 16; q.forEach(cb => cb(now)); } };
    const box = () => {
        hk().getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    };

    it('tilts toward the pointer while it moves, and comes back to rest on leave', () => {
        render({ gaming: true });
        box();
        pointer('pointerenter', 100, 0);
        frames(60);
        const par = () => (host.querySelector('.hk-par') as HTMLElement).style.transform;
        const lean = () => (host.querySelector('.hk-lean') as HTMLElement).style.transform;
        const back = () => (host.querySelector('.hkg-stage--back') as HTMLElement).style.transform;
        expect(hk().classList.contains('is-tilt')).toBe(true);
        // pointer at the top-right corner: full tilt, within the bounds
        expect(par()).toBe('perspective(420px) rotateX(9.00deg) rotateY(13.00deg)');
        // depth: the TV's stage moves less than his body
        expect(back()).toBe('translate(2.50px, -1.50px)');
        expect(lean()).toBe('translate(7.00px, -4.00px) rotate(4.00deg)');
        expect((host.querySelector('.k2-eyes') as SVGElement).style.transform).toBe('translate(2.60px, -1.80px)');
        // no CSS variables on the root (they would restyle his whole subtree each frame)
        expect(hk().style.getPropertyValue('--hk-x')).toBe('');
        expect(rafQ).toHaveLength(0); // settled: no frame loop while the pointer is still
        pointer('pointerleave', 200, 200);
        frames(200);
        expect(par()).toBe('');
        expect(lean()).toBe('');
        expect(hk().classList.contains('is-tilt')).toBe(false);
        expect(rafQ).toHaveLength(0);
    });

    it('reduced motion: no tilt at all', () => {
        reduce = true;
        render({});
        box();
        pointer('pointerenter', 100, 0);
        pointer('pointermove', 90, 10);
        frames(30);
        expect(hk().classList.contains('is-tilt')).toBe(false);
        expect((host.querySelector('.hk-par') as HTMLElement).style.transform).toBe('');
        expect(rafQ).toHaveLength(0);
    });
});
