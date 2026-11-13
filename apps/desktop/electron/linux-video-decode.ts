/**
 * Linux hardware video DECODE (VA-API) for what we RECEIVE: remote screen
 * shares and camera tiles. The launch-time decision, the NVIDIA driver probe,
 * the persisted failure ledger and the pure rules around them.
 *
 * ── What Chromium 150 does on Linux ─────────────────────────────────────────
 *   • `AcceleratedVideoDecodeLinuxGL` (media::kAcceleratedVideoDecodeLinuxGL)
 *     is ON by default. WebRTC's RTCVideoDecoderFactory asks the GPU process
 *     for a hardware decoder first (VaapiVideoDecoder behind MojoVideoDecoder)
 *     and falls back to libwebrtc's software decoders (FFmpeg for H.264,
 *     libvpx for VP8/VP9, dav1d for AV1) when none is offered for the codec /
 *     profile / size. `getStats()` then says decoderImplementation
 *     "ExternalDecoder" (hardware) or "FFmpeg" / "libvpx" / "dav1d" (software).
 *   • So Intel and AMD with a working libva driver get hardware decode with NO
 *     flag. That is the case this module leaves alone (it only makes the
 *     default explicit, so the Settings toggle can also switch it OFF).
 *   • NVIDIA is the exception. Chromium refuses to initialise VA-API on a
 *     render node driven by nvidia-drm unless `VaapiOnNvidiaGPUs` (off by
 *     default) is on, AND the machine must have nvidia-vaapi-driver
 *     (`nvidia_drv_video.so`, VA-API over NVDEC), AND libva has to be pointed
 *     at it (LIBVA_DRIVER_NAME=nvidia; libva 2.20+ no longer guesses it).
 *     The owner's friend (RTX 5070, CachyOS/KDE Wayland, staging .213)
 *     reported feature_status video_decode "enabled" with decoder "FFmpeg"
 *     hardware=false: the feature was on, the NVIDIA gate was shut.
 *
 * ── Per-vendor decision ──────────────────────────────────────────────────────
 *   intel / amd (any mix, incl. hybrid laptops with an NVIDIA dGPU)
 *                     → AcceleratedVideoDecodeLinuxGL, nothing else. NVIDIA
 *                       flags are NOT set on a hybrid: LIBVA_DRIVER_NAME=nvidia
 *                       would break the iGPU's decoder and Chromium opens the
 *                       first render node, which is usually the iGPU.
 *   nvidia only, proprietary driver, nvidia-vaapi-driver installed,
 *     nvidia_drm modeset=Y
 *                     → + VaapiOnNvidiaGPUs + VaapiIgnoreDriverChecks (Chromium's vendor-string
 *                       allow-list does not know the NVDEC driver; all four feature names were
 *                       checked present in the Electron 43.2 binary), LIBVA_DRIVER_NAME=nvidia,
 *                       NVD_BACKEND=direct (the EGL backend is broken on
 *                       driver 525+). Env the user already set is never replaced.
 *   nvidia only, driver package missing
 *                     → software decode as today, plus a `hint` naming the
 *                       package for the user's distro (Settings row only).
 *   nvidia only, nvidia_drm modeset off
 *                     → software, hint says to enable nvidia-drm.modeset=1.
 *   nouveau / unknown → default behaviour, no flags.
 *
 * ── Off switches and the fallback if it misbehaves ──────────────────────────
 *   env CIPHERLINE_LINUX_HW_DECODE=0, Settings -> Advanced "Hardware video
 *   decoding (Linux)" (startup-flags.json `linuxHwDecode`), --disable-gpu or
 *   --disable-accelerated-video-decode. OFF also disables the Chromium
 *   feature (so it really is software decode, not "whatever Chromium
 *   decides"). The GPU process crashing while decode is on counts as one
 *   failure per launch in a ledger; two launches with a failure on the same
 *   app version keep it off until a new version, 30 quiet days, or the toggle
 *   being turned off and on again.
 *   Tester knobs: CIPHERLINE_LINUX_HW_DECODE=1 forces the decision on (bypasses
 *   the Settings toggle, the ledger and the NVIDIA driver/modeset gates);
 *   =gl additionally selects ANGLE's GL backend (`--use-gl=angle
 *   --use-angle=gl`, what nvidia-vaapi-driver's README asks Chromium for)
 *   in case the default ANGLE/Vulkan path cannot import the decoded dmabuf.
 *
 * Deliberately free of any `electron` import (linux-video-decode.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';

export const LINUX_HW_DECODE_ENV = 'CIPHERLINE_LINUX_HW_DECODE';
export const LINUX_HW_DECODE_FEATURE = 'AcceleratedVideoDecodeLinuxGL';
export const LINUX_HW_DECODE_NVIDIA_FEATURE = 'VaapiOnNvidiaGPUs';
/** Chromium's allow-list of VA-API driver vendor strings does not know nvidia-vaapi-driver ("VA-API NVDEC driver"). */
export const LINUX_HW_DECODE_IGNORE_DRIVER_CHECKS_FEATURE = 'VaapiIgnoreDriverChecks';
export const NVIDIA_VAAPI_DRIVER_FILE = 'nvidia_drv_video.so';

export type LinuxHwDecodeMode = 'auto' | 'on' | 'gl' | 'off';

/** `CIPHERLINE_LINUX_HW_DECODE`: 0/off/false/no -> off, 1/on/true/yes -> on, gl -> on + ANGLE GL, else auto. */
export function parseLinuxHwDecodeMode(v: string | undefined): LinuxHwDecodeMode {
    const s = (v ?? '').trim().toLowerCase();
    if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 'off';
    if (s === 'gl') return 'gl';
    if (s === '1' || s === 'on' || s === 'true' || s === 'yes') return 'on';
    return 'auto';
}

export const LINUX_HW_DECODE_BLOCKING_SWITCHES: readonly string[] = Object.freeze([
    'disable-gpu',
    'disable-accelerated-video-decode',
]);

// ── The machine probe ──────────────────────────────────────────────────────────

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other';
export interface LinuxGpu { vendor: GpuVendor; /** Kernel driver name from sysfs: nvidia, nouveau, amdgpu, i915, xe ... ('' unknown). */ driver: string }

export interface LinuxGpuProbe {
    gpus: LinuxGpu[];
    /** nvidia_drv_video.so found in a libva driver directory. */
    nvidiaVaapiDriver: boolean;
    /** /sys/module/nvidia_drm/parameters/modeset: true = Y, false = N, null = unreadable / module absent. */
    nvidiaDrmModeset: boolean | null;
    /** /etc/os-release ID and ID_LIKE, lower-case. */
    distro: { id: string; like: string[] };
}

/** The file system reads the probe needs, injectable for tests. */
export interface ProbeFs {
    readdir(p: string): string[];
    readFile(p: string): string | null;
    readlink(p: string): string | null;
    exists(p: string): boolean;
}

export const realProbeFs: ProbeFs = {
    readdir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    readlink: (p) => { try { return fs.readlinkSync(p); } catch { return null; } },
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
};

const VENDOR_IDS: Record<string, GpuVendor> = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' };

export function readLinuxGpus(pfs: ProbeFs = realProbeFs): LinuxGpu[] {
    const out: LinuxGpu[] = [];
    for (const name of pfs.readdir('/sys/class/drm')) {
        if (!/^card\d+$/.test(name)) continue;
        const dev = `/sys/class/drm/${name}/device`;
        const vid = (pfs.readFile(`${dev}/vendor`) ?? '').trim().toLowerCase();
        if (!vid) continue;
        const link = pfs.readlink(`${dev}/driver`);
        out.push({ vendor: VENDOR_IDS[vid] ?? 'other', driver: link ? path.basename(link).slice(0, 32) : '' });
    }
    return out;
}

/** The directories libva looks in for `<name>_drv_video.so`, plus the usual distro layouts. */
export function vaapiDriverDirs(env: Readonly<Record<string, string | undefined>>): string[] {
    const dirs = (env.LIBVA_DRIVERS_PATH ?? '').split(':').map(s => s.trim()).filter(Boolean);
    dirs.push(
        '/usr/lib/dri', '/usr/lib64/dri', '/usr/lib/x86_64-linux-gnu/dri', '/usr/lib/aarch64-linux-gnu/dri',
        '/usr/local/lib/dri', '/usr/local/lib64/dri',
    );
    return dirs;
}

export function parseOsRelease(text: string | null): { id: string; like: string[] } {
    const get = (k: string): string => {
        const m = new RegExp(`^${k}=("?)(.*)\\1$`, 'm').exec(text ?? '');
        return (m?.[2] ?? '').trim().toLowerCase();
    };
    return { id: get('ID').slice(0, 32), like: get('ID_LIKE').split(/\s+/).filter(Boolean).slice(0, 6) };
}

export function probeLinuxGpus(env: Readonly<Record<string, string | undefined>>, pfs: ProbeFs = realProbeFs): LinuxGpuProbe {
    const modeset = (pfs.readFile('/sys/module/nvidia_drm/parameters/modeset') ?? '').trim().toUpperCase();
    return {
        gpus: readLinuxGpus(pfs),
        nvidiaVaapiDriver: vaapiDriverDirs(env).some(d => pfs.exists(`${d}/${NVIDIA_VAAPI_DRIVER_FILE}`)),
        nvidiaDrmModeset: modeset === 'Y' ? true : modeset === 'N' ? false : null,
        distro: parseOsRelease(pfs.readFile('/etc/os-release')),
    };
}

/** The package that ships nvidia_drv_video.so, by distro family. */
export function nvidiaVaapiPackage(distro: { id: string; like: string[] }): { pkg: string; install: string } {
    const fam = new Set([distro.id, ...distro.like]);
    if (['arch', 'cachyos', 'manjaro', 'endeavouros', 'garuda'].some(f => fam.has(f))) return { pkg: 'libva-nvidia-driver', install: 'sudo pacman -S libva-nvidia-driver' };
    if (['fedora', 'rhel', 'centos', 'nobara'].some(f => fam.has(f))) return { pkg: 'nvidia-vaapi-driver', install: 'sudo dnf install nvidia-vaapi-driver   (RPM Fusion nonfree)' };
    if (['debian', 'ubuntu', 'linuxmint', 'pop'].some(f => fam.has(f))) return { pkg: 'nvidia-vaapi-driver', install: 'sudo apt install nvidia-vaapi-driver' };
    if (['opensuse', 'suse', 'opensuse-tumbleweed', 'opensuse-leap'].some(f => fam.has(f))) return { pkg: 'nvidia-vaapi-driver', install: 'sudo zypper install nvidia-vaapi-driver' };
    return { pkg: 'nvidia-vaapi-driver', install: 'install the "nvidia-vaapi-driver" package (libva-nvidia-driver on Arch-based distros)' };
}

// ── The failure ledger (GPU process crashed while decode was on) ─────────────

export const LINUX_HW_DECODE_FAILURE_KINDS = ['gpu_crash'] as const;
export type LinuxHwDecodeFailureKind = (typeof LINUX_HW_DECODE_FAILURE_KINDS)[number];
export const LINUX_HW_DECODE_LEDGER_FILENAME = 'linux-hw-decode-failures.json';
export const LINUX_HW_DECODE_LEDGER_MAX_BYTES = 4 * 1024;
export const LINUX_HW_DECODE_LOCKOUT_LAUNCHES = 2;
export const LINUX_HW_DECODE_LEDGER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LEDGER_MAX_ENTRIES = 8;

export interface LinuxHwDecodeLedgerEntry { at: number; version: string; kind: LinuxHwDecodeFailureKind }
export interface LinuxHwDecodeLedger { entries: LinuxHwDecodeLedgerEntry[] }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseLinuxHwDecodeLedger(text: string | null | undefined): LinuxHwDecodeLedger {
    if (typeof text !== 'string' || text.length === 0 || text.length > LINUX_HW_DECODE_LEDGER_MAX_BYTES) return { entries: [] };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { entries: [] }; }
    if (!isRecord(raw) || !Array.isArray(raw.entries)) return { entries: [] };
    const entries: LinuxHwDecodeLedgerEntry[] = [];
    for (const e of raw.entries) {
        if (!isRecord(e)) continue;
        if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= 0) continue;
        if (typeof e.version !== 'string' || e.version.length === 0 || e.version.length > 64) continue;
        if (e.kind !== 'gpu_crash') continue;
        entries.push({ at: e.at, version: e.version, kind: 'gpu_crash' });
    }
    return { entries: entries.slice(-LEDGER_MAX_ENTRIES) };
}

export function recordLinuxHwDecodeFailure(l: LinuxHwDecodeLedger, entry: LinuxHwDecodeLedgerEntry): LinuxHwDecodeLedger {
    const kept = l.entries.filter(e => entry.at - e.at < LINUX_HW_DECODE_LEDGER_WINDOW_MS);
    return { entries: [...kept, entry].slice(-LEDGER_MAX_ENTRIES) };
}

export function activeDecodeLedgerEntries(l: LinuxHwDecodeLedger, version: string, now: number): LinuxHwDecodeLedgerEntry[] {
    return l.entries.filter(e => e.version === version && now - e.at < LINUX_HW_DECODE_LEDGER_WINDOW_MS && e.at <= now + 60_000);
}

export function isLinuxHwDecodeLockedOut(l: LinuxHwDecodeLedger | null | undefined, version: string, now: number): boolean {
    return !!l && activeDecodeLedgerEntries(l, version, now).length >= LINUX_HW_DECODE_LOCKOUT_LAUNCHES;
}

export function readLinuxHwDecodeLedgerFile(filePath: string): LinuxHwDecodeLedger {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile() || st.size > LINUX_HW_DECODE_LEDGER_MAX_BYTES) return { entries: [] };
        return parseLinuxHwDecodeLedger(fs.readFileSync(filePath, 'utf8'));
    } catch { return { entries: [] }; }
}

export function writeLinuxHwDecodeLedgerFile(filePath: string, l: LinuxHwDecodeLedger): boolean {
    try {
        const tmp = `${filePath}.tmp`;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ entries: l.entries.slice(-LEDGER_MAX_ENTRIES) }) + '\n', { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, filePath);
        return true;
    } catch { return false; }
}

export function clearLinuxHwDecodeLedgerFile(filePath: string): void {
    try { fs.unlinkSync(filePath); } catch { /* absent */ }
}

/** One ledger entry per launch, however many GPU process deaths follow. */
export class LinuxHwDecodeFailureGate {
    private recorded = false;
    accept(active: boolean): boolean {
        if (!active || this.recorded) return false;
        this.recorded = true;
        return true;
    }
    get hasRecorded(): boolean { return this.recorded; }
}

// ── The decision ──────────────────────────────────────────────────────────────

export type NvidiaDecodeState =
    | 'not_applicable'   // no NVIDIA GPU, or Linux-only gate not relevant
    | 'ready'            // NVIDIA-only, driver present: VaapiOnNvidiaGPUs + libva env set
    | 'forced'           // env tester knob: set without the driver/modeset checks
    | 'missing_driver'   // NVIDIA-only, nvidia-vaapi-driver not installed
    | 'no_modeset'       // NVIDIA-only, nvidia_drm modeset is off
    | 'hybrid'           // NVIDIA next to an Intel/AMD GPU: left alone on purpose
    | 'nouveau';         // open nouveau kernel driver: no NVIDIA flags

export interface LinuxHwDecodeInput {
    platform: string;
    mode: LinuxHwDecodeMode;
    /** Settings -> Advanced toggle (startup-flags.json `linuxHwDecode`); default true. */
    setting?: boolean;
    hasSwitch(name: string): boolean;
    probe: LinuxGpuProbe | null;
    /** process.env: an LIBVA_DRIVER_NAME / NVD_BACKEND the user already set is kept. */
    env: Readonly<Record<string, string | undefined>>;
    ledger?: LinuxHwDecodeLedger | null;
    appVersion?: string;
    now?: number;
}

export interface LinuxHwDecodeHint { kind: 'install_driver' | 'enable_modeset'; pkg?: string; install?: string; text: string }

export interface LinuxHwDecodeDecision {
    /** Hardware decode is allowed in this launch (Chromium still decides per codec/profile). */
    enable: boolean;
    enableFeatures: string[];
    disableFeatures: string[];
    /** Plain switches (name, value-or-empty). */
    switches: Array<[string, string]>;
    /** Process env to set BEFORE the GPU process starts (never overrides what is already set). */
    env: Record<string, string>;
    reason: string;
    nvidia: NvidiaDecodeState;
    lockedOut?: boolean;
    hint?: LinuxHwDecodeHint;
    /** Short GPU summary for diagnostics: "nvidia:nvidia" / "amd:amdgpu+nvidia:nvidia". */
    gpus: string;
}

const summarizeGpus = (p: LinuxGpuProbe | null): string => (p?.gpus ?? []).map(g => `${g.vendor}:${g.driver || '?'}`).join('+').slice(0, 96);

export function decideLinuxHwDecode(input: LinuxHwDecodeInput): LinuxHwDecodeDecision {
    const gpus = summarizeGpus(input.probe);
    const base = { enable: false, enableFeatures: [] as string[], disableFeatures: [] as string[], switches: [] as Array<[string, string]>, env: {} as Record<string, string>, nvidia: 'not_applicable' as NvidiaDecodeState, gpus };
    if (input.platform !== 'linux') return { ...base, reason: 'not linux' };
    // OFF really is off: the feature is on by default in Chromium, so it has to be switched off, not just not-enabled.
    const off = (reason: string, extra: Partial<LinuxHwDecodeDecision> = {}): LinuxHwDecodeDecision =>
        ({ ...base, disableFeatures: [LINUX_HW_DECODE_FEATURE], reason, ...extra });
    if (input.mode === 'off') return off('off (env)');
    for (const sw of LINUX_HW_DECODE_BLOCKING_SWITCHES) if (input.hasSwitch(sw)) return { ...base, reason: `blocked by --${sw}` };

    const forced = input.mode === 'on' || input.mode === 'gl';
    if (!forced) {
        if (input.setting === false) return off('off (Settings)');
        const now = input.now ?? Date.now();
        if (isLinuxHwDecodeLockedOut(input.ledger, input.appVersion ?? '', now)) {
            return off(`stayed software: ${activeDecodeLedgerEntries(input.ledger!, input.appVersion ?? '', now).length} launches with a GPU process crash`, { lockedOut: true });
        }
    }

    const out: LinuxHwDecodeDecision = { ...base, enable: true, enableFeatures: [LINUX_HW_DECODE_FEATURE], reason: forced ? `on (env ${input.mode})` : 'auto: on' };
    if (input.mode === 'gl') out.switches.push(['use-gl', 'angle'], ['use-angle', 'gl']);

    const probe = input.probe;
    const gpuList = probe?.gpus ?? [];
    const nvidia = gpuList.filter(g => g.vendor === 'nvidia');
    if (nvidia.length === 0) return out;

    const others = gpuList.filter(g => g.vendor === 'intel' || g.vendor === 'amd');
    const setNvidia = (state: NvidiaDecodeState) => {
        out.nvidia = state;
        out.enableFeatures.push(LINUX_HW_DECODE_NVIDIA_FEATURE, LINUX_HW_DECODE_IGNORE_DRIVER_CHECKS_FEATURE);
        // libva 2.20+ does not guess the driver name; never replace an explicit choice.
        if (!input.env.LIBVA_DRIVER_NAME) out.env.LIBVA_DRIVER_NAME = 'nvidia';
        // The EGL backend is broken on driver 525+; `direct` is the default but pin it.
        if (!input.env.NVD_BACKEND) out.env.NVD_BACKEND = 'direct';
    };

    if (others.length > 0) {
        // Hybrid: the iGPU's own driver is what Chromium will open. Do not touch NVIDIA — unless forced.
        if (forced) { setNvidia('forced'); delete out.env.LIBVA_DRIVER_NAME; out.reason += ' (hybrid: libva driver not forced)'; return out; }
        out.nvidia = 'hybrid';
        out.reason += ' (hybrid: left on the integrated GPU)';
        return out;
    }
    if (nvidia.every(g => g.driver === 'nouveau')) { out.nvidia = 'nouveau'; return out; }
    if (forced) { setNvidia('forced'); return out; }

    if (!probe!.nvidiaVaapiDriver) {
        const p = nvidiaVaapiPackage(probe!.distro);
        out.nvidia = 'missing_driver';
        out.reason += ' (NVIDIA: nvidia-vaapi-driver not installed)';
        out.hint = { kind: 'install_driver', pkg: p.pkg, install: p.install, text: `Your NVIDIA GPU can decode video in hardware, but the VA-API driver for it is not installed. Install the "${p.pkg}" package (${p.install}), then restart Cipherline.` };
        return out;
    }
    if (probe!.nvidiaDrmModeset !== true) {
        out.nvidia = 'no_modeset';
        out.reason += ' (NVIDIA: nvidia_drm modeset is off)';
        out.hint = { kind: 'enable_modeset', text: 'The NVIDIA VA-API driver is installed, but the kernel module needs modesetting: add nvidia-drm.modeset=1 to your kernel command line (recent NVIDIA drivers enable it by default), reboot, then restart Cipherline.' };
        return out;
    }
    setNvidia('ready');
    out.reason += ' (NVIDIA via nvidia-vaapi-driver)';
    return out;
}

/** Electron `child-process-gone` reasons that mean the GPU process really died. */
export function isGpuCrashForHwDecode(details: { type?: unknown; reason?: unknown }): boolean {
    return details.type === 'GPU' && (details.reason === 'crashed' || details.reason === 'abnormal-exit');
}
