/**
 * Does a quality change on a share taken through the Wayland portal re-open the CAPTURE, or is it the encoder's alone?
 *
 * Re-opening is `applyConstraints` on the live track: Chromium's PipeWire capturer answers it with a new portal session
 * (measured, Electron 43.8.1, sway + GNOME + a real KDE Plasma session: +1 `ScreenCast.Start` per change, up and down).
 * Even where that session is silent (GNOME and KDE restore a LISTED source with no dialog) it is not free: the
 * stream is torn down and negotiated again, and the sharer's capture delivers nothing for about a second on an idle
 * machine (KDE VM, 1280x800: 0.9-1.2 s between the last frame before the call and the first after it, every time,
 * up or down) and for 10-20 s on a loaded one (owner reports 2026-11-05, CachyOS + KDE, 3440x1440 software VP8: every
 * retune followed by `share_fps` src_fps 1 for 10-20 s while the viewer saw 1-2 fps).
 *
 * So since 2026-11-05 a share is captured at the SOURCE's native size, at the frame rate the person chose, and:
 *   - a change of RESOLUTION is the encoder's alone (scaleResolutionDownBy from the user's box,
 *     applyScreenShareSenderParams): a capture that already delivers the native size can always be scaled down, and
 *     capturing at a downscaled size is measured to be slower, not faster (reports 87a453ae / 6a325d4e: a fresh
 *     1080p@90 share captured at 1920x804 delivered 19-44 fps where the native capture delivered 59-75);
 *   - a LOWER frame rate is the encoder's alone too (maxFramerate): the capture keeps its rate, which costs a little
 *     copy work but never a stall;
 *   - only a HIGHER frame rate than the capture was opened at re-opens it - there is no other way to get those
 *     frames - and the caller says "Applying..." while it happens.
 * This is the same on every desktop, whether the portal restores a listed source silently or not. When what the
 * capture was asked for is unknown, never re-open it.
 *
 * Pure: no imports (screenShare.ts and sharePlatformSupport.ts both use it).
 */

/** What a capture was asked for: its frame rate and the box it must fit in. */
export interface CaptureAsk { fps: number; width: number; height: number }

export function portalRetuneTouchesCapture(i: {
    /** Not consulted any more (kept so existing callers compile): the policy is the same on every desktop. */
    restoreListed?: boolean;
    asked: CaptureAsk | null;
    want: CaptureAsk;
}): boolean {
    const { asked, want } = i;
    if (!asked) return false;
    return want.fps > asked.fps || want.width > asked.width || want.height > asked.height;
}
