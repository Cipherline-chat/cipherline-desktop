/**
 * A moderator's SERVER mute and the user's own SELF mute are two separate
 * states (Discord semantics, owner bug 2026-11-21: "server muting someone and
 * then unmuting - they have to manually unmute themselves").
 *
 * How a server mute actually reaches this client (measured on the local
 * LiveKit 1.9.12 + livekit-client 2.18.8, see the worklog entry
 * 2026-11-21-server-unmute-restores): the API drops MICROPHONE from the
 * participant's `canPublishSources`, and the SFU itself REMOVES the published
 * mic track and tells us (`LocalTrackUnpublished`) - our own capture is torn
 * down. Lifting the mute only restores the grant; nothing re-publishes the mic.
 * So the client has to put the mic back, and only if the user wants it.
 *
 * The old code decided "did the user want it" by reading
 * `isMicrophoneEnabled` in a React effect AFTER the metadata flag arrived - but
 * by then the SFU had usually already removed the track (the unpublish lands
 * ~15 ms after the metadata, inside the render), so it read "already muted" and
 * never restored. It also kept that snapshot in component refs, which reset
 * whenever the call UI remounts (portal moves) or the call is rejoined.
 *
 * This holds the user's own choice EXPLICITLY:
 *   - learned from the mic's own mute / unmute / publish events only while
 *     nothing else is holding it (no server mute, grant present, not
 *     self-deafened, not push-to-talk) - a server teardown never counts;
 *   - set directly by the Mute button while server-muted (it toggles the
 *     preference; the track stays down - the SFU would refuse it anyway);
 *   - kept per LiveKit Room (WeakMap), so it survives the call UI remounting
 *     mid-call and a LiveKit reconnect (same Room), and a fresh call starts
 *     from the joining controls.
 *
 * On the lift it restores the mic only when the user's choice is "on". The
 * metadata flag and the restored grant are two separate signals; if the grant
 * is not back yet the restore waits for `permissionsChanged`.
 *
 * This is UX only. The SFU is the enforcement: with the grant removed a
 * publish is refused (client- and server-side), so nothing here can bypass a
 * server mute.
 */

export interface ServerMuteMic {
    /** The mic publication exists and is unmuted. */
    isEnabled(): boolean;
    /** The SFU's current grant includes the microphone. */
    canPublish(): boolean;
    setEnabled(on: boolean): Promise<unknown> | void;
}

/** What else, besides a moderator, may be holding the mic right now. */
export interface ServerMuteContext {
    /** The USER deafened themselves (deafen force-mutes the mic; undeafen restores on its own). */
    selfDeafened: boolean;
    /** Push-to-talk owns the mic: it opens on the key, never by a restore. */
    pushToTalk: boolean;
    /** The member may speak here at all (SPEAK). */
    canSpeak: boolean;
}

export type ServerMuteTransition = 'none' | 'applied' | 'restored' | 'pending' | 'kept-muted';

export class ServerMuteGate {
    private selfMuted: boolean;
    private serverMuted = false;
    private pendingRestore = false;
    private listeners = new Set<() => void>();

    constructor(initialSelfMuted: boolean) {
        this.selfMuted = initialSelfMuted;
    }

    /** The user's own mute choice - what the Mute button shows. */
    isSelfMuted(): boolean { return this.selfMuted; }
    /** The last moderator flag this gate was told about. */
    isServerMuted(): boolean { return this.serverMuted; }
    isRestorePending(): boolean { return this.pendingRestore; }

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    private setSelf(muted: boolean): void {
        if (this.selfMuted === muted) return;
        this.selfMuted = muted;
        for (const fn of [...this.listeners]) fn();
    }

    /**
     * The mic's state changed (mute / unmute / publish event, or a mount-time
     * sync). Records it as the user's choice unless something other than the
     * user is holding the mic. `restricted` = server-muted OR the grant has no
     * microphone: a teardown by the SFU is never mistaken for a self-mute.
     */
    noteMicState(enabled: boolean, a: { restricted: boolean; selfDeafened: boolean; pushToTalk: boolean }): void {
        if (a.restricted || this.serverMuted || a.selfDeafened || a.pushToTalk) return;
        this.setSelf(!enabled);
    }

    /**
     * The Mute button (or its hotkey) while server-muted: flip the preference
     * only. Returns the new self-muted value. The track is not touched - the
     * moderator's mute holds it down until lifted.
     */
    userToggled(): boolean {
        this.setSelf(!this.selfMuted);
        // Changing your mind cancels a restore still waiting for its grant.
        if (this.selfMuted) this.pendingRestore = false;
        return this.selfMuted;
    }

    /** A Mute press outside a server mute: record the choice directly too, so
     *  it never depends on the event arriving. */
    userChose(muted: boolean): void {
        this.setSelf(muted);
        if (muted) this.pendingRestore = false;
    }

    /**
     * The moderator flag as it stands now (call on every change, and on mount).
     * Returns what happened:
     *   'applied'    - mute just landed (or found active on mount); the caller
     *                  may switch off a mic that is somehow still live
     *   'restored'   - lifted and the user's choice is "on": mic re-enabled
     *   'pending'    - lifted, choice "on", grant not back yet: waits for
     *                  permissionsChanged()
     *   'kept-muted' - lifted, but the user is self-muted (or deafened / PTT /
     *                  no SPEAK): stays as they chose
     *   'none'       - no transition
     */
    setServerMuted(muted: boolean, mic: ServerMuteMic, ctx: ServerMuteContext): ServerMuteTransition {
        if (muted) {
            const was = this.serverMuted;
            this.serverMuted = true;
            this.pendingRestore = false;
            return was ? 'none' : 'applied';
        }
        if (!this.serverMuted) return 'none';
        this.serverMuted = false;
        return this.tryRestore(mic, ctx);
    }

    /** The SFU's grant changed: finish a restore that was waiting for it. */
    permissionsChanged(mic: ServerMuteMic, ctx: ServerMuteContext): ServerMuteTransition {
        if (!this.pendingRestore || this.serverMuted) return 'none';
        return this.tryRestore(mic, ctx);
    }

    private tryRestore(mic: ServerMuteMic, ctx: ServerMuteContext): ServerMuteTransition {
        this.pendingRestore = false;
        if (this.selfMuted || ctx.selfDeafened || ctx.pushToTalk || !ctx.canSpeak) return 'kept-muted';
        if (mic.isEnabled()) return 'restored';
        if (!mic.canPublish()) {
            this.pendingRestore = true;
            return 'pending';
        }
        const r = mic.setEnabled(true);
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => { /* device busy: the button still reads off */ });
        return 'restored';
    }
}

const gates = new WeakMap<object, ServerMuteGate>();

/** The gate for this LiveKit Room. Created on first use, seeded from the
 *  joining controls; the same Room (UI remount, LiveKit reconnect) keeps it. */
export function serverMuteGateFor(room: object, initialSelfMuted: boolean): ServerMuteGate {
    let g = gates.get(room);
    if (!g) {
        g = new ServerMuteGate(initialSelfMuted);
        gates.set(room, g);
    }
    return g;
}

/** The moderator flag the API writes onto our own participant metadata. Read
 *  live (the metadata object is mutated in place), strict-true only. */
export function metadataServerMuted(metadata: string | undefined | null): boolean {
    if (!metadata) return false;
    try {
        const m: unknown = JSON.parse(metadata);
        return !!m && typeof m === 'object' && (m as { server_muted_audio?: unknown }).server_muted_audio === true;
    } catch {
        return false;
    }
}

/**
 * What the Mute button and the standing notice say while server-muted. The
 * icon follows the USER's own choice (so a click visibly does something); the
 * red ground + shield badge say a moderator is holding the mic regardless.
 */
export function serverMutedMicView(selfMuted: boolean): {
    iconOff: boolean;
    title: string;
    notice: string;
    noticeDetail: string;
} {
    return {
        iconOff: selfMuted,
        title: selfMuted
            ? "Server muted by a moderator. You're also muted yourself - click to unmute for when they lift it"
            : "Server muted by a moderator. You'll be live again when they lift it - click to stay muted",
        notice: 'Server muted by a moderator',
        noticeDetail: selfMuted
            ? "You muted yourself too - you'll stay muted when it's lifted"
            : "You'll be live again when it's lifted",
    };
}
