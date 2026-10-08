import { useEffect, useRef } from 'react';
import type { CallMediaReport } from '@cipherline/shared';

/**
 * Tells the server MY camera / screen-share state in the call I'm in, so
 * members who are NOT in the call can see the same icons the participants
 * see (packages/shared/call-media.ts). The server applies it only to my own
 * state, only while I'm a participant, clamped to what I may publish, and
 * fans it out with the voice-presence VIEW_CHANNEL audience.
 *
 * Source of truth is the same LiveKit-derived snapshot the in-call rows
 * render from (CallTelemetry.participantTrackStates[myId] — camera = a live,
 * unmuted camera track; screen share likewise), so in-call and out-of-call
 * icons are computed from one definition.
 *
 * Sends ONLY on change (and once after each WS reconnect, since a report
 * lost while the socket was down would otherwise stick until the next
 * toggle), debounced so a quick on/off flicker is one report. The server
 * clears my flags whenever I join or leave a call, so a fresh call starts
 * from "nothing on" and needs no report until something turns on.
 */

export type CallMediaTarget =
    | { kind: 'huddle'; callId: string }
    | { kind: 'voice'; channelId: string };

export interface CallMediaReporterState {
    targetKey: string;
    camera: boolean;
    screen_share: boolean;
    connCount: number;
}

export const CALL_MEDIA_REPORT_DEBOUNCE_MS = 300;

const targetKeyOf = (t: CallMediaTarget): string =>
    t.kind === 'huddle' ? `h:${t.callId}` : `v:${t.channelId}`;

/**
 * Pure decision: given what was last sent (or null) and what is true now,
 * return the report to send (or null) and the new "last sent" record.
 */
export function decideCallMediaReport(
    prev: CallMediaReporterState | null,
    now: { target: CallMediaTarget | null; camera: boolean; screen_share: boolean; connCount: number },
): { report: CallMediaReport | null; next: CallMediaReporterState | null } {
    if (!now.target) return { report: null, next: null };
    const targetKey = targetKeyOf(now.target);
    // New call: the server cleared my flags on join, so the baseline is
    // "nothing on" as of the current connection.
    const base: CallMediaReporterState = prev && prev.targetKey === targetKey
        ? prev
        : { targetKey, camera: false, screen_share: false, connCount: now.connCount };
    const reconnected = base.connCount !== now.connCount;
    const changed = base.camera !== now.camera || base.screen_share !== now.screen_share;
    if (!reconnected && !changed) return { report: null, next: base };
    const report: CallMediaReport = now.target.kind === 'huddle'
        ? { call_id: now.target.callId, camera: now.camera, screen_share: now.screen_share }
        : { channel_id: now.target.channelId, camera: now.camera, screen_share: now.screen_share };
    return {
        report,
        next: { targetKey, camera: now.camera, screen_share: now.screen_share, connCount: now.connCount },
    };
}

export function useCallMediaReporter(opts: {
    target: CallMediaTarget | null;
    camera: boolean;
    screenShare: boolean;
    /** Bumps on every WS (re)connect — useRealtime's `wsConnectCount`. */
    connCount: number;
    /** Returns false when the socket was not open (nothing sent). */
    send: (report: CallMediaReport) => boolean;
}): void {
    const { target, camera, screenShare, connCount, send } = opts;
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
        const id = setTimeout(() => {
            const { report, next } = decideCallMediaReport(lastRef.current, {
                target: t, camera, screen_share: screenShare, connCount,
            });
            if (!report) { lastRef.current = next; return; }
            // Only advance "last sent" if it actually went out — a closed
            // socket leaves it pending for the reconnect re-assert.
            if (sendRef.current(report)) lastRef.current = next;
        }, CALL_MEDIA_REPORT_DEBOUNCE_MS);
        return () => clearTimeout(id);
    }, [targetKind, targetId, camera, screenShare, connCount]);
}
