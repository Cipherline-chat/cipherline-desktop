/**
 * Renderer side of the Settings → Advanced startup flags (screen capture
 * method, capture timing log). The single source of truth is main's
 * <userData>/startup-flags.json (electron/startup-flags.ts) — nothing is
 * persisted in the renderer, so there is no secureLocalStore key for
 * backupRegistry.ts to classify (and the file is machine-specific anyway).
 *
 * `parseStartupFlagsState` narrows main's reply field by field, the same way
 * screenShareDiagnostics.ts does, so an older/newer main process can never
 * feed the settings card a shape it trusts blindly.
 */

export type ScreenCapturerChoice = 'auto' | 'dxgi' | 'wgc';

export interface StartupFlagValues {
    screenCapturer: ScreenCapturerChoice;
    captureLog: boolean;
}

export interface StartupFlagsState {
    platform: string;
    /** In startup-flags.json — what the NEXT launch uses. */
    saved: StartupFlagValues;
    /** What THIS launch applied. */
    active: StartupFlagValues;
    /** An environment variable is forcing this launch's value. */
    envOverride: { screenCapturer: boolean; captureLog: boolean };
    captureLogPath: string | null;
    captureLogMaxBytes: number | null;
}

const capturer = (v: unknown): ScreenCapturerChoice =>
    v === 'dxgi' || v === 'wgc' ? v : 'auto';

const values = (v: unknown): StartupFlagValues => {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return { screenCapturer: capturer(r.screenCapturer), captureLog: r.captureLog === true };
};

export function parseStartupFlagsState(v: unknown): StartupFlagsState | null {
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    if (!r.saved || typeof r.saved !== 'object' || !r.active || typeof r.active !== 'object') return null;
    const env = (r.envOverride && typeof r.envOverride === 'object' ? r.envOverride : {}) as Record<string, unknown>;
    return {
        platform: typeof r.platform === 'string' ? r.platform : 'unknown',
        saved: values(r.saved),
        active: values(r.active),
        envOverride: { screenCapturer: env.screenCapturer === true, captureLog: env.captureLog === true },
        captureLogPath: typeof r.captureLogPath === 'string' && r.captureLogPath ? r.captureLogPath : null,
        captureLogMaxBytes: typeof r.captureLogMaxBytes === 'number' && r.captureLogMaxBytes > 0 ? r.captureLogMaxBytes : null,
    };
}

/**
 * True when a restart would change what is running: a saved value differs
 * from the active one AND no env var is overriding it (with an override the
 * restart would change nothing, so offering one would be a lie).
 * The capture method only counts on Windows, the one platform it applies to.
 */
export function restartPending(s: StartupFlagsState): boolean {
    const capturerPending = s.platform === 'win32'
        && !s.envOverride.screenCapturer
        && s.saved.screenCapturer !== s.active.screenCapturer;
    const logPending = !s.envOverride.captureLog && s.saved.captureLog !== s.active.captureLog;
    return capturerPending || logPending;
}
