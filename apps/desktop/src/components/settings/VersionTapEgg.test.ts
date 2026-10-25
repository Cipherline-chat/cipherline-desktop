// @vitest-environment jsdom
/**
 * Egg: tap the version in Settings → Advanced seven times → "Keys developer
 * mode" (cosmetic badge). Pure counting is tested directly; the wrapper is
 * mounted around a real <button> so the click really bubbles from it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const { VersionTapEgg } = await import('./VersionTapEgg');
const { versionTap, VERSION_TAP_GOAL, VERSION_TAP_WINDOW_MS, DEV_MODE_ON_LINE } = await import('../../utils/versionTaps');
const { KEYS_DEV_POOL } = await import('../../utils/eggPools');
const { EGG_LEDGER_KEY } = await import('../../utils/easterEggs');
/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


describe('versionTap (pure)', () => {
    it('counts quietly, then counts down, then activates on the 7th', () => {
        let s: ReturnType<typeof versionTap>['streak'] | undefined;
        const notes: (string | null)[] = [];
        let activated = false;
        for (let i = 0; i < VERSION_TAP_GOAL; i++) {
            const r = versionTap(s, 1000 + i * 200, false);
            s = r.streak; notes.push(r.note); activated = r.activate;
        }
        expect(notes.slice(0, 2)).toEqual([null, null]);
        expect(notes[2]).toBe('4 more taps to go…');
        expect(notes[5]).toBe('1 more tap to go…');
        expect(notes[6]).toBe(DEV_MODE_ON_LINE);
        expect(activated).toBe(true);
    });

    it('a pause longer than the window restarts the run', () => {
        let s = versionTap(undefined, 0, false).streak;
        for (let i = 1; i < 5; i++) s = versionTap(s, i * 300, false).streak;
        const after = versionTap(s, 5 * 300 + VERSION_TAP_WINDOW_MS + 1, false);
        expect(after.streak.count).toBe(1);
        expect(after.note).toBeNull();
        expect(after.activate).toBe(false);
    });

    it('once on, extra taps shrug from a rotating pool and never re-activate', () => {
        let s: ReturnType<typeof versionTap>['streak'] | undefined;
        const seen: (string | null)[] = [];
        for (let i = 0; i < 8; i++) {
            const r = versionTap(s, i * 200, true);
            s = r.streak; seen.push(r.note);
            expect(r.activate).toBe(false);
        }
        expect(seen[0]).toBeNull();
        expect(seen.slice(2).every(n => KEYS_DEV_POOL.includes(n as never))).toBe(true);
        expect(seen[2]).not.toBe(seen[3]);
    });
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
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

const copied = vi.fn();
const mount = () => act(() => root.render(React.createElement(
    VersionTapEgg, null,
    React.createElement('button', { type: 'button', id: 'chip', onClick: copied }, 'v1.0.22'),
)));
const tap = (n: number, gap = 200) => {
    for (let i = 0; i < n; i++) {
        act(() => { (host.querySelector('#chip') as HTMLButtonElement).click(); });
        act(() => { vi.advanceTimersByTime(gap); });
    }
};
const badge = () => host.querySelector('[data-testid="keys-dev-badge"]');
const note = () => host.querySelector('[role="status"]')?.textContent ?? '';

describe('VersionTapEgg', () => {
    it('seven quick taps → the badge, a note that says it does nothing, persisted', () => {
        copied.mockReset();
        mount();
        expect(badge()).toBeNull();
        tap(6);
        expect(badge()).toBeNull();
        expect(note()).toContain('1 more tap');
        tap(1, 0);
        expect(badge()).not.toBeNull();
        expect(note()).toBe(DEV_MODE_ON_LINE);
        expect(badge()!.textContent).toContain('dev mode');
        expect(badge()!.getAttribute('title')).toMatch(/cosmetic/i);
        expect(JSON.parse(store.get(EGG_LEDGER_KEY)!)['dev-mode'].count).toBe(1);
        // The chip kept doing its real job on every tap.
        expect(copied).toHaveBeenCalledTimes(7);
    });

    it('the note clears on its own', () => {
        mount();
        tap(3, 0);
        expect(note()).not.toBe('');
        act(() => { vi.advanceTimersByTime(3000); });
        expect(note()).toBe('');
    });

    it('slow taps never get there', () => {
        mount();
        tap(10, VERSION_TAP_WINDOW_MS + 100);
        expect(badge()).toBeNull();
    });

    it('stays on across a remount (the ledger), and a click on the badge is not a tap', () => {
        mount();
        tap(7, 0);
        act(() => root.unmount());
        root = createRoot(host);
        mount();
        expect(badge()).not.toBeNull();
        act(() => { (badge() as HTMLElement).click(); });
        expect(note()).toBe('');
    });

    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        mount();
        tap(7, 0);
        expect(badge()).not.toBeNull();
    });

    it('is wired around the version chip in Advanced', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(here, '..', 'AdvancedSettings.tsx'), 'utf8');
        expect(src).toMatch(/<VersionTapEgg>\s*<CopyChip text=\{buildVersionText\(APP_VERSION, BUILD_COMMIT\)\}/);
    });
});
