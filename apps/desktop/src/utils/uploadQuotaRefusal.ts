/**
 * The server's refusal when an account has used up its rolling upload limit
 * (POST /attachments/initiate -> 413 `upload_quota_exceeded`, see
 * apps/api/src/attachments/upload-quota.ts). The body carries plain-words
 * `message` already, so an older client that only shows `response.data.message`
 * is fine too; this reads the typed fields so the toast can be specific.
 *
 * UX only: the server is the enforcement point.
 */
export interface UploadQuotaRefusal {
    title: string;
    message: string;
    remainingBytes: number | null;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const fmt = (bytes: number): string =>
    bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB` : `${Math.max(0, Math.round(bytes / MB))} MB`;

export function uploadQuotaRefusal(err: unknown): UploadQuotaRefusal | null {
    const r = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)?.response;
    if (!r || r.status !== 413 || r.data?.code !== 'upload_quota_exceeded') return null;
    const remaining = typeof r.data.remaining_bytes === 'number' ? r.data.remaining_bytes : null;
    const limit = typeof r.data.limit_bytes === 'number' ? r.data.limit_bytes : null;
    const days = typeof r.data.window_days === 'number' ? r.data.window_days : 14;
    const serverText = typeof r.data.message === 'string' ? r.data.message : null;
    const fallback =
        limit !== null && remaining !== null
            ? `You've used your ${fmt(limit)} upload limit for the last ${days} days (${fmt(remaining)} left). Messages and smaller files still send. Room frees up as older uploads pass ${days} days.`
            : `You've reached your upload limit for the last ${days} days. Messages and smaller files still send.`;
    return { title: 'Upload limit reached', message: serverText ?? fallback, remainingBytes: remaining };
}
