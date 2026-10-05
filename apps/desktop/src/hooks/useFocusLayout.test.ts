import { describe, it, expect } from 'vitest';
import {
    FOCUS_SPANS_SIDEBAR_MAX_PX,
    FOCUS_SPANS_SIDEBAR_MIN_CHAT_PX,
    FOCUS_SPANS_SIDEBAR_QUERY,
    focusSpansSidebarAt,
} from './useFocusLayout';

describe('focusSpansSidebarAt', () => {
    it('spans the sidebar at and below the breakpoint', () => {
        expect(focusSpansSidebarAt(FOCUS_SPANS_SIDEBAR_MAX_PX)).toBe(true);
        expect(focusSpansSidebarAt(FOCUS_SPANS_SIDEBAR_MAX_PX - 1)).toBe(true);
        expect(focusSpansSidebarAt(900)).toBe(true);
    });

    it('leaves the sidebar alone above the breakpoint', () => {
        expect(focusSpansSidebarAt(FOCUS_SPANS_SIDEBAR_MAX_PX + 1)).toBe(false);
        expect(focusSpansSidebarAt(1440)).toBe(false);
        expect(focusSpansSidebarAt(2560)).toBe(false);
    });

    it('agrees with the matchMedia query it ships alongside', () => {
        // `max-width` is inclusive, so the pure predicate must be too — a
        // mismatch here would show as the CSS and the JS disagreeing by 1px.
        expect(FOCUS_SPANS_SIDEBAR_QUERY).toBe(`(max-width: ${FOCUS_SPANS_SIDEBAR_MAX_PX}px)`);
    });

    it('keeps the breakpoint where the chat column stops being comfortable', () => {
        // Mirrors the derivation in useFocusLayout.ts: at the default pane
        // ratios the chat column is `W - 104 - list - panel`, and the span
        // kicks in as soon as that drops under FOCUS_SPANS_SIDEBAR_MIN_CHAT_PX.
        // Derived from the constant rather than a literal, so moving the knob
        // moves this check with it — but the breakpoint itself is hard-coded,
        // so a mismatched pair still fails here. If the LAYOUT constants (the
        // 104px chrome, the 0.18/0.20 ratios, the 280px panel floor) move, this
        // is the check that should be revisited alongside the comment.
        const chatColumnWidth = (w: number) =>
            w - 104 - Math.max(200, 0.18 * w) - Math.max(280, 0.20 * w);
        expect(chatColumnWidth(FOCUS_SPANS_SIDEBAR_MAX_PX))
            .toBeLessThan(FOCUS_SPANS_SIDEBAR_MIN_CHAT_PX);
        expect(chatColumnWidth(FOCUS_SPANS_SIDEBAR_MAX_PX + 1))
            .toBeGreaterThanOrEqual(FOCUS_SPANS_SIDEBAR_MIN_CHAT_PX);
    });

    it('spans on a maximised 1366px laptop, the common narrow case', () => {
        // The old 1151 breakpoint left exactly this window sitting just above
        // the threshold with a cramped video — the case that prompted the move.
        expect(focusSpansSidebarAt(1366)).toBe(true);
        expect(focusSpansSidebarAt(1280)).toBe(true);
    });
});
