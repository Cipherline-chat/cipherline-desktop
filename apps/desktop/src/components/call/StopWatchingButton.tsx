import { X } from 'lucide-react';
import { stopWatchingAriaLabel } from '../../utils/stopWatchingScreenshare';

export interface StopWatchingButtonProps {
    /** The sharer's display name — only used for the accessible label. */
    name: string;
    onStop: () => void;
    /** Matches the sizing of the sibling icons in the pill hosting it. */
    size?: number;
}

/**
 * StopWatchingButton — the small red X beside the sharer's name on a screen
 * share this client is watching. Click = stop watching (unsubscribe, leave the
 * sharer's viewer list, back to the Watch gate); see
 * utils/stopWatchingScreenshare.ts.
 *
 * It lives inside `TileNamePill`, whose wrapper is `pointer-events-none` so the
 * tile underneath keeps click-to-focus over its whole area — hence the explicit
 * `pointer-events-auto` here. Every pointer/click event is stopped from reaching
 * the tile: a click must not ALSO toggle focus/fullscreen, and a press must not
 * start the tile's quality pre-warm.
 */
export const StopWatchingButton = ({ name, onStop, size = 12 }: StopWatchingButtonProps) => (
    <button
        type="button"
        aria-label={stopWatchingAriaLabel(name)}
        title="Stop watching"
        data-testid="stop-watching"
        onClick={e => { e.stopPropagation(); onStop(); }}
        onDoubleClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        className="shrink-0 pointer-events-auto grid place-items-center w-5 h-5 rounded-md bg-cl-flash/20 text-cl-flash hover:bg-cl-flash hover:text-white active:bg-cl-flash-press transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
    >
        <X style={{ width: size, height: size }} strokeWidth={3} aria-hidden />
    </button>
);
