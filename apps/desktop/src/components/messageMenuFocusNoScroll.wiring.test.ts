// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { focusRowInPlace } from '../utils/menuFocusReturn';

/**
 * "Clicking Save on a message in a chat with formatted text makes the chat
 * jump" (owner, 0.1.2-staging.242). Root cause: the message right-click menu
 * focused its row with a plain `focus()` — on open, and again on the return
 * once the menu closed after Save to server / Pin / Save for me. A plain
 * focus() scrolls the feed until the row is in view, and a formatted message
 * (headings, lists, code blocks) is usually taller than the part of it on
 * screen, so the feed jumped to put the row's top edge at the top of the pane.
 * Measured in the real ChatPane by harness/save-no-jump-check.mjs: 97 / 104 /
 * 151 px per menu action at 1000x720 / 1366x768 / 1920x1080 before the fix
 * (the distance the row's top was above the fold), 0 after.
 *
 * ChatPane has no render harness under vitest, so — like
 * messageRowIdentityWiring / feedScrollWiring — the wiring is pinned by a
 * scan, and the behaviour by a jsdom model of the browser's focus scroll.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

/** Plain focus() calls on a message row: `row?.focus()`, `rowEl.focus()`,
 *  `(e.currentTarget as HTMLElement).focus?.()` — no options, so they scroll. */
export function bareRowFocusCalls(code: string): string[] {
    return code.match(/(?:\brow\b|\browEl\b|\(e\.currentTarget[^)]*\))\??\.focus(?:\?\.)?\(\s*\)/g) ?? [];
}

describe('ChatPane message menus focus their row without scrolling the feed', () => {
    it('positive control: the scan catches the pre-fix calls', () => {
        expect(bareRowFocusCalls('if (shouldReturnFocusToRow(document.activeElement, row)) row?.focus();')).toHaveLength(1);
        expect(bareRowFocusCalls('(e.currentTarget as HTMLElement).focus?.();')).toHaveLength(1);
        expect(bareRowFocusCalls('focusRowInPlace(row); el.focus({ preventScroll: true });')).toHaveLength(0);
    });

    it('no plain focus() on a message row is left in ChatPane', () => {
        expect(bareRowFocusCalls(src)).toEqual([]);
    });

    it('the menu focus return goes through focusRowInPlace', () => {
        expect(src).toMatch(/import \{[^}]*focusRowInPlace[^}]*\} from '\.\.\/utils\/menuFocusReturn'/);
        expect(src).toMatch(/if \(shouldReturnFocusToRow\(document\.activeElement, row\)\) focusRowInPlace\(row\);/);
    });

    it('all three menu openers (message, member event, undelivered) focus the row in place', () => {
        for (const opener of ['const handleContextMenu = ', 'const openMemberEventMenu = ', 'const openUndeliveredMenu = ']) {
            const at = src.indexOf(opener);
            expect(at, opener).toBeGreaterThan(-1);
            const body = src.slice(at, src.indexOf('msgCtxOpenIdRef.current = msg.id', at));
            expect(body, opener).toContain('focusRowInPlace(e.currentTarget);');
        }
    });
});

describe('focusRowInPlace (jsdom model of the browser focus scroll)', () => {
    /** jsdom has no layout, so model what Chromium does: focus() without
     *  preventScroll scrolls the feed until the row's top is in view. */
    const realFocus = HTMLElement.prototype.focus;
    afterEach(() => { HTMLElement.prototype.focus = realFocus; document.body.innerHTML = ''; });

    function feedWithStraddlingRow() {
        const feed = document.createElement('div');
        const row = document.createElement('div');
        row.tabIndex = 0;
        feed.appendChild(row);
        document.body.appendChild(feed);
        // The row's top is 120 px above the visible part of the feed.
        const ROW_OFFSET = 880;
        feed.scrollTop = 1000;
        let scrollTop = 1000;
        Object.defineProperty(feed, 'scrollTop', { get: () => scrollTop, set: (v: number) => { scrollTop = v; }, configurable: true });
        HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
            realFocus.call(this, opts);
            if (this === row && !opts?.preventScroll && ROW_OFFSET < scrollTop) scrollTop = ROW_OFFSET;
        };
        return { feed, row };
    }

    it('positive control: a plain focus() on a straddling row scrolls the feed (the bug)', () => {
        const { feed, row } = feedWithStraddlingRow();
        row.focus();
        expect(document.activeElement).toBe(row);
        expect(feed.scrollTop).toBe(880);
    });

    it('focusRowInPlace focuses the row and leaves the scroll position alone', () => {
        const { feed, row } = feedWithStraddlingRow();
        focusRowInPlace(row);
        expect(document.activeElement).toBe(row);
        expect(feed.scrollTop).toBe(1000);
    });

    it('is a no-op without a row', () => {
        expect(() => focusRowInPlace(null)).not.toThrow();
        expect(() => focusRowInPlace(undefined)).not.toThrow();
    });
});
