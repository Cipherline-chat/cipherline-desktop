/**
 * Shared parser for LiveKit participant.metadata. Every consumer (ParticipantCard,
 * VideoTile, FullscreenOverlay, ServerContextPanel) needs to read the same flags
 * — keeping the shape in one place prevents drift.
 *
 * Two namespaces inside the metadata JSON:
 *   - `deafened`            — set by the client itself for self-deafen
 *   - `server_*`            — set by the API moderator endpoint (call-mute);
 *                             the client treats these as authoritative
 *
 * Server-side writer:  apps/api/src/servers/moderation.service.ts
 */
export interface ParticipantMeta {
    /** User self-deafened — client toggle, sets their audio output to muted. */
    deafened: boolean;
    /** Moderator force-muted this user's mic. Their canPublishSources also has
     *  microphone revoked, so republish attempts will fail at the SFU. */
    serverMutedAudio: boolean;
    /** Moderator disabled this user's camera publish. */
    serverMutedVideo: boolean;
    /** Moderator disabled this user's screen share publish. */
    serverMutedScreenShare: boolean;
    /** Moderator deafened this user — they can't speak (mic blocked) and the
     *  client honors the flag by muting its own audio output. */
    serverDeafened: boolean;
    /** Can THIS participant render annotation strokes drawn on a track they are the SHARER
     *  of back to themselves? `false` only for mobile — a phone sharing its screen has no
     *  self-view of its own outgoing broadcast to draw onto, so a desktop viewer drawing on
     *  a phone's shared screen previously did nothing the phone user could ever see (mobile
     *  `src/core/calls/participantMetadata.ts` stamps this on every mobile client). Absent
     *  defaults to `true` — desktop, and any older peer that predates this field, can both
     *  render fine, so the gate only ever REMOVES an affordance, never grants one nobody
     *  can back up. Read directly off raw participant.metadata in VideoTile.tsx's
     *  annotSurface gate (see the comment there) rather than through this parser today; kept
     *  here so the shape stays the single source of truth this file's own header promises. */
    canRenderAnnotations: boolean;
}

const EMPTY: ParticipantMeta = {
    deafened: false,
    serverMutedAudio: false,
    serverMutedVideo: false,
    serverMutedScreenShare: false,
    serverDeafened: false,
    canRenderAnnotations: true,
};

export function parseParticipantMetadata(raw: string | undefined | null): ParticipantMeta {
    if (!raw) return EMPTY;
    try {
        const obj = JSON.parse(raw);
        if (typeof obj !== 'object' || obj === null) return EMPTY;
        return {
            deafened:               obj.deafened === true,
            serverMutedAudio:       obj.server_muted_audio === true,
            serverMutedVideo:       obj.server_muted_video === true,
            serverMutedScreenShare: obj.server_muted_screenshare === true,
            serverDeafened:         obj.server_deafened === true,
            canRenderAnnotations:   obj.can_render_annotations !== false,
        };
    } catch {
        return EMPTY;
    }
}

/** True if ANY server-side moderation is currently applied — drives the red
 *  "moderated" badge on the participant tile / row. */
export function hasServerModeration(m: ParticipantMeta): boolean {
    return m.serverMutedAudio || m.serverMutedVideo
        || m.serverMutedScreenShare || m.serverDeafened;
}
