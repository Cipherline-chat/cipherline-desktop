import { Eye } from 'lucide-react';
import { useScreenShareViewerCount } from './useScreenShareViewers';

export interface ViewerCountBadgeProps {
    /** Identity of the participant PUBLISHING the share, not of the viewer. */
    publisher: string | undefined;
    /** Matches the sizing of the sibling icons in whichever pill hosts it. */
    size?: number;
    /** Render even at zero. Off by default — see below. */
    showZero?: boolean;
    className?: string;
}

/**
 * ViewerCountBadge — "N" beside an eye, for a screenshare's watcher count.
 *
 * Sits inside the tile chrome that already exists (the `TileNamePill` on a
 * VideoTile, the identity line on a ScreenShareGate) rather than claiming a
 * corner of its own: every corner of a call tile is already spoken for by
 * `videoRectChrome`'s table, and a fifth floating overlay would have to pick a
 * side in an argument that file exists to settle.
 *
 * Hidden at zero unless `showZero`. A live "0 watching" on someone else's tile
 * is a small public shaming, and on your own it is a status you can do nothing
 * about; the absence of the badge says the same thing more kindly. The
 * streamer's OWN tile passes `showZero` — there the number is feedback about a
 * thing you deliberately started, and a badge that only appears once someone
 * arrives reads as broken until it does.
 *
 * `title` rather than visible text, because the widest place this renders is a
 * ~100px strip thumbnail.
 */
export const ViewerCountBadge = ({
    publisher,
    size = 11,
    showZero = false,
    className = '',
}: ViewerCountBadgeProps) => {
    const count = useScreenShareViewerCount(publisher);
    if (count === 0 && !showZero) return null;

    return (
        <span
            // white/70 rather than a cl-* token: every surface this lands on
            // is dark (the black/35 name pill, the cl-abyss gate card), and its
            // siblings there are plain white / white-ish. A muted token reads
            // as disabled next to them.
            className={`shrink-0 inline-flex items-center gap-0.5 text-white/70 tabular-nums ${className}`}
            title={count === 1 ? '1 person is watching this share' : `${count} people are watching this share`}
            aria-label={count === 1 ? '1 viewer' : `${count} viewers`}
        >
            <Eye style={{ width: size, height: size }} className="shrink-0" aria-hidden />
            <span style={{ fontSize: Math.max(9, size - 1) }} className="font-semibold leading-none">{count}</span>
        </span>
    );
};
