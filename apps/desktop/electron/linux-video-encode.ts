/**
 * Linux hardware video encode for screen share (VA-API) — the launch-time
 * decision, the persisted failure ledger, and the pure rules around both.
 *
 * ── What Chromium 150 needs (read from chromium/src @150.0.7871.250 and
 *    checked against the Electron 43.x binary's feature table) ────────────────
 *   • The feature `AcceleratedVideoEncoder` (media::kAcceleratedVideoEncodeLinux,
 *     media_switches.cc) — DISABLED by default on Linux. It is read in three
 *     places: GpuVideoEncodeAcceleratorFactory (CreateVaapiVEA returns nothing
 *     without it), RenderThreadImpl::GetGpuFactories (the renderer's encoder
 *     factory is not built without it) and the chrome://gpu "Video Encode"
 *     status. This is the whole switch: `VaapiVideoEncoder` (the pre-2023 name)
 *     and `VaapiVideoDecodeLinuxGL` do NOT exist in 150, and decode is already
 *     on by default (`AcceleratedVideoDecodeLinuxGL`).
 *   • Not a flag but a precondition: GPU compositing must be on in the
 *     renderer (GetGpuFactories returns null otherwise) and the GPU process
 *     needs a native-pixmap-capable display — Wayland, or X11 with DRI3. Under
 *     Xvfb (no DRI3) Chromium never even opens VA-API.
 *   • A working VA-API driver on the render node WITH AN ENCODE ENTRYPOINT
 *     Chromium will use (see "Who gets hardware" below).
 *
 * ── Who gets hardware, who does not (distro matrix, Electron 43.8.1, 2026-11-04) ─
 *   • Arch, CachyOS, openSUSE Tumbleweed (Wayland cells): VaapiVideoEncodeAccelerator
 *     encodes VP8, H.264 Constrained Baseline and H.264 High at ~60 fps at 1080p60
 *     (software: libvpx VP8 40-48, OpenH264 34-60).
 *   • Ubuntu 22.04/24.04, Debian 12: do NOT engage on the test GPU (Intel UHD 630, Gen9.5).
 *     Isolated 2026-11-04 on ubuntu-24.04 (same Electron, same switches, same GPU):
 *       - stock `intel-media-va-driver` (iHD 24.1.0, the free build) lists H.264 `EncSliceLP`
 *         ONLY and no VP8 encode; Chromium builds the VA-API encoder object for its profile
 *         query and destroys it unused (no Initialize), so every codec stays software;
 *       - `VaapiLowPowerEncoderGen9x` (the Chromium feature for LP on Gen9) changes nothing;
 *       - `intel-media-va-driver-non-free` (same iHD 24.1.0, the build with the proprietary
 *         media kernels; Ubuntu multiverse) adds `EncSlice` and VP8 encode and Chromium then
 *         encodes VP8 60 fps, H.264 CB 59.6 fps, H.264 High 52 fps in hardware;
 *       - forcing `LIBVA_DRIVER_NAME=i965` (i965-va-driver, which has EncSlice on Gen9) does
 *         NOT work: libva-intel-driver aborts in intel_enc_hw_context_init
 *         ("Assertion `encoder_context->mfc_context' failed") and the share stays software.
 *     So it is the distro's driver BUILD, not a switch we can set. Nothing here forces a libva
 *     driver (i965 is unmaintained and aborts the process); a user who wants hardware encode on
 *     Ubuntu / Debian installs intel-media-va-driver-non-free. UNTESTED: Gen11+ Intel (Tiger
 *     Lake and newer), whose iHD has only the LP entrypoint on every distro and which Chromium
 *     does drive through LP - expected to engage on Ubuntu / Debian with the stock driver.
 *   • Fedora: no encode-capable driver without RPM Fusion (stock mesa-va-drivers
 *     and intel-media-driver are decode-only).
 *   • NVIDIA: NO. Chromium on Linux has no NVENC path; nvidia-vaapi-driver is
 *     decode-only and Chromium refuses to init VA-API on nvidia-drm unless
 *     `VaapiOnNvidiaGPUs` (off by default; deliberately NOT enabled here).
 *     Those users stay on software (VP8, see decideScreenShareCodec) whatever
 *     this returns.
 *
 * ── Default ON, safe because of what happens when it does not work ──────────
 * Enabling the feature on a machine with no usable VA-API encoder changes
 * NOTHING: Chromium's encoder provider reports no profiles,
 * navigator.mediaCapabilities says powerEfficient:false for every codec,
 * src/utils/screenShare.ts picks software VP8 exactly as before, and
 * getStats() says encoderImplementation libvpx / OpenH264. Hardware is used only
 * where Chromium itself says it can encode in hardware, and the renderer trusts
 * `encoderImplementation`, never `getGPUFeatureStatus().video_encode` (which
 * stays `disabled_software` even while the VA-API encoder is running).
 *
 * ── When the hardware encoder fails ────────────────────────────────────────────
 *   1. Chromium/libwebrtc: a VA-API encoder that cannot start or errors is
 *      replaced INSIDE the sender by the software encoder of the same codec
 *      (VideoEncoderSoftwareFallbackWrapper: VP8, H.264 Constrained Baseline).
 *      H.264 High has no software encoder; its start is watched
 *      (watchH264HighStart) and the codec drift watch republishes.
 *   2. The renderer (src/utils/linuxHwEncode.ts) turns the evidence — a hardware
 *      encoder that went software mid-share, an H.264 High encoder that produced
 *      nothing, an encoder stall, a codec drift — into (a) a SESSION fallback
 *      (no hardware probe is trusted again until the app restarts) and (b) one
 *      failure reported to main.
 *   3. Main records at most ONE failure per launch in the ledger below, also
 *      when the GPU process crashes while the feature is on. After
 *      LINUX_HW_ENCODE_LOCKOUT_LAUNCHES launches with a failure on the same app
 *      version inside LINUX_HW_ENCODE_LEDGER_WINDOW_MS, the next launches stay
 *      software ("stayed software: ..."). A new app version, 30 quiet days, the
 *      Settings toggle (off then on), or CIPHERLINE_LINUX_HW_ENCODE=1 retry it.
 *
 * ── Off switches ────────────────────────────────────────────────────────────────
 *   env CIPHERLINE_LINUX_HW_ENCODE=0 (wins over everything), Settings → Advanced
 *   "Hardware video encoding (Linux)" (startup-flags.json `linuxHwEncode`), and the
 *   process being launched with --disable-gpu or --disable-accelerated-video-encode.
 *   CIPHERLINE_LINUX_HW_ENCODE=1 forces it on, bypassing the Settings toggle and
 *   the ledger lockout (a tester's knob).
 *
 * Deliberately free of any `electron` import (linux-video-encode.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';

export const LINUX_HW_ENCODE_FEATURE = 'AcceleratedVideoEncoder';
export const LINUX_HW_ENCODE_ENV = 'CIPHERLINE_LINUX_HW_ENCODE';

/**
 * ON by default (2026-11-04). The distro matrix showed hardware encode at ~60 fps
 * where Chromium supports it and a no-op everywhere else — see the header.
 */
export const LINUX_HW_ENCODE_DEFAULT_ON = true;

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

// ── The failure ledger ──────────────────────────────────────────────────────────

/** What went wrong with the hardware encoder; the only words that ever reach the ledger. */
export const LINUX_HW_ENCODE_FAILURE_KINDS = ['gpu_crash', 'hw_lost', 'stall', 'drift', 'high_start'] as const;
export type LinuxHwEncodeFailureKind = (typeof LINUX_HW_ENCODE_FAILURE_KINDS)[number];

export function isLinuxHwEncodeFailureKind(v: unknown): v is LinuxHwEncodeFailureKind {
    return typeof v === 'string' && (LINUX_HW_ENCODE_FAILURE_KINDS as readonly string[]).includes(v);
}

export const LINUX_HW_ENCODE_LEDGER_FILENAME = 'linux-hw-encode-failures.json';
export const LINUX_HW_ENCODE_LEDGER_MAX_BYTES = 4 * 1024;
/** Launches (one entry each) with a failure, on the running app version, that switch hardware encode off. */
export const LINUX_HW_ENCODE_LOCKOUT_LAUNCHES = 2;
/** Entries older than this are forgotten (a driver or Mesa update gets another try). */
export const LINUX_HW_ENCODE_LEDGER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_ENTRIES = 8;

export interface LinuxHwEncodeLedgerEntry {
    /** Epoch ms. */
    at: number;
    /** App version that ran (a new version retries). */
    version: string;
    kind: LinuxHwEncodeFailureKind;
}

export interface LinuxHwEncodeLedger { entries: LinuxHwEncodeLedgerEntry[] }

export const EMPTY_LEDGER: Readonly<LinuxHwEncodeLedger> = Object.freeze({ entries: [] as LinuxHwEncodeLedgerEntry[] });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict, never throws: anything that is not exactly what this module writes is dropped (entry by entry). */
export function parseLinuxHwEncodeLedger(text: string | null | undefined): LinuxHwEncodeLedger {
    if (typeof text !== 'string' || text.length === 0 || text.length > LINUX_HW_ENCODE_LEDGER_MAX_BYTES) return { entries: [] };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { entries: [] }; }
    if (!isRecord(raw) || !Array.isArray(raw.entries)) return { entries: [] };
    const entries: LinuxHwEncodeLedgerEntry[] = [];
    for (const e of raw.entries) {
        if (!isRecord(e)) continue;
        if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= 0) continue;
        if (typeof e.version !== 'string' || e.version.length === 0 || e.version.length > 64) continue;
        if (!isLinuxHwEncodeFailureKind(e.kind)) continue;
        entries.push({ at: e.at, version: e.version, kind: e.kind });
    }
    return { entries: entries.slice(-LEDGER_MAX_ENTRIES) };
}

export function serializeLinuxHwEncodeLedger(l: LinuxHwEncodeLedger): string {
    return JSON.stringify({
        entries: l.entries.slice(-LEDGER_MAX_ENTRIES).map(e => ({ at: e.at, version: e.version.slice(0, 64), kind: e.kind })),
    }) + '\n';
}

/** The ledger with one more failure, and entries past the window forgotten. */
export function recordLinuxHwEncodeFailure(l: LinuxHwEncodeLedger, entry: LinuxHwEncodeLedgerEntry): LinuxHwEncodeLedger {
    const kept = l.entries.filter(e => entry.at - e.at < LINUX_HW_ENCODE_LEDGER_WINDOW_MS);
    return { entries: [...kept, entry].slice(-LEDGER_MAX_ENTRIES) };
}

/** Entries that count toward a lockout right now: this version, inside the window. */
export function activeLedgerEntries(l: LinuxHwEncodeLedger, version: string, now: number): LinuxHwEncodeLedgerEntry[] {
    return l.entries.filter(e => e.version === version && now - e.at < LINUX_HW_ENCODE_LEDGER_WINDOW_MS && e.at <= now + 60_000);
}

export function isLinuxHwEncodeLockedOut(l: LinuxHwEncodeLedger | null | undefined, version: string, now: number): boolean {
    return !!l && activeLedgerEntries(l, version, now).length >= LINUX_HW_ENCODE_LOCKOUT_LAUNCHES;
}

/** Synchronous read for the top of main.ts. Missing / unreadable / oversized -> empty. Never throws. */
export function readLinuxHwEncodeLedgerFile(filePath: string): LinuxHwEncodeLedger {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile() || st.size > LINUX_HW_ENCODE_LEDGER_MAX_BYTES) return { entries: [] };
        return parseLinuxHwEncodeLedger(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return { entries: [] };
    }
}

/** Temp file + rename (a crash mid-write leaves the old file). Best effort: never throws, returns whether it wrote. */
export function writeLinuxHwEncodeLedgerFile(filePath: string, l: LinuxHwEncodeLedger): boolean {
    try {
        const tmp = `${filePath}.tmp`;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, serializeLinuxHwEncodeLedger(l), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, filePath);
        return true;
    } catch {
        return false;
    }
}

export function clearLinuxHwEncodeLedgerFile(filePath: string): void {
    try { fs.unlinkSync(filePath); } catch { /* absent */ }
}

// ── The decision ────────────────────────────────────────────────────────────────

export interface LinuxHwEncodeInput {
    platform: string;
    /** CIPHERLINE_LINUX_HW_ENCODE. */
    mode: LinuxHwEncodeMode;
    /** Settings -> Advanced toggle (startup-flags.json `linuxHwEncode`); default true. */
    setting?: boolean;
    /** app.commandLine.hasSwitch — true when the process was launched with that switch. */
    hasSwitch(name: string): boolean;
    /** Failures recorded by earlier launches; absent = none. */
    ledger?: LinuxHwEncodeLedger | null;
    appVersion?: string;
    now?: number;
}

export interface LinuxHwEncodeDecision {
    enable: boolean;
    /** Entries for the single --enable-features list (empty when disabled). */
    features: string[];
    /** One short reason for the capture:switches diagnostics event and the Settings row. */
    reason: string;
    /** True when the only thing keeping it off is the failure ledger (the Settings row offers a retry). */
    lockedOut?: boolean;
}

export function decideLinuxHwEncode(input: LinuxHwEncodeInput): LinuxHwEncodeDecision {
    const no = (reason: string, extra: Partial<LinuxHwEncodeDecision> = {}): LinuxHwEncodeDecision => ({ enable: false, features: [], reason, ...extra });
    if (input.platform !== 'linux') return no('not linux');
    if (input.mode === 'off') return no('off (env)');
    for (const sw of LINUX_HW_ENCODE_BLOCKING_SWITCHES) {
        if (input.hasSwitch(sw)) return no(`blocked by --${sw}`);
    }
    if (input.mode === 'on') return { enable: true, features: [LINUX_HW_ENCODE_FEATURE], reason: 'on (env)' };
    if (input.setting === false) return no('off (Settings)');
    if (!LINUX_HW_ENCODE_DEFAULT_ON) return no('auto: off by default');
    const now = input.now ?? Date.now();
    if (isLinuxHwEncodeLockedOut(input.ledger, input.appVersion ?? '', now)) {
        const mine = activeLedgerEntries(input.ledger!, input.appVersion ?? '', now);
        return no(`stayed software: ${mine.length} launches with an encoder failure (last: ${mine[mine.length - 1].kind})`, { lockedOut: true });
    }
    return { enable: true, features: [LINUX_HW_ENCODE_FEATURE], reason: 'auto: on' };
}

/**
 * The "one failure per launch" gate main applies to the ledger. A renderer that
 * reports the same dying encoder five times in a minute must count once: the
 * lockout is about repeated LAUNCHES that went wrong, not repeated symptoms.
 */
export class LinuxHwEncodeFailureGate {
    private recorded = false;
    /** True only for the first valid failure of this launch while hardware encode is active. */
    accept(active: boolean, kind: unknown): kind is LinuxHwEncodeFailureKind {
        if (!active || this.recorded || !isLinuxHwEncodeFailureKind(kind)) return false;
        this.recorded = true;
        return true;
    }
    get hasRecorded(): boolean { return this.recorded; }
}

/** Electron `child-process-gone` reasons that mean the GPU process really died (not a clean exit, not an external kill). */
export function isGpuCrashForHwEncode(details: { type?: unknown; reason?: unknown }): boolean {
    return details.type === 'GPU' && (details.reason === 'crashed' || details.reason === 'abnormal-exit');
}
