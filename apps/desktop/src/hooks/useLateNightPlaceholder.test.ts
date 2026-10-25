// @vitest-environment jsdom
/**
 * Egg: 03:00–04:59 local, the composer's idle placeholder asks whether you
 * shouldn't be asleep. Clock only; switch-gated; one line per night.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useLateNightPlaceholder } = await import('./useEasterEggs');
const { LATE_NIGHT_PLACEHOLDERS } = await import('../utils/eggPools');
const { dayNumber } = await import('../utils/easterEggs');
/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


let root: Root;
let host: HTMLDivElement;
const Probe: React.FC = () => React.createElement('span', { id: 'ph' }, useLateNightPlaceholder() ?? '∅');
const shown = () => host.querySelector('#ph')!.textContent;
const at = (iso: string) => vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date(iso) });
const mount = () => act(() => root.render(React.createElement(Probe)));

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

describe('late-night composer placeholder', () => {
    it('03:30 → one of the late-night lines (the first line is the owner’s)', () => {
        at('2026-10-20T03:30:00');
        mount();
        expect(LATE_NIGHT_PLACEHOLDERS).toContain(shown());
        expect(LATE_NIGHT_PLACEHOLDERS[0]).toBe('Shouldn’t you be asleep?');
    });

    it('is nothing in the daytime, at 02:59 and at 05:00', () => {
        for (const t of ['2026-10-20T12:00:00', '2026-10-20T02:59:00', '2026-10-20T05:00:00']) {
            at(t);
            act(() => root.unmount());
            root = createRoot(host);
            mount();
            expect(shown(), t).toBe('∅');
            vi.useRealTimers();
        }
    });

    it('same line all night, a different one the next night', () => {
        const line = (iso: string) => {
            at(iso);
            act(() => root.unmount());
            root = createRoot(host);
            mount();
            const v = shown();
            vi.useRealTimers();
            return v;
        };
        expect(line('2026-10-20T03:05:00')).toBe(line('2026-10-20T04:55:00'));
        expect(line('2026-10-20T03:05:00')).not.toBe(line('2026-10-21T03:05:00'));
        expect(dayNumber(new Date('2026-10-21T03:05:00'))).toBe(dayNumber(new Date('2026-10-20T03:05:00')) + 1);
    });

    it('appears when the clock crosses 03:00 and clears at 05:00 (five-minute re-check)', () => {
        at('2026-10-20T02:58:00');
        mount();
        expect(shown()).toBe('∅');
        act(() => { vi.setSystemTime(new Date('2026-10-20T03:02:00')); vi.advanceTimersByTime(5 * 60 * 1000); });
        expect(LATE_NIGHT_PLACEHOLDERS).toContain(shown());
        act(() => { vi.setSystemTime(new Date('2026-10-20T05:01:00')); vi.advanceTimersByTime(5 * 60 * 1000); });
        expect(shown()).toBe('∅');
    });

    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        at('2026-10-20T03:30:00');
        mount();
        expect(LATE_NIGHT_PLACEHOLDERS).toContain(shown());
    });

    it('ChatPane uses it only for the plain composer hint (self-chat and every functional hint win)', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(here, '..', 'components', 'ChatPane.tsx'), 'utf8');
        expect(src).toMatch(/const lateNightPlaceholder = useLateNightPlaceholder\(\);/);
        expect(src).toMatch(/isSelfChat \? 'Message yourself…' : \(lateNightPlaceholder \?\? 'Message…'\)/);
        // The functional states precede it in the same ternary chain.
        const chain = src.slice(src.indexOf("'Waiting for channel keys"), src.indexOf('lateNightPlaceholder ??'));
        expect(chain).toMatch(/don't have permission[\s\S]*Add a caption/);
    });
});
