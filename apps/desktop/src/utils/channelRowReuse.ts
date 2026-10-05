/**
 * Which rows of a channel-history page actually need decrypting.
 *
 * PERF: every channel open re-fetches the newest page (50 rows) and used to
 * decrypt all of it again — 50 `channel:decrypt-message` IPCs, each a
 * signature check + AES-GCM + replay-ledger update in the MAIN process — even
 * when every one of those rows was already in the local cache from the last
 * visit. `foldChannelHistory` then threw the fresh copies away anyway: a
 * plain message whose id is already cached (and isn't a "couldn't decrypt"
 * placeholder) is a no-op there. So decrypting it changed nothing but cost
 * main-process time on the navigation path.
 *
 * Rows reused from the cache are exactly the ones fold would ignore: same id,
 * cached copy is real content. Everything else is still decrypted: new rows,
 * rows cached only as placeholders (so they can heal), and edit / delete /
 * reaction envelopes, which are never cached as rows and are re-applied by
 * fold every time, as before.
 */
import { isUndecryptablePlaceholder } from './channelHistoryMerge';

export function splitReusableChannelRows<R extends { id: string }, C extends { id: string; content?: unknown }>(
    raw: readonly R[],
    cached: readonly C[] | undefined,
): { reused: C[]; toDecrypt: R[] } {
    if (!cached || cached.length === 0) return { reused: [], toDecrypt: [...raw] };
    const byId = new Map<string, C>();
    for (const c of cached) if (c && typeof c.id === 'string') byId.set(c.id, c);
    const reused: C[] = [];
    const toDecrypt: R[] = [];
    for (const r of raw) {
        const hit = byId.get(r.id);
        if (hit && !isUndecryptablePlaceholder(hit)) reused.push(hit);
        else toDecrypt.push(r);
    }
    return { reused, toDecrypt };
}
