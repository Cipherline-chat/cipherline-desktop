// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { HydrationProvider, useHydration } from './HydrationContext';

// The provider's one behaviour that is not pure: after the core loads first
// settle, wait for the boot burst to drain and bump the generation ONCE, so
// every avatar that failed during the burst gets a pass after it.
let latest: ReturnType<typeof useHydration> | null = null;
// eslint-disable-next-line react-hooks/globals -- test probe: the whole point is to read the hook's value from outside
const Probe: React.FC = () => { latest = useHydration(); return null; };
let root: Root | null = null;
const mount = () => {
    const el = document.createElement('div');
    root = createRoot(el);
    act(() => { root!.render(React.createElement(HydrationProvider, null, React.createElement(Probe))); });
};
afterEach(() => { act(() => { root?.unmount(); }); root = null; latest = null; vi.useRealTimers(); });

describe('HydrationProvider post-boot bump', () => {
    it('bumps the generation once, 2.5s after all core loads settle, and never again', () => {
        vi.useFakeTimers();
        mount();
        expect(latest!.generation).toBe(0);
        act(() => { latest!.markSettled('conversations'); latest!.markSettled('friends'); });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(latest!.generation).toBe(0);           // not ready: servers outstanding
        act(() => { latest!.markSettled('servers'); });
        expect(latest!.ready).toBe(true);
        act(() => { vi.advanceTimersByTime(2_400); });
        expect(latest!.generation).toBe(0);           // still inside the drain window
        act(() => { vi.advanceTimersByTime(200); });
        expect(latest!.generation).toBe(1);           // one pass after the burst
        act(() => { latest!.markSettled('friends'); vi.advanceTimersByTime(60_000); });
        expect(latest!.generation).toBe(1);           // never again on its own
        act(() => { latest!.bumpGeneration(); });
        expect(latest!.generation).toBe(2);           // explicit rehydration still works
    });

    it('a released gate (timeout) counts as ready too', () => {
        vi.useFakeTimers();
        mount();
        act(() => { latest!.releaseGate(); });
        act(() => { vi.advanceTimersByTime(2_500); });
        expect(latest!.generation).toBe(1);
    });

    it('a cache-opened gate does NOT start the retry pass: only the network loads end the burst', () => {
        vi.useFakeTimers();
        mount();
        act(() => {
            latest!.markSettled('conversations', 'cache');
            latest!.markSettled('friends', 'cache');
            latest!.markSettled('servers', 'cache');
        });
        expect(latest!.ready).toBe(true);             // the app opens at once from the cache
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(latest!.generation).toBe(0);           // but no retry pass yet: the burst is still running
        act(() => { latest!.markSettled('conversations'); latest!.markSettled('friends'); latest!.markSettled('servers'); });
        act(() => { vi.advanceTimersByTime(2_500); });
        expect(latest!.generation).toBe(1);           // one pass after the real loads
    });
});
