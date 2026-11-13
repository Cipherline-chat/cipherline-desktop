import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CallEventMonitor and VideoTile need a live room to run, so how the fallback
 * notice is wired between them is pinned at the source level, in the style of
 * shareHold.wiring.test.ts.
 */
const monitor = readFileSync(join(__dirname, 'CallEventMonitor.tsx'), 'utf8');
const tile = readFileSync(join(__dirname, 'VideoTile.tsx'), 'utf8');

const at = (src: string, needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `"${needle}" not found`).toBeGreaterThanOrEqual(0);
    return i;
};

describe('the monitor tells the viewer, and obeys them', () => {
    const tick = monitor.slice(at(monitor, 'const d = r.fb.observe({'), at(monitor, 'r.prev = cur;'));

    it('takes the notice down whenever the cap comes off, with the reason', () => {
        const changed = tick.slice(at(tick, 'if (d.changed) {'));
        expect(changed.slice(0, changed.indexOf('}'))).toContain('if (!d.cap) shareFallbackNotice.lifted(pub.trackSid, d.reason);');
    });

    it('puts it up only once the lighter copy is on screen, once per cap', () => {
        expect(tick).toContain('if (r.fb.lowShowing && !r.noticed) {');
        expect(tick).toContain('r.noticed = true;');
        expect(at(tick, 'shareFallbackNotice.showLighter(pub.trackSid, r.fb.lowShort ??')).toBeGreaterThan(at(tick, 'if (r.fb.lowShowing && !r.noticed) {'));
    });

    it('Keep full quality: turns the fallback off, lifts the cap now, logs by placeholder only', () => {
        const keep = monitor.slice(at(monitor, 'shareFallbackNotice.onKeepFullQuality(sid => {'), at(monitor, '// One per watched remote screen share'));
        expect(keep).toContain('r.fb.optOut()');
        expect(keep).toContain('setQualityCeiling(r.pub, null)');
        expect(keep).toContain("const name = trackPlaceholder(sid, 'remote-screen');");
        expect(keep).toContain("logCallEvent('share_rx_optout', { track: name, capped: !!d?.changed });");
    });

    it('a share watched again keeps the choice; an unwatched one loses its notice; the call end clears it all', () => {
        expect(monitor).toContain('if (fb && shareFallbackNotice.isOptedOut(pub.trackSid)) fb.optOut();');
        const unseen = monitor.slice(at(monitor, 'for (const [sid, r] of [...rx.entries()]) {'));
        expect(unseen.slice(0, unseen.indexOf('rx.delete(sid);'))).toContain('shareFallbackNotice.forget(sid);');
        const cleanup = monitor.slice(at(monitor, 'clearInterval(iv);'));
        expect(cleanup).toContain('offKeep();');
        expect(cleanup).toContain('shareFallbackNotice.reset();');
    });
});

describe('the tile shows it where the viewer is watching', () => {
    it('remote shares in the focused view and the fullscreen stage / grid, never your own, never during a hold', () => {
        const line = tile.slice(at(tile, '<ShareFallbackNoteFor') - 200, at(tile, '<ShareFallbackNoteFor'));
        expect(line).toContain('isScreenShare && !isLocal && (isFocusedView || isGridView) && layerPubRaw?.trackSid && !chromeHidden && !hold.placeholder');
        expect(tile).toContain('<ShareFallbackNoteFor sid={layerPubRaw.trackSid} insets={chrome} />');
    });

    it('rides the same picture insets as the corner chrome', () => {
        expect(at(tile, 'const chrome = videoRectInsets(')).toBeLessThan(at(tile, '<ShareFallbackNoteFor'));
    });
});
