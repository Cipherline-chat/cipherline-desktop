/**
 * Upload / save a built diagnostic report.
 *
 * Upload goes through the app's shared axios instance, so the global
 * interceptors in utils/httpBootstrap.ts attach X-Cipherline-Version and the
 * attestation header exactly as on every other API call; the JWT ties the
 * report to the account server-side. The request body is
 * JSON.stringify(body) of the SAME object the preview renders — nothing is
 * added on the way out.
 */
import axios from 'axios';
import { API_BASE } from '../../constants';
import { reportFileText } from './bundle';
import type { DiagnosticReportBody } from './reportTypes';

import { FAILURE_COPY, classifySendError, shortReference, type SendResult } from './sendPolicy';

export { FAILURE_COPY, classifySendError, shortReference };
export type { SendResult, SendFailure } from './sendPolicy';

const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export async function sendDiagnosticReport(body: DiagnosticReportBody, token: string): Promise<SendResult> {
    if (!isOnline()) return { ok: false, reason: 'offline', message: FAILURE_COPY.offline };
    try {
        const res = await axios.post(`${API_BASE}/diagnostics/reports`, JSON.stringify(body), {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 30_000,
        });
        const id = (res.data as { id?: unknown } | undefined)?.id;
        return { ok: true, id: typeof id === 'string' ? id : null, reference: shortReference(id) };
    } catch (err) {
        return { ok: false, ...classifySendError(err, isOnline()) };
    }
}

/** The file text; compact if the pretty form would exceed main's 512 KiB cap. */
export function fileTextFor(body: DiagnosticReportBody): string {
    const pretty = reportFileText(body);
    return new TextEncoder().encode(pretty).length <= 512 * 1024 ? pretty : JSON.stringify(body);
}

export type SaveResult = 'saved' | 'cancelled' | 'failed';

/**
 * Save to a file. In the app, main owns the dialog and the path and writes
 * only this text; without the bridge (website / tests) fall back to a browser
 * download of the same text.
 */
export async function saveDiagnosticReport(body: DiagnosticReportBody): Promise<SaveResult> {
    const text = fileTextFor(body);
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (api?.diagSaveReport) {
        try {
            const r = await api.diagSaveReport(body.category, text);
            return r?.status === 'saved' ? 'saved' : 'cancelled';
        } catch {
            return 'failed';
        }
    }
    try {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `cipherline-diagnostics-${body.category}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
        return 'saved';
    } catch {
        return 'failed';
    }
}
