/**
 * Gather the live inputs for a diagnostic report — the only part of the
 * reporter that touches IPC, the DOM and app state. Everything it returns is
 * handed to the pure builder (bundle.ts), which scrubs, caps and fits it.
 *
 * Two phases so the modal feels instant: prepareReportInputs() runs once when
 * the reporter opens (async: system info, perf log, devices, pending crashes),
 * and buildFromPrepared() re-runs synchronously whenever the category or the
 * description changes.
 */
import { APP_VERSION, BUILD_COMMIT } from '../../constants';
import secureLocalStore from '../secureLocalStore';
import { fetchFreezeLog } from '../freezeLog';
import { getScreenShareCodecPref, getStreamStatsHudEnabled } from '../streamDiagnosticsPrefs';
import { getScreenShareSession } from '../screenShareDiagnostics';
import { parseStartupFlagsState } from '../startupFlags';
import { buildDiagnosticReport, type BuiltReport, type PerfLogInput, type SettingsSnapshot } from './bundle';
import { buildSettingsSnapshot, type NotificationPrefsLike, type VoiceSettingsLike } from './settingsSnapshot';
import { collectSensitiveTerms } from './sensitiveTerms';
import { getRecentErrors, type CapturedError } from './recentErrors';
import { webrtcRing } from './webrtcRing';
import { readCallEvents, type CallEventInput } from './callEventsSource';
import { avSyncSnapshotEvents, sampleAvSyncNow } from '../avSyncMonitor';
import { parsePendingCrashesReply, parseSystemInfoReply, type PendingCrashEntry } from './ipc';
import type { CrashInfo, DiagnosticCategory, DiagnosticTrigger, SystemInfo, WebrtcSummary } from './reportTypes';

export interface LiveContext {
    user: { username?: string | null; email?: string | null } | null;
    entitlement: { isPaid: boolean; canPublishVideo: boolean; maxUploadBytes: number } | null;
    notificationPrefs: NotificationPrefsLike | null;
}

export interface PreparedInputs {
    now: number;
    system: SystemInfo;
    homeDir?: string;
    settings: SettingsSnapshot;
    entitlement: LiveContext['entitlement'];
    perfLog: PerfLogInput[];
    webrtc: WebrtcSummary;
    callEvents: CallEventInput[];
    pendingCrashes: PendingCrashEntry[];
    recentErrors: CapturedError[];
    sensitiveTerms: string[];
}

function readVoiceSettings(): VoiceSettingsLike | null {
    try {
        const raw = secureLocalStore.getItem('cipherline_voice_settings');
        return raw ? JSON.parse(raw) as VoiceSettingsLike : null;
    } catch {
        return null;
    }
}

async function deviceKinds(): Promise<Array<{ kind: string }> | null> {
    try {
        const list = await navigator.mediaDevices?.enumerateDevices?.();
        // Kind only — the label and id are dropped on the spot.
        return list ? list.map(d => ({ kind: d.kind })) : null;
    } catch {
        return null;
    }
}

async function startupFlags() {
    try {
        const raw = await window.electronAPI?.getStartupFlags?.();
        return raw ? parseStartupFlagsState(raw) : null;
    } catch {
        return null;
    }
}

export async function prepareReportInputs(ctx: LiveContext): Promise<PreparedInputs> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const [sysRaw, crashesRaw, perf, devices, flags, avSync] = await Promise.all([
        api?.diagGetSystemInfo?.().catch(() => null) ?? Promise.resolve(null),
        api?.diagGetPendingCrashes?.().catch(() => null) ?? Promise.resolve(null),
        fetchFreezeLog().catch(() => []),
        deviceKinds(),
        startupFlags(),
        // A fresh A/V-sync estimate while a call is up (~1 s, in parallel with
        // the IPC above; bounded). Carried as `av_sync_estimate` call events —
        // no wire-schema change. Identity-free (per-call placeholders).
        sampleAvSyncNow().catch(() => []),
    ]);
    const now = Date.now();
    const { system, scrub } = parseSystemInfoReply(sysRaw, APP_VERSION, BUILD_COMMIT);
    const session = getScreenShareSession();
    const settings = buildSettingsSnapshot({
        hardwareAcceleration: system.hardware_acceleration,
        reducedMotion: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : undefined,
        voice: readVoiceSettings(),
        notifications: ctx.notificationPrefs,
        notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
        screenShareCodecPref: getScreenShareCodecPref(),
        streamStatsHud: getStreamStatsHudEnabled(),
        shareSession: session,
        startupFlags: flags,
        devices,
    });
    const sensitiveTerms = collectSensitiveTerms({
        extra: [ctx.user?.username, ctx.user?.email, scrub.osUsername],
    });
    return {
        now,
        system,
        homeDir: scrub.homeDir,
        settings,
        entitlement: ctx.entitlement,
        perfLog: (perf ?? []).map(r => ({ at: r.at, source: r.source, ms: r.ms, activity: r.activity })),
        webrtc: webrtcRing.summary(now),
        callEvents: [...readCallEvents(), ...avSyncSnapshotEvents(avSync)],
        pendingCrashes: parsePendingCrashesReply(crashesRaw),
        recentErrors: getRecentErrors(),
        sensitiveTerms,
    };
}

export function buildFromPrepared(p: PreparedInputs, o: {
    category: DiagnosticCategory;
    trigger: DiagnosticTrigger;
    description?: string;
    replyEmail?: string;
    crash?: CrashInfo | null;
}): BuiltReport {
    return buildDiagnosticReport({
        category: o.category,
        trigger: o.trigger,
        now: p.now,
        description: o.description,
        replyEmail: o.replyEmail,
        system: p.system,
        settings: p.settings,
        entitlement: p.entitlement,
        perfLog: p.perfLog,
        webrtc: p.webrtc,
        callEvents: p.callEvents,
        crash: o.crash ?? null,
        recentErrors: p.recentErrors,
        scrub: { sensitiveTerms: p.sensitiveTerms, homeDir: p.homeDir },
    });
}
