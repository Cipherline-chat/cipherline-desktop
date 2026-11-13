import type React from 'react';

/**
 * The shapes the profile surfaces draw for integrations (Steam, Spotify,
 * Twitch, GitHub, Xbox, ...). The profile UI (preview popover, full profile,
 * Settings preview) only RENDERS these; where the data comes from lives in
 * hooks/useProfileActivity.ts and hooks/useProfileConnections.ts.
 * Contract and placement: components/profile/INTEGRATION_SLOTS.md.
 */

/** What someone is doing right now. Drawn as the activity row under the status line. */
export type ActivityKind = 'playing' | 'listening' | 'watching' | 'streaming';

export interface ProfileActivity {
    kind: ActivityKind;
    /** Main line: the game, the track, the stream title. Plain text (never HTML). */
    title: string;
    /** Second line: "Artist - Album", "on Steam", ... Plain text. */
    detail?: string | null;
    /**
     * Square art (album cover, game capsule). Must pass `safeImageSrc`
     * (blob:, data:image/*, or an allow-listed https host); anything else is
     * dropped and the source icon is drawn instead.
     */
    art?: string | null;
    /** 'icon' = an app/executable icon (drawn contained, with padding); 'cover' (default) fills the box. */
    artShape?: 'icon' | 'cover' | null;
    /** A plain original drawing for when there is no picture ('block' = a cube, for Minecraft). */
    glyph?: 'block' | null;
    /** Where it comes from: picks the icon and the label. 'game' = a detected local process. */
    source: string;
    /** A live position (listening): epoch ms the item started + its length. Drawn as a thin bar. */
    progress?: { startedAt: number; durationMs: number } | null;
    /** Opened through the validated external-link path when the row is pressed. */
    url?: string | null;
    /**
     * What pressing it does, as the row's accessible name and tooltip
     * ("Open Midnight City on Spotify", "Search YouTube for ..."). Defaults to
     * the activity text + "Opens in your browser".
     */
    linkLabel?: string | null;
    /**
     * Report the picture this row shows - offered only for a friend's
     * end-to-end encrypted Spotify cover (the server cannot see it, so the
     * reporter's device attaches it: utils/integrations/coverReport.ts).
     */
    report?: (() => void) | null;
}

/** A connected account, drawn as a card on the Integrations tab. */
export interface ProfileConnection {
    /** 'steam' | 'spotify' | 'twitch' | 'github' | 'xbox' | 'youtube' | ... */
    platform: string;
    /** The account's display name or handle. Plain text. */
    name: string;
    /** Proven ownership (OpenID / OAuth), not a typed handle. Draws the tick. */
    verified?: boolean;
    /** Opened through the validated external-link path. */
    url?: string | null;
    /** Optional rich content inside the card (a Steam showcase, top tracks...). */
    body?: React.ReactNode;
}
