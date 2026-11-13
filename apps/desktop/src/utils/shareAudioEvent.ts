/**
 * The `share_audio` call event: what became of a share's system audio, step by
 * step (SidebarConference.startNativeWindowAudio and the swap / toggle paths
 * that call it).
 *
 * Why it exists. A Linux tester's share carried audio for six minutes (a
 * 204 kbps screen-audio sender in the report's stats) and lost it at a source
 * swap, and nothing in the report said whether audio was asked for again,
 * refused, or skipped - the report had to be read through side effects (the
 * audio sender vanishing, a ring-trim counter). Every step now leaves a row.
 *
 * Privacy: fixed words and small numbers only. Never a source id or title, a
 * process name, an application name (mode "app" is a fixed word; the apps on offer are a
 * COUNT), a pid, or a path. Anything not on the lists below is written
 * as 'other' rather than passed through, so a caller cannot leak by accident.
 */
import type { CallEventDetail } from './callEventLog';

export type ShareAudioStep =
    | 'skipped'      // audio was not started; `why` says why
    | 'starting'     // the native capture was requested
    | 'refused'      // main answered "no" to the start (consent / addon / PipeWire)
    | 'first_chunk'  // the first PCM arrived from the addon
    | 'no_chunks'    // started, but 3 s passed with nothing
    | 'failed'       // the addon reported a terminal failure; `reason` says which
    | 'exited'       // the captured app quit (window shares)
    | 'stopped'      // the app tore the capture down; `cause` says why
    | 'picked';      // Wayland window share: the picker's choice of app (count of apps offered, how it was chosen)

const WHY = new Set(['off', 'no_native', 'no_pid', 'no_api', 'window_unsupported']);
const REASON = new Set(['permission', 'no-target', 'unavailable', 'unsupported', 'stopped', 'error']);
const CAUSE = new Set(['swap', 'restart', 'toggle', 'share_end', 'start_again', 'exited', 'failed']);
// How the app for a Wayland window share was chosen: from the window's title, by the user, or none.
const HOW = new Set(['auto', 'manual', 'none']);

const pick = (set: ReadonlySet<string>, v: unknown): string =>
    typeof v === 'string' && set.has(v) ? v : 'other';

export interface ShareAudioInput {
    step: ShareAudioStep;
    /** 'app' = one application's audio, picked from the list (Linux Wayland window shares). */
    mode?: 'screen' | 'window' | 'app';
    why?: string;
    reason?: string;
    cause?: string;
    /** picked: how many apps were on offer (a count - never their names). */
    apps?: number;
    /** picked: how the app was chosen. */
    how?: string;
    /** Milliseconds since the start request. */
    ms?: number;
    /** The host platform (electronAPI.platform): which addon answered. */
    platform?: string;
}

export function shareAudioEventDetail(i: ShareAudioInput): CallEventDetail {
    const d: CallEventDetail = { step: i.step };
    if (i.mode === 'screen' || i.mode === 'window' || i.mode === 'app') d.mode = i.mode;
    if (i.step === 'skipped') d.why = pick(WHY, i.why);
    if (i.step === 'failed') d.reason = pick(REASON, i.reason);
    if (i.step === 'stopped') d.cause = pick(CAUSE, i.cause);
    if (i.step === 'picked') {
        d.how = pick(HOW, i.how);
        if (typeof i.apps === 'number' && Number.isFinite(i.apps) && i.apps >= 0) d.apps = Math.min(Math.round(i.apps), 99);
    }
    if (typeof i.ms === 'number' && Number.isFinite(i.ms) && i.ms >= 0) d.ms = Math.round(i.ms);
    if (i.platform === 'linux' || i.platform === 'windows' || i.platform === 'mac') d.os = i.platform;
    return d;
}
