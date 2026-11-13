/**
 * "Send a call quality report?" — what a LOW call rating offers.
 *
 * Sends the same three reports a user would file by hand from the in-call
 * menu — call audio, screen share, camera — through the manual-report
 * pipeline (buildFromPrepared → sendDiagnosticReport → POST
 * /v1/diagnostics/reports). Nothing here is automatic: it runs only after the
 * user pressed Send on the card. Trigger is the existing 'in_call'; no API
 * change.
 *
 * The call has already ended when the card shows, so the caller prepares the
 * inputs (prepareReportInputs) the moment the card appears: webrtcRing and the
 * call event log still hold the just-ended call then (the ring is frozen at
 * call end, not cleared, and only the NEXT call's beginCall drops it).
 *
 * RATE LIMIT: the API allows 3 report submits per minute per user. Three
 * reports fit exactly, but an earlier manual report in the same window makes
 * the last one 429. A 429 (and a transient offline / 5xx) is retried after a
 * wait, never dropped and never hammered; only a permanent refusal gives up,
 * and the caller is told how many went out so it can say so.
 */
import type { DiagnosticCategory, DiagnosticReportBody } from './reportTypes';
import type { SendResult } from './sendPolicy';
import { buildFromPrepared, type PreparedInputs } from './collect';

export const CALL_QUALITY_CATEGORIES: readonly DiagnosticCategory[] = ['call_audio', 'screen_share', 'video_camera'];

/** Ratings at or below this (of 5: "Bad" and "Poor") offer the report. */
export const LOW_RATING_MAX = 2;
export const isLowRating = (rating: number): boolean => rating >= 1 && rating <= LOW_RATING_MAX;

/** The throttle window is 60 s; wait a little past it. */
export const RATE_LIMIT_WAIT_MS = 62_000;
export const TRANSIENT_WAIT_MS = 10_000;
export const MAX_RETRIES = 2;

/** Free text for the report: the rating and the tag enums, nothing typed by anyone. */
export function describeRating(rating: number, tags: readonly string[]): string {
    const t = tags.length ? ` Reported problems: ${tags.join(', ')}.` : '';
    return `Rated ${rating} out of 5 right after the call ended.${t}`;
}

export function buildCallQualityBodies(prepared: PreparedInputs, rating: number, tags: readonly string[]): DiagnosticReportBody[] {
    const description = describeRating(rating, tags);
    return CALL_QUALITY_CATEGORIES.map(category =>
        buildFromPrepared(prepared, { category, trigger: 'in_call', description }).body);
}

export interface SendProgress { sent: number; total: number; /** waiting out a rate limit / a transient failure */ waiting: boolean }
export interface SendOutcome { sent: number; total: number }

export interface SendDeps {
    send: (body: DiagnosticReportBody) => Promise<SendResult>;
    sleep: (ms: number) => Promise<void>;
    onProgress?: (p: SendProgress) => void;
}

export async function sendCallQualityReports(bodies: readonly DiagnosticReportBody[], deps: SendDeps): Promise<SendOutcome> {
    const total = bodies.length;
    let sent = 0;
    const progress = (waiting: boolean) => { try { deps.onProgress?.({ sent, total, waiting }); } catch { /* UI only */ } };
    progress(false);
    for (const body of bodies) {
        let attempt = 0;
        for (;;) {
            const r = await deps.send(body);
            if (r.ok) { sent++; progress(false); break; }
            const retryable = r.reason === 'rate_limited' || r.reason === 'offline' || r.reason === 'server';
            if (!retryable || attempt >= MAX_RETRIES) break;
            attempt++;
            progress(true);
            await deps.sleep(r.reason === 'rate_limited' ? RATE_LIMIT_WAIT_MS : TRANSIENT_WAIT_MS);
            progress(false);
        }
    }
    return { sent, total };
}
