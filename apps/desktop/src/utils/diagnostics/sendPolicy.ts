/**
 * Pure half of send.ts (no axios import, so it is unit-testable in node):
 * how an upload failure is explained to the user, and the short reference
 * shown on success.
 */

export type SendFailure = 'too_large' | 'rate_limited' | 'offline' | 'unauthorized' | 'rejected' | 'server';

export type SendResult =
    | { ok: true; id: string | null; reference: string | null }
    | { ok: false; reason: SendFailure; message: string };

export const FAILURE_COPY: Record<SendFailure, string> = {
    too_large: 'This report is larger than the server accepts. Save it to a file instead and attach it when you contact support.',
    rate_limited: 'You’ve sent several reports recently — try again later, or save it to a file.',
    offline: 'You’re offline, so the report couldn’t be sent. Try again when you’re back online, or save it to a file.',
    unauthorized: 'Your session has expired. Sign in again to send it, or save it to a file.',
    rejected: 'The server didn’t accept this report. Save it to a file and send it to support instead.',
    server: 'Something went wrong on our side. Try again in a moment, or save it to a file.',
};

/** `3f9a12bc-…` → `3F9A-12BC`: short enough to read out to support. */
export function shortReference(id: unknown): string | null {
    if (typeof id !== 'string') return null;
    const hex = id.replace(/[^0-9a-f]/gi, '').slice(0, 8).toUpperCase();
    return hex.length === 8 ? `${hex.slice(0, 4)}-${hex.slice(4)}` : null;
}

export function classifySendError(err: unknown, online: boolean): { reason: SendFailure; message: string } {
    const status = (err as { response?: { status?: number } })?.response?.status;
    let reason: SendFailure;
    if (status === 413) reason = 'too_large';
    else if (status === 429) reason = 'rate_limited';
    else if (status === 401 || status === 403) reason = 'unauthorized';
    else if (status !== undefined && status >= 400 && status < 500) reason = 'rejected';
    else if (status === undefined && (!online || (err as { code?: string })?.code === 'ERR_NETWORK')) reason = 'offline';
    else if (status === undefined) reason = 'offline';
    else reason = 'server';
    return { reason, message: FAILURE_COPY[reason] };
}

