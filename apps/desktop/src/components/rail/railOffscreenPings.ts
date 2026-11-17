/**
 * "Unseen ping" arrows for the server rail — the pure half.
 *
 * Owner (2026-11-16): with many servers the rail scrolls, so the DM or server
 * you were just pinged in can be scrolled out of view. A small Flash-coral
 * pill pinned to the top / bottom edge of the rail's server box says "there is
 * a ping up there / down there" and scrolls to it when clicked
 * (rail/RailPingArrows.tsx draws it; this file decides everything it shows).
 *
 * WHAT COUNTS AS A PING
 *   Exactly what the tile itself draws as a red (Flash) count badge —
 *   `BadgeState.tone === 'alert'` from utils/unreadBadges.resolveBadge /
 *   dmGroupRailBadges. Deliberately NOT a second rule:
 *     - a grey "quiet" dot (a server or conversation on @mentions-only with no
 *       mention yet) is not a ping, so it never raises an arrow;
 *     - a muted server shows only its @mentions in red — those count;
 *     - the DM and Group tiles are red for any unread in a conversation left on
 *       "all" (a DM is always a ping) and grey on @mentions-only;
 *     - the ACTIVE server's tile hides its own badge, so it is not a ping;
 *     - a folder tile carries the aggregate of its servers, minus the active
 *       one (rail/serverFolders.aggregateFolderBadge) — that is what is red on
 *       the rail, so the FOLDER tile is the ping. An open folder is a popover
 *       portaled to <body>, outside the rail's scroller, so there is never an
 *       "inner" tile in the scroller to track; the folder tile is always it.
 *   If the badge rule changes, this follows it, because it reads the same
 *   resolved BadgeState the tile renders.
 *
 * VISIBILITY RULE
 *   A pinged tile counts as on screen when at least VISIBLE_FRACTION (half) of
 *   its height is inside the scroller's visible box. Half is the point where
 *   the tile's badge corner and most of its icon are readable; a sliver of a
 *   tile peeking in at the edge is not "seen". A tile that is not visible
 *   enough is ABOVE when its centre is above the box's centre, else BELOW (so a
 *   tile hanging off the top edge is above, never below).
 */
import type { BadgeState } from '../../utils/unreadBadges';
import { aggregateFolderBadge, folderKey, serverKey, type RailItem } from './serverFolders';
import { scrollTopToReveal } from './railScrollReveal';

/** `data-rail-id` of the fixed Direct-messages / Group-chats tiles. Prefixed so
 *  they can never collide with a `srv:` / `fld:` rail key. */
export const RAIL_DM_KEY = 'nav:dm';
export const RAIL_GROUP_KEY = 'nav:group';

/** Fraction of a tile's height that must be inside the visible box for the
 *  tile to count as seen. See VISIBILITY RULE above. */
export const VISIBLE_FRACTION = 0.5;

/** Room kept above / below a revealed tile so it lands clear of the arrow
 *  pill that sits on the edge (pill 4px inset + 18px tall + 6px gap). */
export const PING_REVEAL_MARGIN = 28;

/** The rail's red-badge condition — the same thing RailBadge draws in Flash. */
export function isPingBadge(badge: BadgeState | null | undefined): boolean {
    return !!badge && badge.tone === 'alert' && badge.count > 0;
}

export interface RailPingSource {
    dm: BadgeState | null;
    group: BadgeState | null;
    items: readonly RailItem[];
    /** One server's resolved rail badge (Dashboard's railServerBadge). */
    serverBadge: (serverId: string) => BadgeState | null;
    /** The server whose tile is active (its badge is hidden), or null. */
    activeServerId: string | null;
}

/** `data-rail-id`s of the rail tiles that currently show a red badge, in rail
 *  order (DMs, Groups, then servers / folders top to bottom). */
export function pingedRailKeys(src: RailPingSource): string[] {
    const out: string[] = [];
    if (isPingBadge(src.dm)) out.push(RAIL_DM_KEY);
    if (isPingBadge(src.group)) out.push(RAIL_GROUP_KEY);
    for (const item of src.items) {
        if (item.kind === 'folder') {
            const agg = aggregateFolderBadge(
                item.folder.serverIds.filter(id => id !== src.activeServerId).map(src.serverBadge),
            );
            if (isPingBadge(agg)) out.push(folderKey(item.folder.id));
        } else if (item.id !== src.activeServerId && isPingBadge(src.serverBadge(item.id))) {
            out.push(serverKey(item.id));
        }
    }
    return out;
}

/** One pinged tile's box, relative to the TOP OF THE SCROLLER'S VISIBLE AREA
 *  (so 0 is the top edge you can see and `viewportHeight` the bottom edge;
 *  a tile scrolled out above has a negative top). */
export interface PingTileBox {
    key: string;
    top: number;
    height: number;
}

export interface OffscreenPings {
    above: number;
    below: number;
    /** The off-screen pinged tile closest to the top edge, or null. */
    nearestAbove: string | null;
    /** The off-screen pinged tile closest to the bottom edge, or null. */
    nearestBelow: string | null;
}

export const NO_OFFSCREEN_PINGS: OffscreenPings = Object.freeze({ above: 0, below: 0, nearestAbove: null, nearestBelow: null });

/** How many pinged tiles are out of view above / below, and the nearest one in
 *  each direction. Tiles with no height (not laid out) are ignored. */
export function offscreenPings(
    tiles: readonly PingTileBox[],
    viewportHeight: number,
    threshold = VISIBLE_FRACTION,
): OffscreenPings {
    if (!(viewportHeight > 0)) return NO_OFFSCREEN_PINGS;
    let above = 0;
    let below = 0;
    let nearestAbove: PingTileBox | null = null;
    let nearestBelow: PingTileBox | null = null;
    for (const t of tiles) {
        if (!(t.height > 0)) continue;
        const shown = Math.max(0, Math.min(t.top + t.height, viewportHeight) - Math.max(t.top, 0));
        if (shown / t.height >= threshold) continue;
        if (t.top + t.height / 2 < viewportHeight / 2) {
            above++;
            if (!nearestAbove || t.top > nearestAbove.top) nearestAbove = t;
        } else {
            below++;
            if (!nearestBelow || t.top < nearestBelow.top) nearestBelow = t;
        }
    }
    if (above === 0 && below === 0) return NO_OFFSCREEN_PINGS;
    return { above, below, nearestAbove: nearestAbove?.key ?? null, nearestBelow: nearestBelow?.key ?? null };
}

export function sameOffscreenPings(a: OffscreenPings, b: OffscreenPings): boolean {
    return a.above === b.above && a.below === b.below
        && a.nearestAbove === b.nearestAbove && a.nearestBelow === b.nearestBelow;
}

/** The scrollTop that brings `tile` into view clear of the edge pill. */
export function scrollTopForPing(currentScrollTop: number, tile: PingTileBox, viewportHeight: number): number {
    return scrollTopToReveal(currentScrollTop, 0, viewportHeight, tile.top, tile.height, PING_REVEAL_MARGIN);
}

/** Pill text: the number of off-screen pinged tiles, capped like the badges. */
export function pingArrowCount(n: number): string {
    return n > 9 ? '9+' : String(n);
}

/** Accessible name of an arrow, e.g. "3 unread pings above". */
export function pingArrowLabel(direction: 'up' | 'down', n: number): string {
    return `${n} unread ${n === 1 ? 'ping' : 'pings'} ${direction === 'up' ? 'above' : 'below'}`;
}

/**
 * What the polite live region should say after a re-measure, or null for
 * nothing. Only a NEW ping going off-screen is announced — i.e. the set of
 * pinged tiles changed (`pingsChanged`) and a direction's count went up. The
 * user scrolling a ping out of view themselves is not news, and a count going
 * down (read, or scrolled into view) is silent.
 */
export function pingAnnouncement(prev: OffscreenPings, next: OffscreenPings, pingsChanged: boolean): string | null {
    if (!pingsChanged) return null;
    const parts: string[] = [];
    if (next.above > prev.above) parts.push(pingArrowLabel('up', next.above));
    if (next.below > prev.below) parts.push(pingArrowLabel('down', next.below));
    return parts.length ? `${parts.join(', ')} in the server list` : null;
}
