import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutScreenChoice } from './screenChoiceLayout';
import {
    overlayDesktopState, overlayStateAttributePatch, overlayStateNote, ANNOT_OVERLAY_STATE_ATTR,
} from './annotationOverlayCapture';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

const CHOICE = {
    displays: [
        { id: 7, x: 3440, y: 0, width: 3440, height: 1440, primary: false },
        { id: 5, x: 0, y: 0, width: 3440, height: 1440, primary: true },
        { id: 9, x: 6880, y: 0, width: 1080, height: 1920, primary: false },
    ],
    candidates: [5, 7],
};

describe('layoutScreenChoice (the chooser draws the real desk)', () => {
    const tiles = layoutScreenChoice(CHOICE, 440, 200);
    const byId = (id: number) => tiles.find(t => t.id === id)!;

    it('numbers monitors the way a person would: left to right, whatever order the OS listed them', () => {
        expect([5, 7, 9].map(id => byId(id).number)).toEqual([1, 2, 3]);
    });

    it('keeps relative positions and sizes (the two landscapes are equal, the portrait is taller than wide)', () => {
        expect(byId(5).width).toBeCloseTo(byId(7).width, 5);
        expect(byId(7).left).toBeGreaterThan(byId(5).left + byId(5).width);
        expect(byId(9).height).toBeGreaterThan(byId(9).width);
        expect(byId(9).height).toBeGreaterThan(byId(5).height);
    });

    it('fits inside the box, centred', () => {
        for (const t of tiles) {
            expect(t.left).toBeGreaterThanOrEqual(0);
            expect(t.top).toBeGreaterThanOrEqual(0);
            expect(t.left + t.width).toBeLessThanOrEqual(440 + 0.001);
            expect(t.top + t.height).toBeLessThanOrEqual(200 + 0.001);
        }
    });

    it('only the candidates are selectable; the portrait one is shown but disabled', () => {
        expect(tiles.filter(t => t.selectable).map(t => t.id).sort()).toEqual([5, 7]);
        expect(byId(9).selectable).toBe(false);
        expect(byId(5).primary).toBe(true);
    });

    it('degenerate input yields nothing rather than NaN', () => {
        expect(layoutScreenChoice({ displays: [], candidates: [] }, 440, 200)).toEqual([]);
        expect(layoutScreenChoice(CHOICE, 0, 200)).toEqual([]);
    });
});

describe('the viewer is told when the sharer\'s desktop cannot show drawings', () => {
    it('attribute round-trips; unknown values are ignored (exact match only)', () => {
        expect(overlayDesktopState(overlayStateAttributePatch('choose'))).toBe('choose');
        expect(overlayDesktopState(overlayStateAttributePatch('off'))).toBe('off');
        expect(overlayDesktopState(overlayStateAttributePatch('idle'))).toBeNull();       // '' = deleted in LiveKit
        expect(overlayDesktopState({ [ANNOT_OVERLAY_STATE_ATTR]: '<b>x</b>' })).toBeNull();
        expect(overlayDesktopState({})).toBeNull();
        expect(overlayDesktopState(undefined)).toBeNull();
    });

    it('the wording says what is wrong and what still works', () => {
        expect(overlayStateNote('choose', 'Dawson').long).toMatch(/Dawson has not said which screen/);
        expect(overlayStateNote('off', 'Dawson').long).toMatch(/cannot show your drawing/);
        expect(overlayStateNote('off', '  ').long).toMatch(/^The sharer/);
    });
});

describe('wiring', () => {
    it('SidebarConference mounts the chooser and publishes the state from the same status', () => {
        const s = read('../components/SidebarConference.tsx');
        expect(s).toMatch(/<ScreenChoiceDialog[\s\S]*?answerScreenChoice\(null\)/);
        expect(s).toMatch(/overlayStateAttributePatch\(overlayStatus\.kind\)/);
    });
    it('VideoTile shows the note only to a viewer who may draw', () => {
        const s = read('../components/call/VideoTile.tsx');
        expect(s).toMatch(/annotSurface && !isLocal && annotGranted && overlayDesktopState/);
    });
    it('the transport sends stroke packets through the ~30 Hz gate and flushes it on teardown', () => {
        const s = read('../hooks/useAnnotationTransport.ts');
        expect(s).toContain('new LeadingTrailingGate(OUTBOUND_MIN_INTERVAL_MS');
        expect(s).toMatch(/gate\.flush\(\);\s*disposed = true;/);
    });
});
