import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STORAGE_POLICY_CHANGED_EVENT } from '../utils/deviceStorageSetup';

export type AttachmentRetention = 'never' | '1y' | '6mo' | '3mo' | '1mo' | '1wk' | '24h';
export type MessageRetention    = 'never' | '1y' | '6mo' | '3mo' | '1mo' | '1wk';

export interface StoragePolicy {
    // Global fallback retention (used when no type-specific default is set).
    attachmentRetention: AttachmentRetention;
    messageRetention: MessageRetention;
    // Per-type default retention — override the global fields for each chat type.
    // Undefined = fall back to the global messageRetention / attachmentRetention.
    dmMessageRetention?:        MessageRetention;
    dmAttachmentRetention?:     AttachmentRetention;
    groupMessageRetention?:     MessageRetention;
    groupAttachmentRetention?:  AttachmentRetention;
    serverMessageRetention?:    MessageRetention;
    serverAttachmentRetention?: AttachmentRetention;
    // Explicit per-message save/unsave overrides.
    savedAttachmentIds: string[];
    unsavedAttachmentIds: string[];
    savedMessageIds: string[];
    unsavedMessageIds: string[];
    unsavedMessageTimestamps:    Record<string, number>; // msgId  → ms when unsaved
    unsavedAttachmentTimestamps: Record<string, number>; // attId  → ms when unsaved
}

const DEFAULT_POLICY: StoragePolicy = {
    attachmentRetention: '24h',
    messageRetention: 'never',
    savedAttachmentIds: [],
    unsavedAttachmentIds: [],
    savedMessageIds: [],
    unsavedMessageIds: [],
    unsavedMessageTimestamps: {},
    unsavedAttachmentTimestamps: {},
};

// ── Per-type effective retention helpers ──────────────────────────────────────

export type ConvType = 'dm' | 'group' | 'server';

/** Resolve the effective message retention for a given conversation type.
 *  Falls back to the global field when no type-specific default has been set. */
export function getEffectiveMessageRetention(
    policy: StoragePolicy,
    type: ConvType,
): MessageRetention {
    switch (type) {
        case 'dm':     return policy.dmMessageRetention     ?? policy.messageRetention;
        case 'group':  return policy.groupMessageRetention  ?? policy.messageRetention;
        case 'server': return policy.serverMessageRetention ?? policy.messageRetention;
    }
}

/**
 * The retention that actually applies to a chat: a per-server override (when the
 * chat is a server channel and one is set) beats the per-type default (DM / group
 * / server), which beats the global setting. The expiry countdown, the cleanup
 * sweep AND the "is this saved?" indicator must all use this one chain — the
 * indicator used to skip the per-type step, so with a global "keep forever" every
 * message in a chat with its own shorter retention was shown as saved while it
 * was in fact going to expire.
 */
export function resolveChatMessageRetention(
    policy: StoragePolicy,
    convType: ConvType | undefined,
    channelOverride?: MessageRetention | null,
): MessageRetention {
    const typeDefault = convType ? getEffectiveMessageRetention(policy, convType) : policy.messageRetention;
    return channelOverride ?? typeDefault;
}

export function resolveChatAttachmentRetention(
    policy: StoragePolicy,
    convType: ConvType | undefined,
    channelOverride?: AttachmentRetention | null,
): AttachmentRetention {
    const typeDefault = convType ? getEffectiveAttachmentRetention(policy, convType) : policy.attachmentRetention;
    return channelOverride ?? typeDefault;
}

/** Resolve the effective attachment retention for a given conversation type. */
export function getEffectiveAttachmentRetention(
    policy: StoragePolicy,
    type: ConvType,
): AttachmentRetention {
    switch (type) {
        case 'dm':     return policy.dmAttachmentRetention     ?? policy.attachmentRetention;
        case 'group':  return policy.groupAttachmentRetention  ?? policy.attachmentRetention;
        case 'server': return policy.serverAttachmentRetention ?? policy.attachmentRetention;
    }
}

// Grace period after an explicit unsave: item is deleted 24 h after unsave was
// clicked, OR at its natural policy window end — whichever is later.
export const UNSAVE_EXPIRY_MS = 24 * 60 * 60 * 1000;

const DAY = 24 * 60 * 60 * 1000;

export function attachmentRetentionMs(r: AttachmentRetention): number {
    switch (r) {
        case 'never': return Number.POSITIVE_INFINITY;
        case '1y':    return 365 * DAY;
        case '6mo':   return 182 * DAY;
        case '3mo':   return 91 * DAY;
        case '1mo':   return 30 * DAY;
        case '1wk':   return 7 * DAY;
        case '24h':   return 1 * DAY;
        // A value this build doesn't know (a hand-edited / restored / newer
        // build's setting). `undefined` here made every `age < window` test
        // false and so DELETED EVERYTHING; the only safe reading of a window
        // we can't parse is "don't delete".
        default:      return Number.POSITIVE_INFINITY;
    }
}

export function messageRetentionMs(r: MessageRetention): number {
    switch (r) {
        case 'never': return Number.POSITIVE_INFINITY;
        case '1y':    return 365 * DAY;
        case '6mo':   return 182 * DAY;
        case '3mo':   return 91 * DAY;
        case '1mo':   return 30 * DAY;
        case '1wk':   return 7 * DAY;
        default:      return Number.POSITIVE_INFINITY; // see attachmentRetentionMs
    }
}

export const ATTACHMENT_RETENTION_LABELS: Record<AttachmentRetention, string> = {
    'never': 'Forever',
    '1y':    '1 year',
    '6mo':   '6 months',
    '3mo':   '3 months',
    '1mo':   '1 month',
    '1wk':   '1 week',
    '24h':   '24 hours',
};

export const MESSAGE_RETENTION_LABELS: Record<MessageRetention, string> = {
    'never': 'Forever',
    '1y':    '1 year',
    '6mo':   '6 months',
    '3mo':   '3 months',
    '1mo':   '1 month',
    '1wk':   '1 week',
};

function storageKey(userId: string | null | undefined): string | null {
    return userId ? `cipherline_storage_policy_${userId}` : null;
}

function loadPolicy(userId: string | null | undefined): StoragePolicy {
    const key = storageKey(userId);
    if (!key) return DEFAULT_POLICY;
    try {
        const raw = secureLocalStore.getItem(key);
        if (!raw) return DEFAULT_POLICY;
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_POLICY,
            ...parsed,
            savedAttachmentIds:   Array.isArray(parsed.savedAttachmentIds)   ? parsed.savedAttachmentIds   : [],
            unsavedAttachmentIds: Array.isArray(parsed.unsavedAttachmentIds) ? parsed.unsavedAttachmentIds : [],
            savedMessageIds:      Array.isArray(parsed.savedMessageIds)       ? parsed.savedMessageIds       : [],
            unsavedMessageIds:    Array.isArray(parsed.unsavedMessageIds)     ? parsed.unsavedMessageIds     : [],
            // New fields — fall back to empty objects for old localStorage entries
            unsavedMessageTimestamps:    (typeof parsed.unsavedMessageTimestamps === 'object'
                && parsed.unsavedMessageTimestamps !== null)
                ? parsed.unsavedMessageTimestamps : {},
            unsavedAttachmentTimestamps: (typeof parsed.unsavedAttachmentTimestamps === 'object'
                && parsed.unsavedAttachmentTimestamps !== null)
                ? parsed.unsavedAttachmentTimestamps : {},
        };
    } catch {
        return DEFAULT_POLICY;
    }
}

/** Every policy object that came FROM storage (as opposed to a user change).
 *  The persist effect skips these: writing freshly-loaded state back is how
 *  this hook used to stamp DEFAULT_POLICY onto every account on mount — which
 *  would now also be indistinguishable from "this device has chosen a
 *  retention" and suppress the first-run storage prompt
 *  (utils/deviceStorageSetup.ts). Only user-initiated changes persist. Weak,
 *  so superseded policies are collected. */
const LOADED_POLICIES = new WeakSet<StoragePolicy>();

function loadFromStorage(userId: string | null | undefined): StoragePolicy {
    const p = loadPolicy(userId);
    // DEFAULT_POLICY is a shared singleton — copy so each load is distinct.
    const fresh = p === DEFAULT_POLICY ? { ...DEFAULT_POLICY } : p;
    LOADED_POLICIES.add(fresh);
    return fresh;
}

export function useRetentionPolicy(userId: string | null | undefined) {
    const [policy, setPolicy] = useState<StoragePolicy>(() => loadFromStorage(userId));

    // Re-load if the userId changes (account switch)
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- account switch must swap in the new account's stored policy (pre-existing behaviour)
        setPolicy(loadFromStorage(userId));
    }, [userId]);

    // Re-load when the stored policy is rewritten outside this hook: the
    // first-run storage prompt saving its choice, or a restore / history
    // transfer merging in explicitly-saved ids.
    useEffect(() => {
        if (!userId) return;
        const onChanged = (e: Event) => {
            const uid = (e as CustomEvent<{ userId?: string }>).detail?.userId;
            if (uid === userId) setPolicy(loadFromStorage(userId));
        };
        window.addEventListener(STORAGE_POLICY_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(STORAGE_POLICY_CHANGED_EVENT, onChanged);
    }, [userId]);

    // P2-REND-17: when userId changes, the persist effect fires with the OLD policy
    // before the load effect's setPolicy has run, writing the previous user's data
    // under the new user's key. Track the previously-seen userId; skip persisting
    // on the transition render so only the freshly-loaded policy is ever written.
    const persistedForUserRef = useRef(userId);

    // Persist every change
    useEffect(() => {
        const key = storageKey(userId);
        if (!key) return;
        if (userId !== persistedForUserRef.current) {
            persistedForUserRef.current = userId;
            return;
        }
        // Loaded from storage, not changed by the user — nothing to write.
        if (LOADED_POLICIES.has(policy)) return;
        try {
            secureLocalStore.setItem(key, JSON.stringify(policy));
        } catch (e) {
            console.warn('[retention] failed to persist policy', e);
        }
    }, [policy, userId]);

    const setAttachmentRetention = useCallback((r: AttachmentRetention) => {
        setPolicy(p => ({ ...p, attachmentRetention: r }));
    }, []);

    const setMessageRetention = useCallback((r: MessageRetention) => {
        setPolicy(p => ({ ...p, messageRetention: r }));
    }, []);

    // Per-type default setters (undefined = clear override, fall back to global)
    const setDmMessageRetention = useCallback((r: MessageRetention | undefined) => {
        setPolicy(p => ({ ...p, dmMessageRetention: r }));
    }, []);
    const setDmAttachmentRetention = useCallback((r: AttachmentRetention | undefined) => {
        setPolicy(p => ({ ...p, dmAttachmentRetention: r }));
    }, []);
    const setGroupMessageRetention = useCallback((r: MessageRetention | undefined) => {
        setPolicy(p => ({ ...p, groupMessageRetention: r }));
    }, []);
    const setGroupAttachmentRetention = useCallback((r: AttachmentRetention | undefined) => {
        setPolicy(p => ({ ...p, groupAttachmentRetention: r }));
    }, []);
    const setServerMessageRetention = useCallback((r: MessageRetention | undefined) => {
        setPolicy(p => ({ ...p, serverMessageRetention: r }));
    }, []);
    const setServerAttachmentRetention = useCallback((r: AttachmentRetention | undefined) => {
        setPolicy(p => ({ ...p, serverAttachmentRetention: r }));
    }, []);

    const isAttachmentSaved = useCallback((id: string): boolean => {
        // Explicit unsave always wins (forces grace-period override regardless of global policy).
        if (policy.unsavedAttachmentIds.includes(id)) return false;
        if (policy.savedAttachmentIds.includes(id)) return true;
        // Under 'never', implicit default is saved.
        if (policy.attachmentRetention === 'never') return true;
        return false;
    }, [policy]);

    const saveAttachment = useCallback((id: string) => {
        setPolicy(p => {
            const { [id]: _drop, ...restTs } = p.unsavedAttachmentTimestamps;
            return {
                ...p,
                savedAttachmentIds:          p.savedAttachmentIds.includes(id) ? p.savedAttachmentIds : [...p.savedAttachmentIds, id],
                unsavedAttachmentIds:        p.unsavedAttachmentIds.filter(x => x !== id),
                unsavedAttachmentTimestamps: restTs,
            };
        });
    }, []);

    const unsaveAttachment = useCallback((id: string) => {
        const now = Date.now();
        setPolicy(p => ({
            ...p,
            savedAttachmentIds:          p.savedAttachmentIds.filter(x => x !== id),
            unsavedAttachmentIds:        p.unsavedAttachmentIds.includes(id)
                ? p.unsavedAttachmentIds
                : [...p.unsavedAttachmentIds, id],
            unsavedAttachmentTimestamps: { ...p.unsavedAttachmentTimestamps, [id]: now },
        }));
    }, []);

    const isMessageSaved = useCallback((id: string): boolean => {
        if (policy.unsavedMessageIds.includes(id)) return false;
        if (policy.savedMessageIds.includes(id)) return true;
        if (policy.messageRetention === 'never') return true;
        return false;
    }, [policy]);

    const saveMessage = useCallback((id: string) => {
        setPolicy(p => {
            const { [id]: _drop, ...restTs } = p.unsavedMessageTimestamps;
            return {
                ...p,
                savedMessageIds:          p.savedMessageIds.includes(id) ? p.savedMessageIds : [...p.savedMessageIds, id],
                unsavedMessageIds:        p.unsavedMessageIds.filter(x => x !== id),
                unsavedMessageTimestamps: restTs,
            };
        });
    }, []);

    const unsaveMessage = useCallback((id: string) => {
        const now = Date.now();
        setPolicy(p => ({
            ...p,
            savedMessageIds:          p.savedMessageIds.filter(x => x !== id),
            unsavedMessageIds:        p.unsavedMessageIds.includes(id)
                ? p.unsavedMessageIds
                : [...p.unsavedMessageIds, id],
            unsavedMessageTimestamps: { ...p.unsavedMessageTimestamps, [id]: now },
        }));
    }, []);

    /**
     * Return the UTC ms at which a given message is scheduled to be swept,
     * or null if it's saved forever.
     *
     * For explicitly unsaved items: effective expiry = max(natural window end,
     * unsavedAt + 24h). This ensures messages past their natural window get a
     * 24-hour grace period from the moment of unsave rather than instant deletion,
     * while messages still inside their window expire at the natural time.
     */
    const getMessageExpiryAt = useCallback((id: string, sentAtMs: number): number | null => {
        if (policy.savedMessageIds.includes(id)) return null;
        if (policy.unsavedMessageIds.includes(id)) {
            // Fall back to sentAtMs for legacy entries that predate timestamp tracking
            const unsavedAt      = policy.unsavedMessageTimestamps[id] ?? sentAtMs;
            const graceExpiry    = unsavedAt + UNSAVE_EXPIRY_MS;
            const retMs          = messageRetentionMs(policy.messageRetention);
            if (retMs === Number.POSITIVE_INFINITY) return graceExpiry;
            return Math.max(sentAtMs + retMs, graceExpiry);
        }
        if (policy.messageRetention === 'never') return null;
        return sentAtMs + messageRetentionMs(policy.messageRetention);
    }, [policy]);

    const getAttachmentExpiryAt = useCallback((id: string, sentAtMs: number): number | null => {
        if (policy.savedAttachmentIds.includes(id)) return null;
        if (policy.unsavedAttachmentIds.includes(id)) {
            const unsavedAt      = policy.unsavedAttachmentTimestamps[id] ?? sentAtMs;
            const graceExpiry    = unsavedAt + UNSAVE_EXPIRY_MS;
            const retMs          = attachmentRetentionMs(policy.attachmentRetention);
            if (retMs === Number.POSITIVE_INFINITY) return graceExpiry;
            return Math.max(sentAtMs + retMs, graceExpiry);
        }
        if (policy.attachmentRetention === 'never') return null;
        return sentAtMs + attachmentRetentionMs(policy.attachmentRetention);
    }, [policy]);

    const getAttachmentExpiryMs = useCallback(() => attachmentRetentionMs(policy.attachmentRetention), [policy.attachmentRetention]);
    const getMessageExpiryMs    = useCallback(() => messageRetentionMs(policy.messageRetention), [policy.messageRetention]);

    return useMemo(() => ({
        policy,
        setAttachmentRetention,
        setMessageRetention,
        setDmMessageRetention,
        setDmAttachmentRetention,
        setGroupMessageRetention,
        setGroupAttachmentRetention,
        setServerMessageRetention,
        setServerAttachmentRetention,
        isAttachmentSaved,
        saveAttachment,
        unsaveAttachment,
        isMessageSaved,
        saveMessage,
        unsaveMessage,
        getAttachmentExpiryMs,
        getMessageExpiryMs,
        getMessageExpiryAt,
        getAttachmentExpiryAt,
    }), [policy, setAttachmentRetention, setMessageRetention, setDmMessageRetention, setDmAttachmentRetention, setGroupMessageRetention, setGroupAttachmentRetention, setServerMessageRetention, setServerAttachmentRetention, isAttachmentSaved, saveAttachment, unsaveAttachment, isMessageSaved, saveMessage, unsaveMessage, getAttachmentExpiryMs, getMessageExpiryMs, getMessageExpiryAt, getAttachmentExpiryAt]);
}

export type RetentionHook = ReturnType<typeof useRetentionPolicy>;
