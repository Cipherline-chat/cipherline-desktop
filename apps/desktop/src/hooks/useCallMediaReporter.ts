import { useEffect, useRef } from 'react';
import type { CallMediaReport } from '@cipherline/shared';

/**
 * Tells the server MY camera / screen-share / mute / deafen state in the call
 * I'm in, so members who are NOT in the call can see the same icons the
 * participants see (packages/shared/call-media.ts). The server applies it
 * only to my own state, only while I'm a participant, clamped to what I may
 * publish, and fans it out with the voice-presence VIEW_CHANNEL audience.
 *
 * Source of truth is the same LiveKit-derived snapshot the in-call rows
 * render from (CallTelemetry.participantTrackStates[myId] — camera = a live,
 * unmuted camera track; screen share likewise; muted = the mic track is off;
 * participantMetadata[myId].deafened = self-deafen), so in-call and
 * out-of-call icons are computed from one definition.
 *
 * PUSH-TO-TALK: in PTT mode the app itself closes the mic on every key-up and
 * opens it on every key-down, so "mic track off" is the resting state, not a
 * mute. {@link selfMutedForPresence} therefore reports `muted: false` for the
 * whole time PTT mode is on (there is no separate persistent "I muted myself"
 * state in PTT mode), so the icon does not flap on every key press and does
 * not fan out a VIEW_CHANNEL broadcast per press. Deafen is unaffected: it is
 * a real toggle, reported as-is.
 *
 * Sends ONLY on change (and once after each WS reconnect, since a report
 * lost while the socket was down would otherwise stick until the next
 * toggle), debounced so a quick on/off flicker is one report. The server
 * clears my flags whenever I join or leave a call, so a fresh call starts
 * from "nothing on" and needs no report until something turns on. The FIRST
 * report of a call waits a little longer ({@link CALL_MEDIA_JOIN_SETTLE_MS}):
 * the mic track reads "off" until LiveKit has published it, and reporting that
 * would flash a muted icon on everyone who joins with their mic on.
 */

export type CallMediaTarget =
    | { kind: 'huddle'; callId: string }
    | { kind: 'voice'; channelId: string };

export interface CallMediaReporterState {
    targetKey: string;
    camera: boolean;
    screen_share: boolean;
    muted: boolean;
    deafened: boolean;
    connCount: number;
}

export const CALL_MEDIA_REPORT_DEBOUNCE_MS = 300;
/** Trailing delay for the first report after joining a call (see above). */
export const CALL_MEDIA_JOIN_SETTLE_MS = 1200;

/**
 * The `muted` value to report. `micOff` is the in-call mic indicator
 * (`!isMicrophoneEnabled`, what the in-call row's MicOff reads); in push-to-talk
 * mode it is never a mute — see the file header.
 */
export function selfMutedForPresence(micOff: boolean, pushToTalk: boolean): boolean {
    return !pushToTalk && micOff;
}

const targetKeyOf = (t: CallMediaTarget): string =>
    t.kind === 'huddle' ? `h:${t.callId}` : `v:${t.channelId}`;

/**
 * Pure decision: given what was last sent (or null) and what is true now,
 * return the report to send (or null) and the new "last sent" record.
 */
export function decideCallMediaReport(
    prev: CallMediaReporterState | null,
    now: { target: CallMediaTarget | null; camera: boolean; screen_share: boolean; muted: boolean; deafened: boolean; connCount: number },
): { report: CallMediaReport | null; next: CallMediaReporterState | null } {
    if (!now.target) return { report: null, next: null };
    const targetKey = targetKeyOf(now.target);
    // New call: the server cleared my flags on join, so the baseline is
    // "nothing on" as of the current connection.
    const base: CallMediaReporterState = prev && prev.targetKey === targetKey
        ? prev
        : { targetKey, camera: false, screen_share: false, muted: false, deafened: false, connCount: now.connCount };
    const reconnected = base.connCount !== now.connCount;
    const changed = base.camera !== now.camera || base.screen_share !== now.screen_share
        || base.muted !== now.muted || base.deafened !== now.deafened;
    if (!reconnected && !changed) return { report: null, next: base };
    const flags = { camera: now.camera, screen_share: now.screen_share, muted: now.muted, deafened: now.deafened };
    const report: CallMediaReport = now.target.kind === 'huddle'
        ? { call_id: now.target.callId, ...flags }
        : { channel_id: now.target.channelId, ...flags };
    return {
        report,
        next: { targetKey, ...flags, connCount: now.connCount },
    };
}

export function useCallMediaReporter(opts: {
    target: CallMediaTarget | null;
    camera: boolean;
    screenShare: boolean;
    /** True when my mic track is off right now (the in-call MicOff reading).
     *  Not the same as "muted" in push-to-talk mode — see `pushToTalk`. */
    micOff: boolean;
    /** Push-to-talk mode is on: a closed mic is the resting state, not a mute. */
    pushToTalk: boolean;
    /** Self-deafen (participant metadata `deafened`). */
    deafened: boolean;
    /** Bumps on every WS (re)connect — useRealtime's `wsConnectCount`. */
    connCount: number;
    /** Returns false when the socket was not open (nothing sent). */
    send: (report: CallMediaReport) => boolean;
}): void {
    const { target, camera, screenShare, micOff, pushToTalk, deafened, connCount, send } = opts;
    const muted = selfMutedForPresence(micOff, pushToTalk);
    const lastRef = useRef<CallMediaReporterState | null>(null);
    const sendRef = useRef(send);
    useEffect(() => { sendRef.current = send; }, [send]);

    const targetKind = target?.kind ?? null;
    const targetId = target ? (target.kind === 'huddle' ? target.callId : target.channelId) : null;

    useEffect(() => {
        const t: CallMediaTarget | null = targetKind === 'huddle' && targetId
            ? { kind: 'huddle', callId: targetId }
            : targetKind === 'voice' && targetId
                ? { kind: 'voice', channelId: targetId }
                : null;
        if (!t) {
            lastRef.current = null;
            return;
        }
        // Nothing sent yet for this call → wait out the join settle window.
        const fresh = lastRef.current?.targetKey !== targetKeyOf(t);
        const id = setTimeout(() => {
            const { report, next } = decideCallMediaReport(lastRef.current, {
                target: t, camera, screen_share: screenShare, muted, deafened, connCount,
            });
            if (!report) { lastRef.current = next; return; }
            // Only advance "last sent" if it actually went out — a closed
            // socket leaves it pending for the reconnect re-assert.
            if (sendRef.current(report)) lastRef.current = next;
        }, fresh ? CALL_MEDIA_JOIN_SETTLE_MS : CALL_MEDIA_REPORT_DEBOUNCE_MS);
        return () => clearTimeout(id);
    }, [targetKind, targetId, camera, screenShare, muted, deafened, connCount]);
}
