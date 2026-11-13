/**
 * "Drawings won't show on your screen" — what the SHARER is told when their own
 * desktop cannot show the annotation overlay, while viewers' drawings still work.
 *
 * Viewers were already told (annotationOverlayCapture.overlayStateNote, from the
 * sharer's `cl.annot_ovl` attribute); the sharer was told nothing. On an X11
 * session with no compositing manager the desktop overlay is refused (or taken
 * down mid-share) with reason 'no_compositor' — main asks the X server whether
 * anyone owns `_NET_WM_CM_S<screen>` (electron/annotation-overlay-x11.ts) — so a
 * viewer's strokes appeared on every tile except, silently, the sharer's screen.
 *
 * Only for that reason, and only on Linux (the reason cannot occur elsewhere; the
 * platform check keeps it inert on Windows and macOS regardless). Shown once per
 * share by SidebarConference, as a card in the call's notice slot
 * (utils/callNoticeLayer.ts). Annotation itself is never blocked.
 */
import type { OverlayStatus } from './desktopAnnotationOverlay';

export interface SharerOverlayNote {
    /** The refusal it explains (an enum, safe for the call event log). */
    reason: 'no_compositor';
    title: string;
    body: string;
}

export const SHARER_NO_COMPOSITOR_NOTE: Readonly<SharerOverlayNote> = Object.freeze({
    reason: 'no_compositor',
    title: 'Drawings won’t show on your screen',
    body: 'People watching your share still see every drawing. Your screen can’t show them because no compositor is running.',
});

/**
 * The note for this overlay status on this platform, or null when there is
 * nothing to tell the sharer (overlay fine, waiting on the chooser, they declined
 * it themselves, another platform).
 */
export function sharerOverlayNote(status: OverlayStatus, platform: string | undefined): SharerOverlayNote | null {
    if (platform !== 'linux') return null;
    if (status.kind !== 'off' || status.reason !== 'no_compositor') return null;
    return SHARER_NO_COMPOSITOR_NOTE;
}

/**
 * Once per share. `toldThisShare` is reset when the local share ends (a source
 * change mid-share is the same share: no second note).
 */
export function shouldTellSharer(
    status: OverlayStatus,
    platform: string | undefined,
    toldThisShare: boolean,
): SharerOverlayNote | null {
    if (toldThisShare) return null;
    return sharerOverlayNote(status, platform);
}
