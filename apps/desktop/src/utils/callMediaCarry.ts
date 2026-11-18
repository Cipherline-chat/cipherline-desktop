/**
 * callMediaCarry - the user's screen share and camera, carried across a
 * moderator's MOVE into another call.
 *
 * ── The bug (owner report, 2026-11-18) ───────────────────────────────────────
 * "When moving members from one voice channel to another it stopped the
 * screenshare." A move (`huddle:force_move`, utils/callTransition.ts) swaps
 * `activeCall`, which re-keys CallPane: the old pane unmounts, its <LiveKitRoom>
 * disconnects, and LiveKit stops every local track it published - the share's
 * capture included. The new pane mounts with nothing published but the mic
 * (self mute / deafen were already carried: utils/selfCallIntent.ts). So the
 * moved member silently lost their share (and camera) and had to notice and
 * start it again.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 *  1. The mounted in-call UI (SidebarConference) registers a SNAPSHOT function
 *     here: what it is publishing right now - the share's options, a CLONE of
 *     the share's live capture where one can be taken, and whether the camera is
 *     on.
 *  2. The Dashboard's force_move flow calls `capture()` synchronously, before the
 *     state change that unmounts the old pane. A cloned MediaStreamTrack is
 *     independent of the original: LiveKit stopping the old room's track leaves
 *     the clone (and so the OS capture) running. No new capture, so no consent
 *     dialog and no portal chooser for a person who did not click anything.
 *  3. The destination's SidebarConference `take()`s it once its room is
 *     connected and decides (decideCarriedMedia) per kind:
 *       - publish it in the NEW room (its own E2EE key provider: the old room's
 *         key is gone with the old pane, so nothing can go out under it), or
 *       - stop it and tell the user why: the destination denies SCREEN_SHARE /
 *         VIDEO, a moderator has it disabled, the token does not grant the
 *         source (free tier: no video / share), or the room is not encrypted.
 *     Never published unencrypted: no encryption = stop.
 *  4. Anything not taken is released: a carry is single-use, bound to the
 *     destination call id, and expires (CARRY_TTL_MS) with its clone STOPPED -
 *     a screen capture must never outlive the share it was taken for. A leave
 *     (handleDisconnectCall) discards it at once.
 *
 * Only a moderator's move carries. A user switching calls themselves leaves the
 * share behind, as before (Discord does the same).
 *
 * Pure and framework-free (the clock and timers are injectable) so the contract
 * is unit-testable without mounting the call UI.
 */

import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

/** What the in-call UI is publishing, as handed to the next call. */
export interface LiveMediaSnapshot {
    share: {
        options: ScreenShareOptions;
        /** A clone of the live capture, or null: the share must be captured again
         *  (its frames come from a pipeline that cannot be cloned - the Linux
         *  hardware path, the HDR path - or no live capture track was found). */
        capture: MediaStreamTrack | null;
    } | null;
    camera: boolean;
}

export interface CarriedMedia extends LiveMediaSnapshot {
    toCallId: string;
    toCallName: string;
}

/** Same backstop as the move marker (callTransition.CALL_TRANSITION_TTL_MS):
 *  a destination that has not connected by then is a failed move. */
export const CARRY_TTL_MS = 20_000;

type Snapshotter = () => LiveMediaSnapshot | null;

export interface CallMediaCarry {
    /** The mounted in-call UI says what it is publishing. Returns the unregister. */
    register(fn: Snapshotter): () => void;
    /**
     * Record the live share's options against its publication, for an in-call UI
     * that was remounted (portal moves) and so lost its own record of the share.
     */
    noteShare(options: ScreenShareOptions | null, trackSid: string | null): void;
    /** The share options noted for the publication `trackSid`, if it is the same one. */
    notedShareFor(trackSid: string | null | undefined): ScreenShareOptions | null;
    /** A move into `toCallId` begins: snapshot what is live. True = something to carry. */
    capture(toCallId: string, toCallName: string): boolean;
    /** The destination's in-call UI collects it. Single use; null if not for `callId`. */
    take(callId: string | null | undefined): CarriedMedia | null;
    /** Drop (and stop) whatever is carried. A deliberate drop (a leave): no expiry notice. */
    discard(): void;
    /**
     * Who to tell when a carry EXPIRES uncollected (the destination took longer than
     * CARRY_TTL_MS to connect): its capture is stopped, and the user must not lose the
     * share silently. One handler; the Dashboard sets it.
     */
    onExpire(fn: ((c: CarriedMedia) => void) | null): void;
    pending(): CarriedMedia | null;
}

export function stopCapture(t: MediaStreamTrack | null | undefined): void {
    if (!t) return;
    try { t.stop(); } catch { /* already stopped */ }
}

export function createCallMediaCarry(deps: {
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
} = {}): CallMediaCarry {
    const now = deps.now ?? Date.now;
    const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
    let source: Snapshotter | null = null;
    let noted: { options: ScreenShareOptions; trackSid: string } | null = null;
    let carried: (CarriedMedia & { expiresAt: number }) | null = null;
    let timer: unknown = null;
    let expireHandler: ((c: CarriedMedia) => void) | null = null;

    const discard = () => {
        if (timer !== null) { clearTimer(timer); timer = null; }
        const c = carried;
        carried = null;
        stopCapture(c?.share?.capture);
    };
    const expire = () => {
        const c = carried;
        discard();
        if (!c || !expireHandler) return;
        const { expiresAt: _e, ...rest } = c;
        void _e;
        try { expireHandler(rest); } catch { /* a notice must not break the move */ }
    };

    return {
        register(fn) {
            source = fn;
            return () => { if (source === fn) source = null; };
        },
        noteShare(options, trackSid) {
            noted = options && trackSid ? { options: { ...options }, trackSid } : null;
        },
        notedShareFor(trackSid) {
            return noted && trackSid && noted.trackSid === trackSid ? { ...noted.options } : null;
        },
        capture(toCallId, toCallName) {
            discard();
            if (!source) return false;
            let snap: LiveMediaSnapshot | null = null;
            try { snap = source(); } catch (err) { console.warn('[MoveCarry] snapshot failed:', err); snap = null; }
            if (!snap || (!snap.share && !snap.camera)) {
                stopCapture(snap?.share?.capture);
                return false;
            }
            carried = { share: snap.share, camera: snap.camera, toCallId, toCallName, expiresAt: now() + CARRY_TTL_MS };
            // A clone nobody takes is a screen capture with no share: end it.
            timer = setTimer(() => { timer = null; expire(); }, CARRY_TTL_MS);
            return true;
        },
        take(callId) {
            if (!carried || !callId) return null;
            if (now() >= carried.expiresAt) { expire(); return null; }
            if (carried.toCallId !== callId) return null;
            const { expiresAt: _e, ...c } = carried;
            void _e;
            carried = null;
            if (timer !== null) { clearTimer(timer); timer = null; }
            return c;
        },
        discard,
        onExpire(fn) { expireHandler = fn; },
        pending() { return carried; },
    };
}

/** The app-wide carry. SidebarConference registers / takes; Dashboard captures / discards. */
export const callMediaCarry: CallMediaCarry = createCallMediaCarry();

// ── Is the carried media allowed in the destination? ─────────────────────────

export interface CarryGateInput {
    /** The destination room encrypts what we publish (LocalParticipant.isE2EEEnabled). */
    e2eeActive: boolean;
    /** The channel permission bit (SCREEN_SHARE / VIDEO) for this user. */
    channelAllows: boolean;
    /** A moderator has this source disabled for the user (carried by the server on a move). */
    moderatorDisabled: boolean;
    /** The destination token / SFU grants this source (free tier: no video, no share). */
    grantAllows: boolean;
}

export type CarryStopReason = 'encryption' | 'permission' | 'moderator' | 'grant';
export type CarryDecision = { action: 'publish' } | { action: 'stop'; reason: CarryStopReason };

/** Encryption first (never publish in the clear), then the specific reasons, so the notice says the truest thing. */
export function decideCarriedMedia(i: CarryGateInput): CarryDecision {
    if (!i.e2eeActive) return { action: 'stop', reason: 'encryption' };
    if (!i.channelAllows) return { action: 'stop', reason: 'permission' };
    if (i.moderatorDisabled) return { action: 'stop', reason: 'moderator' };
    if (!i.grantAllows) return { action: 'stop', reason: 'grant' };
    return { action: 'publish' };
}

export type CarryKind = 'share' | 'camera';

/** The notice for a carried share / camera that was stopped instead of published. */
export function carryStoppedToast(kind: CarryKind, reason: CarryStopReason | 'failed', callName: string): { kind: 'warning'; title: string; message: string } {
    const where = callName.trim() || 'the new call';
    const what = kind === 'share' ? 'share your screen' : 'use your camera';
    const title = kind === 'share' ? 'Screen share stopped' : 'Camera turned off';
    const message = (() => {
        switch (reason) {
            case 'permission': return `You were moved to ${where}, where you don't have permission to ${what}.`;
            case 'moderator': return `You were moved to ${where}. A moderator has turned off your ${kind === 'share' ? 'screen share' : 'camera'}.`;
            case 'grant': return `You were moved to ${where}, where you can't ${what}.`;
            case 'encryption': return `You were moved to ${where}. It isn't encrypted yet, so your ${kind === 'share' ? 'screen share' : 'camera'} was stopped.`;
            case 'failed': return kind === 'share'
                ? `Your screen share couldn't restart in ${where}. Share again to continue.`
                : `Your camera couldn't restart in ${where}. Turn it on again to continue.`;
        }
    })();
    return { kind: 'warning', title, message };
}

// ── LiveKit publish grants, asked of the live connection ─────────────────────

/** LiveKit protocol TrackSource values. */
export const PROTO_SOURCE_CAMERA = 1;
export const PROTO_SOURCE_SCREEN_SHARE = 3;

/**
 * May the local participant publish `source` right now, per what the SFU says
 * (`permissions` from the join response, updated mid-call)? Unknown → true: the
 * SFU enforces regardless, and a refused publish is reported as a failed restart.
 */
export function canPublishSource(
    p: { permissions?: { canPublish?: boolean; canPublishSources?: readonly number[] } | undefined } | null | undefined,
    source: typeof PROTO_SOURCE_CAMERA | typeof PROTO_SOURCE_SCREEN_SHARE,
): boolean {
    const perms = p?.permissions;
    if (!perms) return true;
    if (perms.canPublish === false) return false;
    if (perms.canPublishSources && perms.canPublishSources.length > 0) return perms.canPublishSources.includes(source);
    return true;
}
