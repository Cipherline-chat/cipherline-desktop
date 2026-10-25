/**
 * Call-engine breadcrumbs mirrored into MAIN's perf log, so a renderer crash
 * no longer erases what the call was doing.
 *
 * Why: the 2026-10-24 auto crash report (staging.174, renderer_gone
 * exit 0xC0000005, ~25 s into a screen share) carried main's perf log — window
 * focus, picker enumeration, process metrics — and NOTHING about the call:
 * call events live in the renderer that had just died, and the report is built
 * by the next renderer. Main keeps these rows (electron/freeze-monitor.ts
 * FreezeMonitor.breadcrumb), and every report already includes that log as
 * `perf_log`, so no wire-schema change is needed.
 *
 * Only an allowlist of kinds is mirrored, and only scalar details that are
 * already in the call-event log (no new data leaves the renderer): numbers,
 * booleans and short identifier-like strings. Free-text-ish fields (the
 * foreground exe / state) are not mirrored.
 */
import type { CallEventDetail } from './callEventLog';

export const BREADCRUMB_KINDS: ReadonlySet<string> = new Set([
    'call_join', 'call_leave',
    'share_picker', 'share_codec', 'share_hdr', 'share_start', 'share_start_check', 'share_fallback',
    'share_low_layer', 'share_fps', 'share_clamp', 'h265_switch',
    'camera_codec', 'camera_start_check',
    'ns_load_fallback', 'audio_render', 'e2ee_audio_lag', 'av_sync_applied',
    'gpu_process_restarted', 'video_recovery', 'mic_device_switch',
]);

const SKIP_KEYS = new Set(['fg_exe', 'fg_state', 'fg_cover', 'enc']);
const SAFE_STR = /^[a-z0-9_.:-]{1,32}$/i;
const MAX_DETAIL = 200;

/** `k=v k=v` from a sanitized call-event detail, or '' when nothing is safe. */
export function formatBreadcrumbDetail(detail: CallEventDetail | undefined): string {
    if (!detail) return '';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(detail)) {
        if (SKIP_KEYS.has(k) || !/^[a-z][a-z0-9_]{0,31}$/.test(k)) continue;
        let s: string;
        if (typeof v === 'number') { if (!Number.isFinite(v)) continue; s = String(Math.round(v * 10) / 10); }
        else if (typeof v === 'boolean') s = v ? '1' : '0';
        else if (typeof v === 'string' && SAFE_STR.test(v)) s = v;
        else continue;
        const part = `${k}=${s}`;
        if (parts.join(' ').length + part.length + 1 > MAX_DETAIL) break;
        parts.push(part);
    }
    return parts.join(' ');
}

type Bridge = { perfBreadcrumb?: (name: string, detail: string) => void };
const bridge = (): Bridge | undefined =>
    (typeof window !== 'undefined' ? (window as unknown as { electronAPI?: Bridge }).electronAPI : undefined);

/** Mirror one call event to main, if its kind is on the list. Never throws. */
export function mirrorBreadcrumb(kind: string, detail: CallEventDetail | undefined, send: Bridge['perfBreadcrumb'] = bridge()?.perfBreadcrumb): boolean {
    if (!BREADCRUMB_KINDS.has(kind) || typeof send !== 'function') return false;
    try { send(`call:${kind}`, formatBreadcrumbDetail(detail)); return true; } catch { return false; }
}
