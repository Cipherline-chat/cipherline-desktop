// @vitest-environment jsdom
/**
 * HuddleButton under START_CALLS — the three states a member can be in for a
 * Calls channel:
 *   can start   → enabled "+", the row spawns a call
 *   join-only   → "+" shown DISABLED with "You don't have permission to start
 *                 calls here", the row never spawns, is not dimmed, and the
 *                 running calls under it (children) stay rendered/joinable
 *   no connect  → the existing lock (no "+" at all)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// jsdom has no matchMedia; a motion helper HuddleButton imports reads it at
// module load. Hoisted so it exists before that import runs.
vi.hoisted(() => {
    if (typeof window !== 'undefined' && !window.matchMedia) {
        (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
            matches: false, media: q, onchange: null,
            addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
        });
    }
});

import { HuddleButton } from './HuddleButton';

let root: Root;
const el = () => document.getElementById('root') as HTMLElement;
const row = () => el().querySelector('[title]') as HTMLElement;
const enabledPlus = () => el().querySelector('[data-testid="huddle-start"]');
const disabledPlus = () => el().querySelector('[data-testid="huddle-start-disabled"]') as HTMLElement | null;

function render(over: Partial<React.ComponentProps<typeof HuddleButton>> = {}) {
    const props: React.ComponentProps<typeof HuddleButton> = {
        name: 'Calls',
        activeParticipantCount: 0,
        activeCallCount: 0,
        canConnect: true,
        isActiveForMe: false,
        expanded: false,
        onToggleExpanded: vi.fn(),
        onSpawn: vi.fn(),
        ...over,
    };
    act(() => { root.render(React.createElement(HuddleButton, props)); });
    return props;
}

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(el());
});
afterEach(() => { act(() => root.unmount()); });

describe('HuddleButton — START_CALLS', () => {
    it('can start: enabled "+", clicking the row spawns', () => {
        const p = render({ canStart: true });
        expect(enabledPlus()).not.toBeNull();
        expect(disabledPlus()).toBeNull();
        expect(row().getAttribute('title')).toBe('Click to start a new call in Calls');
        act(() => { row().click(); });
        expect(p.onSpawn).toHaveBeenCalledTimes(1);
    });

    it('canStart defaults to true (callers that predate it are unchanged)', () => {
        render();
        expect(enabledPlus()).not.toBeNull();
    });

    it('join-only: "+" is disabled with the tooltip, and the row never spawns', () => {
        const p = render({ canStart: false });
        expect(enabledPlus()).toBeNull();
        const plus = disabledPlus()!;
        expect(plus).not.toBeNull();
        expect(plus.getAttribute('aria-disabled')).toBe('true');
        expect(plus.getAttribute('title')).toBe("You don't have permission to start calls here");
        expect(row().getAttribute('title')).toBe("You don't have permission to start calls here");
        expect(row().getAttribute('data-start-blocked')).toBe('true');
        act(() => { row().click(); });
        act(() => { plus.click(); });
        expect(p.onSpawn).not.toHaveBeenCalled();
        // Not dimmed like the no-permission lock — the channel is usable.
        expect(row().className).not.toContain('opacity-50');
        expect(el().textContent).toContain("you can't start one here");
    });

    it("the truncating status line owns the grey colour, so its '…' is grey too (not white)", () => {
        // text-overflow:ellipsis paints the "…" in the colour of the element that
        // truncates. The grey used to sit on an inner span, leaving a white "…".
        for (const over of [{ canStart: false }, { canStart: true }]) {
            render(over);
            const statusText = [...el().querySelectorAll('span')].find(s => /start one here|Click to start/.test(s.textContent ?? ''))!;
            const owner = statusText.closest('.truncate') as HTMLElement;
            expect(owner.className).toContain('text-cl-faint');
        }
        render({ canStart: true, cooldownSecs: 3 });
        const hold = [...el().querySelectorAll('span')].find(s => /Hold on/.test(s.textContent ?? ''))!;
        expect((hold.closest('.truncate') as HTMLElement).className).toContain('text-amber-400');
    });

    it('join-only with a running call: the call list (Join buttons) still renders, and a row click opens it instead of spawning', () => {
        const p = render({
            canStart: false, activeCallCount: 1, activeParticipantCount: 2, expanded: true,
            children: React.createElement('button', { 'data-testid': 'join-running' }, 'Join'),
        });
        expect(el().querySelector('[data-testid="join-running"]')).not.toBeNull();
        expect(disabledPlus()).not.toBeNull();
        act(() => { row().click(); });
        expect(p.onSpawn).not.toHaveBeenCalled();
        // Already expanded → no toggle; collapsed → a click expands it.
        expect(p.onToggleExpanded).not.toHaveBeenCalled();
        const q = render({ canStart: false, activeCallCount: 1, activeParticipantCount: 2, expanded: false });
        act(() => { row().click(); });
        expect(q.onToggleExpanded).toHaveBeenCalledTimes(1);
        expect(q.onSpawn).not.toHaveBeenCalled();
    });

    it('no CONNECT at all: the lock, not the join-only affordance', () => {
        const p = render({ canConnect: false, canStart: false });
        expect(enabledPlus()).toBeNull();
        expect(disabledPlus()).toBeNull();
        expect(row().getAttribute('title')).toBe("You don't have permission to connect");
        act(() => { row().click(); });
        expect(p.onSpawn).not.toHaveBeenCalled();
    });

    it('while you are already in a call here, neither "+" is shown', () => {
        render({ canStart: false, isActiveForMe: true, activeCallCount: 1 });
        expect(enabledPlus()).toBeNull();
        expect(disabledPlus()).toBeNull();
    });
});
