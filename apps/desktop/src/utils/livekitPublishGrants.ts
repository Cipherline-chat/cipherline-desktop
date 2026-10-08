/**
 * What a LiveKit access token lets this participant PUBLISH, read from the
 * token itself.
 *
 * Why the client needs to know: <LiveKitRoom audio={true}> publishes the mic the
 * moment the room connects, and when the token carries no microphone grant
 * (a voice channel where the member has CONNECT but not SPEAK, a server-mute
 * timeout, ...) LiveKit rejects that publish — which components-react hands to
 * onError, and CallPane treats onError as "the call failed". So a listen-only
 * member could not join at all. Reading the grant lets the room connect with
 * the mic simply left off: joined, listening, muted.
 *
 * This is a UX decision only. The SFU enforces the grant regardless; the token
 * is not verified here (the client holds no secret and the server is the
 * authority). A token we cannot read changes nothing: both default to allowed,
 * i.e. exactly the old behaviour.
 */

export interface PublishGrants {
    microphone: boolean;
    camera: boolean;
}

const ALLOW_ALL: PublishGrants = { microphone: true, camera: true };

function payload(token: string): Record<string, unknown> | null {
    const part = token.split('.')[1];
    if (!part) return null;
    try {
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const json = typeof atob === 'function'
            ? decodeURIComponent(Array.from(atob(b64), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
            : Buffer.from(b64, 'base64').toString('utf8');
        const parsed: unknown = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function publishGrants(token: string | null | undefined): PublishGrants {
    if (!token) return ALLOW_ALL;
    const video = payload(token)?.video;
    if (!video || typeof video !== 'object') return ALLOW_ALL;
    const v = video as { canPublish?: unknown; canPublishSources?: unknown };
    // LiveKit: canPublish defaults to true; false means nothing at all.
    if (v.canPublish === false) return { microphone: false, camera: false };
    // canPublishSources is an allow-list when present and non-empty.
    if (Array.isArray(v.canPublishSources) && v.canPublishSources.length > 0) {
        const names = v.canPublishSources.map(s => String(s).toLowerCase());
        return { microphone: names.includes('microphone'), camera: names.includes('camera') };
    }
    return ALLOW_ALL;
}

/** LiveKit's TrackSource enum value for the microphone (protocol). */
const PROTO_SOURCE_MICROPHONE = 2;

/**
 * The same question, asked of the LIVE connection rather than the token: may the
 * local participant publish a microphone right now? `permissions` is what the
 * SFU says (and updates mid-call, e.g. when a member's SPEAK is revoked). Unknown
 * → true, so nothing changes where the SFU hasn't told us anything.
 *
 * Used to stop the mic-restoring effects (undeafen, push-to-talk, server-mute
 * lift) from trying to publish for a listen-only member: those fire on mount for
 * everybody, and for someone who joined without the mic they would otherwise try
 * to turn it on and be rejected.
 */
export function canPublishMicrophone(
    p: { permissions?: { canPublish?: boolean; canPublishSources?: readonly number[] } | undefined } | null | undefined,
): boolean {
    const perms = p?.permissions;
    if (!perms) return true;
    if (perms.canPublish === false) return false;
    if (perms.canPublishSources && perms.canPublishSources.length > 0) {
        return perms.canPublishSources.includes(PROTO_SOURCE_MICROPHONE);
    }
    return true;
}
