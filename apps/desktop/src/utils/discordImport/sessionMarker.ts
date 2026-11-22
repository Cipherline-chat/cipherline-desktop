/**
 * "An import session may still be open on the server" — written while this
 * device holds an OPEN message-import session, cleared once it is closed.
 *
 * Why: a crash or a killed app (no `pagehide`, so no keepalive cancel) used to
 * leave the API session `active`, and the API then refused the account's next
 * import as "already running" for 72 h. The API now supersedes a session idle
 * for 15 minutes on its own; this marker lets the next launch end it AT ONCE
 * (POST /servers/:sid/imports/active/end, keeping what was copied), so the
 * owner can start again immediately after a crash.
 *
 * Holds only the Cipherline server id and when it was written (no Discord
 * data). Device bookkeeping: excluded from backups (services/backupRegistry.ts).
 */
import { secureLocalStore } from '../secureLocalStore';

export const IMPORT_SESSION_MARKER_KEY = 'cipherline_discord_import_open';

export interface ImportSessionMarker { serverId: string; at: number }

/** The store is synchronous after hydration; any failure is ignored (the API's idle rule is the backstop). */
export function markImportSessionOpen(serverId: string): void {
    try { secureLocalStore.setItem(IMPORT_SESSION_MARKER_KEY, JSON.stringify({ serverId, at: Date.now() })); } catch { /* best effort */ }
}

export function clearImportSessionMarker(): void {
    try { secureLocalStore.removeItem(IMPORT_SESSION_MARKER_KEY); } catch { /* best effort */ }
}

export function readImportSessionMarker(): ImportSessionMarker | null {
    try {
        const raw = secureLocalStore.getItem(IMPORT_SESSION_MARKER_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as { serverId?: unknown; at?: unknown };
        if (typeof v.serverId !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.serverId)) return null;
        return { serverId: v.serverId, at: typeof v.at === 'number' ? v.at : 0 };
    } catch {
        return null;
    }
}
