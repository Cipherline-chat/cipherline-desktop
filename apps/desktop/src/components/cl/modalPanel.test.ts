/**
 * Guards for the "panel" modal shape (`.mcard--panel`): fixed header, scrolling
 * body, footer that is always on screen. Source scans, for the same reason as
 * modalScroll.test.ts (no component-test setup that can lay a modal out).
 *
 * The bug: the Calls-channel settings dialog's body was
 * `flex-1 min-h-0` with a child `h-full overflow-y-auto`. The card is only
 * height-CAPPED (max-height), never given a height, so `h-full` resolved to auto,
 * the "scroller" grew to its content and never scrolled, and the card's
 * `overflow: hidden` clipped it. On a short window the footer (Delete / Cancel /
 * Save) was painted over by the body and CALL NAMES was cut off with no way to
 * reach it. Measured in headless Chromium at 1280x600: body bottom 842px against
 * a footer top of 516px. Layout itself is proven by harness/channel-modal-scroll-shots.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, ...p), 'utf8');

/** Dialogs that share the panel shape. */
const PANELS: [name: string, path: string[]][] = [
    ['ChannelSettingsDialog', ['..', 'server', 'ChannelSettingsDialog.tsx']],
    ['CategoryFormDialog', ['..', 'server', 'CategoryFormDialog.tsx']],
];

describe('.mcard--panel', () => {
    const css = read('..', '..', 'styles', 'cl-kit-ext.css');
    const rule = css.match(/\.mcard--panel\s*\{([^}]*)\}/)?.[1] ?? '';

    it('is a real rule in the stylesheet both apps load', () => {
        expect(rule).not.toBe('');
    });

    it('is a height-capped flex column that clips to its rounded corners', () => {
        expect(rule).toMatch(/display:\s*flex/);
        expect(rule).toMatch(/flex-direction:\s*column/);
        expect(rule).toMatch(/overflow:\s*hidden/);
    });

    it('caps the height to the viewport, with a vh fallback before the dvh line', () => {
        const caps = [...rule.matchAll(/max-height:\s*([^;]+)/g)].map(m => m[1].trim());
        expect(caps).toEqual(['calc(100vh - 48px)', 'calc(100dvh - 48px)']);
    });
});

describe.each(PANELS)('%s', (_name, path) => {
    const src = read(...path);

    it('opts into the panel card and sets no inline height/overflow that would beat it', () => {
        expect(src).toContain('cardClassName="mcard--panel"');
        // ClModal spreads cardStyle onto the element's style attribute, which outranks the class.
        const cardStyle = src.match(/cardStyle=\{\{([^}]*)\}\}/)?.[1] ?? '';
        expect(cardStyle).not.toMatch(/overflow|maxHeight|height|display/i);
    });

    it('the body scroller takes its height from flex, never from `h-full`', () => {
        const m = src.match(/className="([^"]*)" data-modal-scroll/);
        expect(m, 'scroll body must carry data-modal-scroll').not.toBeNull();
        const cls = m![1].split(/\s+/);
        expect(cls).toEqual(expect.arrayContaining(['flex-1', 'min-h-0', 'overflow-y-auto', 'overscroll-contain', 'custom-scrollbar']));
        expect(cls).not.toContain('h-full');
        // No overflow container anywhere in the file may use the broken combination.
        expect(src).not.toMatch(/className="[^"]*\bh-full\b[^"]*\boverflow-y-auto\b/);
        expect(src).not.toMatch(/className="[^"]*\boverflow-y-auto\b[^"]*\bh-full\b/);
    });

    it('the body is a clipped flex column between a fixed header and a fixed footer', () => {
        expect(src).toMatch(/className="flex-1 min-h-0 relative flex flex-col overflow-hidden"[^>]*data-modal-body/);
        // header and footer rows can never be squeezed by the body
        expect(src).toMatch(/px-5 py-3 border-b border-cl-border\/40 shrink-0/);
        expect(src).toMatch(/px-5 py-3 border-t border-cl-border\/40 shrink-0/);
    });

    it('the Permissions pane is sized off the dynamic viewport with room for header + footer', () => {
        expect(src).toContain('h-[min(520px,calc(100dvh-190px))]');
        expect(src).not.toMatch(/calc\(90vh-140px\)/);
    });
});

describe('AccessPresetPicker role finder', () => {
    it('scrolls its inline list into view, since it lives in the dialog scroll body', () => {
        const src = read('..', 'server', 'channelPerms', 'AccessPresetPicker.tsx');
        expect(src).toMatch(/getElementById\(listId\)\?\.scrollIntoView\?\.\(\{ block: 'nearest' \}\)/);
    });
});

describe('popovers inside the scroll body are portaled, not clipped by it', () => {
    it.each([
        ['ClSelect (Category, "Name new calls")', ['ClSelect.tsx']],
        ['ChannelIconDropdown', ['..', 'server', 'ChannelIconPicker.tsx']],
    ])('%s renders through createPortal', (_n, path) => {
        expect(read(...path)).toContain('createPortal(');
    });
});
