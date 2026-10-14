/**
 * MsgActionBar — the hover/focus action strip of one message row.
 *
 * Placement: anchored to the row's TOP-RIGHT and centred on its top edge — half
 * inside the row, half poking out above it (see the `.msgbar-inline` block in
 * index.css). Because the bar is a descendant of the row, the pointer moving
 * from the message onto the bar (even onto the half that lies over the previous
 * message) never leaves the row: the previous row gets no mouseenter, so its bar
 * does not open and this one stays. For the same reason the bar adds no leave
 * timer of its own — it used to hide the bar 200 ms after the pointer slid from
 * the bar back onto the same message, which is now the ordinary path.
 *
 * The row (ChatPane) owns visibility; this component owns geometry and the
 * accessible grouping. Children are `MsgBarBtn`s.
 */

import React from 'react';

/** Class string for the bar element. `msgbar-inline` carries the placement. */
export const MSG_ACTION_BAR_CLASS = 'msgbar msgbar-inline';

interface MsgActionBarProps {
    children: React.ReactNode;
    /** Pointer reached the bar: cancel the row's pending hide. */
    onPointerEnterBar?: () => void;
}

export const MsgActionBar: React.FC<MsgActionBarProps> = ({ children, onPointerEnterBar }) => (
    <div
        className={MSG_ACTION_BAR_CLASS}
        role="group"
        aria-label="Message actions"
        data-msg-action-bar=""
        // A click on the bar's chrome (gaps/padding) must not reach the row's
        // onClick, which opens the viewer / selects the message.
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={onPointerEnterBar}
    >
        {children}
    </div>
);
