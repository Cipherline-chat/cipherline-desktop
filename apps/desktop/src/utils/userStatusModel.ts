/**
 * The user-status model shared by useUserStatus, the status dot components
 * and the presence reducer. Deliberately dependency-free (no axios, no
 * storage) so render code and tests can import it on its own.
 */

export type UserStatus = 'online' | 'away' | 'dnd' | 'offline';

export interface FriendStatusEntry {
    status: UserStatus;
    custom_status_text: string | null;
    custom_status_emoji: string | null;
    current_game: string | null;
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
    away:    { label: 'Away',    color: '#FFC94D' },
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
