// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// An in-memory secureLocalStore: the rotation's persistence is what is under
// test here, not the encryption (secureLocalStore's own tests).
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

import { HomeKeys, BURST_LINES, PLAY_DELAY_MS, SETTLE_SLACK_MS, type PlayVerdict } from './HomeKeys';
import { __resetWaveGuard } from './Keys';
import { SPAM_GAP_MS, homeGameVerdict } from '../../utils/keysBurst';
import { SHOWS, PERSONALITIES, type Personality } from '../../utils/keysSpam';
import { spamBagKey, __resetSpamBagMemory } from '../../utils/keysSpamStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * HomeKeys wired end to end in the DOM: real clicks on the rig, the spam
 * streak deciding, each of the five shows building for 5 s and opening the
 * game (or recovering when the streak breaks), and the rotation handing a
 * different show to each streak, kept per account. The streak's own
 * boundaries are in utils/keysBurst.test.ts, the shows' shapes in
 * utils/keysSpam.test.ts.
 */

const UID = 'acct-1';
let root: Root | null = null;
let host: HTMLDivElement;
let now = 0;
let reduce = false;

function mount(verdict: PlayVerdict = 'ok', userId = UID) {
    const onPlay = vi.fn();
    const onPoke = vi.fn();
    const canPlay = vi.fn(() => verdict);
    act(() => {
        root!.render(React.createElement(HomeKeys, { userId, signal: 'idle', speech: null, lively: true, onPoke, canPlay, onPlay }));
    });
    return { onPlay, onPoke, canPlay };
}
/** The next streak gets `id`. */
const lineUp = (id: Personality, userId = UID) => store.set(spamBagKey(userId), JSON.stringify({ bag: [id], last: null }));
const rig = () => host.querySelector('[role="img"]') as HTMLElement;
/** Click him `n` times, `gap` ms apart. */
function clicks(n: number, gap: number) {
    for (let i = 0; i < n; i++) {
        act(() => { rig().click(); });
        now += gap;
        act(() => { vi.advanceTimersByTime(gap); });
    }
}
/** Keep spamming for `ms` (one click every `gap` ms, the last one at +ms). */
const spamFor = (ms: number, gap = 100) => clicks(Math.floor(ms / gap) + 1, gap);
/** Let the streak break and the recovery finish. */
const rest = () => { now += 4000; act(() => { vi.advanceTimersByTime(4000); }); };
const speech = () => host.querySelector('.k2-speech')?.textContent ?? null;
const showing = () => host.querySelector('.hk')?.getAttribute('data-spam') ?? null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    reduce = false;
    window.matchMedia = ((q: string) => ({
        matches: reduce && q.includes('prefers-reduced-motion: reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.requestAnimationFrame = vi.fn(() => 1);
    window.cancelAnimationFrame = vi.fn();
    __resetWaveGuard();
    store.clear();
    __resetSpamBagMemory();
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

describe('HomeKeys: each of the five shows', () => {
    it.each(PERSONALITIES)('%s: builds a line a second, and 5.0 s of spam opens the game', (id) => {
        lineUp(id);
        const { onPlay, onPoke } = mount();
        const seen: string[] = [];
        for (let i = 0; i < 50; i++) { // 0 .. 4.9 s
            clicks(1, 100);
            const l = speech();
            if (l && l !== seen[seen.length - 1]) seen.push(l);
        }
        expect(showing()).toBe(id);
        expect(seen.filter(l => (SHOWS[id].lines as readonly string[]).includes(l))).toEqual([...SHOWS[id].lines]);
        expect(onPlay).not.toHaveBeenCalled();
        act(() => { rig().click(); }); // +5.0 s
        expect(speech()).toBe(SHOWS[id].finaleLine);
        act(() => { vi.advanceTimersByTime(PLAY_DELAY_MS); });
        expect(onPlay).toHaveBeenCalledTimes(1);
        expect(onPoke).toHaveBeenCalledTimes(1); // only the streak's first click was an ordinary poke
        act(() => { vi.advanceTimersByTime(400); });
        expect(showing()).toBeNull(); // back to plain Keys under the game
    });

    it.each(PERSONALITIES)('%s: 4.9 s then a stop never opens, and he recovers his own way', (id) => {
        lineUp(id);
        const { onPlay } = mount();
        spamFor(4900);
        expect(showing()).toBe(id);
        act(() => { vi.advanceTimersByTime(SPAM_GAP_MS + SETTLE_SLACK_MS + 50); });
        expect(speech()).toBe(SHOWS[id].recoveredLine);
        act(() => { vi.advanceTimersByTime(3000); });
        expect(showing()).toBeNull();
        expect(host.querySelector('.k2-brow')).not.toBeNull(); // his own eyes back
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onPlay).not.toHaveBeenCalled();
    });

    it('clicks that keep coming during the finale do not cut it off or start a new show', () => {
        lineUp('charge');
        const { onPlay } = mount();
        spamFor(5000);              // the 5 s click fires the finale
        clicks(6, 100);             // the spammer has not noticed yet
        act(() => { vi.advanceTimersByTime(100); }); // 800 ms after the finale began
        expect(showing()).toBe('charge');
        expect(speech()).toBe(SHOWS.charge.finaleLine);
        expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it('a show draws its own eyes once it gets going (glitch: pixel eyes)', () => {
        lineUp('glitch');
        mount();
        spamFor(1500);
        expect(host.querySelector('.hk-eyes')).not.toBeNull();
        expect(host.querySelector('.k2-brow')).toBeNull();
    });
});

describe('HomeKeys: the rotation', () => {
    it('five streaks in a row get five different shows, then a new round starts', () => {
        mount();
        const got: (string | null)[] = [];
        for (let i = 0; i < 5; i++) {
            spamFor(1200);
            got.push(showing());
            rest();
        }
        expect(new Set(got).size).toBe(5);
        expect(got.every(g => g && (PERSONALITIES as readonly string[]).includes(g))).toBe(true);
        spamFor(1200);
        expect(showing()).not.toBe(got[4]); // a new round never opens with the last one
    });

    it('carries on across a remount (a new session) from the account’s store', () => {
        mount();
        spamFor(1200);
        const first = showing();
        rest();
        act(() => { root!.unmount(); });
        root = createRoot(host);
        mount();
        spamFor(1200);
        expect(showing()).not.toBe(first);
        expect(JSON.parse(store.get(spamBagKey(UID))!).bag).toHaveLength(3);
    });

    it('is per account: another account starts its own rotation', () => {
        lineUp('camo', UID);
        lineUp('dance', 'acct-2');
        mount('ok', 'acct-2');
        spamFor(1200);
        expect(showing()).toBe('dance');
    });

    it('a double-click (a streak under half a second) does not use up a show', () => {
        lineUp('charge');
        mount();
        clicks(2, 120);
        rest();
        spamFor(1200);
        expect(showing()).toBe('charge');
    });

    it('a single click is still the ordinary poke, and uses up nothing', () => {
        lineUp('dodge');
        const { onPoke, onPlay } = mount();
        clicks(1, 50);
        expect(onPoke).toHaveBeenCalledWith(1);
        rest();
        expect(onPlay).not.toHaveBeenCalled();
        expect(JSON.parse(store.get(spamBagKey(UID))!).bag).toEqual(['dodge']);
    });
});

describe('HomeKeys: refusals and slow clicking', () => {
    it.each([
        ['call', BURST_LINES.call],
        ['unavailable', BURST_LINES.unavailable],
    ] as const)('when the host says "%s", he says why and the game stays shut', (verdict, line) => {
        const { onPlay, canPlay } = mount(verdict);
        spamFor(5000);
        expect(canPlay).toHaveBeenCalledTimes(1);
        expect(speech()).toBe(line);
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onPlay).not.toHaveBeenCalled();
        expect(showing()).toBeNull();
    });

    it('a click every 700 ms for a minute never opens the game and never starts a show', () => {
        const { onPlay, onPoke } = mount();
        const shows = new Set<string | null>();
        for (let i = 0; i < 100; i++) { clicks(1, 700); shows.add(host.querySelector('.hk-eyes, .hk-ghost, .hk-ring, .hk-note, .hk-stripes') ? 'drawn' : null); }
        act(() => { vi.advanceTimersByTime(5000); });
        expect(onPlay).not.toHaveBeenCalled();
        expect(onPoke).toHaveBeenCalledTimes(100);
        expect(shows).toEqual(new Set([null]));
    });

    it('every streak click starts Web Animations on html elements only, and they stop when the show ends', () => {
        const started: { el: Element; anim: { cancelled: boolean } }[] = [];
        const proto = Element.prototype as unknown as { animate?: unknown };
        const had = proto.animate;
        proto.animate = function (this: Element) {
            const anim = { cancelled: false, cancel() { this.cancelled = true; }, playState: 'running' };
            started.push({ el: this, anim });
            return anim as unknown as Animation;
        };
        try {
            lineUp('charge');
            mount();
            spamFor(3000);
            expect(started.length).toBeGreaterThan(20);
            expect(started.every(s => s.el instanceof HTMLElement || s.el.tagName.toLowerCase() === 'svg')).toBe(true);
            expect(started.some(s => (s.el as Element).closest?.('.k2-svg') && s.el.tagName.toLowerCase() !== 'svg')).toBe(false);
            rest();
            // everything held during the show was let go once he settled
            const held = started.filter(s => !s.anim.cancelled);
            expect(held.length).toBeLessThan(started.length);
        } finally {
            proto.animate = had;
        }
    });

    it('unmounting at the last moment cancels the pending open', () => {
        const { onPlay } = mount();
        spamFor(5000);
        act(() => { root!.unmount(); });
        root = null;
        vi.advanceTimersByTime(PLAY_DELAY_MS * 2);
        expect(onPlay).not.toHaveBeenCalled();
    });
});

describe('HomeKeys: the streak survives a human', () => {
    it.each([450, 550, 600])('a click every %i ms for 5 s opens the game (a gap up to 600 ms keeps it going)', (gap) => {
        lineUp('dance');
        const { onPlay } = mount();
        clicks(Math.ceil(5000 / gap) + 1, gap);
        act(() => { vi.advanceTimersByTime(PLAY_DELAY_MS); });
        expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it('a 650 ms gap ends the streak: positive control, nothing opens', () => {
        lineUp('dance');
        const { onPlay } = mount();
        clicks(Math.ceil(8000 / 650), 650);
        act(() => { vi.advanceTimersByTime(PLAY_DELAY_MS * 3); });
        expect(onPlay).not.toHaveBeenCalled();
    });

    it('MID-STREAK a click beside him (in the hit zone, not on him) still counts', () => {
        lineUp('dodge');
        const { onPlay } = mount();
        const zone = host.querySelector('.hk') as HTMLElement;
        clicks(3, 100); // streak is live
        for (let i = 0; i < 48; i++) { // the rest of the 5 s, every click landing on the zone, not the rig
            act(() => { zone.click(); });
            now += 100; act(() => { vi.advanceTimersByTime(100); });
        }
        act(() => { zone.click(); });
        act(() => { vi.advanceTimersByTime(PLAY_DELAY_MS); });
        expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it('positive control: with NO live streak a click beside him does nothing (no stolen clicks)', () => {
        const { onPoke } = mount();
        const zone = host.querySelector('.hk') as HTMLElement;
        act(() => { zone.click(); });
        expect(onPoke).not.toHaveBeenCalled();
        expect(showing()).toBeNull();
    });

    it('clicking him does not remount the rig (a remount restarts every leg animation in flight)', () => {
        mount();
        const svg = host.querySelector('svg.k2-svg');
        for (let i = 0; i < 6; i++) clicks(1, 100);
        expect(host.querySelector('svg.k2-svg')).toBe(svg);
    });
});

describe('HomeKeys: reduced motion (Windows "Animation effects" off) still opens the game', () => {
    // The owner's report: spamming him never opened the game. With reduced
    // motion on, the host's rule said 'motion' and he only ever replied
    // "I'd play, but motion is turned down": 0 of 25 real-pointer attempts in
    // headless Chromium (harness/keys-egg-drive.mjs, reducedMotion 'reduce'),
    // 25 of 25 with the rule fixed.
    const animateSpy = () => {
        const proto = Element.prototype as unknown as { animate?: unknown };
        const had = proto.animate;
        let calls = 0;
        proto.animate = function () { calls++; return { cancel() {}, playState: 'running' } as unknown as Animation; };
        return { calls: () => calls, restore: () => { proto.animate = had; } };
    };

    it('homeGameVerdict ignores reduced motion: ok, unless in a call or the machine cannot draw it', () => {
        reduce = true;
        expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true); // the premise
        expect(homeGameVerdict(false, () => true)).toBe('ok');
        // controls: the two refusals that remain
        expect(homeGameVerdict(true, () => true)).toBe('call');
        expect(homeGameVerdict(false, () => false)).toBe('unavailable');
    });

    it('5 s of spam under reduced motion opens the game, with no show motion on the way', () => {
        reduce = true;
        const spy = animateSpy();
        try {
            lineUp('dodge');
            const onPlay = vi.fn();
            act(() => {
                root!.render(React.createElement(HomeKeys, {
                    userId: UID, signal: 'idle', speech: null, lively: true, onPoke: vi.fn(),
                    canPlay: () => homeGameVerdict(false, () => true), onPlay,
                }));
            });
            spamFor(5000);
            act(() => { vi.advanceTimersByTime(PLAY_DELAY_MS); });
            expect(onPlay).toHaveBeenCalledTimes(1);
            // reduced motion really was in effect: the shows started no animation
            expect(spy.calls()).toBe(0);
        } finally {
            spy.restore();
        }
    });

    it('positive control: the same spam without reduced motion does animate (the spy sees shows)', () => {
        const spy = animateSpy();
        try {
            lineUp('dodge');
            mount();
            spamFor(1000);
            expect(spy.calls()).toBeGreaterThan(0);
        } finally {
            spy.restore();
        }
    });
});

describe('HomeKeys: a busy main thread does not break the streak', () => {
    // A click, stamped with WHEN it happened (event.timeStamp, the
    // performance clock), handled whenever the renderer gets to it.
    const stampedClick = (el: Element, at: number) => {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'timeStamp', { value: at });
        act(() => { el.dispatchEvent(ev); });
    };
    /**
     * Spam for 5 s at a steady 500 ms cadence, every other click handled
     * 150 ms late (the main thread was busy), so some handler-to-handler gaps
     * are 650 ms although no input gap is over 500. `stamp` false = the
     * events carry no usable timestamp (the old behaviour: handler time).
     */
    const lateSpam = (stamp: boolean, on: (i: number) => Element) => {
        const t0 = now;
        for (let i = 0; i <= 10; i++) {
            const made = t0 + i * 500;
            const handled = made + (i % 2 === 0 ? 0 : 150);
            act(() => { vi.advanceTimersByTime(handled - now); });
            now = handled;
            stampedClick(on(i), stamp ? made : Number.NaN);
        }
        act(() => { vi.advanceTimersByTime(PLAY_DELAY_MS * 3); });
    };
    /** Beside him: in the hit zone, not on the rig. */
    const zone = () => host.querySelector('.hk')!;

    it('clicks every 500 ms, every other one handled 150 ms late, still open the game', () => {
        lineUp('dance');
        const { onPlay } = mount();
        lateSpam(true, rig);
        expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it('positive control: the same clicks judged by handler time break the streak', () => {
        lineUp('dance');
        const { onPlay } = mount();
        lateSpam(false, rig);
        expect(onPlay).not.toHaveBeenCalled();
    });

    it('zone clicks (beside him, mid-streak) are judged by their own timestamps too', () => {
        lineUp('dodge');
        const { onPlay } = mount();
        lateSpam(true, i => (i === 0 ? rig() : zone()));
        expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it('positive control: unstamped zone clicks handled late break the streak', () => {
        lineUp('dodge');
        const { onPlay } = mount();
        lateSpam(false, i => (i === 0 ? rig() : zone()));
        expect(onPlay).not.toHaveBeenCalled();
    });
});

describe('HomeKeys: the idle-CPU contract', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles', 'home-keys.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ''); // rules only, not the comments that explain them

    it('turns the rig’s main-thread leg sway off', () => {
        mount();
        expect(host.querySelector('svg.k2-svg')?.classList.contains('k2-still')).toBe(true);
    });

    it('its loop animates transform only, and stops with the idle and occlusion gates and reduced motion', () => {
        const swim = css.slice(css.indexOf('@keyframes hk-swim'), css.indexOf('}', css.indexOf('100%', css.indexOf('@keyframes hk-swim'))));
        const props = [...swim.matchAll(/\{\s*([a-z-]+)\s*:/g)].map(m => m[1]);
        expect(props.length).toBeGreaterThan(0);
        expect(new Set(props)).toEqual(new Set(['transform']));
        expect(css).toMatch(/:root\[data-cl-motion="idle"\] \.hk-swim \{ animation: none; \}/);
        expect(css).toMatch(/:root\[data-cl-occluded="on"\] \.hk-swim:not\(\.sd-root \*\) \{ animation: none; \}/);
        expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*\.hk\[data-swim\] \.hk-swim \{ animation: none; \}/);
        expect(css).not.toMatch(/(^|[^-])filter\s*:|box-shadow|will-change/);
    });

    it('no swim at all when ambience is off', () => {
        act(() => {
            root!.render(React.createElement(HomeKeys, { userId: UID, signal: 'idle', speech: null, lively: false, onPoke: () => {}, canPlay: (): PlayVerdict => 'ok', onPlay: () => {} }));
        });
        expect(host.querySelector('.hk')?.getAttribute('data-swim')).toBe('off');
    });
});
