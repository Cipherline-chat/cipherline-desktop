// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { useMessagePagination, MESSAGE_PAGE_SIZE } from './useMessagePagination';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rows = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, timestamp: 1_000 + i * 10 }));

function mountPager() {
    let api!: ReturnType<typeof useMessagePagination<typeof rows[number]>>;
    const Probe = () => { api = useMessagePagination(rows, 'conv'); return null; };
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => { root.render(React.createElement(Probe)); });
    return { get: () => api, unmount: () => act(() => root.unmount()) };
}

// Owner, 2026-11-16: jumping to a pinned message far up "doesn't take you to
// the message first try". The target was made the FIRST row of the window, so
// centring it hit the top and the scroll-to-top loader prepended a page under
// the jump.
describe('ensureVisible leaves a page of headroom above the target', () => {
    it('a far target is not the first rendered row', () => {
        const p = mountPager();
        expect(p.get().displayed[0].id).toBe(`m${300 - MESSAGE_PAGE_SIZE}`);
        act(() => { expect(p.get().ensureVisible('m100')).toBe(true); });
        const shown = p.get().displayed.map(r => r.id);
        expect(shown.indexOf('m100')).toBe(MESSAGE_PAGE_SIZE);
        expect(p.get().hasMore).toBe(true);
        p.unmount();
    });
    it('near the start, the window opens at the first message', () => {
        const p = mountPager();
        act(() => { p.get().ensureVisible('m5'); });
        expect(p.get().displayed[0].id).toBe('m0');
        p.unmount();
    });
    it('already visible: the window does not move; unknown id: false', () => {
        const p = mountPager();
        const first = p.get().displayed[0].id;
        act(() => { expect(p.get().ensureVisible('m299')).toBe(true); });
        expect(p.get().displayed[0].id).toBe(first);
        act(() => { expect(p.get().ensureVisible('nope')).toBe(false); });
        p.unmount();
    });
});

describe('ChatPane: a jump holds off scroll-to-top loading and re-centres after landing', () => {
    const src = readFileSync(resolve(__dirname, '../components/ChatPane.tsx'), 'utf8');
    it('the scroll-to-top loader is gated on the jump window', () => {
        expect(src).toContain('if (el && el.scrollTop < 80 && !chatSearch.trim() && Date.now() >= jumpScrollUntilRef.current) {');
        expect(src).toMatch(/const centreMessageRow = useCallback[\s\S]{0,900}?jumpScrollUntilRef\.current = Date\.now\(\) \+ 1500;/);
    });
    it('both jump paths centre through the same function, which re-measures after the smooth scroll', () => {
        expect(src).toContain('const doScroll = (id: string): boolean => centreMessageRow(id);');
        expect(src).toContain('if (centreMessageRow(id)) pendingScrollMsgIdRef.current = null;');
        expect(src).toMatch(/for \(const ms of \[700, 1300\]\)[\s\S]{0,400}?if \(Math\.abs\(off\) > 24\) feed\.scrollTo\(\{ top: Math\.max\(0, feed\.scrollTop \+ off\), behavior: 'auto' \}\);/);
    });
});
