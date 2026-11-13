import React from 'react';
import { Track } from 'livekit-client';
import { useWindowFocus } from '../../hooks/useWindowFocus';
import { VideoTile } from './VideoTile';
import { getNativeShareLive, isNativeShareLive } from '../../utils/nativeShareLive';
import { NativeSharePreview } from './NativeSharePreview';

// Self-view of your own screenshare — unlike everyone else's screenshare tile,
// which other participants need decoded to actually watch, nothing in the call
// depends on this one being rendered. It exists purely so you can confirm
// what's going out. Swapping in a static placeholder while Cipherline isn't
// the focused app unmounts the VideoTile underneath, which detaches the track
// from its <video> element and stops the local decode/composite work — free
// savings with no effect on what's actually being sent to the room. It is also
// what stops a hall of mirrors when the thing you are sharing can see this.
//
// This is the ONE copy of that rule: the docked strip, the focused banner and
// FullscreenOverlay all draw your own share through here, so "clicking out of
// Cipherline pauses it" cannot hold on one surface and not another. Nothing in
// here touches the publication — attaching and detaching a <video> is local.
//
// The placeholder takes the box the tile would have had: a contain-fit surface
// (focused, grid) is sized by its parent, the sidebar takes its height from a
// 16:9 box. It stays a tile either way, so going to the background never changes
// a layout — in fullscreen it must not, or alt-tabbing would empty the stage and
// close the view.
//
// The desktop annotation overlay is NOT tied to this tile (it used to be).
// This tile is unmounted whenever you focus your own share — the focused
// stage draws a different tile — and whenever its portal target is gone, so
// the overlay vanished exactly while the streamer was looking at the strokes.
// It is held by SidebarConference for the whole share instead.
export const LocalScreenShareTile = (props: React.ComponentProps<typeof VideoTile>) => {
    const appFocused = useWindowFocus();
    // A native (hardware) share publishes a stand-in track: drawing it shows garbage, so the tile draws the helper's own thumbnail of the
    // frames it encodes instead (NativeSharePreview) - the same live self-view Windows gets from its capture track, and paused the same way.
    const isNative = props.source === Track.Source.ScreenShare && isNativeShareLive(getNativeShareLive());
    const fillsParent = !!(props.isFocusedView || props.isGridView);
    if (!appFocused) {
        return (
            <div
                className={`relative overflow-hidden bg-cl-abyss flex items-center justify-center ${
                    fillsParent ? 'w-full h-full' : 'w-full shrink-0 min-h-[80px] aspect-video'
                } ${props.isFilled ? '' : 'rounded-xl ring-inset ring-1 ring-white/5'}`}
            >
                <span className="text-[11px] font-semibold text-cl-text/35 text-center px-4 leading-snug">
                    Preview paused — Cipherline isn&rsquo;t focused
                </span>
            </div>
        );
    }
    if (isNative) return <NativeSharePreview fillsParent={fillsParent} isFilled={props.isFilled} />;
    return <VideoTile {...props} />;
};

/**
 * A video tile for a surface that can show anyone's stream: your own share goes
 * through the pause above, everything else is a plain VideoTile.
 */
export const CallStreamTile = (props: React.ComponentProps<typeof VideoTile>) => {
    const isOwnShare = props.source === Track.Source.ScreenShare && props.p.identity === props.localParticipant?.identity;
    return isOwnShare ? <LocalScreenShareTile {...props} /> : <VideoTile {...props} />;
};
