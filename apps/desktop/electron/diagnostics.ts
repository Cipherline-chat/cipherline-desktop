/**
 * diagnostics — the main-process half of the crash / issue reporter.
 *
 * What lives here:
 *   • CRASH CAPTURE → a short list of pending crash records the renderer
 *     offers to send on the next boot ("Cipherline closed unexpectedly…").
 *     Sources: render-process-gone, child-process-gone (GPU / Utility / …),
 *     main-process uncaughtException / unhandledRejection, the root React
 *     error boundary (via IPC), and an UNCLEAN-EXIT marker — a tiny file
 *     written at startup and removed on a clean quit; finding it at the next
 *     launch means the last session died without quitting.
 *   • SYSTEM INFO for a report (versions, OS, CPU/RAM, GPU ids + driver,
 *     display sizes / refresh rates).
 *   • Validation for the "Save to file" IPC.
 *
 * PRIVACY:
 *   • JS-level crash info only — error name, SCRUBBED message + stack, process
 *     TYPE, Electron's fixed reason enum, exit code, versions. No minidumps,
 *     no crashReporter, no process memory.
 *   • Every free-text string goes through ./diagnostics-scrub (the
 *     byte-identical copy of the renderer's scrubber) with the OS home
 *     directory and the OS account name as sensitive terms. The renderer
 *     scrubs the whole report AGAIN with the full term list (usernames,
 *     server / channel names) before anything is shown or sent.
 *   • The unclean-exit marker holds the app version and a start time. Nothing
 *     else.
 *   • Pending records are persisted ENCRYPTED through SecureStore (main.ts
 *     supplies the storage adapter), never as plaintext files.
 *
 * Like lifecycle-diagnostics.ts this file has no runtime `electron` import:
 * the Electron objects are passed in, structurally typed, so it is
 * unit-testable (diagnostics.test.ts). It must not import from src/ either
 * (the rootDir trap in CLAUDE.md) — the report types it produces are a
 * narrowed copy of src/utils/diagnostics/reportTypes.ts, and the renderer
 * re-validates everything it receives over IPC.
 */
import { createScrubber, type Scrubber } from './diagnostics-scrub';

// ── Types (structural copy of the renderer's CrashInfo / SystemInfo) ─────────

export type CrashKind = 'renderer_gone' | 'child_process_gone' | 'main_exception' | 'renderer_exception' | 'unclean_exit';

export interface CrashInfoLike {
    kind: CrashKind;
    process_type?: string;
    reason?: string;
    exit_code?: number;
    service_name?: string;
    error_name?: string;
    message?: string;
    stack?: string;
    occurred_at: string;
    app_version_at_crash?: string;
}

export interface PendingCrash {
    /** Stable dedupe key: kind + process type + reason + error + top frame. */
    signature: string;
    /** How many times this signature was seen while pending. Not sent. */
    count: number;
    /** Set once the renderer has shown the boot prompt for it ("Not now"). */
    seen: boolean;
    crash: CrashInfoLike;
}

/** At most this many pending records; the oldest falls off. */
export const MAX_PENDING_CRASHES = 5;

/** Electron's fixed `reason` values that mean "this died abnormally". */
export const CRASH_REASONS: ReadonlySet<string> = new Set([
    'crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit',
]);

const REASON_RE = /^[a-z-]{1,40}$/;
const PROCESS_TYPE_RE = /^[A-Za-z][A-Za-z -]{0,39}$/;
const SERVICE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const ERROR_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const iso = (ms: number): string => new Date(ms).toISOString();
const intOrUndef = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
const pick = (v: unknown, re: RegExp): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined);

/** The scrubber main uses for its own records: home dir + OS account name. */
export function mainScrubber(homeDir: string | undefined, osUsername: string | undefined): Scrubber {
    return createScrubber({
        homeDir,
        sensitiveTerms: osUsername ? [osUsername] : [],
        maxLength: 2000,
    });
}

// ── Building records ─────────────────────────────────────────────────────────

/** Is this `child-process-gone` / `render-process-gone` reason a crash? */
export function isCrashReason(reason: unknown): boolean {
    return typeof reason === 'string' && CRASH_REASONS.has(reason);
}

/** `render-process-gone` → record, or null when the reason is not a crash. */
export function crashFromRenderGone(details: unknown, now: number, appVersion: string): CrashInfoLike | null {
    const d = (details ?? {}) as { reason?: unknown; exitCode?: unknown };
    if (!isCrashReason(d.reason)) return null;
    return {
        kind: 'renderer_gone',
        process_type: 'renderer',
        reason: d.reason as string,
        exit_code: intOrUndef(d.exitCode),
        occurred_at: iso(now),
        app_version_at_crash: pick(appVersion, VERSION_RE),
    };
}

/** `app.on('child-process-gone')` → record, or null when not a crash. */
export function crashFromChildGone(details: unknown, now: number, appVersion: string): CrashInfoLike | null {
    const d = (details ?? {}) as { type?: unknown; reason?: unknown; exitCode?: unknown; serviceName?: unknown };
    if (!isCrashReason(d.reason)) return null;
    return {
        kind: 'child_process_gone',
        process_type: pick(d.type, PROCESS_TYPE_RE) ?? 'unknown',
        reason: d.reason as string,
        exit_code: intOrUndef(d.exitCode),
        service_name: pick(d.serviceName, SERVICE_RE),
        occurred_at: iso(now),
        app_version_at_crash: pick(appVersion, VERSION_RE),
    };
}

/** Name / message / stack out of whatever was thrown, scrubbed. */
function describeThrown(thrown: unknown, scrubber: Scrubber): { error_name?: string; message?: string; stack?: string } {
    if (thrown instanceof Error || (thrown && typeof thrown === 'object' && 'message' in (thrown as object))) {
        const e = thrown as { name?: unknown; message?: unknown; stack?: unknown };
        const name = typeof e.name === 'string' ? e.name : undefined;
        const stackRaw = typeof e.stack === 'string' ? e.stack : undefined;
        return {
            error_name: pick(name, ERROR_NAME_RE) ?? (name ? 'Error' : undefined),
            message: scrubber.text(e.message, 1000) || undefined,
            stack: stackRaw ? scrubber.stack(stackRaw, 30) : undefined,
        };
    }
    // A thrown string / number / plain value: the value IS the message.
    const msg = scrubber.text(thrown, 1000);
    return { message: msg || undefined };
}

/** Main-process `uncaughtException` / `unhandledRejection` → record. */
export function crashFromMainError(
    thrown: unknown,
    origin: 'uncaughtException' | 'unhandledRejection',
    now: number,
    appVersion: string,
    scrubber: Scrubber,
): CrashInfoLike {
    return {
        kind: 'main_exception',
        process_type: 'browser',
        reason: origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception',
        ...describeThrown(thrown, scrubber),
        occurred_at: iso(now),
        app_version_at_crash: pick(appVersion, VERSION_RE),
    };
}

/**
 * The root error boundary's report (renderer → main over IPC). Untrusted
 * input: only strings, length-capped, scrubbed again here.
 */
export function crashFromRendererReport(payload: unknown, now: number, appVersion: string, scrubber: Scrubber): CrashInfoLike | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const p = payload as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof p.name === 'string' ? p.name.slice(0, 64) : undefined;
    const message = typeof p.message === 'string' ? p.message.slice(0, 4000) : undefined;
    const stack = typeof p.stack === 'string' ? p.stack.slice(0, 16_000) : undefined;
    if (!name && !message && !stack) return null;
    return {
        kind: 'renderer_exception',
        process_type: 'renderer',
        reason: 'render-error',
        error_name: pick(name, ERROR_NAME_RE),
        message: message ? scrubber.text(message, 1000) || undefined : undefined,
        stack: stack ? scrubber.stack(stack, 30) : undefined,
        occurred_at: iso(now),
        app_version_at_crash: pick(appVersion, VERSION_RE),
    };
}

/** First "at …" line of a stack, for the signature (already scrubbed). */
function topFrame(stack: string | undefined): string {
    if (!stack) return '';
    const line = stack.split('\n').find(l => /^\s*at\s/.test(l));
    return (line ?? '').trim().slice(0, 200);
}

/** Dedupe key. Deliberately excludes times, exit codes and counters. */
export function crashSignature(c: CrashInfoLike): string {
    return [
        c.kind,
        c.process_type ?? '',
        c.reason ?? '',
        c.service_name ?? '',
        c.error_name ?? '',
        (c.message ?? '').split('\n')[0].slice(0, 160),
        topFrame(c.stack),
    ].join('|');
}

/**
 * Add a record to the pending list (pure). An identical signature is merged —
 * the newer occurrence replaces the older one in place of honour (moved to the
 * end, count incremented, `seen` reset so the boot prompt asks again about a
 * crash that happened AGAIN). The list never exceeds MAX_PENDING_CRASHES; the
 * oldest falls off.
 */
export function addPendingCrash(list: readonly PendingCrash[], crash: CrashInfoLike): PendingCrash[] {
    const signature = crashSignature(crash);
    const existing = list.find(p => p.signature === signature);
    const rest = list.filter(p => p.signature !== signature);
    const next: PendingCrash = { signature, count: (existing?.count ?? 0) + 1, seen: false, crash };
    const out = [...rest, next];
    return out.length > MAX_PENDING_CRASHES ? out.slice(out.length - MAX_PENDING_CRASHES) : out;
}

/** Validate a persisted / IPC-supplied list. Anything malformed is dropped. */
export function parsePendingCrashes(raw: unknown): PendingCrash[] {
    let v: unknown = raw;
    if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { return []; }
    }
    if (!Array.isArray(v)) return [];
    const out: PendingCrash[] = [];
    for (const item of v.slice(-MAX_PENDING_CRASHES)) {
        if (!item || typeof item !== 'object') continue;
        const it = item as Partial<PendingCrash>;
        const c = it.crash as Partial<CrashInfoLike> | undefined;
        if (!c || typeof c !== 'object') continue;
        if (!['renderer_gone', 'child_process_gone', 'main_exception', 'renderer_exception', 'unclean_exit'].includes(c.kind as string)) continue;
        if (typeof c.occurred_at !== 'string' || !ISO_RE.test(c.occurred_at)) continue;
        const crash: CrashInfoLike = {
            kind: c.kind as CrashKind,
            process_type: pick(c.process_type, PROCESS_TYPE_RE),
            reason: pick(c.reason, REASON_RE),
            exit_code: intOrUndef(c.exit_code),
            service_name: pick(c.service_name, SERVICE_RE),
            error_name: pick(c.error_name, ERROR_NAME_RE),
            message: typeof c.message === 'string' ? c.message.slice(0, 2000) : undefined,
            stack: typeof c.stack === 'string' ? c.stack.slice(0, 16_000) : undefined,
            occurred_at: c.occurred_at,
            app_version_at_crash: pick(c.app_version_at_crash, VERSION_RE),
        };
        for (const k of Object.keys(crash) as (keyof CrashInfoLike)[]) if (crash[k] === undefined) delete crash[k];
        out.push({
            signature: crashSignature(crash),
            count: typeof it.count === 'number' && it.count > 0 ? Math.min(Math.trunc(it.count), 1_000_000) : 1,
            seen: it.seen === true,
            crash,
        });
    }
    return out;
}

// ── Unclean-exit marker ──────────────────────────────────────────────────────

export const UNCLEAN_EXIT_MARKER_FILE = 'diag-session.json';

export interface SessionMarker {
    v: 1;
    version: string;
    /** ISO time this session started. */
    started_at: string;
}

export function serializeMarker(version: string, now: number): string {
    const m: SessionMarker = { v: 1, version: pick(version, VERSION_RE) ?? '0.0.0', started_at: iso(now) };
    return JSON.stringify(m);
}

export function parseMarker(text: unknown): SessionMarker | null {
    if (typeof text !== 'string' || text.length > 512) return null;
    try {
        const m = JSON.parse(text) as Partial<SessionMarker>;
        if (m?.v !== 1 || typeof m.started_at !== 'string' || !ISO_RE.test(m.started_at)) return null;
        return { v: 1, version: pick(m.version, VERSION_RE) ?? '0.0.0', started_at: m.started_at };
    } catch {
        return null;
    }
}

/**
 * A marker left behind by the previous launch → an `unclean_exit` record.
 * `occurred_at` is when that session STARTED: when it actually died is not
 * knowable without writing to disk while running, which we deliberately do not.
 * Unreadable / garbage marker → still an unclean exit, version unknown.
 */
export function crashFromLeftoverMarker(text: string | null, now: number): CrashInfoLike | null {
    if (text === null) return null;
    const m = parseMarker(text);
    return {
        kind: 'unclean_exit',
        process_type: 'browser',
        reason: 'unclean-exit',
        message: 'The previous session ended without a clean quit (occurred_at is when that session started).',
        occurred_at: m?.started_at ?? iso(now),
        ...(m && m.version !== '0.0.0' ? { app_version_at_crash: m.version } : {}),
    };
}

/** Minimal file-system slice used for the marker (fs, injected). */
export interface MarkerFs {
    readFileSync(p: string, enc: 'utf8'): string;
    writeFileSync(p: string, data: string, opts: { encoding: 'utf8'; mode: number }): void;
    unlinkSync(p: string): void;
}

/**
 * Startup: read (and so consume) the previous session's marker, then write
 * this session's. Returns the record for a leftover marker. Callers skip this
 * entirely under the smoke test (no disk writes at startup — CLAUDE.md).
 */
export function rotateSessionMarker(fs: MarkerFs, markerPath: string, version: string, now: number): CrashInfoLike | null {
    let leftover: string | null = null;
    try { leftover = fs.readFileSync(markerPath, 'utf8'); } catch { leftover = null; }
    const record = crashFromLeftoverMarker(leftover, now);
    try { fs.writeFileSync(markerPath, serializeMarker(version, now), { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ }
    return record;
}

/** Clean quit / OS shutdown: remove the marker. Idempotent. */
export function clearSessionMarker(fs: MarkerFs, markerPath: string): void {
    try { fs.unlinkSync(markerPath); } catch { /* already gone */ }
}

// ── Pending store (persisted through an injected storage adapter) ────────────

export interface PendingStorage {
    /** null when nothing is stored, or the store is not usable. */
    read(): string | null;
    write(value: string): void;
    clear(): void;
}

/**
 * In-memory list + write-through to `storage` once it is attached. Records
 * captured before SecureStore is ready (a crash during startup) are held in
 * memory and merged on attach.
 */
export class PendingCrashStore {
    private list: PendingCrash[] = [];
    private storage: PendingStorage | null = null;

    attach(storage: PendingStorage): void {
        this.storage = storage;
        let persisted: PendingCrash[] = [];
        try { persisted = parsePendingCrashes(storage.read()); } catch { persisted = []; }
        // Persisted (older) first, then anything captured this launch.
        let merged = persisted;
        for (const p of this.list) {
            merged = addPendingCrash(merged, p.crash);
            const m = merged.find(x => x.signature === p.signature);
            if (m) { m.count = Math.max(m.count, p.count); m.seen = p.seen; }
        }
        this.list = merged;
        this.persist();
    }

    add(crash: CrashInfoLike | null): void {
        if (!crash) return;
        this.list = addPendingCrash(this.list, crash);
        this.persist();
    }

    all(): PendingCrash[] {
        return this.list.map(p => ({ ...p, crash: { ...p.crash } }));
    }

    markSeen(signatures?: readonly string[]): void {
        for (const p of this.list) if (!signatures || signatures.includes(p.signature)) p.seen = true;
        this.persist();
    }

    remove(signatures?: readonly string[]): void {
        this.list = signatures ? this.list.filter(p => !signatures.includes(p.signature)) : [];
        this.persist();
    }

    private persist(): void {
        if (!this.storage) return;
        try {
            if (this.list.length === 0) this.storage.clear();
            else this.storage.write(JSON.stringify(this.list));
        } catch { /* store locked / unavailable — memory only this launch */ }
    }
}

/** Parse a renderer-supplied list of signatures (IPC). */
export function parseSignatures(v: unknown): string[] | undefined {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is string => typeof s === 'string' && s.length <= 600).slice(0, MAX_PENDING_CRASHES * 2);
}

// ── System info ──────────────────────────────────────────────────────────────

export interface GpuInfoLike {
    gpuDevice?: Array<{ vendorId?: number; deviceId?: number; active?: boolean; driverVendor?: string; driverVersion?: string }>;
}

export interface DisplayLike {
    id: number;
    size: { width: number; height: number };
    scaleFactor: number;
    displayFrequency?: number;
}

export interface SystemInfoDeps {
    appVersion: string;
    versions: { electron?: string; chrome?: string; node?: string };
    platform: string;
    osRelease: string;
    arch: string;
    cpus: Array<{ model: string }>;
    totalMemBytes: number;
    gpuInfo: GpuInfoLike | null;
    gpuFeatureStatus: Record<string, unknown> | null;
    displays: DisplayLike[];
    primaryDisplayId: number | null;
    hardwareAcceleration: boolean;
    uptimeS: number;
    channel: 'stable' | 'staging' | 'dev' | 'unknown';
}

export interface SystemInfoLike {
    app_version: string;
    build_commit: string;
    channel: 'stable' | 'staging' | 'dev' | 'unknown';
    electron: string;
    chrome: string;
    node: string;
    platform: 'win32' | 'darwin' | 'linux';
    os_version: string;
    arch: string;
    cpu_model: string;
    cpu_cores: number;
    ram_gb: number;
    gpu: {
        devices: Array<{ vendor_id: string; device_id: string; active: boolean; driver_vendor?: string; driver_version?: string }>;
        feature_status: Record<string, string>;
    };
    displays: Array<{ width: number; height: number; scale_factor: number; refresh_hz: number; primary: boolean }>;
    hardware_acceleration: boolean;
    uptime_s: number;
}

const hex = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? `0x${Math.trunc(n).toString(16)}` : '0x0');
const short = (s: unknown, n: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Which update channel this install is on, as the report names it. */
export function reportChannel(packaged: boolean, stored: string | null, version: string): SystemInfoLike['channel'] {
    if (!packaged) return 'dev';
    if (stored === 'staging') return 'staging';
    if (stored === 'latest') return 'stable';
    return version.includes('-') ? 'staging' : 'stable';
}

/**
 * Assemble SystemInfo from injected Electron/OS values. The build commit is
 * filled in by the renderer (it is a Vite build constant — the same one
 * Settings → Advanced → Source commit shows), so main reports 'unknown'.
 */
export function buildSystemInfo(d: SystemInfoDeps): SystemInfoLike {
    const platform = d.platform === 'win32' || d.platform === 'darwin' ? d.platform : 'linux';
    const featureStatus: Record<string, string> = {};
    if (d.gpuFeatureStatus) {
        for (const [k, v] of Object.entries(d.gpuFeatureStatus).slice(0, 30)) {
            if (/^[a-z0-9_]{1,40}$/.test(k) && typeof v === 'string' && /^[a-z_]{1,40}$/.test(v)) featureStatus[k] = v;
        }
    }
    const devices = (d.gpuInfo?.gpuDevice ?? []).slice(0, 6).map(g => {
        const dev: SystemInfoLike['gpu']['devices'][number] = {
            vendor_id: hex(g.vendorId),
            device_id: hex(g.deviceId),
            active: g.active === true,
        };
        const dv = short(g.driverVendor, 40);
        const dver = short(g.driverVersion, 40);
        if (dv && /^[A-Za-z0-9 ._()-]{1,40}$/.test(dv)) dev.driver_vendor = dv;
        if (dver && /^[0-9A-Za-z._-]{1,40}$/.test(dver)) dev.driver_version = dver;
        return dev;
    });
    const displays = d.displays.slice(0, 8).map(s => ({
        width: Math.round(s.size.width * (s.scaleFactor || 1)),
        height: Math.round(s.size.height * (s.scaleFactor || 1)),
        scale_factor: Math.round((s.scaleFactor || 1) * 100) / 100,
        refresh_hz: Math.round(s.displayFrequency ?? 0),
        primary: d.primaryDisplayId !== null && s.id === d.primaryDisplayId,
    }));
    return {
        app_version: d.appVersion,
        build_commit: 'unknown',
        channel: d.channel,
        electron: d.versions.electron ?? 'unknown',
        chrome: d.versions.chrome ?? 'unknown',
        node: d.versions.node ?? 'unknown',
        platform,
        os_version: short(d.osRelease, 64),
        arch: short(d.arch, 16),
        cpu_model: short(d.cpus[0]?.model, 96),
        cpu_cores: d.cpus.length,
        ram_gb: Math.round((d.totalMemBytes / 1024 ** 3) * 10) / 10,
        gpu: { devices, feature_status: featureStatus },
        displays,
        hardware_acceleration: d.hardwareAcceleration,
        uptime_s: Math.max(0, Math.round(d.uptimeS)),
    };
}

// ── Save to file ─────────────────────────────────────────────────────────────

export const MAX_REPORT_FILE_BYTES = 512 * 1024;
const CATEGORY_RE = /^(?:crash|screen_share|call_audio|video_camera|performance|notifications|other)$/;

/**
 * Validate what the renderer asks main to write: a string, ≤ 512 KiB of
 * UTF-8, that parses as a JSON object. Main writes exactly that string and
 * nothing else — it never builds or reads report content itself.
 */
export function validateReportFile(category: unknown, content: unknown): { ok: true; category: string; text: string } | { ok: false; error: string } {
    if (typeof category !== 'string' || !CATEGORY_RE.test(category)) return { ok: false, error: 'bad-category' };
    if (typeof content !== 'string') return { ok: false, error: 'not-a-string' };
    if (Buffer.byteLength(content, 'utf8') > MAX_REPORT_FILE_BYTES) return { ok: false, error: 'too-large' };
    try {
        const parsed = JSON.parse(content) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'not-an-object' };
    } catch {
        return { ok: false, error: 'not-json' };
    }
    return { ok: true, category, text: content };
}

/** `cipherline-diagnostics-screen_share-2026-10-07.json` (local date). */
export function defaultReportFileName(category: string, now: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    return `cipherline-diagnostics-${CATEGORY_RE.test(category) ? category : 'other'}-${date}.json`;
}
