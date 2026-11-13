// @vitest-environment jsdom
/**
 * First friend, ever: the celebration (FirstFriendCelebration) and the trigger it hangs off
 * (Dashboard, unchanged rules: once per account, the egg find and the sound before the
 * reduced-motion gate). Owner 2026-11-12: a proper celebration on the shared dim, with words.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { FirstFriendCelebration, FIRST_FRIEND_MS, FIRST_FRIEND_HEADLINE, FIRST_FRIEND_LINE, BURST } = await import('./FirstFriendCelebration');
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

let root: Root;
let host: HTMLDivElement;
let done: ReturnType<typeof vi.fn<() => void>>;
const layer = () => document.querySelector<HTMLElement>('[data-testid="first-friend"]');
const mount = () => {
    function Harness() {
        const [on, setOn] = React.useState(true);
        const end = React.useCallback(() => { done(); setOn(false); }, []);
        return on ? React.createElement(FirstFriendCelebration, { onDone: end }) : null;
    }
    act(() => root.render(React.createElement(Harness)));
};
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    done = vi.fn<() => void>();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('FirstFriendCelebration', () => {
    it('dims the app, says what happened, and is gone after ~3.8 s', () => {
        mount();
        const l = layer()!;
        expect(l.getAttribute('aria-hidden')).toBe('true');
        expect(l.firstElementChild?.getAttribute('data-testid')).toBe('egg-scrim');
        expect([...l.querySelectorAll('[data-read]')].map(e => e.textContent)).toEqual([FIRST_FRIEND_HEADLINE, FIRST_FRIEND_LINE]);
        expect(l.querySelector('svg')).not.toBeNull(); // Keys
        expect(FIRST_FRIEND_MS).toBeGreaterThanOrEqual(3000);
        expect(FIRST_FRIEND_MS).toBeLessThanOrEqual(4500);
        act(() => { vi.advanceTimersByTime(FIRST_FRIEND_MS - 10); });
        expect(layer()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(20); });
        expect(layer()).toBeNull();
        expect(done).toHaveBeenCalledTimes(1);
    });

    it('a fuller burst than the old 22 squares, in the ocean palette (no rainbow reds or pinks)', () => {
        mount();
        expect(layer()!.querySelectorAll('.ff-p').length).toBe(BURST.length);
        expect(BURST.length).toBeGreaterThanOrEqual(40);
        // Every colour leans aqua/blue (more green or blue than red); the one warm accent is the brand glow, used sparingly.
        const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
        const warm = BURST.filter(p => { const [r, g, b] = rgb(p.color); return r >= g && r >= b; });
        expect(new Set(warm.map(p => p.color.toUpperCase()))).toEqual(new Set(['#FFC94D']));
        expect(warm.length).toBeLessThanOrEqual(BURST.length / 6);
    });

    it('never traps anyone: Escape (through the escape stack) or a click ends it early', () => {
        mount();
        const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => { document.body.dispatchEvent(esc); });
        expect(layer()).toBeNull();
        expect(esc.defaultPrevented).toBe(true);
        mount();
        act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(layer()).toBeNull();
    });

    it('typing is left alone (it is passive: it never takes focus or a keystroke)', () => {
        mount();
        const e = new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true });
        act(() => { document.body.dispatchEvent(e); });
        expect(layer()).not.toBeNull();
        expect(e.defaultPrevented).toBe(false);
    });
});

describe('Dashboard trigger (rules unchanged)', () => {
    const dash = readFileSync(join(SRC, 'components/Dashboard.tsx'), 'utf8');
    const effect = dash.slice(dash.indexOf('// ── First friend, ever'), dash.indexOf('const endFirstFriendCelebration'));
    it('once per account, the egg find and the sound, then the reduced-motion gate, then the visual', () => {
        expect(effect).toMatch(/cipherline_first_friend_\$\{userId\}/);
        const order = ["recordEggFound('first-friend')", "playSound('celebration'", 'prefers-reduced-motion', 'setFirstFriendCelebration(true)'].map(t => effect.indexOf(t));
        expect(order.every(i => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
    it('renders the real component (the harness imports it too: no copy to drift)', () => {
        expect(dash).toMatch(/<FirstFriendCelebration onDone=\{endFirstFriendCelebration\} \/>/);
        expect(dash).not.toMatch(/FirstFriendConfetti/);
    });
});
