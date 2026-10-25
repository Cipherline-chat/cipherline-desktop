/**
 * Unsent composer drafts — per account, per conversation, on this device only.
 *
 * "When you type a message and navigate away, it's gone." ChatPane remounts on
 * every conversation switch (Dashboard keys the pane on the conversation id), so
 * the composer text died with it. This keeps the text per conversation and puts
 * it back when you return, across app restarts too.
 *
 * Storage: ONE JSON record, `cipherline_composer_drafts_<userId>`, in
 * secureLocalStore (AES-256-GCM IndexedDB — drafts are message plaintext, so
 * they must never touch raw localStorage). EXCLUDED from backups
 * (services/backupRegistry.ts): a draft is a half-typed convenience, not
 * account data, and a backup file is the one thing here that travels.
 *
 * Rules that keep it safe and bounded:
 *  - Text only. Staged attachments are `File` handles that cannot outlive the
 *    pane, and the reply target needs the message list to resolve — neither is
 *    stored.
 *  - Empty (or whitespace-only) text REMOVES the draft; so does sending.
 *  - Per-draft cap, total-count cap and total-size cap, oldest evicted first; a
 *    TTL for drafts nobody came back to.
 *  - Writes are debounced (a keystroke must not re-serialise the whole record)
 *    and flushed when the pane unmounts or the window hides.
 *  - Never writes unless `isAccountReady(userId)`: right after an explicit
 *    sign-in the account's records are COLD, a read returns nothing, and
 *    writing a blob built on that would erase every real draft
 *    (secure_local_store_account_rebind). A cold read is never cached either.
 *  - The conversation list shows a draft as an italic "Draft: …" preview for
 *    conversations that are not open (hooks/useConversationDraft.ts). That text
 *    comes from this store only — it is in memory and secureLocalStore, never
 *    in a notification, the window title, or anything sent to the server.
 *  - A draft whose conversation no longer exists (left server, removed DM,
 *    deleted channel) is pruned (`pruneToKnown`).
 */

export type DraftKind = 'dm' | 'ch';

export interface DraftEntry {
    /** The text, in the composer's DISPLAY form (`@name`, `:party:`). */
    t: string;
    /** Last edit time (ms). */
    at: number;
    /** Channel drafts only: the owning server, so pruning can tell "channel
     *  deleted" from "channel list not loaded yet". */
    s?: string;
}
export type DraftMap = Record<string, DraftEntry>;

export const MAX_DRAFT_CHARS = 20_000;
export const MAX_DRAFTS = 50;
/** Total characters across every draft — bounds the single record's size. */
export const MAX_TOTAL_CHARS = 200_000;
export const DRAFT_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const DEFAULT_DEBOUNCE_MS = 400;

export const draftStorageKey = (userId: string) => `cipherline_composer_drafts_${userId}`;
export const draftKey = (kind: DraftKind, id: string) => `${kind}:${id}`;

const isBlank = (t: string) => t.trim().length === 0;

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Tolerant parse: anything malformed is dropped, never thrown. */
export function parseDrafts(raw: string | null | undefined): DraftMap {
    if (!raw) return {};
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return {}; }
    const d = (v as { d?: unknown } | null)?.d;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const out: DraftMap = {};
    for (const [k, e] of Object.entries(d as Record<string, unknown>)) {
        if (!/^(dm|ch):.+/.test(k)) continue;
        const t = (e as DraftEntry | null)?.t;
        const at = (e as DraftEntry | null)?.at;
        const s = (e as DraftEntry | null)?.s;
        if (typeof t !== 'string' || isBlank(t) || typeof at !== 'number' || !Number.isFinite(at)) continue;
        out[k] = { t: t.slice(0, MAX_DRAFT_CHARS), at, ...(typeof s === 'string' && s ? { s } : {}) };
    }
    return out;
}

export function serializeDrafts(map: DraftMap): string {
    return JSON.stringify({ v: 1, d: map });
}

/** Evict by age (TTL), then oldest-first until the count and size caps hold. */
export function enforceCaps(map: DraftMap, now: number): DraftMap {
    const entries = Object.entries(map).filter(([, e]) => now - e.at <= DRAFT_TTL_MS);
    entries.sort((a, b) => b[1].at - a[1].at);          // newest first
    const out: DraftMap = {};
    let total = 0;
    for (const [k, e] of entries) {
        if (Object.keys(out).length >= MAX_DRAFTS) break;
        if (total + e.t.length > MAX_TOTAL_CHARS) continue;
        out[k] = e;
        total += e.t.length;
    }
    return out;
}

/** Returns a NEW map with `key` set (or removed when the text is blank). */
export function putDraft(map: DraftMap, key: string, text: string, now: number, serverId?: string): DraftMap {
    const next = { ...map };
    if (isBlank(text)) {
        delete next[key];
        return next;
    }
    next[key] = { t: text.slice(0, MAX_DRAFT_CHARS), at: now, ...(serverId ? { s: serverId } : {}) };
    return enforceCaps(next, now);
}

/** What the app currently knows exists. `null` = "not loaded yet — keep". */
export interface KnownConversations {
    dmIds: ReadonlySet<string> | null;
    serverIds: ReadonlySet<string> | null;
    /** Per server: its channel ids, or absent/null when that list isn't loaded. */
    channelIdsByServer: Readonly<Record<string, ReadonlySet<string> | null | undefined>>;
}

/**
 * Drops drafts for conversations the account no longer has. Conservative on
 * purpose: an unloaded list never prunes anything (a partial boot must not eat
 * drafts), and a channel draft only goes when its server's channel list IS
 * loaded and lacks it, or its server itself is loaded and gone.
 */
export function pruneToKnown(map: DraftMap, known: KnownConversations): DraftMap {
    const out: DraftMap = {};
    for (const [k, e] of Object.entries(map)) {
        const id = k.slice(k.indexOf(':') + 1);
        if (k.startsWith('dm:')) {
            if (known.dmIds && !known.dmIds.has(id)) continue;
        } else if (k.startsWith('ch:')) {
            if (e.s) {
                if (known.serverIds && !known.serverIds.has(e.s)) continue;
                const chans = known.channelIdsByServer[e.s];
                if (chans && !chans.has(id)) continue;
            }
        }
        out[k] = e;
    }
    return out;
}

// ── Store ───────────────────────────────────────────────────────────────────

/** The slice of secureLocalStore the drafts use (injectable for tests). */
export interface DraftBackingStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    isAccountReady(userId: string): boolean;
    whenAccountReady(): Promise<void>;
}

export interface DraftStoreOptions {
    secureLocalStore: DraftBackingStore;
    now?: () => number;
    debounceMs?: number;
}

export function createDraftStore(opts: DraftStoreOptions) {
    const { secureLocalStore } = opts;
    const now = opts.now ?? Date.now;
    const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    /** Loaded maps + the raw record they were parsed from / last written as. */
    const cache = new Map<string, { map: DraftMap; raw: string | null }>();
    const dirty = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listeners = new Set<() => void>();
    const notify = () => { for (const l of [...listeners]) { try { l(); } catch { /* a listener must not break a draft write */ } } };

    /**
     * The account's drafts, or null while it is cold. The cache is trusted only
     * while this module has unflushed edits (the store is then BEHIND it) or the
     * stored record is still exactly what we last saw; anything else (a wipe, a
     * restore, another path writing the key) is re-read, so a stale copy can
     * never be written back over the real one.
     */
    const load = (userId: string): DraftMap | null => {
        if (!userId || !secureLocalStore.isAccountReady(userId)) return null;   // cold: don't read, don't cache
        const hit = cache.get(userId);
        if (hit && dirty.has(userId)) return hit.map;
        const raw = secureLocalStore.getItem(draftStorageKey(userId));
        if (hit && hit.raw === raw) return hit.map;
        const map = enforceCaps(parseDrafts(raw), now());
        cache.set(userId, { map, raw });
        return map;
    };

    const update = (userId: string, map: DraftMap) => {
        cache.set(userId, { map, raw: cache.get(userId)?.raw ?? null });
        dirty.add(userId);
        schedule();
        notify();
    };

    const writeUser = (userId: string) => {
        if (!secureLocalStore.isAccountReady(userId)) return;                   // never write over a cold namespace
        const hit = cache.get(userId);
        if (!hit) return;
        try {
            if (Object.keys(hit.map).length === 0) {
                secureLocalStore.removeItem(draftStorageKey(userId));
                hit.raw = null;
            } else {
                const raw = serializeDrafts(hit.map);
                secureLocalStore.setItem(`cipherline_composer_drafts_${userId}`, raw);
                hit.raw = raw;
            }
            dirty.delete(userId);
        } catch { /* quota — a draft is a convenience, never fatal */ }
    };

    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        for (const u of [...dirty]) writeUser(u);
    };

    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    };

    return {
        /** The saved text for a conversation ('' if none, or the account isn't ready). */
        get(userId: string, key: string): string {
            return load(userId)?.[key]?.t ?? '';
        },

        /**
         * Record the composer's current text. A no-op when it equals what is
         * already stored — which is what keeps a freshly RESTORED draft from
         * being "written back" on mount — and when the account isn't ready.
         */
        set(userId: string, key: string, text: string, serverId?: string): void {
            const m = load(userId);
            if (!m) return;
            const prev = m[key]?.t ?? '';
            const next = isBlank(text) ? '' : text.slice(0, MAX_DRAFT_CHARS);
            if (prev === next) return;
            update(userId, putDraft(m, key, text, now(), serverId));
        },

        /** Remove a conversation's draft right away (e.g. on send). */
        clear(userId: string, key: string): void {
            const m = load(userId);
            if (!m || !(key in m)) return;
            const next = { ...m };
            delete next[key];
            update(userId, next);
        },

        /** Drop drafts for conversations the account no longer has. */
        prune(userId: string, known: KnownConversations): void {
            const m = load(userId);
            if (!m) return;
            const next = pruneToKnown(m, known);
            if (Object.keys(next).length === Object.keys(m).length) return;
            update(userId, next);
        },

        /**
         * Called after any in-memory change (set / clear / prune / reset) —
         * synchronously, NOT on the debounced disk write, so a list row shows a
         * draft the moment the composer's text changes. Returns an unsubscribe.
         * Listeners should read through `get` and compare, not re-render blindly.
         */
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },

        /** Conversation keys that currently have a draft (for a list indicator). */
        keys(userId: string): string[] {
            return Object.keys(load(userId) ?? {});
        },

        /** Resolves once the account's records are readable (cold sign-in). */
        whenReady(): Promise<void> { return secureLocalStore.whenAccountReady(); },

        flush,

        /** Forget the in-memory copy (sign-out / tests). Pending writes flush first. */
        reset(userId?: string): void {
            flush();
            if (userId) cache.delete(userId); else cache.clear();
            notify();
        },
    };
}
