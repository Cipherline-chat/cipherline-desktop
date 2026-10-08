import { useCallback, useSyncExternalStore } from 'react';
import {
    NO_CALL_MEDIA,
    hasAnyCallMedia,
    readCallMediaByUser,
    readCallMediaState,
    type CallMediaByUser,
    type CallMediaState,
} from '@cipherline/shared';
import { labelVoiceUsers } from './serverCallPresence';

/**
 * Out-of-call camera / screen-share presence: "who in that call has their
 * camera on or is sharing their screen", for members who are NOT in the call
 * (server sidebar rosters, the Home "Happening now" tile).
 *
 * Inside a call those icons come straight from LiveKit track state
 * (CallTelemetry.participantTrackStates). Outside it the only source is the
 * server: seeded by the presence seeds (`media` on each call / voice channel
 * in GET /v1/voice-participants and GET /v1/huddles/:hid/calls) and kept live
 * by `call:media_state` WS events. The server has already applied the
 * VIEW_CHANNEL filter to both, so nothing here re-checks permissions — it
 * cannot re-derive what it was never sent.
 *
 * Keyed by "media key": the huddle CALL id for a Calls-channel call, or
 * `voice:<channel_id>` for a legacy voice channel (whose presence the client
 * keys by channel, not by session). Renderers must still only draw icons for
 * users the roster lists as participants — this store can briefly hold a
 * flag for someone whose leave event raced it.
 *
 * Module-level external store (same pattern as callSpeakingStore): each row
 * subscribes to ONE call, so a toggle re-renders that call's rows only.
 */

export const voiceChannelMediaKey = (channelId: string): string => `voice:${channelId}`;
export const huddleCallMediaKey = (callId: string): string => callId;

const media = new Map<string, Map<string, CallMediaState>>();
const listeners = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();
let version = 0;

function notify(key: string): void {
    version++;
    listeners.get(key)?.forEach(l => l());
    anyListeners.forEach(l => l());
}

function sameState(a: CallMediaState | undefined, b: CallMediaState | undefined): boolean {
    return (a?.camera ?? false) === (b?.camera ?? false)
        && (a?.screen_share ?? false) === (b?.screen_share ?? false);
}

/** Set (or clear, when all-off) one participant's flags. */
export function setCallMedia(key: string, userId: string, state: CallMediaState): void {
    const bucket = media.get(key);
    const prev = bucket?.get(userId);
    if (sameState(prev, state)) return;
    if (hasAnyCallMedia(state)) {
        const b = bucket ?? new Map<string, CallMediaState>();
        b.set(userId, { camera: state.camera, screen_share: state.screen_share });
        media.set(key, b);
    } else if (bucket) {
        bucket.delete(userId);
        if (bucket.size === 0) media.delete(key);
    }
    notify(key);
}

/** Apply one `call:media_state` WS event (raw `data`). Malformed → ignored. */
export function applyCallMediaEvent(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const d = raw as Record<string, unknown>;
    if (typeof d.user_id !== 'string' || !d.user_id) return;
    let key: string | null = null;
    if (typeof d.call_id === 'string' && d.call_id) key = huddleCallMediaKey(d.call_id);
    else if (typeof d.channel_id === 'string' && d.channel_id) key = voiceChannelMediaKey(d.channel_id);
    if (!key) return;
    setCallMedia(key, d.user_id, readCallMediaState(d));
}

/** A participant joined or left: either way they start from nothing on
 *  (the server clears its copy on both, too). */
export function clearCallMediaUser(key: string, userId: string): void {
    setCallMedia(key, userId, NO_CALL_MEDIA);
}

/** The call ended / was destroyed. */
export function clearCallMediaKey(key: string): void {
    if (!media.has(key)) return;
    media.delete(key);
    notify(key);
}

/**
 * Apply a seed. `entries` maps media key → the seed's raw `media` value
 * (absent/undefined = nobody has anything on). With `replaceAll`, every key
 * NOT in `entries` is dropped too — use it for the full cross-server seed,
 * which is a complete picture; a partial seed (one Calls channel's list)
 * replaces only the keys it covers.
 */
export function applyCallMediaSeed(entries: Map<string, unknown>, opts: { replaceAll?: boolean } = {}): void {
    const touched = new Set<string>();
    if (opts.replaceAll) {
        for (const key of [...media.keys()]) {
            if (!entries.has(key)) { media.delete(key); touched.add(key); }
        }
    }
    for (const [key, raw] of entries) {
        const next: CallMediaByUser = readCallMediaByUser(raw);
        const prev = media.get(key);
        const nextIds = Object.keys(next);
        const unchanged = (prev?.size ?? 0) === nextIds.length
            && nextIds.every(uid => sameState(prev?.get(uid), next[uid]));
        if (unchanged) continue;
        if (nextIds.length === 0) media.delete(key);
        else media.set(key, new Map(nextIds.map(uid => [uid, next[uid]])));
        touched.add(key);
    }
    touched.forEach(notify);
}

export function getCallMedia(key: string | null | undefined, userId: string): CallMediaState {
    if (!key) return NO_CALL_MEDIA;
    return media.get(key)?.get(userId) ?? NO_CALL_MEDIA;
}

/** Everyone in `participantIds` with something on, for one call. */
export function summarizeCallMedia(key: string, participantIds: readonly string[]): { camera: string[]; screen_share: string[] } {
    const bucket = media.get(key);
    const out = { camera: [] as string[], screen_share: [] as string[] };
    if (!bucket) return out;
    for (const uid of participantIds) {
        const s = bucket.get(uid);
        if (s?.camera) out.camera.push(uid);
        if (s?.screen_share) out.screen_share.push(uid);
    }
    return out;
}

export function subscribeCallMedia(key: string, l: () => void): () => void {
    let set = listeners.get(key);
    if (!set) { set = new Set(); listeners.set(key, set); }
    set.add(l);
    return () => {
        const s = listeners.get(key);
        if (!s) return;
        s.delete(l);
        if (s.size === 0) listeners.delete(key);
    };
}

/** One participant's flags in one call; re-renders only on that call's
 *  changes. `key` null → always "nothing on" (no subscription). Returns the
 *  stored object itself (stable between changes), as useSyncExternalStore
 *  requires. */
export function useCallMedia(key: string | null | undefined, userId: string): CallMediaState {
    const sub = useCallback(
        (l: () => void) => (key ? subscribeCallMedia(key, l) : () => {}),
        [key],
    );
    return useSyncExternalStore(sub, () => getCallMedia(key, userId), () => NO_CALL_MEDIA);
}

/** Store version for consumers that summarise MANY calls (Home tile); bumps
 *  on any change. */
export function useCallMediaVersion(): number {
    const sub = useCallback((l: () => void) => {
        anyListeners.add(l);
        return () => { anyListeners.delete(l); };
    }, []);
    return useSyncExternalStore(sub, () => version, () => 0);
}

/**
 * The one rule both in-call and out-of-call rows go through: a viewer who is
 * in THIS call uses live LiveKit track state (instant, authoritative for what
 * they are actually receiving); anyone else uses the server presence, which
 * is that same LiveKit state as reported by the participant's own client.
 */
export function resolveParticipantMedia(
    inThisCall: boolean,
    live: { hasCamera: boolean; hasScreenShare: boolean } | undefined,
    presence: CallMediaState,
): { hasCamera: boolean; hasScreenShare: boolean } {
    if (inThisCall) return { hasCamera: !!live?.hasCamera, hasScreenShare: !!live?.hasScreenShare };
    return { hasCamera: presence.camera, hasScreenShare: presence.screen_share };
}

/** Seed entries from a list of huddle calls (GET /huddles/:hid/calls, or a
 *  seed's `huddles[].calls`). Every listed call gets an entry — a call with
 *  no `media` is "nobody has anything on", which must CLEAR stale flags. */
export function callMediaEntriesFromCalls(
    calls: ReadonlyArray<{ call_id?: unknown; media?: unknown }> | null | undefined,
    into: Map<string, unknown> = new Map(),
): Map<string, unknown> {
    for (const c of calls ?? []) {
        if (typeof c?.call_id === 'string' && c.call_id) into.set(huddleCallMediaKey(c.call_id), c.media);
    }
    return into;
}

/** Seed entries from the full cross-server seed (GET /v1/voice-participants). */
export function callMediaEntriesFromSeed(
    servers: ReadonlyArray<{
        channels?: ReadonlyArray<{ channel_id?: unknown; media?: unknown }>;
        huddles?: ReadonlyArray<{ calls?: ReadonlyArray<{ call_id?: unknown; media?: unknown }> }>;
    }> | null | undefined,
): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const s of servers ?? []) {
        for (const ch of s?.channels ?? []) {
            if (typeof ch?.channel_id === 'string' && ch.channel_id) out.set(voiceChannelMediaKey(ch.channel_id), ch.media);
        }
        for (const h of s?.huddles ?? []) callMediaEntriesFromCalls(h?.calls, out);
    }
    return out;
}

/** Accessible label for a call's media summary (Home tile). */
export function describeCallMedia(
    sharing: readonly string[],
    camera: readonly string[],
    names: Record<string, string> | undefined,
): string {
    const parts: string[] = [];
    if (sharing.length) parts.push(`${labelVoiceUsers(sharing, names).join(', ')} ${sharing.length === 1 ? 'is' : 'are'} sharing a screen`);
    if (camera.length) parts.push(`${labelVoiceUsers(camera, names).join(', ')} ${camera.length === 1 ? 'has' : 'have'} a camera on`);
    return parts.join(' · ');
}

/** Tests only. */
export function __resetCallMediaPresence(): void {
    const keys = [...media.keys()];
    media.clear();
    keys.forEach(notify);
}
