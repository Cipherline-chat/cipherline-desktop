import React, { createContext, useContext } from 'react';
import type { CallStats } from '../hooks/useCallStats';
import type { ParticipantMeta } from '../utils/participantMetadata';

/**
 * Narrow slices of CallProvider's telemetry (render-cost isolation).
 *
 * CallTelemetryContext (CallContext.tsx) changes whenever the per-participant
 * snapshot or the call stats change. Two hot consumers never read that value:
 *   - SidebarConference only WRITES telemetry. Subscribing to the whole
 *     context made the entire call UI (every tile, the control bar) re-render
 *     after each of its own pushes.
 *   - ParticipantCard reads callStats only (the local ping readout).
 * The setters are useState setters (stable for the provider's lifetime), so
 * the setters value never changes; the stats value changes at the stats poll
 * rate (≤ 1/3 Hz) and only when the numbers actually move.
 *
 * Lives outside CallContext.tsx so that file keeps exporting components only
 * (react-refresh/only-export-components).
 */
export type ParticipantTrackStates = Record<string, { hasCamera: boolean; hasScreenShare: boolean; isMuted?: boolean }>;

export interface CallTelemetrySetters {
    setCallStats: (stats: CallStats) => void;
    /** useState setters: accept an updater, so writers can keep the previous
     *  object when nothing changed (see utils/flatRecordEqual.ts). */
    setParticipantTrackStates: React.Dispatch<React.SetStateAction<ParticipantTrackStates>>;
    setParticipantMetadata: React.Dispatch<React.SetStateAction<Record<string, ParticipantMeta>>>;
}

export const CallTelemetrySettersContext = createContext<CallTelemetrySetters | null>(null);
export const CallStatsContext = createContext<CallStats | null>(null);

/** Write-only access to the telemetry snapshot; never causes a re-render. */
export const useCallTelemetrySettersSafe = () => useContext(CallTelemetrySettersContext);
/** Live call stats only (ping / loss); null outside a CallProvider. */
export const useCallStatsSafe = () => useContext(CallStatsContext);
