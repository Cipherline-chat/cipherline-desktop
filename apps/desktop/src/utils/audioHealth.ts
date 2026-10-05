/**
 * Audio-health diagnostics singleton — a minimal, always-on record of what
 * the call-audio pipeline is actually doing, so regressions in the fixes
 * from this pass (jitter-buffer underruns, auto-bypass trips, AGC gain
 * swings) are visible instead of only inferable from "someone said it
 * sounded bad." Fed by the same voiceProcessor callbacks CallPane already
 * wires for the toast notices (onNsAutoBypass / onNsStats / onAgcStats /
 * onNsUnavailable) — see CallPane.tsx's voiceProcessorManager.updateCallbacks
 * call.
 *
 * Deliberately a plain singleton with a tiny pub/sub, not React state: the
 * numbers update at up to ~1 Hz from worklet stats messages, and routing
 * that through top-level component state would re-render more of the call
 * UI than necessary. Consumers that want live numbers (a settings panel)
 * should use useSyncExternalStore(subscribe, getSnapshot); a one-off read
 * (logging a summary on disconnect) can just call getSnapshot() directly.
 */

export type NsState = 'active' | 'bypassed' | 'unavailable' | 'unknown';

export interface AudioHealthSnapshot {
    nsState: NsState;
    /** Cumulative underrun count reported by the RNNoise worklet's ring buffer
     *  this call (see nsKernel.js) — non-zero under sustained CPU load is
     *  expected occasionally; a rapidly climbing count means the auto-bypass
     *  hysteresis is being hit repeatedly. */
    nsUnderruns: number;
    /** How many times auto-bypass has tripped this call. */
    nsAutoBypassCount: number;
    nsAutoBypassActive: boolean;
    /** Worklet pipeline (gate+NS+AGC) failed to initialize at all this call. */
    nsUnavailable: boolean;
    /** Currently-applied AGC gain in dB, or null before the first stats report. */
    agcGainDb: number | null;
    agcVoiceActive: boolean;
    /** Wall-clock ms of the last update, or null if nothing has reported yet. */
    lastUpdatedAt: number | null;
}

function emptySnapshot(): AudioHealthSnapshot {
    return {
        nsState: 'unknown',
        nsUnderruns: 0,
        nsAutoBypassCount: 0,
        nsAutoBypassActive: false,
        nsUnavailable: false,
        agcGainDb: null,
        agcVoiceActive: false,
        lastUpdatedAt: null,
    };
}

let snapshot: AudioHealthSnapshot = emptySnapshot();
const listeners = new Set<() => void>();

function commit(next: Partial<AudioHealthSnapshot>): void {
    snapshot = { ...snapshot, ...next, lastUpdatedAt: Date.now() };
    for (const listener of listeners) listener();
}

/** Reset all counters — call once per new call (CallPane mount), so a
 *  previous call's underrun count doesn't bleed into the next one's display. */
export function resetForCall(): void {
    snapshot = emptySnapshot();
    for (const listener of listeners) listener();
}

export function recordNsStats(stats: { underruns: number; state: string }): void {
    const nsState: NsState = stats.state === 'bypass' ? 'bypassed' : 'active';
    commit({
        nsState,
        nsUnderruns: snapshot.nsUnderruns + stats.underruns,
    });
}

export function recordNsAutoBypass(active: boolean): void {
    commit({
        nsAutoBypassActive: active,
        nsAutoBypassCount: active ? snapshot.nsAutoBypassCount + 1 : snapshot.nsAutoBypassCount,
        nsState: active ? 'bypassed' : snapshot.nsState,
    });
}

export function recordNsUnavailable(): void {
    commit({ nsUnavailable: true, nsState: 'unavailable' });
}

export function recordAgcStats(stats: { gainDb: number; voiceActive: boolean }): void {
    commit({ agcGainDb: stats.gainDb, agcVoiceActive: stats.voiceActive });
}

export function getSnapshot(): AudioHealthSnapshot {
    return snapshot;
}

/** For useSyncExternalStore. */
export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** One-line summary for logging on call disconnect. */
export function summarize(): string {
    const s = snapshot;
    return (
        `ns=${s.nsState} underruns=${s.nsUnderruns} autoBypass=${s.nsAutoBypassCount} ` +
        `unavailable=${s.nsUnavailable} agcGainDb=${s.agcGainDb?.toFixed(1) ?? 'n/a'}`
    );
}
