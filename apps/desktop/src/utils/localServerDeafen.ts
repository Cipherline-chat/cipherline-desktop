import { useSyncExternalStore } from 'react';

/**
 * "A moderator server-deafened ME" - the one flag the remote-audio chains need.
 *
 * Server deafen means: do not play other participants' MICROPHONES. It is not
 * the same as a self-deafen: screen-share audio (and all video) must keep
 * playing, and the member's own mic is untouched. So it cannot ride the
 * `isLocalDeafened` prop that silences every chain; the mic chain reads this
 * flag on its own (hooks/useParticipantAudio) and the share chain never does.
 *
 * Module-level external store (same pattern as callSpeakingStore) so the three
 * components that call `useParticipantAudio` need no new prop threaded through
 * ~20 call sites. SidebarConference is the only writer; it mirrors the flag the
 * server put on the local participant's metadata (`server_deafened`), and
 * clears it when the call tears down. The state is the server's - this holds
 * no decision of its own.
 */
let serverDeafened = false;
const listeners = new Set<() => void>();

export function setLocalServerDeafened(v: boolean): void {
    if (serverDeafened === v) return;
    serverDeafened = v;
    listeners.forEach(l => l());
}

export function getLocalServerDeafened(): boolean {
    return serverDeafened;
}

function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function useLocalServerDeafened(): boolean {
    return useSyncExternalStore(subscribe, getLocalServerDeafened, () => false);
}

/**
 * Should a remote participant's MICROPHONE chain be silent? Any of: the user
 * muted that person locally, the user self-deafened, or a moderator
 * server-deafened them. Screen-share audio uses {@link shouldSilenceShareAudio}
 * instead, which deliberately ignores the moderator deafen.
 */
export function shouldSilenceMicAudio(o: {
    isLocalMuted: boolean;
    isLocalDeafened: boolean;
    serverDeafened: boolean;
}): boolean {
    return o.isLocalMuted || o.isLocalDeafened || o.serverDeafened;
}

/** Screen-share audio is silent only for the user's OWN choices (self-deafen or
 *  muting that share) - never for a moderator's server deafen. */
export function shouldSilenceShareAudio(o: {
    isLocalDeafened: boolean;
    isScreenShareMuted: boolean;
}): boolean {
    return !!(o.isLocalDeafened || o.isScreenShareMuted);
}

/** Tests only. */
export function __resetLocalServerDeafened(): void {
    serverDeafened = false;
    listeners.forEach(l => l());
}
