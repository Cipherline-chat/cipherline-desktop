/**
 * The user-status model shared by useUserStatus, the status dot components
 * and the presence reducer. Deliberately dependency-free (no axios, no
 * storage) so render code and tests can import it on its own.
 */

import type { GameDetail } from './richPresence';

export type UserStatus = 'online' | 'away' | 'dnd' | 'offline';

export interface FriendStatusEntry {
    status: UserStatus;
    custom_status_text: string | null;
    custom_status_emoji: string | null;
    /** ISO instant the custom status clears (server-enforced); absent/null = never. */
    custom_status_expires_at?: string | null;
    current_game: string | null;
    /** The game's Rich Presence detail lines (round, score, party, time), when
     *  the player shares them (utils/richPresence.ts). Absent/null = none. */
    current_game_detail?: GameDetail | null;
    /** Visibly present on phones only — render the phone glyph instead of
     *  the dot. Always false while offline. */
    on_mobile?: boolean;
}

// Colors are the hex values of --cl-ok / --cl-glow / --cl-flash / --cl-faint
// (apps/desktop/src/index.css) — kept as raw hex rather than CSS vars because
// consumers use them in inline styles and non-DOM contexts (e.g. tinting the
// game-controller SVG icon), where var() isn't available. HomePanel.tsx keeps
// its own copy of this same mapping for the same reason — if either drifts,
// update both.
export const STATUS_CONFIG: Record<UserStatus, { label: string; color: string }> = {
    online:  { label: 'Online',  color: '#4ADE80' },
    away:    { label: 'Idle',    color: '#FFC94D' },
    dnd:     { label: 'Do Not Disturb', color: '#FF6B5E' },
    offline: { label: 'Offline', color: '#5E6B8F' },
};

/**
 * The status to restore when the app starts: whatever the user last CHOSE,
 * except that an automatic 'away' is not a choice.
 *
 * 'offline' (appear offline) used to be thrown away here as "stale from the
 * previous session" — reasonable while the server itself promoted every
 * reconnect to 'online' regardless, but it meant someone who chose to be
 * invisible became visible just by launching the app. The server now keeps
 * the choice across disconnects, so the client keeps it across restarts too.
 */
export function initialStatusFromSaved(saved: string | null | undefined): UserStatus {
    return saved === 'dnd' || saved === 'offline' ? saved : 'online';
}

/**
 * The fill for a status dot, shaped so presence never relies on colour alone
 * (accessibility plan D12 / V8; the shapes Discord users already know). Shown
 * to everyone, not a setting:
 *
 *   online   filled dot
 *   idle     crescent (the dot with a disc bitten out of its top right)
 *   dnd      dot with a minus bar (Do Not Disturb)
 *   offline  ring (hollow dot)
 *
 * Pure `background` gradients on the same round box (no mask, so the ring
 * `box-shadow` every call site paints around the dot is untouched, and the
 * box keeps its `border-radius: 50%`). Use as the dot's `background`, not
 * `backgroundColor`.
 *
 * The cut-outs are NOT transparent: the crescent's bite and the offline
 * ring's hole show a solid BACKING disc, `--status-backing` (the colour of
 * the surface the avatar sits on: row, rail, card, tile), never the avatar
 * picture behind the dot (Discord-style). Each context that sits on a
 * different surface, or whose row changes colour on hover / selection, sets
 * `--status-backing` on the dot's wrapper (or the row); the same variable
 * colours the ring painted around the dot, so ring and backing always agree.
 */
export type StatusShape = 'dot' | 'crescent' | 'minus' | 'ring';

/** The backing disc under every status shape: a theme token, `--cl-deep` when a context sets nothing. */
export const STATUS_BACKING = 'var(--status-backing, var(--cl-deep))';
export function statusShape(status: UserStatus | string | undefined): StatusShape {
    return status === 'away' ? 'crescent' : status === 'dnd' ? 'minus' : status === 'offline' ? 'ring' : 'dot';
}

/** The DND bar: black on Dark, white on Light (theme token, see themes.ts `dot-hole`). */
const MINUS_BAR = 'var(--cl-dot-hole)';

export function statusDotFill(status: UserStatus | string | undefined, color: string): string {
    switch (statusShape(status)) {
        case 'crescent': return `radial-gradient(ellipse 46% 46% at 72% 28%, transparent 0 94%, ${color} 100%), ${STATUS_BACKING}`;
        case 'minus':    return `linear-gradient(${MINUS_BAR}, ${MINUS_BAR}) 50% 50% / 64% 24% no-repeat, ${color}`;
        case 'ring':     return `radial-gradient(circle closest-side, transparent 0 46%, ${color} 52%), ${STATUS_BACKING}`;
        default:         return color;
    }
}

/**
 * A presence dot's colour as a theme token: the same colours as STATUS_CONFIG
 * in Dark, a darker shade in Light so a dot on a white panel clears 3:1
 * (WCAG 1.4.11). For backgrounds only: STATUS_CONFIG keeps the hex for code
 * that mixes alpha into it or draws SVG attributes.
 */
export function statusDotColor(status: UserStatus | string | undefined): string {
    switch (status) {
        case 'online': return 'var(--cl-ok-dot)';
        case 'away': return 'var(--cl-idle-dot)';
        case 'dnd': return 'var(--cl-dnd-dot)';
        case 'offline': return 'var(--cl-offline-dot)';
        // Anything else (an unknown / future status): the neutral grey these dots always fell back to.
        default: return 'rgb(var(--cl-tw-gray-500))';
    }
}

