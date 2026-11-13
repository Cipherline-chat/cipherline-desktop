import React from 'react';
import { Eye } from 'lucide-react';
import { useScreenShareViewerList } from './useScreenShareViewers';
import { useClTooltip } from '../cl/useClTooltip';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { capViewers, viewerAriaLabel, viewerLabel, type ViewerPerson } from '../../utils/screenShareViewers';

export interface ViewerCountBadgeProps {
    /** Identity of the participant PUBLISHING the share, not of the viewer. */
    publisher: string | undefined;
    /** Matches the sizing of the sibling icons in whichever pill hosts it. */
    size?: number;
    /** Render even at zero. Off by default — see below. */
    showZero?: boolean;
    className?: string;
    /**
     * The viewer's own auth token, which `EncryptedAvatar` needs to fetch an
     * avatar. Every tile that hosts the badge already has it. Without it the
     * list is names only.
     */
    token?: string | null;
    /**
     * The host tile's right-click handler. The eye is hit-testable (it has to
     * be, to be hovered), so it no longer lets a right-click fall through to the
     * tile's context-menu surface underneath; the host passes its own handler
     * here to keep that working.
     */
    onContextMenu?: (e: React.MouseEvent | React.PointerEvent) => void;
    /**
     * What a plain click on the eye does, for a host whose click handler is NOT
     * an ancestor of the badge (ScreenShareGate's pill: its "click = Watch"
     * surface is a sibling underneath). On a VideoTile the tile's own onClick is
     * an ancestor, the click simply bubbles, and this is left unset.
     */
    onActivate?: () => void;
}

/** Rows shown in the hover list; the rest fold into "+N more" (utils/screenShareViewers.ts). */
const ROW_AVATAR_PX = 16;

const ViewerRow = ({ person, token }: { person: ViewerPerson; token: string | null | undefined }) => (
    <div className="flex items-center gap-1.5 min-w-0" data-testid="viewer-row">
        {token !== undefined && (
            <span className="shrink-0 rounded-full overflow-hidden" style={{ width: ROW_AVATAR_PX, height: ROW_AVATAR_PX }}>
                <EncryptedAvatar
                    attachmentId={person.avatar}
                    userId={person.identity}
                    token={token}
                    className="w-full h-full object-cover"
                    fallbackSize={9}
                    disableClickProfile
                    bypassFriendGate
                />
            </span>
        )}
        <span className="truncate min-w-0">{viewerLabel(person)}</span>
    </div>
);

/**
 * ViewerCountBadge — "N" beside an eye, for a screenshare's watcher count.
 * Hovering or keyboard-focusing it lists who is watching.
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
 * The names come through the kit's portal tooltip (`useClTooltip`), not a
 * `title`: the widest place this renders is a ~100px strip thumbnail inside a
 * tile that clips its overflow, and a native title could not hold a list, or
 * avoid stacking with a second tooltip. It is always the same people the count
 * counts (`describeViewers` folds the same roster), capped at
 * `VIEWER_LIST_CAP` names then "+N more", live while open.
 *
 * Who may see it: every client in the call, on every tile where the count
 * shows. The roster, each `participant.name` and the `watching_shares`
 * metadata the count is derived from are already in every participant's own
 * LiveKit view of the room (see utils/screenShareViewers.ts), and tiles print
 * these same names. Nothing new is sent or stored.
 *
 * The TileNamePill that hosts this is `pointer-events-none` so the tile keeps
 * click-to-focus and right-click over its whole area. The eye opts back in
 * (it must, to be hovered), which is why it forwards a right-click
 * (`onContextMenu`) and, where the host's click handler is not an ancestor, a
 * click (`onActivate`). A left click otherwise bubbles to the tile exactly as
 * before.
 */
export const ViewerCountBadge = ({
    publisher,
    size = 11,
    showZero = false,
    className = '',
    token,
    onContextMenu,
    onActivate,
}: ViewerCountBadgeProps) => {
    const people = useScreenShareViewerList(publisher);
    const count = people.length;

    // Built per render of the people list, not per render of the tile: the
    // tooltip re-measures when this node changes, so it must be stable.
    const tipContent = React.useMemo<React.ReactNode>(() => {
        if (people.length === 0) return 'No one is watching yet';
        const { shown, more } = capViewers(people);
        return (
            <div className="flex flex-col gap-1" data-testid="viewer-list">
                {shown.map(p => <ViewerRow key={p.identity} person={p} token={token} />)}
                {more > 0 && <div className="text-white/60" data-testid="viewer-more">{`+${more} more`}</div>}
            </div>
        );
    }, [people, token]);

    const { anchorProps, tooltip } = useClTooltip(tipContent, { wide: people.length > 0 });

    if (count === 0 && !showZero) return null;

    return (
        <>
            <span
                {...anchorProps}
                // white/70 rather than a cl-* token: every surface this lands on
                // is dark (the black/35 name pill, the cl-abyss gate card), and its
                // siblings there are plain white / white-ish. A muted token reads
                // as disabled next to them.
                className={`shrink-0 inline-flex items-center gap-0.5 text-white/70 tabular-nums pointer-events-auto cursor-default rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${className}`}
                role="img"
                tabIndex={0}
                aria-label={viewerAriaLabel(people)}
                data-testid="viewer-count-badge"
                onPointerDown={e => {
                    // Closes the tooltip (the kit's own press behaviour), then a
                    // secondary press also opens the tile's menu, as the surface
                    // this eye sits over would have.
                    anchorProps.onPointerDown();
                    if (e.button === 2) onContextMenu?.(e);
                }}
                onContextMenu={onContextMenu}
                onClick={onActivate ? () => onActivate() : undefined}
            >
                <Eye style={{ width: size, height: size }} className="shrink-0" aria-hidden />
                <span style={{ fontSize: Math.max(9, size - 1) }} className="font-semibold leading-none">{count}</span>
            </span>
            {tooltip}
        </>
    );
};
