// @vitest-environment jsdom
/**
 * Egg: alone in a call for a few minutes → Keys echoes (AloneEcho).
 * Trigger = the roster being just you for ALONE_ECHO_AFTER_MS; rate-limited to
 * once per call and once per six hours; dismissable; cancelled the moment
 * anyone joins; off with the switch.
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

const { AloneEcho } = await import('./AloneEcho');
const { ALONE_ECHO_AFTER_MS, ALONE_ECHO_STEP_MS, ALONE_ECHO_COOLDOWN_MS, aloneEchoLine } = await import('../../utils/aloneEcho');
const { ALONE_ECHO_POOL } = await import('../../utils/eggPools');

/** The retired switch's key: a '0' left behind by it must change nothing. */
const LEGACY_EGGS_KEY = 'cipherline_easter_eggs';


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

const render = (alone: boolean, sessionId = 'call-1') =>
    act(() => root.render(React.createElement(AloneEcho, { alone, sessionId })));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const pill = () => host.querySelector('[data-testid="alone-echo"]');
const text = () => pill()?.textContent ?? '';

describe('alone in a call', () => {
    it('says nothing until the full wait has passed, then opens with the echo', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS - 1000);
        expect(pill()).toBeNull();
        advance(1500);
        expect(text()).toContain('…echo… echo…');
    });

    it('walks its lines, then goes quiet', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        for (let i = 1; i < ALONE_ECHO_POOL.length; i++) {
            advance(ALONE_ECHO_STEP_MS);
            expect(text()).toContain(ALONE_ECHO_POOL[i]);
        }
        advance(ALONE_ECHO_STEP_MS);
        expect(pill()).toBeNull();
    });

    it('someone joining cancels it before it starts, and removes it once showing', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS - 5000);
        render(false);
        advance(ALONE_ECHO_AFTER_MS);
        expect(pill()).toBeNull();

        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).not.toBeNull();
        render(false);
        expect(pill()).toBeNull();
    });

    it('the wait restarts from zero each time you become alone', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS - 1000);
        render(false);
        render(true);
        advance(ALONE_ECHO_AFTER_MS - 1000);
        expect(pill()).toBeNull();
    });

    it('is dismissable with a real, labelled button', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        const btn = pill()!.querySelector('button')!;
        expect(btn.getAttribute('aria-label')).toBe('Dismiss');
        expect(btn.getAttribute('type')).toBe('button');
        act(() => btn.click());
        expect(pill()).toBeNull();
        advance(ALONE_ECHO_STEP_MS * 5);
        expect(pill()).toBeNull();
    });

    it('once per call: a second stretch of solitude in the same call stays quiet', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).not.toBeNull();
        render(false);
        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).toBeNull();
    });

    it('rate-limited across calls: not again inside six hours, fine after', () => {
        render(true, 'call-1');
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).not.toBeNull();
        render(false, 'call-1');
        render(true, 'call-2');
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).toBeNull();

        render(false, 'call-2');
        advance(ALONE_ECHO_COOLDOWN_MS);
        render(true, 'call-3');
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).not.toBeNull();
    });

    it('a stale "off" from the retired switch changes nothing', () => {
        store.set(LEGACY_EGGS_KEY, '0');
        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        expect(pill()).not.toBeNull();
        expect(store.has('cipherline_egg_seen')).toBe(true);
    });

    it('its text is decorative (aria-hidden) so a screen reader is not read "echo"', () => {
        render(true);
        advance(ALONE_ECHO_AFTER_MS + 10);
        const spans = Array.from(pill()!.querySelectorAll('span[aria-hidden="true"]')).map(s => s.textContent);
        expect(spans.some(t => t?.includes('echo'))).toBe(true);
    });
});

describe('aloneEchoLine / wiring', () => {
    it('is null before the start and after the last line', () => {
        expect(aloneEchoLine(-1)).toBeNull();
        expect(aloneEchoLine(0)).toBe('…echo… echo…');
        expect(aloneEchoLine(ALONE_ECHO_POOL.length)).toBeNull();
    });

    it('SidebarConference mounts it with the roster count and the reconnecting state', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(here, '..', 'SidebarConference.tsx'), 'utf8');
        expect(src).toMatch(/import \{ AloneEcho \} from '\.\/call\/AloneEcho'/);
        expect(src).toMatch(/<AloneEcho alone=\{participants\.length === 1 && !isReconnecting\} sessionId=\{sessionId\} \/>/);
    });
});
