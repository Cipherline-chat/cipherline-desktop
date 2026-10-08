/**
 * "The sharer's desktop overlay is INSIDE their share" — and what viewers do
 * about it.
 *
 * On Windows and macOS the desktop annotation overlay (electron/annotation-
 * overlay.ts) is excluded from capture, so the shared video never contains
 * strokes and every client draws them itself on its tile. Linux has no
 * per-window capture exclusion (X11 and Wayland alike), and the owner chose
 * (2026-10-08) to show the overlay there anyway: the streamer sees the strokes
 * on their real screen, and the share carries them, baked into the video.
 *
 * A viewer that ALSO drew everyone's strokes on its tile would show each one
 * twice: its own crisp copy, then the video's copy a few hundred ms later and
 * slightly behind — a ghost trail. So a sharer whose overlay is captured says
 * so on its LiveKit participant (attribute ANNOT_OVERLAY_CAPTURED_ATTR = '1'),
 * and on that participant's SCREEN-SHARE tile every client draws only the
 * strokes it authored itself:
 *
 *   - other people's strokes: shown once, by the video;
 *   - your own: drawn locally, immediately (the echo that keeps the pen from
 *     feeling laggy), with the video's copy following underneath it. That
 *     one doubled line is the author's alone and fades with the laser.
 *
 * The alternative — keep everyone's local strokes and accept the duplicate —
 * was rejected: a delayed second copy of someone ELSE's stroke reads as a bug
 * to every viewer, on every stroke. The sharer's own self-view tile follows
 * the same rule (its preview is the captured video too).
 *
 * The attribute is set only after the overlay was actually shown with
 * `captured: true`, and cleared when the share's overlay attachment ends. A
 * viewer on an older build ignores it (and sees the duplicate); a sharer on an
 * older build never sets it (and its overlay is not captured anyway, because
 * older builds show none on Linux). Cameras are never affected.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Stroke } from './annotationStore';

/** LiveKit participant attribute key (same `cl.` namespace as hevcNegotiation's `cl.vdec`). */
export const ANNOT_OVERLAY_CAPTURED_ATTR = 'cl.annot_cap';
/** Does this participant's screen share carry their annotation overlay? */
export function isOverlayCaptured(attributes: Readonly<Record<string, string>> | undefined | null): boolean {
    return attributes?.[ANNOT_OVERLAY_CAPTURED_ATTR] === '1';
}

/**
 * Who a tile should draw strokes for: `null` = everyone (the normal case),
 * otherwise only strokes authored by this identity.
 */
export function strokeAuthorFilter(opts: { isScreenShare: boolean; captured: boolean; me: string | null | undefined }): string | null {
    if (!opts.isScreenShare || !opts.captured || !opts.me) return null;
    return opts.me;
}

export function filterStrokesByAuthor(list: readonly Stroke[], onlyBy: string | null | undefined): readonly Stroke[] {
    if (!onlyBy) return list;
    let all = true;
    for (const s of list) if (s.by !== onlyBy) { all = false; break; }
    return all ? list : list.filter(s => s.by === onlyBy);
}

/** The attribute patch the sharer publishes ('' deletes it in LiveKit). */
export function capturedAttributePatch(captured: boolean): Record<string, string> {
    return { [ANNOT_OVERLAY_CAPTURED_ATTR]: captured ? '1' : '' };
}

/** Minimal participant surface (structural: livekit-client's Participant fits). */
export interface AttributeSource {
    attributes: Readonly<Record<string, string>>;
    on(event: 'attributesChanged', cb: () => void): unknown;
    off(event: 'attributesChanged', cb: () => void): unknown;
}

/** Live `isOverlayCaptured(p.attributes)`, re-rendering on attribute changes. */
export function useOverlayCaptured(p: AttributeSource | null | undefined, enabled: boolean): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        if (!enabled || !p) return () => {};
        p.on('attributesChanged', onChange);
        return () => { p.off('attributesChanged', onChange); };
    }, [p, enabled]);
    const read = () => !!(enabled && p && isOverlayCaptured(p.attributes));
    return useSyncExternalStore(subscribe, read, read);
}
