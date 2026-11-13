/**
 * Which encoder path a "Share screen" takes (Linux hardware screen share, ON by default since 2026-11-10). THE single decision point.
 * `native` only when ALL of: not switched off (Settings -> Advanced; CIPHERLINE_NATIVE_SHARE_ENCODER=1 forces it on), we are on Linux, the main
 * process reported a working hardware backend, and that hardware can sustain a worthwhile frame rate at the source size.
 * Everything else is the unchanged Chromium path. Pure so "no usable GPU = the normal path" is unit-tested.
 */
export interface NativeProbe {
    vaapi: boolean;
    nvenc: boolean;
    /** Frames/s the encoder sustained unpaced at the requested size in a short calibration run (absent = not measured). */
    sustainedFps?: number;
}

/** An encoder that cannot sustain this at the requested size is not worth the native path: Chromium's own choice is better. */
export const NATIVE_MIN_FPS = 24;
/** Paced sustainable rate = this share of the unpaced calibration, so a share never runs the encoder flat out (a stutter source). */
export const NATIVE_SUSTAIN_FACTOR = 0.85;

export interface ShareBackendDecision {
    path: 'native' | 'chromium';
    backend?: 'nvenc' | 'vaapi';
    reason: string;
    /** The frame rate the native path will run at (<= the requested one): capability-driven, so it lowers instead of stuttering. */
    fps?: number;
}

export function decideShareBackend(input: {
    flagOn: boolean; platform: string; probe: NativeProbe | null | undefined;
    /** The frame rate being asked for; with probe.sustainedFps it sets the ceiling. */
    wantFps?: number;
}): ShareBackendDecision {
    if (!input.flagOn) return { path: 'chromium', reason: 'flag off' };
    if (input.platform !== 'linux') return { path: 'chromium', reason: 'not linux' };
    if (!input.probe) return { path: 'chromium', reason: 'no probe result' };
    // NVENC first (the one Chromium cannot reach on Linux, and on a hybrid laptop the dGPU encodes regardless of which GPU draws the desktop);
    // otherwise VA-API (Intel iHD/i965, AMD radeonsi: the helper has already picked the node that passed its self-test).
    const backend: 'nvenc' | 'vaapi' | null = input.probe.nvenc ? 'nvenc' : input.probe.vaapi ? 'vaapi' : null;
    if (!backend) return { path: 'chromium', reason: 'no native backend available' };
    const want = input.wantFps;
    const sustained = input.probe.sustainedFps;
    if (typeof want === 'number' && want > 0 && typeof sustained === 'number' && sustained > 0) {
        const ceiling = Math.floor(sustained * NATIVE_SUSTAIN_FACTOR);
        if (ceiling < NATIVE_MIN_FPS) return { path: 'chromium', reason: `${backend} too slow at this size (${sustained} fps sustained)` };
        return { path: 'native', backend, reason: ceiling < want ? `${backend} available, fps lowered to what it sustains` : `${backend} available`, fps: Math.min(want, ceiling) };
    }
    return { path: 'native', backend, reason: `${backend} available`, ...(typeof want === 'number' && want > 0 ? { fps: want } : {}) };
}
