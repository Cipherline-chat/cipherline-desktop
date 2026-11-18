import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import {
    parseCollapsed,
    pruneCollapsed,
    serializeCollapsed,
    toggleCollapsed,
} from '../utils/memberGroupCollapse';

/**
 * Which groups of a list are collapsed, remembered in secureLocalStore under
 * `storageKey` (per account: callers build the key with the user id — see
 * utils/memberGroupCollapse.ts).
 *
 * Persistence rules (memory: secure-local-store-account-rebind):
 *  - Never writes on mount. Only a user toggle / expand, or a prune that
 *    actually removes a stale id, writes.
 *  - Writes only while `secureLocalStore.isAccountReady(userId)`. Right after an
 *    account switch the per-account namespace is cold; the hook re-reads once
 *    `whenAccountReady()` resolves instead of writing defaults over real data.
 *  - Switching `storageKey` (another server) reads that key in the SAME render,
 *    so a switch never paints one frame with the previous server's state.
 *
 * `validIds`: the ids that can still exist (null while unknown, e.g. the
 * roster has not loaded). Stored ids outside it are pruned and the trimmed
 * list is written back, so ids of deleted roles do not accumulate.
 */
export function useCollapsedGroups(
    storageKey: string | null,
    userId: string | null | undefined,
    validIds: ReadonlySet<string> | null,
): {
    collapsed: ReadonlySet<string>;
    isCollapsed: (id: string) => boolean;
    toggle: (id: string) => void;
    expand: (id: string) => void;
} {
    const [state, setState] = useState(() => ({ key: storageKey, ids: readSet(storageKey) }));
    // Different key than the state was read for: read it now, during render.
    let current = state;
    if (state.key !== storageKey) {
        current = { key: storageKey, ids: readSet(storageKey) };
        setState(current);
    }

    const persist = useCallback((key: string | null, ids: ReadonlySet<string>) => {
        if (!key || !userId || !secureLocalStore.isAccountReady(userId)) return;
        try {
            if (ids.size === 0) secureLocalStore.removeItem(key);
            else secureLocalStore.setItem(key, serializeCollapsed(ids));
        } catch { /* persisting a UI preference is best-effort; a failed write must not break the UI */ }
    }, [userId]);

    // Cold namespace (explicit sign-in / account switch in flight): re-read
    // once this account's records are decrypted. No write here.
    useEffect(() => {
        if (!storageKey || !userId || secureLocalStore.isAccountReady(userId)) return;
        let cancelled = false;
        void secureLocalStore.whenAccountReady().then(() => {
            if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
            setState(s => (s.key === storageKey ? { key: storageKey, ids: readSet(storageKey) } : s));
        }).catch(() => { /* load failure: stay on what we have, never write */ });
        return () => { cancelled = true; };
    }, [storageKey, userId]);

    // Ids of groups that can no longer exist (deleted / un-hoisted roles) are
    // dropped from what the caller sees right away, and the trimmed list is
    // written back once (only when something was actually dropped).
    const currentIds = current.ids;
    const ids = useMemo(
        () => (validIds ? pruneCollapsed(currentIds, validIds) : currentIds),
        [currentIds, validIds],
    );
    const pruned = ids !== currentIds;
    useEffect(() => {
        if (pruned) persist(storageKey, ids);
    }, [pruned, ids, storageKey, persist]);
    const validRef = useRef(validIds);
    useEffect(() => { validRef.current = validIds; }, [validIds]);
    const clean = (set: Set<string>) => (validRef.current ? pruneCollapsed(set, validRef.current) : set);

    const toggle = useCallback((id: string) => {
        setState(s => {
            const next = clean(toggleCollapsed(s.ids, id));
            persist(s.key, next);
            return { key: s.key, ids: next };
        });
    }, [persist]);

    const expand = useCallback((id: string) => {
        setState(s => {
            if (!s.ids.has(id)) return s;
            const next = new Set(s.ids);
            next.delete(id);
            const cleaned = clean(next);
            persist(s.key, cleaned);
            return { key: s.key, ids: cleaned };
        });
    }, [persist]);

    const isCollapsed = useCallback((id: string) => ids.has(id), [ids]);
    return { collapsed: ids, isCollapsed, toggle, expand };
}

function readSet(key: string | null): Set<string> {
    if (!key) return new Set();
    try { return parseCollapsed(secureLocalStore.getItem(key)); } catch { return new Set(); }
}
