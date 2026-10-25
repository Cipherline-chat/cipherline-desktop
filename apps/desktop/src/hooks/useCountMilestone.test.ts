// @vitest-environment jsdom
/**
 * Moments 'friends-100' / 'servers-10': asked for only when the count is SEEN
 * crossing the threshold — never on a fresh load that is already past it,
 * never on a load/resync jump, never twice for staying above it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useCountMilestone } = await import('./useCountMilestone');
const { MOMENT_EVENT, crossedMilestone } = await import('../utils/moments');

let root: Root;
const asked: string[] = [];
const onMoment = (e: Event) => asked.push((e as CustomEvent<{ id: string }>).detail.id);
const Probe: React.FC<{ count: number | null }> = ({ count }) => { useCountMilestone(count, 100, 'friends-100'); return null; };
const seq = (counts: Array<number | null>) => { for (const c of counts) act(() => root.render(React.createElement(Probe, { count: c }))); };

beforeEach(() => {
    asked.length = 0;
    window.addEventListener(MOMENT_EVENT, onMoment);
    root = createRoot(document.createElement('div'));
});
afterEach(() => { window.removeEventListener(MOMENT_EVENT, onMoment); act(() => root.unmount()); });

describe('useCountMilestone', () => {
    it('99 → 100 while you watch: asked once', () => { seq([null, 99, 100, 101]); expect(asked).toEqual(['friends-100']); });
    it('98 → 100 (two accepted at once) still counts', () => { seq([98, 100]); expect(asked).toEqual(['friends-100']); });
    it('first observation already past it (an old account, booting): never', () => { seq([null, 140, 141]); expect(asked).toEqual([]); });
    it('a load jump 0 → 140: never', () => { seq([0, 140]); expect(asked).toEqual([]); });
    it('dropping below and coming back still asks (the ledger makes it once-ever)', () => { seq([99, 100, 99, 100]); expect(asked).toEqual(['friends-100', 'friends-100']); });
    it('unknown in the middle does not reset the baseline', () => { seq([99, null, 100]); expect(asked).toEqual(['friends-100']); });
});

describe('crossedMilestone', () => {
    it('boundaries', () => {
        expect(crossedMilestone(9, 10, 10)).toBe(true);
        expect(crossedMilestone(10, 11, 10)).toBe(false);
        expect(crossedMilestone(null, 10, 10)).toBe(false);
        expect(crossedMilestone(7, 10, 10)).toBe(false);
        expect(crossedMilestone(9, null, 10)).toBe(false);
    });
});
