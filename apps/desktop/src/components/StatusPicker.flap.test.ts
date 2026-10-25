// @vitest-environment jsdom
/**
 * Egg: six presence-status changes inside a minute → the picker's "Status"
 * label asks "Still deciding?" for a few seconds. Real StatusPicker, real
 * clicks. Controls: picking the status you already have doesn't count, a slow
 * flipper never trips it, it fires once (not on every flip after), cooldown,
 * switch OFF, and the status change itself always goes through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});
vi.mock('../hooks/useUserStatus', () => ({
    STATUS_CONFIG: {
        online: { label: 'Online', color: '#4ADE80' },
        away: { label: 'Away', color: '#FFC94D' },
        dnd: { label: 'Do Not Disturb', color: '#FF6B5E' },
        offline: { label: 'Offline', color: '#5E6B8F' },
    },
}));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('./StatusIcon', () => ({ StatusDot: () => null, StatusIcon: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { StatusPicker } = await import('./StatusPicker');
const { STATUS_FLAP_SHOW_MS, STATUS_FLAP_COOLDOWN_MS, STATUS_FLAP_WINDOW_MS } = await import('../utils/statusFlap');
const { STATUS_FLAP_POOL } = await import('../utils/eggPools');

/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


let root: Root;
let host: HTMLDivElement;
const changed = vi.fn();
const Host: React.FC = () => {
    const [s, setS] = useState<'online' | 'away' | 'dnd' | 'offline'>('online');
    return React.createElement(StatusPicker, { myStatus: s, username: 'me', onSetStatus: (n) => { changed(n); setS(n); } });
};
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
    store.clear();
    changed.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Host)));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const label = () => Array.from(host.querySelectorAll('p')).find(p => /Status|deciding|dizzy|Pick one|Decisions/.test(p.textContent ?? ''))?.textContent ?? '';
const pick = (name: string, gap = 500) => {
    const b = Array.from(host.querySelectorAll('button')).find(x => x.textContent?.trim() === name)!;
    act(() => b.click());
    act(() => { vi.advanceTimersByTime(gap); });
};
const SIX = ['Idle', 'Online', 'DND', 'Online', 'Offline', 'Online'];

describe('status flap', () => {
    it('six changes in a minute swap the label for a pool line, then it reverts', () => {
        expect(label()).toBe('Status');
        SIX.slice(0, 5).forEach(n => pick(n));
        expect(label()).toBe('Status');
        pick(SIX[5], 0);
        expect(STATUS_FLAP_POOL).toContain(label());
        expect(label()).toBe('Still deciding?');
        act(() => { vi.advanceTimersByTime(STATUS_FLAP_SHOW_MS + 50); });
        expect(label()).toBe('Status');
    });

    it('the status change itself always goes through (all six)', () => {
        SIX.forEach(n => pick(n));
        expect(changed.mock.calls.map(c => c[0])).toEqual(['away', 'online', 'dnd', 'online', 'offline', 'online']);
    });

    it('re-picking the current status is not a flip', () => {
        pick('Idle');
        for (let i = 0; i < 8; i++) pick('Idle');
        expect(label()).toBe('Status');
    });

    it('a slow flipper (changes spread past a minute) never trips it', () => {
        SIX.forEach(n => pick(n, STATUS_FLAP_WINDOW_MS / 4));
        expect(label()).toBe('Status');
    });

    it('fires on the exact hit only; a 7th flip does not restart it', () => {
        SIX.forEach(n => pick(n, 100));
        act(() => { vi.advanceTimersByTime(STATUS_FLAP_SHOW_MS + 50); });
        expect(label()).toBe('Status');
        pick('Offline', 100);
        expect(label()).toBe('Status');
    });

    it('after speaking it stays quiet through the cooldown, then can again with a different line', () => {
        SIX.forEach(n => pick(n, 100));
        act(() => { vi.advanceTimersByTime(STATUS_FLAP_COOLDOWN_MS + 10); });
        ['Idle', 'Online', 'DND', 'Online', 'Offline', 'Online'].forEach(n => pick(n, 100));
        expect(label()).toBe(STATUS_FLAP_POOL[1]);
    });

    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        SIX.forEach(n => pick(n, 100));
        expect(label()).not.toBe('Status');
        expect(changed).toHaveBeenCalledTimes(6);
    });
});
