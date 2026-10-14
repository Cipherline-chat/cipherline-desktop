/**
 * selfCallIntent - the user's OWN mute / deafen, carried from one call to the
 * next.
 *
 * Self-mute and self-deafen are a property of the person, not of the call they
 * happen to be in (Discord-style). Before this, every join - including the one
 * a moderator's move performs - went through beginCallJoin, which reset the
 * join intent to "not muted, not deafened". The new room was therefore
 * connected with the microphone requested on: someone muted in call A and
 * dragged into call B had a LIVE MIC. That is a privacy bug, not a cosmetic one.
 *
 * How the carry works:
 *   1. SidebarConference publishes the user's intent here while they are in a
 *      call (deriveSelfIntent).
 *   2. beginCallJoin - the single start of every join path, user switch and
 *      moderator move alike - asks resolveCarriedIntent and seeds `joinIntent`
 *      with it, BEFORE the next room is built.
 *   3. CallPane builds the LiveKit room with the microphone NOT requested when
 *      the intent says muted or deafened (shouldPublishMicAtConnect), so no
 *      audio frame is ever captured or sent, and the call UI is seeded with the
 *      same state (the existing joining-controls seed), so remote audio is
 *      silenced from the first frame for a deafened user.
 *
 * Only a user who is IN a call (or mid-join) carries anything: someone joining
 * from nothing starts clean, as before.
 *
 * Moderator-applied (server) mute / deafen are NOT self state and never flow
 * through here; they live on the LiveKit participant and are carried by the
 * server on a move (HuddlesService.applyMove).
 */

export interface SelfCallIntent {
    muted: boolean;
    deafened: boolean;
}

export const NO_SELF_INTENT: SelfCallIntent = { muted: false, deafened: false };

let stored: SelfCallIntent | null = null;

/** The app-wide holder SidebarConference writes and Dashboard reads. */
export const selfCallIntent = {
    set(i: SelfCallIntent): void { stored = { muted: i.muted, deafened: i.deafened }; },
    get(): SelfCallIntent | null { return stored ? { ...stored } : null; },
    clear(): void { stored = null; },
};

export interface DeriveSelfIntentInput {
    /** The microphone is not enabled right now. */
    micOff: boolean;
    /** The USER deafened themselves (not a moderator's server-deafen). */
    selfDeafened: boolean;
    /** Was the mic already off when they deafened? (deafen force-mutes; undeafen restores only if not.) */
    wasMutedBeforeDeafen: boolean;
    pushToTalk: boolean;
    /** A moderator has server-muted / server-deafened them: the mic is off, but not by choice. */
    serverForcedMute: boolean;
    /** They may speak here at all; a listen-only member's mic is off by permission. */
    canSpeak: boolean;
}

/**
 * What the user has chosen. Deafened wins and remembers whether they were also
 * muted before (so undeafening in the next call restores the right mic state);
 * otherwise "muted" means the mic is off BY CHOICE - not because push-to-talk
 * holds it closed, not because a moderator or a missing permission did.
 */
export function deriveSelfIntent(i: DeriveSelfIntentInput): SelfCallIntent {
    if (i.selfDeafened) return { muted: i.wasMutedBeforeDeafen, deafened: true };
    return { muted: i.micOff && !i.pushToTalk && !i.serverForcedMute && i.canSpeak, deafened: false };
}

export interface ResolveCarriedInput {
    /** A call is up (activeCall is set). */
    inCall: boolean;
    /** A join is in flight and no call object exists yet. */
    starting: boolean;
    /** That call's room has reported Connected, so `stored` is current. */
    connected: boolean;
    /** The intent pressed on the joining controls (authoritative until connected). */
    joinIntent: SelfCallIntent;
    stored: SelfCallIntent | null;
}

/** What the next join starts with. */
export function resolveCarriedIntent(i: ResolveCarriedInput): SelfCallIntent {
    if (!i.inCall && !i.starting) return { ...NO_SELF_INTENT }; // joining from nothing: clean slate
    // Once connected the in-call controls are the truth; before that, the
    // joining controls are (the in-call UI is not mounted yet).
    const src = i.connected ? (i.stored ?? i.joinIntent) : i.joinIntent;
    return { muted: src.muted, deafened: src.deafened };
}

/**
 * Does the room ask for the microphone at connect? Only if the token allows it
 * and the user is neither muted nor deafened. When false the mic is never
 * requested at all: no capture, no publish, no frame - not "publish then mute".
 */
export function shouldPublishMicAtConnect(intent: SelfCallIntent, tokenAllowsMic: boolean): boolean {
    return tokenAllowsMic && !intent.muted && !intent.deafened;
}

/** Warm the mic device ahead of the connect only when it will actually be used. */
export function shouldWarmMic(intent: SelfCallIntent): boolean {
    return !intent.muted && !intent.deafened;
}
