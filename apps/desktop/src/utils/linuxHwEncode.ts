/**
 * Linux hardware (VA-API) video encode, renderer side: what to do when the
 * hardware encoder lets a share or the camera down.
 *
 * Main turns the Chromium feature `AcceleratedVideoEncoder` on by default on
 * Linux (electron/linux-video-encode.ts). Where Chromium has a VA-API encoder
 * it is used (measured: VP8 / H.264 at ~60 fps at 1080p60 on Arch, CachyOS and
 * openSUSE); where it does not, nothing changes: MediaCapabilities says
 * powerEfficient:false for every codec and the share is software VP8 as ever.
 * This module covers the third case, a hardware encoder that WAS working and
 * then was not:
 *
 *   hw_lost     a sender whose share_fps samples said hardware reports software
 *               (libwebrtc swapped in its software fallback inside the sender)
 *   high_start  an H.264 High encoder (hardware only, no software twin) produced nothing
 *   stall       the encoder produced no frame at all (the share's start watchdog)
 *   drift       the sender is sending another codec than it was published with
 *
 * Each does two things, once per kind per app session:
 *   1. SESSION fallback: `linuxHwEncodeDistrusted()` turns true and
 *      probeHardwareEncoders() answers "no hardware encoder" from then on, so
 *      the next codec decision (the republish the callers already do) and the
 *      camera's decision pick the software path without trusting the probe.
 *   2. LEDGER: one word is sent to main (`reportLinuxHwEncodeFailure`), which
 *      writes at most one entry per launch; two bad launches on one app version
 *      keep hardware encode off for the following ones.
 * A `call event` records the kind (a fixed word, the codec and the encoder
 * implementation name - nothing about people).
 *
 * Counted ONLY when this launch actually has the feature on (asked once from
 * main) and only on Linux: a software encoder having trouble is not evidence
 * against VA-API, and an older main process (no state) counts as "feature off".
 */
import { logCallEvent } from './callEventLog';

export type LinuxHwFailureKind = 'gpu_crash' | 'hw_lost' | 'stall' | 'drift' | 'high_start';

export interface LinuxHwEncodeEnv {
    isLinux(): boolean;
    /** Whether THIS launch has hardware encode on. null = unknown (counts as off). */
    featureActive(): Promise<boolean | null>;
    report(kind: LinuxHwFailureKind): Promise<unknown>;
}

const defaultEnv: LinuxHwEncodeEnv = {
    isLinux: () => typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent),
    featureActive: async () => {
        try {
            const raw = await window.electronAPI?.getStartupFlags?.();
            const r = raw && typeof raw === 'object' ? (raw as { linuxHwEncode?: { active?: unknown } | null }).linuxHwEncode : null;
            return r && typeof r.active === 'boolean' ? r.active : null;
        } catch {
            return null;
        }
    },
    report: (kind) => window.electronAPI?.reportLinuxHwEncodeFailure?.(kind) ?? Promise.resolve(false),
};

let env: LinuxHwEncodeEnv = defaultEnv;
let featureActiveCache: Promise<boolean | null> | null = null;
const reportedKinds = new Set<LinuxHwFailureKind>();
let distrusted = false;
/** What the last share_fps sample of the live share said: hardware encoder or not (null = unknown / no share). */
let lastShareHardware: boolean | null = null;

/**
 * Chromium's encoder implementation name -> hardware? The Linux names are
 * `VaapiVideoEncodeAccelerator` (possibly inside `SimulcastEncoderAdapter (...)`);
 * software ones are libvpx / OpenH264 / libaom. null = cannot tell (never counts as either).
 */
export function linuxEncoderIsHardware(name: string | undefined | null, powerEfficient?: unknown): boolean | null {
    if (typeof powerEfficient === 'boolean') return powerEfficient;
    if (!name) return null;
    if (/vaapi|accelerat|external|hardware/i.test(name)) return true;
    if (/libvpx|openh264|libaom|dav1d|ffmpeg|software/i.test(name)) return false;
    return null;
}

/** True once a hardware-encoder failure was seen this app session: stop trusting "this codec is hardware". */
export function linuxHwEncodeDistrusted(): boolean { return distrusted; }

/**
 * The live share's encoder as of the latest share_fps sample. Fed by
 * ShareSoftwareGuard.observe for every sample; the drift watch reads it to tell
 * "the hardware encoder fell over" from "a software encoder was handed a size it cannot open".
 */
export function noteShareEncoderSample(hw: boolean | null | undefined): void {
    lastShareHardware = typeof hw === 'boolean' ? hw : null;
}
export function lastShareEncoderWasHardware(): boolean | null { return lastShareHardware; }

export interface FailureContext {
    /** encoderImplementation of the failing sender, if the stats said. */
    encoder?: string;
    /** The codec the share / camera was published with. */
    codec?: string;
}

/**
 * Report one hardware-encoder failure. Resolves to what happened:
 * 'counted' (session fallback armed, main told), 'repeat' (this kind already counted this session),
 * 'ignored' (not Linux, feature off this launch, or the evidence says it was a software encoder).
 */
export async function noteLinuxHwEncodeFailure(kind: LinuxHwFailureKind, ctx: FailureContext = {}): Promise<'counted' | 'repeat' | 'ignored'> {
    if (!env.isLinux()) return 'ignored';
    if (reportedKinds.has(kind)) return 'repeat';
    // Is it plausibly the hardware encoder?
    const encoderHw = linuxEncoderIsHardware(ctx.encoder);
    if (kind === 'stall' && encoderHw === false) return 'ignored'; // a software encoder that never opened
    if (kind === 'drift' && encoderHw !== true && lastShareHardware !== true) return 'ignored';
    if (!featureActiveCache) featureActiveCache = env.featureActive();
    if ((await featureActiveCache) !== true) return 'ignored';
    if (reportedKinds.has(kind)) return 'repeat';
    reportedKinds.add(kind);
    distrusted = true;
    logCallEvent('linux_hw_encode', { reason: kind, codec: ctx.codec || 'unknown', enc: (ctx.encoder || 'unknown').slice(0, 48) });
    try { await env.report(kind); } catch { /* the session fallback is already armed; the ledger entry is best effort */ }
    return 'counted';
}

/** Test seam. */
export function __setLinuxHwEncodeEnvForTests(e: Partial<LinuxHwEncodeEnv> | null): void {
    env = e ? { ...defaultEnv, ...e } : defaultEnv;
    featureActiveCache = null;
    reportedKinds.clear();
    distrusted = false;
    lastShareHardware = null;
}
