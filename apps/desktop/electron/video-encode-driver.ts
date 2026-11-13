/**
 * "Install the Intel / AMD video encoder driver" - the Linux hardware ENCODE counterpart of nvidia-vaapi-install.ts.
 *
 * Hardware encode for screen share (linux-video-encode.ts header has the distro matrix) needs a VA-API driver BUILD that exposes an H.264
 * encode entrypoint. Some distros ship the free build without it:
 *   - Ubuntu / Debian + Intel Gen9-ish (Skylake .. Comet Lake): stock `intel-media-va-driver` lists only EncSliceLP, which Chromium does not
 *     drive on these GPUs. `intel-media-va-driver-non-free` (Ubuntu multiverse / Debian non-free) adds EncSlice.
 *   - Fedora: stock `mesa-va-drivers` (AMD) and `intel-media-driver` (Intel) are decode-only. RPM Fusion's `mesa-va-drivers-freeworld`
 *     (AMD) / `intel-media-driver` (Intel, nonfree) add encode. Needs RPM Fusion; we NEVER enable repositories.
 *   - Arch / CachyOS / Tumbleweed already encode with stock drivers: no prompt.
 *
 * How we know (no vainfo, no guessing): the native share helper's `--list-va` mode already asks every render node what its VA driver
 * reports (vaInitialize ok? vendor string? H.264 encode entrypoints?). We run it with FIXED arguments and parse the JSON defensively.
 *
 * Security model = nvidia-vaapi-install.ts: the renderer sends NOTHING; the package, command and repo hint are chosen HERE from
 * /etc/os-release + the helper's report, from the fixed table below. We never run sudo / a package manager; PackageKit (polkit) does the
 * install, ONLY_TRUSTED. Any failure falls back to a copyable command. One PackageKit install at a time (shared lock with the NVIDIA card).
 *
 * Free of any `electron` import (video-encode-driver.test.ts).
 */

import { execFile } from 'node:child_process';
import {
    acquireInstallLock, dbusPackageKitBus, installViaPackageKit,
    type NvidiaVaapiInstallOutcome, type NvidiaVaapiStatus, type PackageKitBus,
} from './nvidia-vaapi-install';

export type VideoEncodeDriverState =
    | 'none'        // nothing to offer
    | 'install'     // decode-only VA-API driver on an Intel/AMD GPU, a known package fixes it
    | 'restart';    // the encoder showed up since launch: restart Cipherline

export type VideoEncodeVendor = 'intel' | 'amd';

export interface VideoEncodeDriverStatus {
    state: VideoEncodeDriverState;
    vendor: VideoEncodeVendor | '';
    /** Package name for this distro/vendor; '' when state is 'none'. */
    pkg: string;
    /** Copyable command; '' when state is 'none'. */
    command: string;
    /** The repository the package comes from and how to enable it (we never do); null when none is needed. */
    repoHint: string | null;
    /** A one-click PackageKit install is worth trying (false where it needs a package SWAP, e.g. Fedora). */
    canInstall: boolean;
}

export const NONE_ENCODE_STATUS: VideoEncodeDriverStatus = { state: 'none', vendor: '', pkg: '', command: '', repoHint: null, canInstall: false };

// ── What the helper reports (--list-va) ────────────────────────────────────────

export interface VaNodeReport {
    vendorId: number;               // PCI vendor, 0 unknown
    deviceId: number;               // PCI device, 0 unknown
    kernelDriver: string;
    vendorString: string;           // '' = vaInitialize failed (no VA-API decode either)
    /** H.264 encode entrypoints the driver lists: 'EncSlice' and/or 'EncSliceLP'. */
    encodeEntrypoints: string[];
}

/** Parse the helper's `--list-va` stdout. Anything malformed yields null (= "cannot tell" = no prompt). */
export function parseListVa(stdout: string): VaNodeReport[] | null {
    let j: unknown;
    try { j = JSON.parse(stdout.trim()); } catch { return null; }
    if (!Array.isArray(j) || j.length > 16) return null;
    const hex = (v: unknown): number => (typeof v === 'string' && /^0x[0-9a-f]{1,4}$/i.test(v) ? parseInt(v, 16) : 0);
    const out: VaNodeReport[] = [];
    for (const n of j) {
        if (!n || typeof n !== 'object') return null;
        const r = n as Record<string, unknown>;
        const cands = Array.isArray(r.candidates) ? r.candidates : [];
        const eps = new Set<string>();
        for (const c of cands.slice(0, 16)) {
            const ep = c && typeof c === 'object' ? (c as Record<string, unknown>).entrypoint : null;
            if (ep === 'EncSlice' || ep === 'EncSliceLP') eps.add(ep);
        }
        out.push({
            vendorId: hex(r.vendor_id), deviceId: hex(r.device_id),
            kernelDriver: typeof r.kernel_driver === 'string' ? r.kernel_driver.slice(0, 32) : '',
            vendorString: typeof r.vendor_string === 'string' ? r.vendor_string.slice(0, 120) : '',
            encodeEntrypoints: [...eps],
        });
    }
    return out;
}

/** Run the helper's --list-va with fixed arguments. Never throws; null = cannot tell. */
export function runListVa(helperPath: string, timeoutMs = 6000): Promise<VaNodeReport[] | null> {
    return new Promise((resolve) => {
        try {
            execFile(helperPath, ['--list-va'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
                resolve(err ? null : parseListVa(String(stdout)));
            });
        } catch { resolve(null); }
    });
}

// ── Detection ──────────────────────────────────────────────────────────────────

/** PCI device-id prefixes of Intel generations before Gen11 (Broadwell .. Comet Lake, Apollo/Gemini Lake, Cannon Lake). Gen11+ (Ice Lake, Tiger Lake, Alder Lake, Arc ...) only
 *  ever has the LP entrypoint on every distro and Chromium drives it, so they are not a gap. A HEURISTIC: an unknown id means "no prompt". */
const INTEL_PRE_GEN11_ID_RE = /^(16|19|1a|31|3e|59|5a|87|9b)[0-9a-f]{2}$/;
export function isIntelPreGen11(deviceId: number): boolean {
    return INTEL_PRE_GEN11_ID_RE.test(deviceId.toString(16).padStart(4, '0'));
}

export interface EncodeGap { vendor: VideoEncodeVendor }

/**
 * The first Intel/AMD render node where VA-API works (vaInitialize ok = decode is there) but H.264 encode is missing in the way Chromium needs.
 * NVIDIA nodes are never considered (their own card). An encode-capable node anywhere means no gap (hardware encode will engage there).
 */
export function detectEncodeGap(nodes: VaNodeReport[] | null): EncodeGap | null {
    if (!nodes) return null;
    const cand = nodes.filter(n => (n.vendorId === 0x8086 || n.vendorId === 0x1002) && n.kernelDriver !== 'nvidia' && n.kernelDriver !== 'nouveau');
    if (cand.length === 0 || nodes.some(n => n.vendorString && encodes(n))) return null;
    for (const n of cand) {
        if (!n.vendorString) continue;                               // no VA driver at all: not a "decode works, encode missing" case
        if (n.vendorId === 0x1002) return { vendor: 'amd' };
        // Intel: only the iHD driver (i965 is unmaintained and aborts on Gen9 encode; we never steer anyone to it).
        if (!/iHD/.test(n.vendorString)) continue;
        if (n.encodeEntrypoints.length === 0) return { vendor: 'intel' };            // decode-only build (Fedora)
        if (!n.encodeEntrypoints.includes('EncSlice') && isIntelPreGen11(n.deviceId)) return { vendor: 'intel' };   // LP only on Gen9-ish (Ubuntu / Debian free build)
    }
    return null;
}

/** A node that encodes H.264 in a way Chromium uses: full EncSlice, or LP on Gen11+ (where LP is all there is). */
function encodes(n: VaNodeReport): boolean {
    if (n.encodeEntrypoints.length === 0) return false;
    if (n.vendorId === 0x8086 && !n.encodeEntrypoints.includes('EncSlice')) return !isIntelPreGen11(n.deviceId);
    return true;
}

// ── The fixed package table (main only; the renderer can never choose) ─────────

export interface EncodeFix { pkg: string; command: string; repoHint: string | null; canInstall: boolean }

/** The fix for this distro + vendor, or null when none is known (Arch/Tumbleweed already encode; unknown distros get no prompt). */
export function videoEncodeFix(distro: { id: string; like: string[] }, vendor: VideoEncodeVendor): EncodeFix | null {
    const fam = new Set([distro.id, ...distro.like]);
    if (['fedora', 'rhel', 'centos', 'nobara'].some(f => fam.has(f))) {
        const hint = 'This comes from RPM Fusion (free and nonfree), which must be enabled first: https://rpmfusion.org/Configuration. Cipherline never enables repositories.';
        return vendor === 'amd'
            ? { pkg: 'mesa-va-drivers-freeworld', command: 'sudo dnf swap mesa-va-drivers mesa-va-drivers-freeworld', repoHint: hint, canInstall: false }
            : { pkg: 'intel-media-driver', command: 'sudo dnf install intel-media-driver --allowerasing', repoHint: hint, canInstall: false };
    }
    // Ubuntu/Debian are command-only too: the non-free package REPLACES the installed free intel-media-va-driver
    // (apt Conflicts/Replaces), which a trusted-only PackageKit InstallPackages may refuse or half-do. A copyable
    // command apt resolves itself is the honest path (coordinator decision 2026-11-11).
    if (vendor === 'intel' && fam.has('ubuntu')) {
        return { pkg: 'intel-media-va-driver-non-free', command: 'sudo apt install intel-media-va-driver-non-free',
            repoHint: 'It lives in Ubuntu’s "multiverse" repository. If apt cannot find it: sudo add-apt-repository multiverse && sudo apt update', canInstall: false };
    }
    if (vendor === 'intel' && fam.has('debian')) {
        return { pkg: 'intel-media-va-driver-non-free', command: 'sudo apt install intel-media-va-driver-non-free',
            repoHint: 'It lives in Debian’s "non-free" component. If apt cannot find it, add "non-free" (and "non-free-firmware") to your apt sources and run sudo apt update.', canInstall: false };
    }
    return null;
}

export interface VideoEncodeDriverInput {
    platform: string;
    distro: { id: string; like: string[] } | null;
    /** The helper's report taken NOW (so a driver installed since launch is seen); null = cannot tell. */
    nodesNow: VaNodeReport[] | null;
    /** The gap the FIRST probe of this launch found (null = there was none): what "restart" is measured against. */
    launchGap: EncodeGap | null;
    /** Hardware encode is on in this launch (setting / env / lockout all allow it). */
    encodeEnabledAtLaunch: boolean;
    /** The NVIDIA card's status: while it has something to say, this card stays silent (never two cards at once). */
    nvidia: NvidiaVaapiStatus;
}

export function computeVideoEncodeDriverStatus(i: VideoEncodeDriverInput): VideoEncodeDriverStatus {
    if (i.platform !== 'linux' || !i.distro || !i.encodeEnabledAtLaunch || !i.launchGap) return NONE_ENCODE_STATUS;
    if (i.nvidia.state !== 'none') return NONE_ENCODE_STATUS;
    const fix = videoEncodeFix(i.distro, i.launchGap.vendor);
    if (!fix) return NONE_ENCODE_STATUS;
    const base = { vendor: i.launchGap.vendor, pkg: fix.pkg, command: fix.command, repoHint: fix.repoHint };
    if (detectEncodeGap(i.nodesNow)) return { state: 'install', ...base, canInstall: fix.canInstall };
    // Not missing any more. Only call it "installed, restart" when the helper really answered (a failed probe is not evidence).
    return i.nodesNow ? { state: 'restart', ...base, canInstall: false } : NONE_ENCODE_STATUS;
}

export function isVideoEncodeDriverStatus(v: unknown): v is VideoEncodeDriverStatus {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return (r.state === 'none' || r.state === 'install' || r.state === 'restart')
        && (r.vendor === '' || r.vendor === 'intel' || r.vendor === 'amd')
        && typeof r.pkg === 'string' && typeof r.command === 'string'
        && (r.repoHint === null || typeof r.repoHint === 'string') && typeof r.canInstall === 'boolean';
}

// ── Install ────────────────────────────────────────────────────────────────────

export interface VideoEncodeDriverInstallResult { outcome: NvidiaVaapiInstallOutcome; status: VideoEncodeDriverStatus }

export interface VideoEncodeDriverDeps {
    /** Re-detect now (a fresh helper probe). */
    status: () => Promise<VideoEncodeDriverStatus>;
    busFactory?: () => PackageKitBus | null;
}

/** The IPC body. Takes NO renderer input; the package is whatever `status()` (os-release-derived) says, offered only when state is 'install' and canInstall. */
export async function installVideoEncodeDriver(deps: VideoEncodeDriverDeps): Promise<VideoEncodeDriverInstallResult> {
    const before = await deps.status();
    if (before.state !== 'install' || !before.pkg || !before.canInstall) return { outcome: 'unsupported', status: before };
    const release = acquireInstallLock();
    if (!release) return { outcome: 'busy', status: before };
    try {
        const bus = (deps.busFactory ?? dbusPackageKitBus)();
        if (!bus) return { outcome: 'unavailable', status: before };
        const outcome = await installViaPackageKit(bus, before.pkg);
        return { outcome, status: await deps.status() };
    } finally {
        release();
    }
}

