/**
 * Imported reactions (owner 2026-11-22: "there's no reason we cannot import
 * reactions"). They live INSIDE the encrypted content of an imported row
 * (`imported_from.reactions`, packages/shared/import-history.ts); the server
 * never sees an emoji or who reacted. Reading rules, the B6.2 rules applied
 * to reactors:
 *
 *  1. Only a VERIFIED block counts (a server-marked row whose block matches
 *     the mark: `verifiedBlockOf`). A normal message whose content claims
 *     reactions carries none: the ingest gate drops its block entirely.
 *  2. A reactor is named by `ref`, an author id of the import that marked the
 *     row. Once the server's list of that import's authors is known
 *     (GET .../imports/:iid/author-claims), a ref NOT in it is dropped.
 *  3. A claimed reactor shows as the claimant (their username); an unclaimed
 *     one by their imported name, text only (no profile, no mention).
 *  4. Imported reactions are history: they never notify (no marker row is
 *     ever sent for them), and the claimant's own live reaction to the same
 *     emoji is counted once, not twice. Clicking the pill adds / removes the
 *     LIVE reaction only; the imported one stays, like an imported message
 *     cannot be edited.
 *
 * Reactors use pseudo ids (`imp:<author id>`, `imp~<n>` for the unnamed rest
 * of Discord's count) that can never equal a user or device id, so "is this
 * mine" never matches them.
 */
import axios from 'axios';
import type { ImportedFrom } from '@cipherline/shared';
import { apiUrl } from './apiPath';

export const IMPORTED_REACTOR_PREFIX = 'imp:';
const ANON_PREFIX = 'imp~';
/** Unnamed reactors padded into a pill at most (Discord counts can be huge; the pill shows ids.length). */
export const IMPORTED_ANON_PAD_MAX = 999;

export function isImportedReactorId(id: string): boolean {
    return id.startsWith(IMPORTED_REACTOR_PREFIX) || id.startsWith(ANON_PREFIX);
}

export interface MergedReactions {
    reactions: Record<string, string[]> | undefined;
    /** pseudo id -> imported name (unclaimed) or "someone on Discord". */
    names: Record<string, string>;
    /** pseudo id -> claimant user id (claimed reactors). */
    claimed: Record<string, string>;
}

/**
 * Lay a verified block's reactions under the row's live reactions. `authors`
 * = that import's author -> claimant map, or undefined while not loaded yet
 * (names only, no claims, nothing dropped). Pure.
 */
export function mergeImportedReactions(
    live: Record<string, string[]> | undefined,
    block: ImportedFrom | null,
    authors: Map<string, string | null> | undefined,
): MergedReactions {
    const names: Record<string, string> = {};
    const claimed: Record<string, string> = {};
    if (!block?.reactions?.length) return { reactions: live, names, claimed };
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(live ?? {})) if (Array.isArray(v)) out[k] = [...v];
    for (const r of block.reactions) {
        const liveIds = new Set(out[r.emoji] ?? []);
        const ids: string[] = [];
        for (const x of r.reactors) {
            if (authors && !authors.has(x.ref)) continue; // rule 2: not an author of THIS import
            const claimant = authors?.get(x.ref) ?? null;
            if (claimant && liveIds.has(claimant)) continue; // rule 4: counted once
            const pid = `${IMPORTED_REACTOR_PREFIX}${x.ref}`;
            names[pid] = x.name;
            if (claimant) claimed[pid] = claimant;
            ids.push(pid);
        }
        // Discord's count beyond the 100 named (or a budget-skipped reaction).
        const rest = Math.min(IMPORTED_ANON_PAD_MAX, Math.max(0, r.count - r.reactors.length));
        for (let i = 0; i < rest; i++) {
            const pid = `${ANON_PREFIX}${i}`;
            names[pid] = 'someone on Discord';
            ids.push(pid);
        }
        if (ids.length === 0) continue;
        out[r.emoji] = [...ids, ...(out[r.emoji] ?? [])];
    }
    return { reactions: out, names, claimed };
}

// ── Per-import author -> claimant map (rule 2/3) ──────────────────────────

const cache = new Map<string, Map<string, string | null>>();
const inflight = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) { try { l(); } catch { /* listener */ } } };

export function reactorClaimsFor(importId: string): Map<string, string | null> | undefined {
    return cache.get(importId.toLowerCase());
}

/** Load once per import (deduped; a failure retries after 30 s). */
export function ensureReactorClaims(token: string | null, serverId: string, importId: string): void {
    const key = importId.toLowerCase();
    if (!token || cache.has(key) || inflight.has(key)) return;
    if ((failedAt.get(key) ?? 0) > Date.now() - 30_000) return;
    const p = axios.get(apiUrl`/servers/${serverId}/imports/${key}/author-claims`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => {
            const m = new Map<string, string | null>();
            for (const a of Array.isArray(r.data?.authors) ? r.data.authors : []) {
                if (a && typeof a.author_id === 'string') m.set(a.author_id.toLowerCase(), typeof a.claimed_user_id === 'string' ? a.claimed_user_id : null);
            }
            cache.set(key, m);
            notify();
        })
        .catch(() => { failedAt.set(key, Date.now()); })
        .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
}

/** `import:author_claim`: a reactor (author) was claimed / unclaimed / moved. */
export function noteImportAuthorClaim(authorId: string, claimedUserId: string | null): void {
    const aid = authorId.toLowerCase();
    let changed = false;
    for (const m of cache.values()) if (m.has(aid) && m.get(aid) !== claimedUserId) { m.set(aid, claimedUserId); changed = true; }
    if (changed) notify();
}

export function subscribeReactorClaims(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

/** Tests only. */
export function resetReactorClaimsForTests(): void { cache.clear(); inflight.clear(); failedAt.clear(); }
export function setReactorClaimsForTests(importId: string, m: Map<string, string | null>): void { cache.set(importId.toLowerCase(), m); notify(); }
