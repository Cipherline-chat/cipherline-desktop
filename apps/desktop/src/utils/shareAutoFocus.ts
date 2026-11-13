/**
 * Watching an ultra-wide share should open it on the stage.
 *
 * A Surround / Eyefinity display is one 5.33:1 picture (7680x1440 -> 3840x720). In the call
 * panel's thumbnail column it is ~250 px wide, i.e. a 47 px-tall sliver, and the viewer in
 * report f38097d5 watched the whole session like that on the lowest layer (tile 47, 1920x360):
 * the layer choice was right for what was drawn, the drawing was the problem. Focusing it gives
 * it the full stage width and (remoteVideoQuality.pickShareLayer) the full layer.
 *
 * Only on the Watch click, only for a wide share, and only when nothing else is focused - a
 * viewer who already picked something to look at, or who un-focuses it afterwards, is never
 * overridden (nothing here re-fires on its own).
 *
 * Pure so the rule is unit-tested; SidebarConference applies it.
 */
import { isUltrawide } from './shareLayout';

export function shouldAutoFocusWatchedShare(i: {
    /** The share's width / height as published (RemoteTrackPublication.dimensions); unknown -> no. */
    width: number | undefined;
    height: number | undefined;
    /** Something is already focused (the viewer's own choice wins). */
    hasFocus: boolean;
}): boolean {
    if (i.hasFocus) return false;
    const { width, height } = i;
    if (!(typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0)) return false;
    return isUltrawide(width / height);
}
