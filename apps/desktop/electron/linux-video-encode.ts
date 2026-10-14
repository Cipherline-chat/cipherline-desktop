/**
 * Linux hardware H.264 encode for screen share (VA-API) — the launch-time
 * decision, as a pure function.
 *
 * ── What Chromium 150 needs (read from chromium/src @150.0.7871.250 and
 *    checked against the Electron 43.7.9 binary's feature table) ──────────────
 *   • The feature `AcceleratedVideoEncoder` (media::kAcceleratedVideoEncodeLinux,
 *     media_switches.cc) — DISABLED by default on Linux. It is read in three
 *     places: GpuVideoEncodeAcceleratorFactory (CreateVaapiVEA returns nothing
 *     without it), RenderThreadImpl::GetGpuFactories (the renderer's encoder
 *     factory is not built without it) and the chrome://gpu "Video Encode"
 *     status. This is the whole switch: `VaapiVideoEncoder` (the pre-2023 name)
 *     and `VaapiVideoDecodeLinuxGL` do NOT exist in 150, and decode is already
 *     on by default (`AcceleratedVideoDecodeLinuxGL`).
 *   • `VaapiLowPowerEncoderGen9x` (Intel Skylake-Comet Lake low-power H.264 /
 *     VP9) is already ENABLED by default — nothing to add for old Intel.
 *   • Not a flag but a precondition: GPU compositing must be on in the
 *     renderer (GetGpuFactories returns null otherwise) and the GPU process
 *     needs a native-pixmap-capable display — Wayland, or X11 with DRI3. Under
 *     Xvfb (no DRI3) Chromium never even opens VA-API (measured: no libva
 *     driver load, no hardware decode either).
 *   • A working VA-API driver on the render node (intel-media-va-driver / iHD
 *     or i965 for Intel, mesa-va-drivers for AMD radeonsi).
 *
 * ── Who gets hardware, who does not ───────────────────────────────────────────
 *   • AMD (radeonsi VA-API encode) and recent Intel (iHD): candidates.
 *   • NVIDIA: NO. nvidia-vaapi-driver is decode-only, and Chromium refuses to
 *     init VA-API on nvidia-drm anyway unless `VaapiOnNvidiaGPUs` (off by
 *     default; deliberately NOT enabled here). Those users stay on software
 *     (VP8 by default, see decideScreenShareCodec) whatever this returns.
 *
 * ── Status: OPT-IN, default off ────────────────────────────────────────────────
 * Measured 2026-10-14 on the dev box (Intel UHD 630, iHD 24.1.0, Mesa 25.2.8),
 * Electron 43.7.9 AND Chrome for Testing 153, on a real GPU-composited Wayland
 * session (sway, headless output on the Intel render node): with the feature
 * on, chrome://gpu reports "Video Encode: Hardware accelerated", VA-API
 * enumerates H.264 EncSliceLP profiles through iHD, and VA-API HARDWARE
 * DECODE works (receiver decoderImplementation "ExternalDecoder") — but
 * Chromium's encoder provider still reports no profiles, WebCodecs
 * `prefer-hardware` fails with EncoderStatus 20 (acceleration support
 * missing) and getStats says encoderImplementation "OpenH264",
 * powerEfficientEncoder false, with and without the flag. The reason was not
 * isolated (that GPU is Gen9.5, a low-power-entrypoint-only part). Because a
 * flag that could not be shown to help on the one machine available must not
 * change what every Linux user runs, this is OFF unless asked for:
 * CIPHERLINE_LINUX_HW_ENCODE=1 turns it on for a tester on AMD / newer Intel,
 * and the existing `share_fps` event (`enc` = encoderImplementation, `hw` =
 * powerEfficientEncoder) says at once whether it worked.
 *
 * ── The fallback ───────────────────────────────────────────────────────────────
 * Needs no code of ours: with the feature on and a hardware encoder that
 * cannot start (no VA-API, a driver error), Chromium's EncoderAdapter keeps
 * the OpenH264 encoder behind it and silently uses that
 * (video_codec_factory.cc), and src/utils/screenShare.ts picks the share codec
 * from what MediaCapabilities says is power-efficient — so a machine without
 * a hardware encoder never asks for H.264 in the first place. A hardware
 * encoder that starts and then produces nothing is the existing
 * ShareEncoderWatchdog / watchH264HighStart path in the renderer. This
 * function adds the one thing Chromium cannot know: do not even try when the
 * user launched with the GPU or video acceleration switched off.
 *
 * Deliberately free of any `electron` import (linux-video-encode.test.ts).
 */

export const LINUX_HW_ENCODE_FEATURE = 'AcceleratedVideoEncoder';
export const LINUX_HW_ENCODE_ENV = 'CIPHERLINE_LINUX_HW_ENCODE';

/** Flip to true once hardware encode has been seen working on real AMD / Intel hardware. */
export const LINUX_HW_ENCODE_DEFAULT_ON = false;

export type LinuxHwEncodeMode = 'auto' | 'on' | 'off';

/** `CIPHERLINE_LINUX_HW_ENCODE`: 1/on/true/yes -> on, 0/off/false/no -> off, anything else -> auto. */
export function parseLinuxHwEncodeMode(v: string | undefined): LinuxHwEncodeMode {
    const s = (v ?? '').trim().toLowerCase();
    if (s === '1' || s === 'on' || s === 'true' || s === 'yes') return 'on';
    if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 'off';
    return 'auto';
}

/** Command-line switches that mean "the user does not want the GPU doing video". */
export const LINUX_HW_ENCODE_BLOCKING_SWITCHES: readonly string[] = Object.freeze([
    'disable-gpu',
    'disable-accelerated-video-encode',
]);

export interface LinuxHwEncodeInput {
    platform: string;
    mode: LinuxHwEncodeMode;
    /** app.commandLine.hasSwitch — true when the process was launched with that switch. */
    hasSwitch(name: string): boolean;
}

export interface LinuxHwEncodeDecision {
    enable: boolean;
    /** Entries for the single --enable-features list (empty when disabled). */
    features: string[];
    /** One short reason for the capture:switches diagnostics event. */
    reason: string;
}

export function decideLinuxHwEncode(input: LinuxHwEncodeInput): LinuxHwEncodeDecision {
    const no = (reason: string): LinuxHwEncodeDecision => ({ enable: false, features: [], reason });
    if (input.platform !== 'linux') return no('not linux');
    if (input.mode === 'off') return no('off (env)');
    for (const sw of LINUX_HW_ENCODE_BLOCKING_SWITCHES) {
        if (input.hasSwitch(sw)) return no(`blocked by --${sw}`);
    }
    if (input.mode === 'auto' && !LINUX_HW_ENCODE_DEFAULT_ON) return no('auto: off by default');
    return {
        enable: true,
        features: [LINUX_HW_ENCODE_FEATURE],
        reason: input.mode === 'on' ? 'on (env)' : 'auto: on',
    };
}
