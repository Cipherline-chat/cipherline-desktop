import React from 'react';
import type { HeldFrame } from '../../utils/shareHoldFrame';

/**
 * What stands in for a screen share while it republishes (utils/shareHold.ts): the
 * last frame, slightly dimmed so it does not read as a live picture, and a small
 * note that it is coming back. Pointer-transparent throughout, so the tile's click
 * and right-click behave exactly as they do on the video.
 */

/** The held frame. Sits where the <video> does and takes the same fit and corner clip. */
export const ShareHoldPicture = ({ frame, clipPath }: { frame: HeldFrame; clipPath?: string }) => {
    const hostRef = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        host.replaceChildren(frame.canvas);
        return () => { host.replaceChildren(); };
    }, [frame]);
    return (
        <div
            ref={hostRef}
            aria-hidden="true"
            data-share-hold-frame=""
            className="absolute inset-0 z-[1] pointer-events-none"
            style={{ clipPath, filter: 'brightness(0.62) saturate(0.85)' }}
        />
    );
};

/**
 * The note. Fades in after a beat (index.css) so the quick republishes, which are
 * over in well under a second, do not flash text at anyone. On a tile too narrow
 * for the words it is just the dot. `belowAvatar`: no frame could be taken, so the
 * tile's centred avatar is showing and the note goes under it.
 */
export const ShareHoldNote = ({ belowAvatar, avatarPx = 0 }: { belowAvatar: boolean; avatarPx?: number }) => (
    <div
        role="status"
        aria-label="Changing stream settings. The stream will be back shortly."
        data-share-hold-note=""
        className="@container absolute inset-0 z-[6] flex items-center justify-center pointer-events-none"
    >
        <div
            className="cl-share-hold-note flex items-center gap-2 bg-black/55 backdrop-blur-sm rounded-lg px-3 py-1.5"
            style={belowAvatar ? { transform: `translateY(${avatarPx / 2 + 26}px)` } : undefined}
        >
            <span className="cl-share-hold-dot w-1.5 h-1.5 rounded-full bg-cl-lume shrink-0" />
            <span className="hidden @[220px]:inline text-white/90 text-xs font-medium whitespace-nowrap">
                Changing stream settings
            </span>
        </div>
    </div>
);
