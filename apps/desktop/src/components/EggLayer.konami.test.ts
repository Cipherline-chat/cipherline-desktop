// @vitest-environment jsdom
/**
 * Egg: the Konami code → Keys party (EggLayer + KeysParty), mounted for real.
 * Controls: a wrong key restarts; keys typed INTO a text field are ignored
 * (privacy: the layer must never see composer input); the switch OFF disables
 * it; a second run inside the cooldown does nothing; reduced motion gets the
 * still variant; it removes itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let reduced = false;
window.matchMedia = ((q: string) => ({
    matches: reduced && /reduced-motion/.test(q), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { EggLayer, KONAMI_COOLDOWN_MS } = await import('./EggLayer');
const { PARTY_MS, PARTY_STILL_MS } = await import('./KeysParty');
const { KONAMI } = await import('../utils/easterEggs');
/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
    store.clear();
    reduced = false;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(EggLayer)));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const press = (keys: readonly string[], target: EventTarget = document.body) => {
    for (const key of keys) act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
};
const party = () => document.querySelector('[data-testid="keys-party"]');

describe('Konami → Keys party', () => {
    it('fires on the full sequence and removes itself afterwards', () => {
        press(KONAMI);
        expect(party()).not.toBeNull();
        expect(party()?.getAttribute('aria-hidden')).toBe('true');
        expect(document.querySelector('.egg-party-swimmer')).not.toBeNull();
        act(() => { vi.advanceTimersByTime(PARTY_MS + 50); });
        expect(party()).toBeNull();
    });

    it('a wrong key restarts the sequence', () => {
        press([...KONAMI.slice(0, 6), 'x', ...KONAMI.slice(6)]);
        expect(party()).toBeNull();
    });

    it('keys typed into a text field never count (and break a run in progress)', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        press(KONAMI, input);
        expect(party()).toBeNull();
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        press(KONAMI.slice(0, 5));
        press(['x'], textarea);
        press(KONAMI.slice(5));
        expect(party()).toBeNull();
    });

    it('modifier chords are ignored', () => {
        for (const key of KONAMI) act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true })); });
        expect(party()).toBeNull();
    });

    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        press(KONAMI);
        expect(party()).not.toBeNull();
    });

    it('a second run inside the cooldown is refused; after it, allowed again', () => {
        press(KONAMI);
        act(() => { vi.advanceTimersByTime(PARTY_MS + 50); });
        press(KONAMI);
        expect(party()).toBeNull();
        act(() => { vi.advanceTimersByTime(KONAMI_COOLDOWN_MS); });
        press(KONAMI);
        expect(party()).not.toBeNull();
    });

    it('reduced motion: a still Keys, no swimmer, no confetti, shorter', () => {
        reduced = true;
        press(KONAMI);
        expect(party()?.classList.contains('egg-party--still')).toBe(true);
        expect(document.querySelector('.egg-party-swimmer')).toBeNull();
        expect(document.querySelector('.egg-party-piece')).toBeNull();
        expect(document.querySelector('g.k2-costume')?.getAttribute('data-costume')).toBe('party');
        act(() => { vi.advanceTimersByTime(PARTY_STILL_MS + 50); });
        expect(party()).toBeNull();
    });

    it('never intercepts the keys: it only listens', () => {
        const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
        act(() => { document.body.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(false);
    });
});
