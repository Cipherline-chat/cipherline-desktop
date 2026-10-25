/**
 * Beta diagnostics — bridges from the diagnostics the app ALREADY keeps into
 * beta events, so failure detection is not duplicated:
 *
 *   deliveryDiagnostics.record   → key_decrypt_failed / msg_fetch_gap / msg_send_failed
 *   callEventLog.logCallEvent    → call_reconnect / call_e2ee_error / share_failed /
 *                                  camera_failed / mic_failed / gpu_fallback,
 *                                  and the live call summary's counters
 *   webrtcRing.record            → the live call summary's samples
 *   freezeLog (long frames)      → app_freeze (≥ APP_FREEZE_MS)
 *   recentErrors.captureError    → unhandled_error
 *
 * Each source keeps its own single tap slot; installBetaBridges() fills them
 * once and returns an uninstall function. The taps run on the reporting
 * code's own call stack, so each one is a few comparisons and returns at once
 * while beta diagnostics is off.
 */
import { setDeliveryTap, type DiagnosticEntry } from '../deliveryDiagnostics';
import { setCallEventTap } from '../callEventLog';
import { setFreezeTap } from '../freezeLog';
import { setErrorTap } from '../diagnostics/recentErrors';
import { webrtcRing } from '../diagnostics/webrtcRing';
import { getScreenShareSession } from '../screenShareDiagnostics';
import { enumish } from './sanitize';
import { isBetaActive, reportBeta } from './reporter';
import { getActiveCallSummary } from './callSession';

/** A renderer stall at least this long is an app_freeze (the perf log keeps everything ≥ 200 ms). */
export const APP_FREEZE_MS = 1_000;

/** Delivery-diagnostics failure → beta event. Exported for tests. */
export function deliveryEntryToBeta(entry: Pick<DiagnosticEntry, 'kind' | 'code' | 'ctx'>): { kind: Parameters<typeof reportBeta>[0]; detail: Record<string, unknown> } | null {
    const code = enumish(entry.code);
    const status = typeof entry.ctx?.status === 'number' ? entry.ctx.status : undefined;
    const base = { ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}) };
    switch (entry.kind) {
        case 'message_decrypt': return { kind: 'key_decrypt_failed', detail: { scope: 'dm', ...base } };
        case 'channel_key_decrypt': return { kind: 'key_decrypt_failed', detail: { scope: 'channel_key', ...base } };
        case 'message_process': return { kind: 'msg_fetch_gap', detail: { stage: 'process', ...base } };
        case 'message_persist': return { kind: 'msg_fetch_gap', detail: { stage: 'persist', ...base } };
        case 'message_ack': return { kind: 'msg_fetch_gap', detail: { stage: 'ack', ...base } };
        case 'message_encrypt': return { kind: 'msg_send_failed', detail: { stage: 'encrypt', ...base } };
        // channel_key_request / _pull / _distribute: no v1 kind fits a failed
        // REST hop of the key path. The requester's wait is covered by
        // key_request_unanswered (detectors.ts).
        default: return null;
    }
}

/** A call-event-log entry → beta event (or null). Exported for tests. */
export function callEventToBeta(kind: string, d: Record<string, unknown> | undefined): { kind: Parameters<typeof reportBeta>[0]; detail?: Record<string, unknown> } | null {
    const v = d ?? {};
    switch (kind) {
        case 'reconnecting': return { kind: 'call_reconnect' };
        case 'e2ee_decrypt_error': return { kind: 'call_e2ee_error', detail: { scope: 'media', reason: v.reason, count: 1 } };
        case 'e2ee_data_error': return { kind: 'call_e2ee_error', detail: { scope: 'data', reason: v.reason, count: 1 } };
        case 'share_start':
            if (v.verdict !== 'failed') return null;
            return { kind: 'share_failed', detail: { stage: 'start', why: v.why, ...shareSource() } };
        case 'share_start_check':
            if (v.verdict !== 'stalled' && v.verdict !== 'no-frames') return null;
            return { kind: 'share_failed', detail: { stage: 'encoder_stall', codec: v.codec, ...shareSource() } };
        case 'camera_encoder_stall': return { kind: 'camera_failed', detail: { stage: 'encoder_stall', codec: v.codec, hardware: v.hardware } };
        case 'mic_device_switch':
            if (v.verdict !== 'failed') return null;
            return { kind: 'mic_failed', detail: { stage: 'device_switch', reason: v.reason, to_default: v.to_default } };
        case 'gpu_process_restarted': return { kind: 'gpu_fallback', detail: { stage: 'gpu_process_restarted', reason: v.reason, exit_code: v.exit_code, in_call: v.in_call } };
        default: return null;
    }
}

function shareSource(): { source?: string } {
    try {
        const k = getScreenShareSession()?.main?.sourceKind;
        return k === 'screen' || k === 'window' ? { source: k } : {};
    } catch {
        return {};
    }
}

/** The first static activity label of a stall (`startup:hydrate`, `dm:pull`, `call:in-call`…). */
export function freezePhase(activity: string): string | undefined {
    const first = activity.split(',')[0]?.trim();
    return first && first !== 'idle' && /^[a-z][a-z0-9_.:-]{0,63}$/i.test(first) ? first : undefined;
}

let installed: (() => void) | null = null;

export function installBetaBridges(): () => void {
    if (installed) return installed;
    setDeliveryTap((entry) => {
        if (!isBetaActive()) return;
        const m = deliveryEntryToBeta(entry);
        if (m) reportBeta(m.kind, m.detail);
    });
    setCallEventTap((kind, detail) => {
        // The summary counts every event of the live call, gated or not —
        // it is only SENT when active (callSession.ts).
        getActiveCallSummary()?.onCallEvent(kind, detail);
        if (!isBetaActive()) return;
        const m = callEventToBeta(kind, detail);
        if (m) reportBeta(m.kind, m.detail);
    });
    webrtcRing.setTap((sample, at) => { getActiveCallSummary()?.onSample(sample, at); });
    setFreezeTap((ms, activity) => {
        if (ms < APP_FREEZE_MS || !isBetaActive()) return;
        const phase = freezePhase(activity);
        reportBeta('app_freeze', { ms, ...(phase ? { phase } : {}) });
    });
    setErrorTap((kind, value) => {
        if (!isBetaActive()) return;
        reportBeta('unhandled_error', { source: kind }, value);
    });
    installed = () => {
        setDeliveryTap(null);
        setCallEventTap(null);
        webrtcRing.setTap(null);
        setFreezeTap(null);
        setErrorTap(null);
        installed = null;
    };
    return installed;
}
