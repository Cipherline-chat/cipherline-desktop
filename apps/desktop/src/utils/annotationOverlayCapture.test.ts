import { describe, it, expect } from 'vitest';
import {
    ANNOT_OVERLAY_CAPTURED_ATTR, isOverlayCaptured, strokeAuthorFilter, filterStrokesByAuthor, capturedAttributePatch,
} from './annotationOverlayCapture';
import type { Stroke } from './annotationStore';

const s = (id: string, by: string): Stroke => ({ id, by, color: '#25E0C8', width: 4, points: [{ x: 0.1, y: 0.1 }], updatedAt: 1, closedAt: 0 });

describe('Linux sharer: overlay captured into the share — viewers do not double-draw', () => {
    it('the attribute round-trips through the patch the sharer publishes', () => {
        expect(isOverlayCaptured({ ...capturedAttributePatch(true) })).toBe(true);
        expect(isOverlayCaptured({ ...capturedAttributePatch(false) })).toBe(false);   // '' = deleted in LiveKit
        expect(isOverlayCaptured({})).toBe(false);
        expect(isOverlayCaptured(undefined)).toBe(false);
        expect(isOverlayCaptured({ [ANNOT_OVERLAY_CAPTURED_ATTR]: 'true' })).toBe(false);  // exact '1' only
    });

    it('decision table: only a captured SCREEN SHARE filters, and then to my own strokes', () => {
        expect(strokeAuthorFilter({ isScreenShare: true, captured: true, me: 'me' })).toBe('me');
        expect(strokeAuthorFilter({ isScreenShare: true, captured: false, me: 'me' })).toBeNull();
        expect(strokeAuthorFilter({ isScreenShare: false, captured: true, me: 'me' })).toBeNull();   // cameras never
        expect(strokeAuthorFilter({ isScreenShare: true, captured: true, me: '' })).toBeNull();     // identity not known yet: show all
    });

    it('the viewer keeps its own strokes (instant local echo) and drops everyone else\'s (the video shows them)', () => {
        const list = [s('a', 'alice'), s('b', 'me'), s('c', 'bob'), s('d', 'me')];
        expect(filterStrokesByAuthor(list, 'me').map(x => x.id)).toEqual(['b', 'd']);
        expect(filterStrokesByAuthor(list, null)).toBe(list);
        const mine = [s('b', 'me')];
        expect(filterStrokesByAuthor(mine, 'me')).toBe(mine);   // no copy when nothing is filtered
    });
});
