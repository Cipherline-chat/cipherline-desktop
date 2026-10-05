/**
 * historyTransfer — helpers for the multi-device pairing handoff.
 *
 * The new device picks a date range (last 7/30/90/365 days, all, or none) and
 * the existing device runs these utilities to (1) filter its local message
 * stores to that window and (2) collect the encrypted ciphertext bytes for
 * any referenced attachments so the new device can view them offline.
 *
 * Companion to `exportLocalHistory` in `apps/desktop/src/utils/crypto.ts`,
 * which orchestrates the full vault build.
 */

import { getEncryptedAttachment } from './attachmentCache';
import { downloadEncryptedAttachment } from './attachmentDownload';
import { API_BASE } from '../constants';

/** Range presets exposed in the new-device picker. `null` = unbounded. */
export const RANGE_CHOICES: { value: number | null; label: string; description: string }[] = [
    { value: 7,    label: 'Last 7 days',    description: 'A quick week of context — fastest transfer.' },
    { value: 30,   label: 'Last 30 days',   description: 'About a month — good default for active chats.' },
    { value: 90,   label: 'Last 90 days',   description: 'A quarter of history.' },
    { value: 365,  label: 'Last 1 year',    description: 'A full year of conversations.' },
    { value: null, label: 'All time',       description: 'Everything — may be large.' },
];

export type RangeDays = 7 | 30 | 90 | 365 | null;

/**
 * Filter a `Record<conversationId, Message[]>` map by message timestamp.
 *
 * - `null` range = no filtering (entire history returned).
 * - Conversations whose filtered window is empty are omitted from the result
 *   so the receiving device's conversation list isn't cluttered with empties.
 * - `keepPinned` lets the caller protect pinned messages: any message whose
 *   id is in the per-conv set is preserved regardless of age.
 */
export function filterMessagesByRange(
    history: Record<string, any[]>,
    days: number | null,
    keepPinned?: Record<string, Set<string>>,
): Record<string, any[]> {
    if (days === null) return history;
    const cutoff = Date.now() - days * 86_400_000;
    const out: Record<string, any[]> = {};
    for (const [convId, msgs] of Object.entries(history)) {
        if (!Array.isArray(msgs)) continue;
        const pinned = keepPinned?.[convId];
        const kept = msgs.filter(m => {
            if (pinned && m?.id && pinned.has(m.id)) return true;
            const t = m?.timestamp ?? m?.sent_at ?? m?.created_at;
            if (!t) return false;
            const ms = typeof t === 'number' ? t : Date.parse(t);
            return Number.isFinite(ms) && ms >= cutoff;
        });
        if (kept.length > 0) out[convId] = kept;
    }
    return out;
}

/** Convert a Blob to base64. Used to inline attachment ciphertext into the
 *  vault JSON. Streams in 32 KB chunks so large blobs don't blow the stack. */
export async function blobToBase64(blob: Blob): Promise<string> {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** Reverse of `blobToBase64`. */
export function base64ToBlob(b64: string, mime = 'application/octet-stream'): Blob {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

/**
 * Walk the filtered DM/group + channel histories, collect every referenced
 * attachment_id, and bundle the encrypted bytes for transfer.
 *
 *   1. Prefer the local IndexedDB cache (`getEncryptedAttachment`) — zero-network.
 *   2. Fall back to the API's presigned URL via `downloadEncryptedAttachment`.
 *   3. Server-side 14-day MinIO sweep may have purged the bytes; if neither
 *      cache nor server has them, skip silently — the receiving device will
 *      show the "Attachment no longer available" placeholder.
 *
 * Concurrency is intentionally serial to keep memory predictable on huge
 * histories; switch to a small pool if this turns out too slow on real data.
 */
export async function collectAttachmentBlobs(
    filteredHistory: Record<string, any[]>,
    filteredChannelHistory: Record<string, any[]>,
    token: string,
    onProgress?: (done: number, total: number, totalBytes: number) => void,
    maxSizeBytes?: number,
): Promise<{ blobs: Record<string, string>; totalBytes: number; count: number; skipped: number }> {
    // Build id → declared-size map from message content metadata (best-effort).
    const sizeHints = new Map<string, number>();
    const ids = new Set<string>();
    const collect = (m: any) => {
        const aid = m?.content?.attachment_id;
        if (typeof aid === 'string' && aid.length > 0) {
            ids.add(aid);
            const sz = m?.content?.size ?? m?.content?.file_size ?? 0;
            if (sz > 0 && !sizeHints.has(aid)) sizeHints.set(aid, sz);
        }
    };
    for (const arr of Object.values(filteredHistory)) for (const m of arr) collect(m);
    for (const arr of Object.values(filteredChannelHistory)) for (const m of arr) collect(m);

    const blobs: Record<string, string> = {};
    let totalBytes = 0;
    let done = 0;
    let skipped = 0;
    const total = ids.size;
    for (const id of ids) {
        // Pre-skip if declared size already exceeds the limit.
        const hint = sizeHints.get(id) ?? 0;
        if (maxSizeBytes && hint > 0 && hint > maxSizeBytes) {
            skipped++;
            done++;
            onProgress?.(done, total, totalBytes);
            continue;
        }

        let blob: Blob | null = null;
        try {
            blob = await getEncryptedAttachment(id);
            if (!blob) {
                blob = await downloadEncryptedAttachment(id, token, API_BASE);
            }
        } catch {
            // Bytes gone for good — the new device shows a "not available" placeholder.
        }

        // Post-download size guard (handles cases where size hint was absent).
        if (blob && maxSizeBytes && blob.size > maxSizeBytes) {
            skipped++;
            done++;
            onProgress?.(done, total, totalBytes);
            continue;
        }

        if (blob) {
            blobs[id] = await blobToBase64(blob);
            totalBytes += blob.size;
        }
        done++;
        onProgress?.(done, total, totalBytes);
    }
    return { blobs, totalBytes, count: Object.keys(blobs).length, skipped };
}

/**
 * Split a DM+group history map into separate DM and group objects using the
 * conversation list (topics) to identify which IDs are DMs.
 *
 * `topics` are the raw `GET /v1/conversations` rows the Dashboard caches under
 * `cipherline_convs_<uid>`, keyed `conversation_id` — there is no `id`. This
 * used to read `t.id` only, so the DM set was always empty and every thread
 * counted as a group: the send dialog's "DMs" / "Groups" toggles (and their
 * attachment twins) could not tell the two apart (History transfer §3).
 * `id` is still accepted for any caller that hands over the other shape.
 */
export function partitionHistoryByType(
    history: Record<string, any[]>,
    topics: Array<{ conversation_id?: string; id?: string; type: string }>,
): { dm: Record<string, any[]>; group: Record<string, any[]> } {
    const dm: Record<string, any[]> = {};
    const group: Record<string, any[]> = {};
    const dmIds = new Set(topics.filter(t => t.type === 'dm').map(t => t.conversation_id ?? t.id));
    for (const [id, msgs] of Object.entries(history)) {
        (dmIds.has(id) ? dm : group)[id] = msgs;
    }
    return { dm, group };
}

/** Sum of message counts across every conversation in the map. */
export function countMessages(history: Record<string, any[]>): number {
    let n = 0;
    for (const arr of Object.values(history)) {
        if (Array.isArray(arr)) n += arr.length;
    }
    return n;
}

/** Build the `pinnedMessages` view used as the `keepPinned` arg above —
 *  flattens `Record<convId, msgId[]>` (from `cipherline_pinned_${userId}`)
 *  into a Set-per-conv for O(1) membership checks. */
export function buildPinnedSet(pinned: Record<string, string[]> | undefined): Record<string, Set<string>> {
    const out: Record<string, Set<string>> = {};
    if (!pinned) return out;
    for (const [convId, ids] of Object.entries(pinned)) {
        if (Array.isArray(ids) && ids.length > 0) out[convId] = new Set(ids);
    }
    return out;
}
