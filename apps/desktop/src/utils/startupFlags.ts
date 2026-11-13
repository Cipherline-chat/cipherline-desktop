/**
 * Renderer side of the startup flags: Settings → Advanced (screen capture
 * method, capture timing log) and Settings → Voice & Video ("Prioritize call
 * video while gaming", `gamingVideo` — see utils/gamingVideoMode.ts). The single source of truth is main's
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
    /** Settings -> Voice & Video -> "Prioritize calls and screen share while gaming". ON by default. */
    gamingVideo: boolean;
    /** Linux: Settings -> Advanced -> "Hardware video encoding". The SAVED choice; ON by default. */
    linuxHwEncode: boolean;
    /** Linux: Settings -> Advanced -> "Hardware video decoding". The SAVED choice; ON by default. */
    linuxHwDecode: boolean;
}

/** Linux hardware video encode, this launch (main: LINUX_HW_ENCODE in main.ts). Null off Linux / from an older main. */
export interface LinuxHwEncodeStatus {
    /** The VA-API encoder feature is on in this launch. */
    active: boolean;
    /** Short reason from the launch decision, e.g. "auto: on", "off (Settings)", "stayed software: ...". */
    reason: string;
    /** Earlier launches' failures are what kept it off. */
    lockedOut: boolean;
    /** The lockout was cleared since (the user turned it back on): the next launch tries again. */
    lockoutCleared: boolean;
    /** Hardware encode failed during this launch (it will count toward a lockout). */
    failureThisLaunch: boolean;
}

/** Linux hardware video DECODE, this launch (main: LINUX_HW_DECODE). Null off Linux / from an older main. */
export interface LinuxHwDecodeStatus {
    active: boolean;
    reason: string;
    /** not_applicable | ready | forced | missing_driver | no_modeset | hybrid | nouveau */
    nvidia: string;
    gpus: string;
    lockedOut: boolean;
    lockoutCleared: boolean;
    failureThisLaunch: boolean;
    /** Set only when an NVIDIA GPU could decode in hardware but something is missing. */
    hint: { kind: 'install_driver' | 'enable_modeset'; pkg: string | null; install: string | null; text: string } | null;
}

export interface StartupFlagsState {
    platform: string;
    /** In startup-flags.json — what the NEXT launch uses. */
    saved: StartupFlagValues;
    /** What THIS launch applied. */
    active: StartupFlagValues;
    /** An environment variable is forcing this launch's value. */
    envOverride: { screenCapturer: boolean; captureLog: boolean; linuxHwEncode: boolean; linuxHwDecode: boolean };
    linuxHwEncode: LinuxHwEncodeStatus | null;
    linuxHwDecode: LinuxHwDecodeStatus | null;
    captureLogPath: string | null;
    captureLogMaxBytes: number | null;
}

const capturer = (v: unknown): ScreenCapturerChoice =>
    v === 'dxgi' || v === 'wgc' ? v : 'auto';

const values = (v: unknown): StartupFlagValues => {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        screenCapturer: capturer(r.screenCapturer),
        captureLog: r.captureLog === true,
        // Default ON: only an explicit false is off (an older main without the
        // field never reaches here as "off" - it has no setting to show).
        gamingVideo: r.gamingVideo !== false,
        // Default ON, like gamingVideo.
        linuxHwEncode: r.linuxHwEncode !== false,
        linuxHwDecode: r.linuxHwDecode !== false,
    };
};

const decodeStatus = (v: unknown): LinuxHwDecodeStatus | null => {
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    if (typeof r.active !== 'boolean') return null;
    const h = r.hint && typeof r.hint === 'object' ? r.hint as Record<string, unknown> : null;
    const hintKind = h && (h.kind === 'install_driver' || h.kind === 'enable_modeset') && typeof h.text === 'string' ? h.kind : null;
    return {
        active: r.active,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 160) : '',
        nvidia: typeof r.nvidia === 'string' ? r.nvidia.slice(0, 24) : 'not_applicable',
        gpus: typeof r.gpus === 'string' ? r.gpus.slice(0, 96) : '',
        lockedOut: r.lockedOut === true,
        lockoutCleared: r.lockoutCleared === true,
        failureThisLaunch: r.failureThisLaunch === true,
        hint: hintKind ? {
            kind: hintKind,
            pkg: typeof h!.pkg === 'string' ? h!.pkg.slice(0, 48) : null,
            install: typeof h!.install === 'string' ? h!.install.slice(0, 160) : null,
            text: String(h!.text).slice(0, 400),
        } : null,
    };
};

const linuxStatus = (v: unknown): LinuxHwEncodeStatus | null => {
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    if (typeof r.active !== 'boolean') return null;
    return {
        active: r.active,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 160) : '',
        lockedOut: r.lockedOut === true,
        lockoutCleared: r.lockoutCleared === true,
        failureThisLaunch: r.failureThisLaunch === true,
    };
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
        envOverride: { screenCapturer: env.screenCapturer === true, captureLog: env.captureLog === true, linuxHwEncode: env.linuxHwEncode === true, linuxHwDecode: env.linuxHwDecode === true },
        linuxHwEncode: linuxStatus(r.linuxHwEncode),
        linuxHwDecode: decodeStatus(r.linuxHwDecode),
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
    return capturerPending || logPending || gamingVideoRestartPending(s) || linuxHwEncodeRestartPending(s) || linuxHwDecodeRestartPending(s);
}

/**
 * Linux hardware video encode: the saved choice differs from the one this launch
 * was decided from, or a lockout was cleared (turning it back on is the retry).
 * Not offered when the environment variable decides it (a restart would change nothing).
 */
export function linuxHwEncodeRestartPending(s: StartupFlagsState): boolean {
    if (s.platform !== 'linux' || s.envOverride.linuxHwEncode || !s.linuxHwEncode) return false;
    return s.saved.linuxHwEncode !== s.active.linuxHwEncode || s.linuxHwEncode.lockoutCleared;
}

/** Linux hardware video decode: same rule as encode (saved differs from this launch, or a lockout was cleared). */
export function linuxHwDecodeRestartPending(s: StartupFlagsState): boolean {
    if (s.platform !== 'linux' || s.envOverride.linuxHwDecode || !s.linuxHwDecode) return false;
    return s.saved.linuxHwDecode !== s.active.linuxHwDecode || s.linuxHwDecode.lockoutCleared;
}

/** One sentence on what hardware video DECODING is doing in THIS launch, with the NVIDIA hint when it applies. */
export function linuxHwDecodeStatusLine(s: StartupFlagsState): string {
    const h = s.linuxHwDecode;
    if (!h) return '';
    if (h.lockedOut) {
        return h.lockoutCleared
            ? 'It was switched off after repeated graphics-process crashes; it will be tried again after a restart.'
            : 'It was switched off automatically after repeated graphics-process crashes on this computer. Turn it on to try again.';
    }
    if (!h.active) return 'Off in this session.';
    if (h.hint) return `Not available yet: ${h.hint.text}`;
    return h.failureThisLaunch ? 'On in this session, but the graphics process crashed, which counts toward switching it off.' : 'On in this session. Whether a given stream decodes in hardware is shown in a diagnostics report (decoder, hw).';
}

/** One sentence on what hardware video encoding is doing in THIS launch (Settings -> Advanced, Linux). */
export function linuxHwEncodeStatusLine(s: StartupFlagsState): string {
    const h = s.linuxHwEncode;
    if (!h) return '';
    if (h.lockedOut) {
        return h.lockoutCleared
            ? 'It was switched off after repeated encoder problems; it will be tried again after a restart.'
            : 'It was switched off automatically after repeated encoder problems on this computer. Turn it on to try again.';
    }
    if (h.active) return h.failureThisLaunch ? 'On in this session, but the hardware encoder failed, so the CPU is being used.' : 'On in this session.';
    return 'Off in this session.';
}

/**
 * The gaming-video mode's launch-time switches differ from the saved choice —
 * in either direction: turning it OFF also needs a restart to drop them. (Its
 * runtime half has already followed the saved value; this is only about the
 * Chromium switches.)
 */
export function gamingVideoRestartPending(s: StartupFlagsState): boolean {
    return s.saved.gamingVideo !== s.active.gamingVideo;
}
