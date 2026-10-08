/**
 * "Prioritize call video while gaming" — the renderer half, and the one store
 * every surface (Voice & Video settings, the freeze offer, the call) reads.
 *
 * The setting itself lives in main's <userData>/startup-flags.json as
 * `gamingVideo` (electron/startup-flags.ts, electron/gaming-video-mode.ts):
 * part of the mode is Chromium command-line switches, which must be known
 * before app.ready, so neither secureLocalStore nor SecureStore can hold it.
 * Machine-specific and not secret; nothing here persists it in the renderer,
 * so backupRegistry.ts has no key for it. (The OFFER's snooze state is
 * separate — utils/gamingVideoOffer.ts.)
 *
 * What the mode does, by layer:
 *   - next launch: Chromium occlusion / backgrounding switches (main);
 *   - immediately, during a call, Windows: ABOVE_NORMAL process priority (main);
 *   - immediately, during a call: the outgoing CAMERA's degradation preference
 *     becomes 'maintain-framerate' (here — applyCameraDegradation below). Under
 *     CPU starvation WebRTC then sheds resolution instead of frame rate, so the
 *     camera keeps moving (softer) rather than dropping toward a slideshow.
 *     LiveKit's default for our 720p camera is 'balanced'. Screen shares are
 *     already 'maintain-framerate' (utils/screenShare.ts) and are not touched.
 */
import { useSyncExternalStore } from 'react';
import { parseStartupFlagsState, gamingVideoRestartPending, type StartupFlagsState } from './startupFlags';

export interface GamingVideoSnapshot {
    /** The main process supports the setting (an older one does not). */
    available: boolean;
    /** Saved value — what the runtime half follows. */
    enabled: boolean;
    /** The launch-time switches differ from the saved value. */
    restartPending: boolean;
    platform: string;
}

const UNAVAILABLE: GamingVideoSnapshot = Object.freeze({ available: false, enabled: false, restartPending: false, platform: 'unknown' });

let snapshot: GamingVideoSnapshot = UNAVAILABLE;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(state: StartupFlagsState | null): void {
    const next: GamingVideoSnapshot = state
        ? { available: true, enabled: state.saved.gamingVideo, restartPending: gamingVideoRestartPending(state), platform: state.platform }
        : UNAVAILABLE;
    if (next.available === snapshot.available && next.enabled === snapshot.enabled
        && next.restartPending === snapshot.restartPending && next.platform === snapshot.platform) return;
    snapshot = next;
    for (const l of [...listeners]) { try { l(); } catch { /* a listener must not break the others */ } }
}

export function getGamingVideoSnapshot(): GamingVideoSnapshot {
    return snapshot;
}

export function subscribeGamingVideo(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Fetch the saved value from main once (dedup'd); refresh with force. */
export function loadGamingVideoMode(force = false): Promise<void> {
    if (loading && !force) return loading;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.getStartupFlags) return Promise.resolve();
    loading = api.getStartupFlags()
        .then(v => publish(parseStartupFlagsState(v)))
        .catch(() => { loading = null; });
    return loading;
}

/** Save the setting. Rejects when main refuses or the bridge is missing. */
export async function setGamingVideoMode(on: boolean): Promise<GamingVideoSnapshot> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.setStartupFlags) throw new Error('Gaming video mode is not available in this build');
    publish(parseStartupFlagsState(await api.setStartupFlags({ gamingVideo: on })));
    return snapshot;
}

export function useGamingVideoMode(): GamingVideoSnapshot {
    return useSyncExternalStore(subscribeGamingVideo, getGamingVideoSnapshot, getGamingVideoSnapshot);
}

/** Test seam: reset the module store. */
export function __resetGamingVideoModeForTests(): void {
    snapshot = UNAVAILABLE;
    loading = null;
    listeners.clear();
}

// ── Settings copy (Voice & Video → While gaming) ───────────────────────────

export const GAMING_VIDEO_LABEL = 'Prioritize call video while gaming';

/** The row's explanation. */
export function gamingVideoDescription(platform: string): string {
    const priority = platform === 'win32' ? 'Cipherline asks Windows for more CPU time during calls, ' : '';
    return 'For when cameras or screen shares freeze while a game has focus. '
        + `${priority}${priority ? 'keeps' : 'Cipherline keeps'} drawing video while a fullscreen game covers it, `
        + 'and keeps your camera’s frame rate up by lowering its sharpness first. '
        + 'This can cost your game a few FPS, which is why it’s off by default.';
}

/** The restart notice, or null when nothing waits on a restart. */
export function gamingVideoRestartCopy(enabled: boolean, restartPending: boolean): string | null {
    if (!restartPending) return null;
    return enabled
        ? 'On for calls now. The rest takes effect after restarting Cipherline.'
        : 'Off for calls now. Restart Cipherline to switch it off completely.';
}

// ── Outgoing camera: degradation preference ────────────────────────────────

export const GAMING_CAMERA_DEGRADATION: RTCDegradationPreference = 'maintain-framerate';

/** The slice of LiveKit's LocalVideoTrack this needs. */
export interface DegradableCameraTrack {
    setDegradationPreference(preference: RTCDegradationPreference): unknown;
}

/**
 * The preference LiveKit last applied to this track. LiveKit keeps it in a
 * field its typings mark private (LocalVideoTrack.degradationPreference, set by
 * setDegradationPreference and at publish); read defensively — undefined when
 * absent or not one of the three values.
 */
function currentPreference(track: DegradableCameraTrack): RTCDegradationPreference | undefined {
    const v = (track as unknown as { degradationPreference?: unknown }).degradationPreference;
    return v === 'balanced' || v === 'maintain-framerate' || v === 'maintain-resolution' ? v : undefined;
}

/** What each track had before the mode changed it — restored exactly on off. */
const originalPreference = new WeakMap<DegradableCameraTrack, RTCDegradationPreference>();

function setPref(track: DegradableCameraTrack, p: RTCDegradationPreference): void {
    try {
        const r = track.setDegradationPreference(p);
        // LiveKit's is async and logs its own failures; never let it surface
        // as an unhandled rejection here.
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => {});
    } catch { /* track torn down */ }
}

/**
 * Apply (on) or undo (off) the mode's camera preference on one published
 * camera track. Idempotent both ways; undo restores the preference the track
 * had before the mode touched it ('balanced' if LiveKit had not recorded one,
 * which is LiveKit's own default for a camera below 1080p).
 */
export function applyCameraDegradation(track: DegradableCameraTrack, on: boolean): void {
    const current = currentPreference(track);
    if (on) {
        if (!originalPreference.has(track)) originalPreference.set(track, current ?? 'balanced');
        if (current !== GAMING_CAMERA_DEGRADATION) setPref(track, GAMING_CAMERA_DEGRADATION);
        return;
    }
    const before = originalPreference.get(track);
    if (before === undefined) return; // never touched
    originalPreference.delete(track);
    if (current !== before) setPref(track, before);
}
