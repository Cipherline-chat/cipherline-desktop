import { describe, it, expect } from 'vitest';
import { sharerOverlayNote, shouldTellSharer, SHARER_NO_COMPOSITOR_NOTE } from './sharerOverlayNotice';
import type { OverlayStatus } from './desktopAnnotationOverlay';

const off = (reason: string): OverlayStatus => ({ kind: 'off', reason });
const choose: OverlayStatus = {
    kind: 'choose',
    choice: { displays: [{ id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true }, { id: 2, x: 1920, y: 0, width: 1920, height: 1080, primary: false }], candidates: [1, 2] },
};

describe('sharerOverlayNote: what the sharer is told about their own screen', () => {
    it('Linux, X11 with no compositor: tells them', () => {
        expect(sharerOverlayNote(off('no_compositor'), 'linux')).toBe(SHARER_NO_COMPOSITOR_NOTE);
    });

    it('inert on Windows and macOS (and when the platform is unknown)', () => {
        for (const p of ['windows', 'mac', undefined, '']) expect(sharerOverlayNote(off('no_compositor'), p)).toBeNull();
    });

    it('nothing for a working overlay, the open chooser, their own "Not now", or other refusals', () => {
        expect(sharerOverlayNote({ kind: 'idle' }, 'linux')).toBeNull();
        expect(sharerOverlayNote(choose, 'linux')).toBeNull();
        for (const r of ['declined', 'wayland', 'no_layer_shell', 'helper_failed', 'not_whole_screen', 'platform']) {
            expect(sharerOverlayNote(off(r), 'linux')).toBeNull();
        }
    });

    it('says it plainly: viewers see the drawings, your screen does not, and why in one clause', () => {
        const n = SHARER_NO_COMPOSITOR_NOTE;
        expect(n.title).toBe('Drawings won’t show on your screen');
        expect(n.body).toMatch(/People watching your share still see every drawing\./);
        expect(n.body).toMatch(/because no compositor is running\.$/);
        expect(n.reason).toBe('no_compositor');   // an enum: the only thing that reaches the call event log
        // A card body, not an essay.
        expect(n.body.length).toBeLessThan(130);
    });
});

describe('shouldTellSharer: once per share', () => {
    it('first refusal of the share: tell; after that: never again this share', () => {
        expect(shouldTellSharer(off('no_compositor'), 'linux', false)).toBe(SHARER_NO_COMPOSITOR_NOTE);
        expect(shouldTellSharer(off('no_compositor'), 'linux', true)).toBeNull();
    });
    it('not told yet but nothing to tell: null (and the caller does not mark it told)', () => {
        expect(shouldTellSharer({ kind: 'idle' }, 'linux', false)).toBeNull();
    });
});
