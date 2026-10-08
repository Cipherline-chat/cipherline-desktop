/**
 * Presentation helpers for `call_events` in the report PREVIEW (ReportPreview).
 * Pure functions over the already-scrubbed wire objects — nothing here can add
 * information to a report, it only decides how the user reads it.
 */
import type { CallEvent } from './reportTypes';

/** `ice_selected` → `Ice selected`. */
export function callEventLabel(event: string): string {
    const t = event.replace(/_/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/** `type: relay · protocol: udp · turn: yes` — booleans read as yes / no. */
export function callEventDetailText(detail: CallEvent['detail']): string {
    if (!detail) return '';
    return Object.entries(detail)
        .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}`)
        .join(' · ');
}

export type CallEventTone = '' | 'rp-warn' | 'rp-bad';

/**
 * Colour cue for a row: freezes and CPU-limit changes are red, other
 * quality-limit changes and fallbacks amber, everything else plain. Matches on
 * the event NAME (callEventLog's fixed set), so an unknown name is just plain.
 */
export function callEventTone(e: CallEvent): CallEventTone {
    if (/freeze/.test(e.event)) return 'rp-bad';
    if (/limit/.test(e.event)) {
        const to = e.detail?.to ?? e.detail?.reason ?? e.detail?.quality_limitation_reason;
        if (to === 'cpu') return 'rp-bad';
        return to === 'none' ? '' : 'rp-warn';
    }
    if (/fallback/.test(e.event) || e.detail?.fallback === true) return 'rp-warn';
    return '';
}
