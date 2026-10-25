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
    /** Where it comes from: picks the icon and the label. 'game' = a detected local process. */
    source: string;
    /** A live position (listening): epoch ms the item started + its length. Drawn as a thin bar. */
    progress?: { startedAt: number; durationMs: number } | null;
    /** Opened through the validated external-link path when the row is pressed. */
    url?: string | null;
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
