import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * With one video focused and nobody else on camera, the voice-channel video
 * strip (portalled above the right panel's search bar) used to mount anyway —
 * all of its tiles skipped, but its padding, flex gaps, an empty cam-strip div
 * and the 1px overflow sentinel still took ~33px. SidebarConference has no
 * render harness, so the rule is pinned at the source level.
 */
const src = readFileSync(join(__dirname, 'SidebarConference.tsx'), 'utf8');

describe('voice-channel video strip mounts only when it has a tile to draw', () => {
    it('derives "has a tile" from the same focus test the tiles use', () => {
        expect(src).toContain('const hasPortalVideoTile = hasLocalShareTile || hasRemoteShareTile || hasCamStripTile;');
        for (const frag of [
            'hasLocalShareTile = !!localScreenShare && !!localParticipant',
            'visibleScreenShareParticipants',
            'sortedVisibleRemoteCamParticipants.some(p => !isFocusedInSidebar(p.identity, Track.Source.Camera))',
        ]) expect(src).toContain(frag);
    });

    it('keeps the wrapper mounted but eases its padding to 0 (an unmount made the panel snap up)', () => {
        expect(src).toMatch(/\{anyVideo && \(\s*<motion\.div\s+key="video-tiles"/);
        expect(src).not.toMatch(/anyVideo && hasPortalVideoTile/);
        expect(src).toContain('paddingTop: hasPortalVideoTile ? 8 : 0');
        expect(src).toContain('paddingBottom: hasPortalVideoTile ? 8 : 0');
        expect(src).toContain('duration: hasPortalVideoTile ? 0.18 : SIDEBAR_GLIDE_S');
        // the Tailwind pt-2/pb-2 that the animation replaces must be gone
        expect(src).not.toMatch(/className="flex flex-col gap-2 px-2 pt-2 pb-2"/);
    });

    it('and the camera strip too, so it cannot be an empty gap-making child', () => {
        expect(src).toContain('{hasCamStripTile && (');
        expect(src).not.toContain('{(localCam || sortedVisibleRemoteCamParticipants.length > 0) && (');
    });
});

describe('the tile strips glide instead of snapping when a tile leaves', () => {
    it('tiles exit by collapsing their height on the shared glide curve, in the strip and the inline list', () => {
        expect(src).toContain('const SIDEBAR_GLIDE_S = 0.32;');
        expect(src).toContain('height: { duration: SIDEBAR_GLIDE_S, ease: SIDEBAR_GLIDE_EASE }');
        expect(src).toContain("overflow: 'hidden' as const");
        // the strip, the camera strip and the inline DM tiles all use it
        expect((src.match(/variants=\{(portal|camStrip|inline)TileGlide\}/g) ?? []).length).toBeGreaterThanOrEqual(11);
    });

    it('each column cancels its own gap as the tile collapses (no snap on the last frame)', () => {
        // the gap beside a collapsing tile must ease away with it, sized to the column it sits in
        expect(src).toContain('marginBottom: -gapPx,');
        expect(src).toContain('marginBottom: { duration: SIDEBAR_GLIDE_S, ease: SIDEBAR_GLIDE_EASE }');
        expect(src).toContain('const portalTileGlide = tileGlideVariants(8);');
        expect(src).toContain('const camStripTileGlide = tileGlideVariants(6);');
        expect(src).toContain('const inlineTileGlide = tileGlideVariants(12);');
        // ...and those numbers are the columns' real gaps
        expect(src).toContain('className="flex flex-col gap-2 px-2"');
        expect(src).toMatch(/key="cam-strip"[\s\S]{0,200}variants=\{portalTileGlide\}[\s\S]{0,200}className="flex flex-col gap-1\.5"/);
        expect(src).toContain('<div ref={videoTilesRef} className="flex flex-col gap-3">');
        const camStrip = src.slice(src.indexOf('key="cam-strip"'), src.indexOf('key="cam-strip"') + 4200);
        expect((camStrip.match(/variants=\{camStripTileGlide\}/g) ?? []).length).toBe(2);
        const inline = src.slice(src.indexOf('LayoutGroup id="inline-video-tiles"'));
        expect(inline).not.toMatch(/variants=\{(portal|camStrip)TileGlide\}/);
    });

    it('no strip takes an exiting tile out of the flow at once (popLayout made the panel snap up)', () => {
        const portal = src.slice(src.indexOf('{noRinging && videoRoot && ReactDOM.createPortal('), src.indexOf('Scrollable area: video tiles (non-portal mode)'));
        const inline = src.slice(src.indexOf('Video tiles wrapper — only rendered in normal'), src.indexOf('Overflow sentinel — 1 px invisible div at the bottom of video tiles.'));
        expect(portal).not.toContain('mode="popLayout"');
        expect(inline).not.toContain('mode="popLayout"');
    });

    it('the camera strip\'s own tiles have an exit to animate (a nested tile with none vanished instantly)', () => {
        const strip = src.slice(src.indexOf('key="cam-strip"'));
        expect(strip.slice(0, 4200)).toContain('<AnimatePresence initial={false}>');
        expect(strip.slice(0, 4200)).toContain('key="local-cam-portal" className="w-full"\n                                    variants={camStripTileGlide}');
    });
});
