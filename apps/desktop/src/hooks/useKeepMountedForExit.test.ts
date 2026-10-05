// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeepMountedForExit } from './useKeepMountedForExit';

/**
 * Covers the keep-mounted-for-exit state machine ChatPane.tsx uses to let
 * the pinned messages panel play `.pinned-panel-exit` (index.css) instead of
 * popping out the instant it's toggled closed. A no-JSX render harness per
 * this file's `.test.ts` extension (vitest's include only picks up
 * `src/**\/*.test.ts` — a `.tsx` test file is silently never collected).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latestMounted: boolean | null = null;

function Harness({ open, exitMs }: { open: boolean; exitMs: number }) {
    latestMounted = useKeepMountedForExit(open, exitMs);
    return null;
}

const renderHarness = (open: boolean, exitMs = 200) => {
    act(() => {
        root.render(React.createElement(Harness, { open, exitMs }));
    });
};

beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestMounted = null;
});

afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
});

describe('useKeepMountedForExit', () => {
    it('reports mounted immediately when open starts true', () => {
        renderHarness(true);
        expect(latestMounted).toBe(true);
    });

    it('stays mounted right after closing, then unmounts once exitMs fully elapses', () => {
        renderHarness(true);
        renderHarness(false);
        // The whole point: no instant pop — still mounted the moment `open` flips false.
        expect(latestMounted).toBe(true);

        act(() => { vi.advanceTimersByTime(199); });
        expect(latestMounted).toBe(true); // exit animation still has 1ms left to play

        act(() => { vi.advanceTimersByTime(1); });
        expect(latestMounted).toBe(false); // exit window elapsed — now actually gone
    });

    it('a re-open mid-exit cancels the pending unmount — no ghost, no stuck-closed panel', () => {
        renderHarness(true);
        renderHarness(false);
        act(() => { vi.advanceTimersByTime(150); }); // mid-exit, 50ms of the timer still pending
        renderHarness(true); // rapid re-toggle back open
        expect(latestMounted).toBe(true);

        // The stale timer (originally due at the 150ms mark's +50ms) must not
        // fire later and force it back closed out from under the reopen.
        act(() => { vi.advanceTimersByTime(500); });
        expect(latestMounted).toBe(true);
    });

    it('a second close before the first fires does not schedule two competing unmounts', () => {
        renderHarness(true);
        renderHarness(false);
        act(() => { vi.advanceTimersByTime(100); });
        renderHarness(false); // still closed — re-render with the same `open`, common with prop churn
        act(() => { vi.advanceTimersByTime(100); });
        // 200ms total since the FIRST close — if a second timer had stacked
        // on top instead of replacing it, this would still read true.
        expect(latestMounted).toBe(false);
    });

    it('clears its timer on unmount so it never updates state on a gone component', () => {
        renderHarness(true);
        renderHarness(false);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        act(() => { root.unmount(); });
        act(() => { vi.advanceTimersByTime(500); });
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});
