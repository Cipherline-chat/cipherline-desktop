/**
 * Your custom entrance sound in the encrypted backup and in the own-device
 * sync snapshot. One shape for both:
 *
 *   entranceSound: { v: 1, id, at, durationMs, b64 }   the sound (b64 = the encoded bytes)
 *   entranceSound: { v: 1, id: null, at }                removed (tombstone)
 *
 * The bytes travel as plaintext INSIDE an already-encrypted container (the
 * backup vault / the own-device slot body that only this account's devices can
 * open), and the receiving device re-seals them under its own fresh key
 * (ownStore.ts), so no at-rest key ever leaves a device. Same rule as the
 * My Emojis snapshot (services/personalEmojiSyncService.ts).
 *
 * Merge is last-writer-wins on `at`; an import is verified (size cap, WebM
 * magic, content hash == id) before anything is written. A container without
 * the field (an older build wrote it) means "no information", never "removed".
 */

import { b64ToBytes, bytesToB64 } from '../personalEmoji/token';
import { checkSoundBytes, isContentId } from './identity';
import type { OwnEntranceSoundStore } from './ownStore';

export type EntranceSoundTransfer =
    | { v: 1; id: string; at: number; durationMs: number; b64: string }
    | { v: 1; id: null; at: number };

export async function exportEntranceSound(store: OwnEntranceSoundStore): Promise<EntranceSoundTransfer | undefined> {
    const r = store.record();
    if (!r) return undefined;
    if (r.id === null) return { v: 1, id: null, at: r.at };
    const bytes = await store.read();
    // Unreadable here: say nothing rather than something we cannot back up.
    if (!bytes) return undefined;
    return { v: 1, id: r.id, at: r.at, durationMs: r.durationMs ?? 0, b64: bytesToB64(bytes) };
}

export function parseEntranceSoundTransfer(raw: unknown): EntranceSoundTransfer | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at) || o.at < 0) return null;
    if (o.id === null) return { v: 1, id: null, at: o.at };
    if (!isContentId(o.id) || typeof o.b64 !== 'string' || !o.b64) return null;
    return { v: 1, id: o.id, at: o.at, durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0, b64: o.b64 };
}

export type ImportOutcome = 'applied' | 'older' | 'same' | 'invalid' | 'none';

/** Apply an incoming copy if it is newer than ours. Never throws. */
export async function importEntranceSound(
    store: OwnEntranceSoundStore,
    raw: unknown,
    origin: 'local' | 'sync' = 'sync',
): Promise<ImportOutcome> {
    if (raw === undefined || raw === null) return 'none';
    const t = parseEntranceSoundTransfer(raw);
    if (!t) return 'invalid';
    const local = store.record();
    if (local && local.id === t.id) return 'same';
    if (local && local.at >= t.at) return 'older';
    try {
        if (t.id === null) { await store.remove({ at: t.at, origin }); return 'applied'; }
        let bytes: Uint8Array;
        try { bytes = b64ToBytes(t.b64); } catch { return 'invalid'; }
        if (await checkSoundBytes(bytes, t.id)) return 'invalid';
        await store.set(bytes, t.durationMs, { at: t.at, origin });
        return 'applied';
    } catch {
        return 'invalid';
    }
}
