// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { CallProvider, useCallContext } from './CallContext';

// Fullscreen must never persist from one call into the next — rejoining a
// call always starts docked, and ending a call while fullscreen was up gets
// a short exit-fade ghost rather than an instant pop. `endCallFullscreen` is
// the single entry point SidebarConference's unmount cleanup calls to make
// both of those true; these tests exercise it directly against the pure
// context logic, same spirit as fullscreenCallLayout.test.ts.

let latest: ReturnType<typeof useCallContext> | null = null;
// eslint-disable-next-line react-hooks/globals -- test probe: the whole point is to read the hook's value from outside
const Probe: React.FC = () => { latest = useCallContext(); return null; };
let root: Root | null = null;
const mount = () => {
    const el = document.createElement('div');
    root = createRoot(el);
    act(() => { root!.render(React.createElement(CallProvider, null, React.createElement(Probe))); });
};
const ghost = () => document.querySelector('.fullscreen-overlay-exit');

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    latest = null;
    vi.useRealTimers();
    // The portal target falls back to document.body when #call-fullscreen-root
    // isn't present (it isn't, in this unit test) — clean up between tests.
    document.body.innerHTML = '';
});

describe('CallContext — a new call session always starts docked', () => {
    it('starts docked', () => {
        mount();
        expect(latest!.isFullscreen).toBe(false);
    });

    it('ending a call that was fullscreen docks it immediately — no stale true observable', () => {
        mount();
        act(() => { latest!.setIsFullscreen(true); });
        expect(latest!.isFullscreen).toBe(true);
        act(() => { latest!.endCallFullscreen(); });
        // Synchronous: whatever mounts next (e.g. a rejoined call's
        // FullscreenOverlay) reading isFullscreen on its very first render
        // must see false, not a value that only catches up a tick later.
        expect(latest!.isFullscreen).toBe(false);
    });

    it('ending a call that was already docked leaves it docked (unconditional reset, not a toggle)', () => {
        mount();
        expect(latest!.isFullscreen).toBe(false);
        act(() => { latest!.endCallFullscreen(); });
        expect(latest!.isFullscreen).toBe(false);
    });

    it('a normal in-call fullscreen toggle (not a call ending) is unaffected', () => {
        mount();
        act(() => { latest!.setIsFullscreen(true); });
        expect(latest!.isFullscreen).toBe(true);
        act(() => { latest!.setIsFullscreen(false); });
        expect(latest!.isFullscreen).toBe(false);
    });
});

describe('CallContext — fullscreen exit-fade ghost', () => {
    it('arms the ghost only when the call that ended was actually fullscreen', () => {
        mount();
        act(() => { latest!.endCallFullscreen(); }); // was docked
        expect(ghost()).toBeNull();

        act(() => { latest!.setIsFullscreen(true); });
        act(() => { latest!.endCallFullscreen(); }); // was fullscreen
        expect(ghost()).not.toBeNull();
    });

    it('the ghost clears itself on its own after the fade window — never gets stuck', () => {
        vi.useFakeTimers();
        mount();
        act(() => { latest!.setIsFullscreen(true); });
        act(() => { latest!.endCallFullscreen(); });
        expect(ghost()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(500); });
        expect(ghost()).toBeNull();
    });

    it('a new call going fullscreen mid-fade cancels the ghost outright — no bleed into the new cinema view', () => {
        vi.useFakeTimers();
        mount();
        act(() => { latest!.setIsFullscreen(true); });
        act(() => { latest!.endCallFullscreen(); });
        expect(ghost()).not.toBeNull();

        // A new call starts and immediately goes fullscreen, well inside the
        // still-pending fade window.
        act(() => { vi.advanceTimersByTime(50); });
        act(() => { latest!.setIsFullscreen(true); });
        expect(ghost()).toBeNull();
        expect(latest!.isFullscreen).toBe(true);

        // The old timer must not fire later and disturb anything (nothing to
        // disturb, but it must not throw or resurrect the ghost either).
        act(() => { vi.advanceTimersByTime(500); });
        expect(ghost()).toBeNull();
        expect(latest!.isFullscreen).toBe(true);
    });

    it('ending a second call while fullscreen re-arms cleanly instead of stacking timers', () => {
        vi.useFakeTimers();
        mount();
        act(() => { latest!.setIsFullscreen(true); });
        act(() => { latest!.endCallFullscreen(); });
        act(() => { vi.advanceTimersByTime(50); });

        // A second call starts, goes fullscreen, and also ends fullscreen —
        // all before the first ghost's timer would have fired.
        act(() => { latest!.setIsFullscreen(true); });
        act(() => { latest!.endCallFullscreen(); });
        expect(ghost()).not.toBeNull();

        // Only the fade window from the SECOND end should govern — advancing
        // just past the first timer's original deadline must not clear it
        // early.
        act(() => { vi.advanceTimersByTime(200); });
        expect(ghost()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(300); });
        expect(ghost()).toBeNull();
    });
});
