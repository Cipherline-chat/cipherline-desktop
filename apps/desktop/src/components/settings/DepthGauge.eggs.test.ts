// @vitest-environment jsdom
/**
 * Settings-search eggs (DepthGauge): octopus / squid / kraken / abyss earn a
 * note in the field-message slot — only with the easter-eggs switch on — while
 * the factual security notes (keys …) never depend on it. Also the Halloween
 * zone names and the birthday footer line, mounted for real.
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
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const { DepthGauge } = await import('./DepthGauge');
const { settingsSearchPool } = await import('../../utils/settingsSearchNote');
const { EGG_SEARCH_NOTES, MISNAMED_KEYS_POOL, ABYSS_SEARCH_POOL, SETTINGS_SEARCH_NOTES, BIRTHDAY_POOL } = await import('../../utils/eggPools');

/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';

const { __resetMascotCueForTests } = await import('../../hooks/useMascotCue');

describe('settingsSearchPool (pure)', () => {
    it('playful and factual queries both answer (there is no switch)', () => {
        expect(settingsSearchPool('octopus')?.pool).toBe(MISNAMED_KEYS_POOL);
        expect(settingsSearchPool('abyss')?.pool).toBe(ABYSS_SEARCH_POOL);
        expect(settingsSearchPool('keys')?.pool).toBe(SETTINGS_SEARCH_NOTES.keys);
    });
    it('normalises like the field does (case, spaces) and only misnamed flags the wiggle', () => {
        expect(settingsSearchPool('  KRAKEN ')?.misnamed).toBe(true);
        expect(settingsSearchPool('Squid')?.misnamed).toBe(true);
        expect(settingsSearchPool('abyss')?.misnamed).toBe(false);
        expect(settingsSearchPool('octopuses')).toBeNull();
        expect(settingsSearchPool('constructor')).toBeNull();
        expect(settingsSearchPool('__proto__')).toBeNull();
    });
    it('every egg query has a pool of at least three', () => {
        for (const p of Object.values(EGG_SEARCH_NOTES)) expect(p.length).toBeGreaterThanOrEqual(3);
    });
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    store.clear();
    __resetMascotCueForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const mount = () => act(() => root.render(React.createElement(DepthGauge, { active: 'profile', onSelect: () => {}, appVersion: '1.0.22' })));
function type(v: string) {
    const el = host.querySelector('input[aria-label="Find a setting"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const note = () => host.querySelector('.cl-fmsg')?.textContent ?? '';
const zones = () => Array.from(host.querySelectorAll('.sd-zlab b')).map(b => b.textContent);

describe('DepthGauge eggs (mounted)', () => {
    it('octopus → a "wrong cephalopod" line, and the cue event fires once', () => {
        const cue = vi.fn();
        window.addEventListener('cl:cuttlefish', cue);
        mount();
        type('octopus');
        expect(MISNAMED_KEYS_POOL).toContain(note());
        expect(cue).toHaveBeenCalledTimes(1);
        type('squid');
        expect(cue).toHaveBeenCalledTimes(1);
        window.removeEventListener('cl:cuttlefish', cue);
    });

    it('abyss → an Abyss line, no cue', () => {
        const cue = vi.fn();
        window.addEventListener('cl:cuttlefish', cue);
        mount();
        type('abyss');
        expect(ABYSS_SEARCH_POOL).toContain(note());
        expect(cue).not.toHaveBeenCalled();
        window.removeEventListener('cl:cuttlefish', cue);
    });

    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        mount();
        type('octopus');
        expect(MISNAMED_KEYS_POOL).toContain(note());
        type('abyss');
        expect(ABYSS_SEARCH_POOL).toContain(note());
        type('keys');
        expect(SETTINGS_SEARCH_NOTES.keys).toContain(note());
    });

    it('clearing the box clears the note', () => {
        mount();
        type('kraken');
        expect(note()).not.toBe('');
        type('');
        expect(note()).toBe('');
    });

    it('Halloween renames Midnight and The Abyss (a stale "off" changes nothing); any other day does not', () => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00') });
        mount();
        expect(zones()).toEqual(['Surface', 'Twilight', 'The Witching Hour', 'The Haunted Abyss']);
        act(() => root.unmount());
        root = createRoot(host);
        store.set(LEGACY_EGGS_KEY, '0');
        mount();
        expect(zones()).toEqual(['Surface', 'Twilight', 'The Witching Hour', 'The Haunted Abyss']);
        act(() => root.unmount());
        root = createRoot(host);
        store.clear();
        vi.setSystemTime(new Date('2026-10-30T12:00:00'));
        mount();
        expect(zones()).toEqual(['Surface', 'Twilight', 'Midnight', 'The Abyss']);
    });

    it('the first anniversary adds a birthday line to the footer, with the age filled in; the security line stays', () => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-04-30T12:00:00') });
        mount();
        const foot = host.querySelector('.sd-gfoot small')!;
        expect(foot.textContent).toContain('E2E encrypted');
        const b = host.querySelector('.sd-bday')!.textContent!;
        expect(BIRTHDAY_POOL.map(l => l.replace('{n}', '1'))).toContain(b);
        act(() => root.unmount());
        root = createRoot(host);
        vi.setSystemTime(new Date('2026-04-30T12:00:00'));
        mount();
        expect(host.querySelector('.sd-bday')).toBeNull();
    });
});
