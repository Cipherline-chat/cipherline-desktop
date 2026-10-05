export interface ConvStorageStats {
    conversationId: string;
    textBytes: number;       // approximate JSON size of non-attachment messages
    attachmentBytes: number; // sum of content.byte_size for attachment messages
    totalBytes: number;
    messageCount: number;
    attachmentCount: number;
}

/**
 * Compute storage stats for a single conversation's message array.
 *
 * • attachmentBytes = sum of each attachment message's file size (cached blob
 *   payload — the thing we'd actually free by purging).
 * • textBytes       = JSON-stringified size of every non-attachment message,
 *   plus the JSON-envelope overhead of attachment metadata rows (id, mime,
 *   reactions, etc.). That envelope is tiny vs. the file bytes, but including
 *   it here is more accurate than subtracting file size from JSON length —
 *   which produced a negative number and clamped textBytes to 0.
 *
 * Uses JSON.stringify length as a cheap byte approximation. Not exact (UTF-16
 * vs UTF-8, no IndexedDB overhead) but consistent for showing relative sizes.
 */
export function calcConversationStorage(
    conversationId: string,
    messages: any[],
): ConvStorageStats {
    let attachmentBytes = 0;
    let attachmentCount = 0;
    let messageCount = 0;
    let textBytes = 0;

    for (const m of messages) {
        messageCount++;
        if (m?.content?.type === 'attachment') {
            attachmentCount++;
            attachmentBytes += (m.content.byte_size as number) || 0;
            // The envelope (id, reactions, timestamps) still counts toward
            // local text storage — it lives in the JSON message blob.
            try { textBytes += JSON.stringify(m).length; } catch { /* ignore */ }
        } else {
            try { textBytes += JSON.stringify(m).length; } catch { /* ignore */ }
        }
    }

    const totalBytes = textBytes + attachmentBytes;
    return { conversationId, textBytes, attachmentBytes, totalBytes, messageCount, attachmentCount };
}

/**
 * Return the top-N conversations by total local storage usage.
 * Conversations with 0 messages are excluded.
 */
export function rankByStorage(
    messagesState: Record<string, any[]>,
    topN = 10,
): ConvStorageStats[] {
    const stats: ConvStorageStats[] = [];
    for (const [convId, msgs] of Object.entries(messagesState)) {
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        stats.push(calcConversationStorage(convId, msgs));
    }
    stats.sort((a, b) => b.totalBytes - a.totalBytes);
    return stats.slice(0, topN);
}

/**
 * Return conversations present in messagesState but NOT in the known active
 * conversation-ID set (deleted DMs, unfriended contacts, etc.).
 * Sorted descending by totalBytes.
 */
export function findOrphanedConversations(
    messagesState: Record<string, any[]>,
    knownConversationIds: Set<string>,
): ConvStorageStats[] {
    const orphans: ConvStorageStats[] = [];
    for (const [convId, msgs] of Object.entries(messagesState)) {
        if (knownConversationIds.has(convId)) continue;
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        orphans.push(calcConversationStorage(convId, msgs));
    }
    orphans.sort((a, b) => b.totalBytes - a.totalBytes);
    return orphans;
}
