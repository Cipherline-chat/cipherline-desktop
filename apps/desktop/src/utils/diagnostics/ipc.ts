/**
 * Renderer side of the diagnostics IPC (electron/diagnostics.ts). Trust
 * nothing that crosses the bridge: every reply is narrowed field by field to
 * the wire types in reportTypes.ts, and anything unexpected is dropped — the
 * same posture as screenShareDiagnostics.ts's parseMainDiagnostics.
 */
import type { CrashInfo, SystemInfo } from './reportTypes';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max = 128): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

const CHANNELS = ['stable', 'staging', 'dev', 'unknown'] as const;
const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
const CRASH_KINDS = ['renderer_gone', 'child_process_gone', 'main_exception', 'renderer_exception', 'unclean_exit'] as const;

export interface SystemInfoReply {
    system: SystemInfo;
    /** Scrubber input ONLY — never placed in a payload. */
    scrub: { homeDir?: string; osUsername?: string };
}

/** A SystemInfo with every field present, for when main gave us nothing. */
export function fallbackSystemInfo(appVersion: string): SystemInfo {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const platform: SystemInfo['platform'] = /Windows/i.test(ua) ? 'win32' : /Mac OS/i.test(ua) ? 'darwin' : 'linux';
    return {
        app_version: appVersion, build_commit: 'unknown', channel: 'unknown',
        electron: 'unknown', chrome: 'unknown', node: 'unknown',
        platform, os_version: 'unknown', arch: 'unknown', cpu_model: 'unknown',
        cpu_cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 0 : 0,
        ram_gb: 0, gpu: { devices: [], feature_status: {} }, displays: [],
        hardware_acceleration: true, uptime_s: 0,
    };
}

export function parseSystemInfoReply(v: unknown, appVersion: string, buildCommit: string): SystemInfoReply {
    const base = fallbackSystemInfo(appVersion);
    const out: SystemInfoReply = { system: { ...base, build_commit: buildCommit }, scrub: {} };
    if (!isObj(v)) return out;
    if (isObj(v.scrub)) {
        const h = str(v.scrub.homeDir, 512);
        const u = str(v.scrub.osUsername, 128);
        if (h) out.scrub.homeDir = h;
        if (u) out.scrub.osUsername = u;
    }
    const s = isObj(v.system) ? v.system : null;
    if (!s) return out;
    const gpu = isObj(s.gpu) ? s.gpu : {};
    const fs: Record<string, string> = {};
    if (isObj(gpu.feature_status)) {
        for (const [k, val] of Object.entries(gpu.feature_status).slice(0, 30)) if (typeof val === 'string') fs[k.slice(0, 40)] = val.slice(0, 40);
    }
    out.system = {
        app_version: str(s.app_version, 64) ?? appVersion,
        build_commit: buildCommit,
        channel: (CHANNELS as readonly unknown[]).includes(s.channel) ? s.channel as SystemInfo['channel'] : 'unknown',
        electron: str(s.electron, 40) ?? 'unknown',
        chrome: str(s.chrome, 40) ?? 'unknown',
        node: str(s.node, 40) ?? 'unknown',
        platform: (PLATFORMS as readonly unknown[]).includes(s.platform) ? s.platform as SystemInfo['platform'] : base.platform,
        os_version: str(s.os_version, 64) ?? 'unknown',
        arch: str(s.arch, 16) ?? 'unknown',
        cpu_model: str(s.cpu_model, 96) ?? 'unknown',
        cpu_cores: Math.max(0, Math.round(num(s.cpu_cores))),
        ram_gb: num(s.ram_gb),
        gpu: {
            devices: (Array.isArray(gpu.devices) ? gpu.devices : []).filter(isObj).slice(0, 6).map(d => {
                const dev: SystemInfo['gpu']['devices'][number] = {
                    vendor_id: str(d.vendor_id, 12) ?? '0x0',
                    device_id: str(d.device_id, 12) ?? '0x0',
                    active: d.active === true,
                };
                const dv = str(d.driver_vendor, 40);
                const dver = str(d.driver_version, 40);
                if (dv) dev.driver_vendor = dv;
                if (dver) dev.driver_version = dver;
                return dev;
            }),
            feature_status: fs,
        },
        displays: (Array.isArray(s.displays) ? s.displays : []).filter(isObj).slice(0, 8).map(d => ({
            width: Math.round(num(d.width)),
            height: Math.round(num(d.height)),
            scale_factor: num(d.scale_factor, 1),
            refresh_hz: Math.round(num(d.refresh_hz)),
            primary: d.primary === true,
        })),
        hardware_acceleration: s.hardware_acceleration !== false,
        uptime_s: Math.max(0, Math.round(num(s.uptime_s))),
    };
    return out;
}

export interface PendingCrashEntry {
    signature: string;
    count: number;
    seen: boolean;
    crash: CrashInfo;
}

export function parsePendingCrashesReply(v: unknown): PendingCrashEntry[] {
    if (!Array.isArray(v)) return [];
    const out: PendingCrashEntry[] = [];
    for (const item of v.slice(0, 10)) {
        if (!isObj(item) || !isObj(item.crash) || typeof item.signature !== 'string') continue;
        const c = item.crash;
        if (!(CRASH_KINDS as readonly unknown[]).includes(c.kind) || typeof c.occurred_at !== 'string') continue;
        const crash: CrashInfo = { kind: c.kind as CrashInfo['kind'], occurred_at: c.occurred_at.slice(0, 40) };
        const pt = str(c.process_type, 40); if (pt) crash.process_type = pt;
        const r = str(c.reason, 40); if (r) crash.reason = r;
        if (typeof c.exit_code === 'number' && Number.isFinite(c.exit_code)) crash.exit_code = Math.trunc(c.exit_code);
        const sn = str(c.service_name, 80); if (sn) crash.service_name = sn;
        const en = str(c.error_name, 64); if (en) crash.error_name = en;
        const m = str(c.message, 2000); if (m) crash.message = m;
        const st = str(c.stack, 16_000); if (st) crash.stack = st;
        const av = str(c.app_version_at_crash, 64); if (av) crash.app_version_at_crash = av;
        out.push({
            signature: item.signature.slice(0, 600),
            count: Math.max(1, Math.round(num(item.count, 1))),
            seen: item.seen === true,
            crash,
        });
    }
    return out;
}

/** Newest pending crash (the list is oldest → newest). */
export function newestCrash(list: readonly PendingCrashEntry[]): PendingCrashEntry | null {
    return list.length ? list[list.length - 1] : null;
}
