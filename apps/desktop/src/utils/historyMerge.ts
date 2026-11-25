/**
 * Merge rules for a device-to-device history TRANSFER (never a backup restore, which stays an authoritative replace).
 * Mirrors the phone's `import_vault` (core/cl-sync/src/history_vault.rs): nothing local is cleared, a message id this
 * device already holds is kept exactly as it is (so a local edit, reaction set or state outranks the arriving copy and a
 * duplicate never doubles a row), a row it lacks is added, topics are inserted only when missing.
 */
import type { ThreadMap } from './messageStore';

const tsOf = (m: { timestamp?: unknown }): number => {
    const t = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
    return Number.isFinite(t) ? t : 0;
};

/** `messageStore.mergeThreads` callback: `threads` = the stored thread(s) for the ids in `incoming`; local rows always win. */
export function mergeVaultThreads(threads: ThreadMap, incoming: ThreadMap): ThreadMap {
    const out: ThreadMap = { ...threads };
    for (const [conv, rows] of Object.entries(incoming)) {
        if (!Array.isArray(rows)) continue;
        const local = Array.isArray(out[conv]) ? out[conv] : [];
        const seen = new Set<string>();
        for (const m of local) if (m && typeof m.id === 'string') seen.add(m.id);
        const added: unknown[] = [];
        for (const m of rows) {
            if (!m || typeof m !== 'object' || typeof (m as { id?: unknown }).id !== 'string') continue;
            const id = (m as { id: string }).id;
            if (seen.has(id)) continue;
            seen.add(id);
            added.push(m);
        }
        if (added.length === 0) { out[conv] = local; continue; }
        // Stable: equal stamps keep local-first, then arrival order.
        out[conv] = [...local, ...added]
            .map((m, i) => ({ m, i, t: tsOf(m as { timestamp?: unknown }) }))
            .sort((a, b) => a.t - b.t || a.i - b.i)
            .map(x => x.m);
    }
    return out;
}

/** Union of the local conversation list and an arriving one, by `conversation_id`; the local entry wins. */
export function mergeTopics(localRaw: string | null, incoming: unknown): unknown[] {
    let local: unknown[] = [];
    try { const v = localRaw ? JSON.parse(localRaw) : []; if (Array.isArray(v)) local = v; } catch { /* unreadable: treated as empty, like the thread reader */ }
    const idOf = (t: unknown): string | null => {
        const o = t as { conversation_id?: unknown; id?: unknown } | null;
        const v = o && typeof o === 'object' ? (o.conversation_id ?? o.id) : null;
        return typeof v === 'string' ? v : null;
    };
    const have = new Set(local.map(idOf).filter((x): x is string => !!x));
    const out = [...local];
    for (const t of Array.isArray(incoming) ? incoming : []) {
        const id = idOf(t);
        if (id && !have.has(id)) { have.add(id); out.push(t); }
    }
    return out;
}
