// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShareFallbackNoteFor } from './ShareFallbackNote';
import { shareFallbackNotice } from '../../utils/shareFallbackNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The note on a watched share, with the real store: what it says, and that both
 * buttons are real buttons that do their job without the click also reaching the
 * tile underneath (which would toggle focus / fullscreen).
 */
const SID = 'TR_share';
const insets = { top: 8, right: 8, bottom: 8, left: 8 };

let host: HTMLDivElement;
let root: Root;
const tileClick = vi.fn();
const tileKey = vi.fn();

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    tileClick.mockReset();
    tileKey.mockReset();
    act(() => {
        root.render(React.createElement('div', { onClick: tileClick, onKeyDown: tileKey, 'data-tile': '' },
            React.createElement(ShareFallbackNoteFor, { sid: SID, insets })));
    });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    shareFallbackNotice.reset();
    vi.useRealTimers();
});

const region = () => host.querySelector('[data-share-fallback-note]') as HTMLElement;
const keep = () => host.querySelector('[data-testid="share-fallback-keep"]') as HTMLButtonElement | null;
const dismiss = () => host.querySelector('[data-testid="share-fallback-dismiss"]') as HTMLButtonElement | null;

describe('the fallback note', () => {
    it('is an empty polite live region until the store says the share was dropped', () => {
        expect(region()).not.toBeNull();
        expect(region().getAttribute('aria-live')).toBe('polite');
        expect(region().textContent).toBe('');
        expect(keep()).toBeNull();
    });

    it('says what happened, with the real size, and offers both buttons', () => {
        act(() => shareFallbackNotice.showLighter(SID, 720));
        expect(region().textContent).toContain('Your connection can’t keep up with this stream, so it’s showing a lighter 720p version.');
        expect(keep()?.tagName).toBe('BUTTON');
        expect(keep()?.type).toBe('button');
        expect(keep()?.textContent).toBe('Keep full quality');
        expect(dismiss()?.getAttribute('aria-label')).toBe('Dismiss');
    });

    it('with no known size it never quotes one', () => {
        act(() => shareFallbackNotice.showLighter(SID, null));
        expect(region().textContent).toContain('so it’s showing a lighter version.');
        expect(region().textContent).not.toMatch(/\dp/);
    });

    it('Keep full quality: opts this share out, tells the monitor, hides the note; the tile never sees the click', () => {
        const handler = vi.fn();
        const off = shareFallbackNotice.onKeepFullQuality(handler);
        act(() => shareFallbackNotice.showLighter(SID, 720));
        act(() => keep()!.click());
        off();
        expect(handler).toHaveBeenCalledWith(SID);
        expect(shareFallbackNotice.isOptedOut(SID)).toBe(true);
        expect(keep()).toBeNull();
        expect(tileClick).not.toHaveBeenCalled();
        // Never again for this share.
        act(() => shareFallbackNotice.showLighter(SID, 720));
        expect(keep()).toBeNull();
    });

    it('the consequence is explained on keyboard focus (tooltip) and tied to the button', () => {
        act(() => shareFallbackNotice.showLighter(SID, 720));
        act(() => keep()!.focus());
        const hint = 'Stay on full quality for this stream. It may freeze or stutter.';
        expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(hint);
        const described = document.getElementById(keep()!.getAttribute('aria-describedby') ?? '');
        expect(described?.textContent).toBe(hint);
    });

    it('Dismiss: hides the note, the drop stays (no opt-out); the tile never sees the click', () => {
        act(() => shareFallbackNotice.showLighter(SID, 720));
        act(() => dismiss()!.click());
        expect(keep()).toBeNull();
        expect(shareFallbackNotice.isOptedOut(SID)).toBe(false);
        expect(tileClick).not.toHaveBeenCalled();
    });

    it('Esc is not taken: it reaches the tile (fullscreen exit stays where it is)', () => {
        act(() => shareFallbackNotice.showLighter(SID, 720));
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => { keep()!.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(false);
        expect(tileKey).toHaveBeenCalled();
    });

    it('recovered: "Back to full quality", then gone; not_needed / no_low_layer: gone silently', () => {
        vi.useFakeTimers();
        act(() => shareFallbackNotice.showLighter(SID, 720));
        act(() => shareFallbackNotice.lifted(SID, 'recovered'));
        expect(region().textContent).toBe('Back to full quality');
        act(() => { vi.advanceTimersByTime(3_000); });
        expect(region().textContent).toBe('');
        for (const reason of ['not_needed', 'no_low_layer'] as const) {
            act(() => shareFallbackNotice.showLighter(SID, 720));
            act(() => shareFallbackNotice.lifted(SID, reason));
            expect(region().textContent).toBe('');
        }
    });

    it('sits below the corner row of the picture, between its side insets', () => {
        const el = region();
        expect(el.style.top).toBe('48px');
        expect(el.style.left).toBe('8px');
        expect(el.style.right).toBe('8px');
        expect(el.className).toContain('pointer-events-none');
    });
});
