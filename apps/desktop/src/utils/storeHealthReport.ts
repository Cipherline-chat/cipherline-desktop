/**
 * The encrypted store's health, shaped for the two places it is reported:
 * the closed-beta `store_load_failed` event, and the settings block of a
 * Report a problem the user chooses to send.
 *
 * LABELS ONLY, by construction: a fixed status word, a load stage word, an
 * error NAME that storeLoadRetry.ts has already reduced to letters (never its
 * message, which can carry a profile path), and small counts. No path, no
 * account or device id, no key name.
 */
import type { StoreHealthStatus, StoreLoadFailureRecord } from './secureLocalStore';

export interface StoreHealth {
    status: StoreHealthStatus;
    lastFailure: StoreLoadFailureRecord | null;
}

const NAME_RE = /^[A-Za-z]{1,40}$/;
const STAGES = new Set(['open', 'read', 'ipc']);

function safeFailure(f: StoreLoadFailureRecord | null): StoreLoadFailureRecord | null {
    if (!f || !STAGES.has(f.stage)) return null;
    return {
        stage: f.stage,
        name: NAME_RE.test(f.name) ? f.name : 'Error',
        attempts: Number.isFinite(f.attempts) ? Math.max(1, Math.min(99, Math.round(f.attempts))) : 1,
        recovered: f.recovered === true,
    };
}

/** Detail for a `store_load_failed` beta event, or null when the load never failed. */
export function storeLoadFailedEvent(health: StoreHealth): { stage: string; name: string; attempts: number; recovered: boolean } | null {
    const f = safeFailure(health.lastFailure);
    return f ? { stage: f.stage, name: f.name, attempts: f.attempts, recovered: f.recovered } : null;
}

export type StorageReportStatus = StoreHealthStatus | 'corrupted';

/**
 * Settings entries for a diagnostic report. `corrupted` = main's Signal-identity
 * store found its file damaged this session (StorageCorruptedScreen's case),
 * which outranks the renderer store's own status.
 */
export function storeHealthSettings(health: StoreHealth, corrupted: boolean): Record<string, string | number | boolean> {
    const status: StorageReportStatus = corrupted ? 'corrupted' : health.status;
    const out: Record<string, string | number | boolean> = { storage_status: status };
    const f = safeFailure(health.lastFailure);
    if (f) {
        out.storage_load_failure = `${f.stage}_${f.name}`;
        out.storage_load_attempts = f.attempts;
        out.storage_load_recovered = f.recovered;
    }
    return out;
}
