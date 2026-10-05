/**
 * Guards for the context-menu row height fix (`.ctxm-row` in cl-kit-ext.css)
 * and the message-menu height trim that rides on the same rows.
 *
 * Source scans rather than behavioural assertions, for the same reason as
 * modalScroll.test.ts / stripeAppearance.test.ts: the desktop app has no
 * component-test setup to render a real menu in and measure it, so this
 * pins the CSS values a real render was measured against instead.
 *
 * The bug: `.ctxm-row` had `padding:8px 11px` and no explicit `line-height`,
 * so its content-box height came from the browser's default (`normal`) line
 * box for a 13.5px `var(--body)` string — taller than the row's own 16px
 * icon (`.ctxm-row .ci`) — making every row 36.25px instead of the intended
 * 32px (8+8 padding around a 16px-tall line/icon). An explicit
 * `line-height:16px` matches the line box to the icon and closes the gap.
 *
 * Measured in headless Chrome (Playwright chromium-1243) at 1280x900,
 * mounting the real `ContextMenu` primitive through the real stylesheet
 * entry set (index.css + cl-kit.css + cl-kit-fallback.css + cl-kit-ext.css,
 * same order as main.tsx) with the exact item set ChatPane.tsx's
 * handleContextMenu builds for a moderator reviewing someone else's
 * saved-to-server-and-pinned channel text message (status row + quick
 * reactions + Reply + Copy Text + Copy Message ID + View Profile + Pin +
 * Save-to-server (disabled, pinned) + Save-for-me + Report Message + Delete
 * (moderator) — 9 `.ctxm-row`s, 2 `.ctxm-custom` rows, 7 separators):
 *   before (unmodified cl-kit-ext.css):        rows 36.25px, menu 497.75px
 *   after line-height:16px alone:              rows 32px,    menu 459.5px
 *   after + tightened .ctxm-custom/.ctxm-sep
 *     + the status row's own py-0.5:           rows 32px,    menu 433.5px
 * (The real app's own moderator menu was independently measured at 534px —
 * a bigger absolute number than this harness's reconstruction, since the
 * real message can add more groups depending on message state, but the
 * same three levers produced the same *shape* of reduction.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, ...p), 'utf8');

describe('.ctxm-row — 32px rows, not 36px', () => {
    it('has an explicit line-height matching the 16px icon, so 8px padding + 16px content = 32px', () => {
        const css = read('..', '..', 'styles', 'cl-kit-ext.css');
        const rule = css.match(/\.ctxm-row\{[^}]*\}/)?.[0] ?? '';
        expect(rule).toContain('padding:8px 11px');
        expect(rule).toContain('line-height:16px');
    });
});

describe('.ctxm-custom / .ctxm-sep — trimmed padding and margins', () => {
    it('.ctxm-custom keeps the status row and quick-reaction row (both rendered as `custom` content) from dominating the menu height', () => {
        const css = read('..', '..', 'styles', 'cl-kit-ext.css');
        const rule = css.match(/\.ctxm-custom\{[^}]*\}/)?.[0] ?? '';
        // Was `padding:6px 11px 8px` — the horizontal 11px still matches
        // .ctxm-row's own rhythm; only the vertical padding was trimmed.
        expect(rule).toContain('padding:4px 11px 6px');
    });

    it('.ctxm-sep stays a thin 1px line with ~4px margins', () => {
        const css = read('..', '..', 'styles', 'cl-kit-ext.css');
        const rule = css.match(/\.ctxm-sep\{[^}]*\}/)?.[0] ?? '';
        expect(rule).toContain('height:1px');
        // Was `margin:5px 8px`.
        expect(rule).toContain('margin:4px 8px');
    });
});

describe('ChatPane.tsx message-menu status row uses the tightened vertical padding', () => {
    it('all four status-row variants (saved-to-server, deletion countdown, pinned, saved) use py-0.5, not the old py-1', () => {
        const src = read('..', 'ChatPane.tsx');
        const statusRowDivs = src.match(/px-1 py-[0-9.]+ text-\[11px\][^"]*/g) ?? [];
        expect(statusRowDivs.length).toBe(4);
        for (const cls of statusRowDivs) {
            expect(cls).toContain('py-0.5');
            expect(cls).not.toContain('py-1 ');
        }
    });
});
