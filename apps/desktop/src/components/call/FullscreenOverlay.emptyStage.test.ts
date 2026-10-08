import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * When the last camera/share goes away the cinema view must close itself, via
 * the same setIsFullscreen(false) the Exit button and Escape use (which is what
 * arms the exit fade) — not by some second path, and not instantly (a video
 * that blinks out for a moment must not eject anyone). FullscreenOverlay needs
 * a live LiveKit room to render, so the rule is pinned at the source level.
 */
const src = readFileSync(join(__dirname, 'FullscreenOverlay.tsx'), 'utf8');
const body = src.slice(src.indexOf('const stageEmpty = stage.length === 0;'));

describe('FullscreenOverlay — closes itself on an empty stage', () => {
    it('derives "nothing to show" from the same stage the overlay renders', () => {
        expect(src).toContain('const stageEmpty = stage.length === 0;');
    });

    it('exits through the shared setIsFullscreen(false) (the normal, fading exit), after a grace period', () => {
        const eff = body.slice(0, 400);
        expect(eff).toContain('callCtx.setIsFullscreen(false)');
        expect(eff).toContain('FULLSCREEN_EMPTY_GRACE_MS');
        expect(eff).toMatch(/clearTimeout\(t\)/);
        expect(src).toMatch(/const FULLSCREEN_EMPTY_GRACE_MS = \d{3,4};/);
    });

    it('only arms while fullscreen is actually up and the stage is empty, and sits above the early return', () => {
        expect(body.slice(0, 300)).toContain('if (!isFullscreen || !stageEmpty) return;');
        expect(src.indexOf('const stageEmpty')).toBeLessThan(src.indexOf('if (!isFullscreen) return null;'));
    });
});
