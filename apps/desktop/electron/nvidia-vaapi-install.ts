/**
 * "Install the NVIDIA video driver" - the status the renderer shows and the
 * one-click install through PackageKit.
 *
 * Hardware DECODE on NVIDIA needs the distro's `nvidia-vaapi-driver` package
 * (linux-video-decode.ts decides, at launch, whether it is usable). We do NOT
 * bundle it (it links GStreamer codecparsers = LGPL, and it is ABI-coupled to
 * the system libva / NVIDIA stack). So: either it is installed already (the
 * .deb Recommends it), or Cipherline offers to install it.
 *
 * Security model:
 *   - The renderer can only ask "install the NVIDIA VA-API driver". It sends
 *     NOTHING; the package name is chosen here from /etc/os-release
 *     (`nvidiaVaapiPackage`) and is one of a fixed set of literals.
 *   - We never run sudo / pkexec / a package manager. PackageKit (system bus)
 *     asks polkit, which shows the system's own authentication dialog.
 *   - Only trusted (signed) packages: transaction flag ONLY_TRUSTED.
 *   - Any failure falls back to a copyable command shown in the UI.
 *
 * Free of any `electron` import (nvidia-vaapi-install.test.ts); dbus-native is
 * lazily required, Linux only.
 */

import fs from 'node:fs';
import type { LinuxGpuProbe, NvidiaDecodeState } from './linux-video-decode';
import { nvidiaVaapiPackage } from './linux-video-decode';

// ── Status (what the renderer is told) ─────────────────────────────────────────

export type NvidiaVaapiState =
    | 'none'        // nothing to offer: not Linux/NVIDIA, AMD/Intel/hybrid/nouveau, decode off, or all set
    | 'install'     // NVIDIA proprietary, nvidia-vaapi-driver missing
    | 'modeset'     // driver present (or just installed) but nvidia_drm modeset is not Y
    | 'restart';    // driver installed since launch and modeset is fine: restart Cipherline

export interface NvidiaVaapiStatus {
    state: NvidiaVaapiState;
    /** Package name for this distro; '' when state is 'none'. */
    pkg: string;
    /** Copyable command (or instruction) for this distro; '' when state is 'none'. */
    command: string;
    /** modeset needs enabling: the kernel parameter text; null otherwise. */
    modesetNote: string | null;
    /** A one-click install is worth trying (state 'install'). */
    canInstall: boolean;
}

export const NVIDIA_MODESET_NOTE =
    'The NVIDIA kernel module needs modesetting. Add nvidia_drm.modeset=1 to your kernel command line (or set "options nvidia_drm modeset=1" in /etc/modprobe.d/), regenerate your initramfs if your distro needs it, then reboot. Recent NVIDIA drivers enable it by default.';

const NONE: NvidiaVaapiStatus = { state: 'none', pkg: '', command: '', modesetNote: null, canInstall: false };

export interface NvidiaVaapiStatusInput {
    platform: string;
    /** The probe, taken NOW (so a driver installed since launch is seen). */
    probe: LinuxGpuProbe | null;
    /** Hardware decode was on in this launch (setting/env/lockout all allow it). */
    decodeEnabledAtLaunch: boolean;
    /** What the LAUNCH decided about NVIDIA. */
    launchNvidia: NvidiaDecodeState;
}

/**
 * Detection -> prompt decision. NVIDIA-only machines on the proprietary driver
 * whose launch said missing_driver / no_modeset are the only ones that ever see
 * anything; AMD, Intel, hybrid, nouveau and "already working" are 'none'.
 */
export function computeNvidiaVaapiStatus(i: NvidiaVaapiStatusInput): NvidiaVaapiStatus {
    if (i.platform !== 'linux' || !i.probe || !i.decodeEnabledAtLaunch) return NONE;
    if (i.launchNvidia !== 'missing_driver' && i.launchNvidia !== 'no_modeset') return NONE;
    const gpus = i.probe.gpus;
    const nvidia = gpus.filter(g => g.vendor === 'nvidia');
    // Defensive: the launch state already implies NVIDIA-only + proprietary.
    if (nvidia.length === 0 || gpus.some(g => g.vendor === 'intel' || g.vendor === 'amd') || nvidia.every(g => g.driver === 'nouveau')) return NONE;
    const p = nvidiaVaapiPackage(i.probe.distro);
    const modesetOk = i.probe.nvidiaDrmModeset === true;
    const modesetNote = modesetOk ? null : NVIDIA_MODESET_NOTE;
    if (!i.probe.nvidiaVaapiDriver) {
        return { state: 'install', pkg: p.pkg, command: p.install, modesetNote, canInstall: true };
    }
    if (!modesetOk) return { state: 'modeset', pkg: p.pkg, command: p.install, modesetNote, canInstall: false };
    // Driver present now, modeset fine, but this launch did not have it.
    return { state: 'restart', pkg: p.pkg, command: p.install, modesetNote: null, canInstall: false };
}

/** The same narrowing the renderer does on the way in - exported so tests can pin the wire shape. */
export function isNvidiaVaapiStatus(v: unknown): v is NvidiaVaapiStatus {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return (r.state === 'none' || r.state === 'install' || r.state === 'modeset' || r.state === 'restart')
        && typeof r.pkg === 'string' && typeof r.command === 'string'
        && (r.modesetNote === null || typeof r.modesetNote === 'string') && typeof r.canInstall === 'boolean';
}

// ── PackageKit ─────────────────────────────────────────────────────────────────

export type NvidiaVaapiInstallOutcome =
    | 'installed'
    | 'not_found'     // the repo has no such package (e.g. RPM Fusion not enabled): use the command
    | 'denied'        // the user cancelled / polkit refused
    | 'unavailable'   // no system bus / PackageKit not running or not activatable
    | 'failed'        // PackageKit reported an error
    | 'busy'          // an install is already in progress
    | 'unsupported';  // not Linux, or no NVIDIA offer to make

export interface NvidiaVaapiInstallResult {
    outcome: NvidiaVaapiInstallOutcome;
    /** Re-detected status after the attempt. */
    status: NvidiaVaapiStatus;
}

const PK_FILTER_NONE = 0;
const PK_TRANSACTION_FLAG_ONLY_TRUSTED = 1 << 1;
const PK_INFO_INSTALLED = 1;
const PK_EXIT_SUCCESS = 1;
const PK_EXIT_CANCELLED = 3;
const PK_ERROR_NOT_AUTHORIZED = 'not-authorized';
export const PACKAGEKIT_STEP_TIMEOUT_MS = 30_000;
/** The install itself can include a download and polkit prompt wait. */
export const PACKAGEKIT_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** A PackageKit transaction signal, plain-JS body. */
export interface PkSignal { member: string; body: unknown[] }

/** The system-bus surface the install needs; dbus-native in the app, a fake in tests. */
export interface PackageKitBus {
    /** PackageKit.CreateTransaction -> object path. Rejects with the D-Bus error name in the message. */
    createTransaction(): Promise<string>;
    /** Call a method on a transaction object. */
    callTransaction(path: string, member: string, signature: string, body: unknown[]): Promise<void>;
    /** Subscribe to the signals of one transaction object. Returns unsubscribe. */
    onSignal(path: string, handler: (s: PkSignal) => void): () => void;
    close(): void;
}

/** The package ids ("name;version;arch;data") of `pkgName` that are NOT installed, from Resolve's Package signals. */
export function pickInstallablePackageId(found: Array<{ info: number; id: string }>, pkgName: string): string | null {
    const cands = found.filter(f => f.info !== PK_INFO_INSTALLED && typeof f.id === 'string' && f.id.split(';')[0] === pkgName);
    return cands.length > 0 ? cands[cands.length - 1].id : null;
}

interface TxResult { exit: number; error: { code: string; details: string } | null; packages: Array<{ info: number; id: string }> }

/** Run one PackageKit transaction (they are single-use) and collect Package / ErrorCode / Finished. */
async function runTx(
    bus: PackageKitBus, start: (path: string) => Promise<void>, timeoutMs: number,
): Promise<TxResult> {
    const path = await withTimeout(bus.createTransaction(), PACKAGEKIT_STEP_TIMEOUT_MS, 'CreateTransaction');
    return await new Promise<TxResult>((resolve, reject) => {
        const res: TxResult = { exit: -1, error: null, packages: [] };
        let done = false;
        let unsub: () => void = () => { /* set below */ };
        const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(t); unsub(); fn(); };
        const t = setTimeout(() => finish(() => reject(new Error('PackageKit transaction timed out'))), timeoutMs);
        (t as { unref?: () => void }).unref?.();
        unsub = bus.onSignal(path, (s) => {
            if (s.member === 'Package' && typeof s.body[0] === 'number' && typeof s.body[1] === 'string') res.packages.push({ info: s.body[0], id: s.body[1] });
            else if (s.member === 'ErrorCode') res.error = { code: String(s.body[0]), details: String(s.body[1] ?? '').slice(0, 300) };
            else if (s.member === 'Finished') { res.exit = typeof s.body[0] === 'number' ? s.body[0] : -1; finish(() => resolve(res)); }
        });
        start(path).catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        (t as { unref?: () => void }).unref?.();
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

const DENIED_RE = /NotAuthorized|Cancelled|AccessDenied|not-authorized|org\.freedesktop\.PolicyKit/i;
const UNAVAILABLE_RE = /ServiceUnknown|NameHasNoOwner|Spawn\.|NoReply|ENOENT|ECONNREFUSED|no system bus|timed out/i;

function classifyError(e: unknown): NvidiaVaapiInstallOutcome {
    const m = e instanceof Error ? e.message : String(e);
    if (DENIED_RE.test(m)) return 'denied';
    if (UNAVAILABLE_RE.test(m)) return 'unavailable';
    return 'failed';
}

/** Resolve the exact package, then InstallPackages it (trusted only). `pkgName` must come from nvidiaVaapiPackage. */
export async function installViaPackageKit(
    bus: PackageKitBus, pkgName: string,
    opts: { installTimeoutMs?: number; stepTimeoutMs?: number } = {},
): Promise<NvidiaVaapiInstallOutcome> {
    const stepMs = opts.stepTimeoutMs ?? PACKAGEKIT_STEP_TIMEOUT_MS;
    const installMs = opts.installTimeoutMs ?? PACKAGEKIT_INSTALL_TIMEOUT_MS;
    try {
        const resolved = await runTx(bus, (p) => bus.callTransaction(p, 'Resolve', 'tas', [PK_FILTER_NONE, [pkgName]]), stepMs);
        const id = pickInstallablePackageId(resolved.packages, pkgName);
        if (!id) {
            // Already installed (resolved but nothing installable) is a success for the caller's purposes.
            return resolved.packages.some(p => p.info === PK_INFO_INSTALLED && p.id.split(';')[0] === pkgName) ? 'installed' : 'not_found';
        }
        const inst = await runTx(bus, (p) => bus.callTransaction(p, 'InstallPackages', 'tas', [PK_TRANSACTION_FLAG_ONLY_TRUSTED, [id]]), installMs);
        if (inst.exit === PK_EXIT_SUCCESS) return 'installed';
        if (inst.exit === PK_EXIT_CANCELLED) return 'denied';
        if (inst.error && (inst.error.code === PK_ERROR_NOT_AUTHORIZED || DENIED_RE.test(inst.error.code))) return 'denied';
        return 'failed';
    } catch (e) {
        return classifyError(e);
    } finally {
        try { bus.close(); } catch { /* gone */ }
    }
}

/** dbus-native SYSTEM bus for PackageKit, or null when there is none. Linux only (lazy require). */
export function dbusPackageKitBus(): PackageKitBus | null {
    if (!fs.existsSync('/run/dbus/system_bus_socket') && !process.env.DBUS_SYSTEM_BUS_ADDRESS) return null;
    interface Msg { type?: number; path?: string; member?: string; body?: unknown[]; sender?: string }
    let bus: {
        invoke: (msg: Record<string, unknown>, cb: (err: unknown, res: unknown) => void) => void;
        addMatch: (m: string, cb: (err: unknown) => void) => void;
        removeMatch: (m: string, cb: (err: unknown) => void) => void;
        connection: { on: (ev: string, cb: (a: never) => void) => void; removeListener?: (ev: string, cb: (a: never) => void) => void; end?: () => void };
    };
    let toPlain: (v: unknown) => unknown;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require so dbus-native stays out of the Windows/macOS dependency graph (Linux-only module)
        const dbus = require('dbus-native');
        bus = dbus.systemBus({ timeout: PACKAGEKIT_STEP_TIMEOUT_MS });
        toPlain = dbus.toPlain;
    } catch { return null; }
    bus.connection.on('error', (() => { /* the pending call fails on its own */ }) as (a: never) => void);
    const errText = (err: unknown): string => typeof err === 'string' ? err : (err as { message?: string; name?: string })?.message ?? (err as { name?: string })?.name ?? String(err);
    const PK = 'org.freedesktop.PackageKit';
    return {
        createTransaction: () => new Promise<string>((resolve, reject) => {
            bus.invoke({ destination: PK, path: '/org/freedesktop/PackageKit', interface: PK, member: 'CreateTransaction' }, (err, res) => {
                if (err) return reject(new Error(errText(err)));
                const p = toPlain(res);
                if (typeof p === 'string' && /^\/[A-Za-z0-9_/]+$/.test(p)) resolve(p);
                else reject(new Error('CreateTransaction returned no path'));
            });
        }),
        callTransaction: (path, member, signature, body) => new Promise<void>((resolve, reject) => {
            // interactive=true lets polkit show its authentication dialog.
            const call = () => bus.invoke({ destination: PK, path, interface: `${PK}.Transaction`, member, signature, body }, (err) => err ? reject(new Error(errText(err))) : resolve());
            bus.invoke({ destination: PK, path, interface: `${PK}.Transaction`, member: 'SetHints', signature: 'as', body: [['interactive=true']] }, () => call());
        }),
        onSignal: (path, handler) => {
            const rule = `type='signal',sender='${PK}',path='${path}'`;
            const onMsg = ((m: Msg) => {
                if (m.type !== 4 || m.path !== path || typeof m.member !== 'string') return;
                try { handler({ member: m.member, body: (toPlain(m.body ?? []) as unknown[]) }); } catch { /* ignore a malformed signal */ }
            }) as (a: never) => void;
            bus.connection.on('message', onMsg);
            bus.addMatch(rule, () => { /* a failed match surfaces as a timeout */ });
            return () => {
                try { bus.connection.removeListener?.('message', onMsg); bus.removeMatch(rule, () => { /* gone */ }); } catch { /* gone */ }
            };
        },
        close: () => { try { bus.connection.end?.(); } catch { /* gone */ } },
    };
}

/** Guards the one-install-at-a-time rule across IPC calls. Shared with video-encode-driver.ts (one PackageKit install at a time, whichever card asked). */
let installing = false;
/** Take the install lock; returns the release function, or null when an install is already running. */
export function acquireInstallLock(): (() => void) | null {
    if (installing) return null;
    installing = true;
    return () => { installing = false; };
}

export interface NvidiaVaapiDeps {
    /** Re-detect now (a fresh probe). */
    status: () => NvidiaVaapiStatus;
    busFactory?: () => PackageKitBus | null;
}

/**
 * The IPC body for "install the NVIDIA VA-API driver". Takes NO renderer input.
 * The package is whatever `status()` (os-release-derived) says; only offered when state is 'install'.
 */
export async function installNvidiaVaapiDriver(deps: NvidiaVaapiDeps): Promise<NvidiaVaapiInstallResult> {
    const before = deps.status();
    if (before.state !== 'install' || !before.pkg) return { outcome: 'unsupported', status: before };
    const release = acquireInstallLock();
    if (!release) return { outcome: 'busy', status: before };
    try {
        const bus = (deps.busFactory ?? dbusPackageKitBus)();
        if (!bus) return { outcome: 'unavailable', status: before };
        const outcome = await installViaPackageKit(bus, before.pkg);
        return { outcome, status: deps.status() };
    } finally {
        release();
    }
}
