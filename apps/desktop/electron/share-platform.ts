/**
 * Which parts of "Prioritize calls and screen share while gaming" exist on
 * which OS — ONE table, so the code that applies each part, the diagnostics
 * that report it and the tests that pin it can never disagree.
 *
 * The setting is shown on every platform and does what the platform allows;
 * nothing here changes what Windows does. Written 2026-10-14 for the
 * Linux/macOS parity pass; the evidence behind each cell:
 *
 *   priorityBoost        Windows only. ABOVE_NORMAL / HIGH priority classes need
 *                        no privilege there. On Linux/macOS a NEGATIVE nice value
 *                        needs CAP_SYS_NICE / root (or a raised RLIMIT_NICE),
 *                        which an ordinary desktop user's app does not have, so
 *                        the call would only fail. We never try — and, because
 *                        setpriority() can only LOWER our standing without that
 *                        privilege, never touching it is also how "never lower
 *                        our own priority" is guaranteed off Windows.
 *   powerThrottleOptOut  Windows only (EcoQoS / timer-resolution coalescing is a
 *                        Windows 11 policy; the addon call is Win32).
 *   powerBlocker         EVERY platform. `prevent-app-suspension` is, in
 *                        Chromium 150: Windows -> a PowerRequestExecutionRequired
 *                        request; macOS -> an IOPMAssertion NoIdleSleep (which also
 *                        keeps App Nap off the process); Linux -> a D-Bus suspend
 *                        inhibit (org.gnome.SessionManager / freedesktop
 *                        PowerManagement) plus a screensaver suspend. Harmless
 *                        where it does little.
 *   backgroundSwitches   EVERY platform: --disable-renderer-backgrounding,
 *                        --disable-backgrounding-occluded-windows and
 *                        --disable-background-timer-throttling are Chromium-level.
 *   occlusionFeatureOff  Windows only: CalculateNativeWinOcclusion is a Windows
 *                        feature. macOS and Linux have no equivalent native
 *                        occlusion tracker to switch off (the backgrounding
 *                        switches above cover Chromium's own occlusion path).
 *   gpuPriority          Windows only (D3DKMT scheduling class, share-boost.ts
 *                        GpuSchedulingBoost). Linux: EGL_IMG_context_priority /
 *                        VK_EXT_global_priority are chosen inside Chromium's GPU
 *                        process, and HIGH needs CAP_SYS_NICE — not feasible from
 *                        the app. macOS: no public per-process GPU priority.
 *   foreground           What has the screen (`fg_state` / `fg_exe` / `fg_cover`
 *                        in share_fps and share_background): 'native' = the
 *                        addon answers (Windows). 'unavailable' = Linux and macOS
 *                        — reported honestly as fg_state "unavailable", never
 *                        guessed. Wayland has no API for another client's window
 *                        at all; an X11 answer (_NET_ACTIVE_WINDOW + _NET_WM_PID +
 *                        _NET_WM_STATE_FULLSCREEN) would need libX11 linked into
 *                        an addon that Linux builds do not ship today (CI builds
 *                        no native addon for Linux), so it is deliberately not
 *                        done; macOS NSWorkspace.frontmostApplication would not
 *                        say whether the window covers the display anyway.
 *
 * Deliberately free of any `electron` import (share-platform.test.ts).
 */

export type ForegroundSupport = 'native' | 'unavailable';

export interface ShareBoostSupport {
    priorityBoost: boolean;
    powerThrottleOptOut: boolean;
    powerBlocker: boolean;
    backgroundSwitches: boolean;
    occlusionFeatureOff: boolean;
    gpuPriority: boolean;
    foreground: ForegroundSupport;
}

export function shareBoostSupport(platform: string): ShareBoostSupport {
    const win = platform === 'win32';
    return {
        priorityBoost: win,
        powerThrottleOptOut: win,
        powerBlocker: true,
        backgroundSwitches: true,
        occlusionFeatureOff: win,
        gpuPriority: win,
        foreground: win ? 'native' : 'unavailable',
    };
}

/**
 * What to ask Electron's display-media callback for as `audio`, when the
 * renderer wants system audio and the native capture (WASAPI / ScreenCaptureKit)
 * is not carrying it. One table cell per OS, so main and its tests cannot disagree.
 *
 *   win32   'loopbackWithMute' for a screen (system audio, Cipherline muted
 *           locally so the call is not echoed back into the share); a single
 *           window has no per-window loopback here, so none.
 *   darwin  none: Electron documents loopback as Windows-only.
 *   linux   none. MEASURED on Electron 43.2.0 / Linux x64 (X11 under Xvfb,
 *           PulseAudio running), a 25 s race against getDisplayMedia with the
 *           handler answering:
 *             audio: 'loopback'          -> resolves in ~0.2 s with a "System audio" track
 *             audio: 'loopbackWithMute'  -> did not settle in 25 s, twice, on a fresh process (the
 *                                           share button would sit on "Starting screen
 *                                           share..." for good); after a plain-loopback capture
 *                                           in the same process it failed at once with
 *                                           "Could not start audio source"
 *           Plain 'loopback' would work, but Linux has no per-app exclusion, so it
 *           carries the call's own voices straight back to the people speaking (a
 *           guaranteed echo), and the one mute that avoids it is the one that
 *           hangs. So Chromium never carries Linux system audio: it comes from the native
 *           PipeWire addon (src-native/audio_capture_linux.cc) when that is supported, and
 *           otherwise the picker says so and the share starts without audio.
 */
export function chromiumLoopbackAudioMode(input: {
    platform: string;
    withAudio: boolean;
    isWindow: boolean;
    /** The native capture addon carries the audio instead (Windows). */
    nativeAudioAvailable: boolean;
}): 'loopbackWithMute' | undefined {
    if (!input.withAudio || input.nativeAudioAvailable) return undefined;
    if (input.platform === 'darwin' || input.platform === 'linux') return undefined;
    return input.isWindow ? undefined : 'loopbackWithMute';
}
