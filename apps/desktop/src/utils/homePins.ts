/**
 * Home-screen pins — the shape a user can pin to the home deck, and the
 * identity function used to dedupe / match / key them.
 *
 * Lives outside HomePanel.tsx on purpose: exporting a non-component value from
 * a component module breaks React Fast Refresh (react-refresh/only-export-
 * components), and both Dashboard and HomePanel need these.
 */

export type PinnedHomeItem =
    | { type: 'conversation'; id: string }
    | { type: 'channel'; channelId: string; serverId: string }
    | { type: 'server'; serverId: string };

/** Stable identity for a pin — used for dedupe, React keys, and unpin matching.
 *  Prefer this over per-type field comparisons so adding a variant doesn't need
 *  a new branch at every call site. */
export function pinKey(p: PinnedHomeItem): string {
    return p.type === 'conversation' ? `c:${p.id}`
        : p.type === 'channel' ? `ch:${p.channelId}`
        : `s:${p.serverId}`;
}
