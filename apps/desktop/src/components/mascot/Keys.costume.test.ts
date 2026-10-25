// @vitest-environment jsdom
/**
 * Egg: Keys wears the day's hat (Halloween witch hat, New Year / birthday
 * party hat). Rendered for real; the calendar is driven with fake system time.
 * Controls: an ordinary day shows nothing, the easter-eggs switch OFF shows
 * nothing, and an explicit `costume` prop wins over the calendar either way.
 */
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// Imported AFTER the matchMedia stub: clPhysics (reached through DepthGauge)
// reads it at module load.
const { Keys } = await import('./Keys');
const { zoneLabel } = await import('../settings/DepthGauge');

/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    store.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const on = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
const hat = () => host.querySelector('g.k2-costume')?.getAttribute('data-costume') ?? null;
const mount = (props: import('./Keys').KeysProps = {}) =>
    act(() => root.render(React.createElement(Keys, { waveOnMount: false, ...props })));

describe('Keys costume', () => {
    it('Halloween: a witch hat, announced in the label', () => {
        on('2026-10-31T12:00:00');
        mount();
        expect(hat()).toBe('witch');
        expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Keys, the Cipherline mascot in a witch hat');
    });

    it('New Year’s Day: a party hat', () => {
        on('2027-01-01T12:00:00');
        mount();
        expect(hat()).toBe('party');
    });

    it('the first anniversary of launch: a party hat', () => {
        on('2027-04-30T12:00:00');
        mount();
        expect(hat()).toBe('party');
    });

    it('an ordinary day: no hat, plain label', () => {
        on('2026-10-20T12:00:00');
        mount();
        expect(hat()).toBeNull();
        expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Keys, the Cipherline mascot');
    });

    it('the day after Halloween: no hat', () => {
        on('2026-11-01T00:30:00');
        mount();
        expect(hat()).toBeNull();
    });

    it('a stale "off" from the retired switch changes nothing: the hat is on', () => {
        on('2026-10-31T12:00:00');
        store.set(LEGACY_EGGS_KEY, '0');
        mount();
        expect(hat()).not.toBeNull();
    });

    it('an explicit costume prop beats the calendar; null forces none', () => {
        on('2026-10-20T12:00:00');
        mount({ costume: 'party' });
        expect(hat()).toBe('party');
        on('2026-10-31T12:00:00');
        mount({ costume: null });
        expect(hat()).toBeNull();
    });

    it('hat changes at the hourly re-check when midnight passes', () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date('2026-10-31T23:30:00') });
        mount();
        expect(hat()).toBe('witch');
        act(() => { vi.setSystemTime(new Date('2026-11-01T00:10:00')); vi.advanceTimersByTime(60 * 60 * 1000); });
        expect(hat()).toBeNull();
    });
});

describe('Halloween depth labels', () => {
    it('relabels Midnight and The Abyss on the day, nothing else', () => {
        expect(zoneLabel('Midnight', true)).toBe('The Witching Hour');
        expect(zoneLabel('The Abyss', true)).toBe('The Haunted Abyss');
        expect(zoneLabel('Surface', true)).toBe('Surface');
        expect(zoneLabel('Twilight', true)).toBe('Twilight');
    });
    it('is the plain name on every other day', () => {
        for (const n of ['Surface', 'Twilight', 'Midnight', 'The Abyss']) expect(zoneLabel(n, false)).toBe(n);
    });
});
