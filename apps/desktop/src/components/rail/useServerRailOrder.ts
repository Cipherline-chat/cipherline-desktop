/**
 * useServerRailOrder — persists the left server rail's drag-to-reorder
 * position, per account, client-side only (server-lean: no API endpoint —
 * this is a personal display preference, not shared server state).
 *
 * Follows the same dirtyRef discipline as useGameSettings.ts: the record is
 * loaded synchronously on mount/account-switch, but never written back
 * unless the user actually reordered something. Writing the just-loaded
 * state back on mount is the exact bug secure_local_store_account_rebind
 * describes — a cold per-account namespace right after sign-in reads as "no
 * saved order", and persisting THAT would erase a real saved order the
 * moment its record becomes readable.
 */

import secureLocalStore from '../../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mergeServerRailOrder, moveServerInRailOrder, moveServerToRailPosition } from './serverRailOrder';

export const serverRailOrderKey = (userId: string) => `cipherline_server_rail_order_${userId}`;

function loadSavedOrder(userId: string | null | undefined): string[] {
    try {
        const raw = userId ? secureLocalStore.getItem(serverRailOrderKey(userId)) : null;
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

export function useServerRailOrder(userId: string | null | undefined, currentIds: string[]) {
    const [savedOrder, setSavedOrder] = useState<string[]>(() => loadSavedOrder(userId));
    const dirtyRef = useRef(false);
    const boundUserRef = useRef(userId);

    // Account switch within a session (sign-out -> sign-in as someone else):
    // reload for the new account, and the dirty flag must not carry over —
    // otherwise the FIRST render's write-back effect for the new account
    // would fire on the old account's data before the reload state commits.
    useEffect(() => {
        if (boundUserRef.current === userId) return;
        boundUserRef.current = userId;
        dirtyRef.current = false;
        setSavedOrder(loadSavedOrder(userId));
    }, [userId]);

    useEffect(() => {
        if (!dirtyRef.current || !userId || !secureLocalStore.isAccountReady(userId)) return;
        // Spelled as a literal template rather than `serverRailOrderKey(userId)`
        // on purpose — same reason as localHistoryFlag.ts's markLocalHistory:
        // backupRegistry.test.ts's source scan only recognises a literal
        // `setItem(\`key…` head or an ALL-CAPS `setItem(SOME_CONST, …)`, not a
        // lowercase helper call. Routing this through the helper would hide
        // the key from that check rather than satisfy it.
        try { secureLocalStore.setItem(`cipherline_server_rail_order_${userId}`, JSON.stringify(savedOrder)); } catch { /* quota — non-fatal */ }
    }, [savedOrder, userId]);

    // The order actually rendered: saved order reconciled against who the
    // user is a member of RIGHT NOW. Left servers drop out, newly joined
    // servers land at the bottom — see serverRailOrder.ts.
    const orderedIds = useMemo(
        () => mergeServerRailOrder(savedOrder, currentIds),
        [savedOrder, currentIds],
    );

    // Persisting the full MERGED order (not the raw savedOrder) on every
    // explicit reorder is what keeps the saved record self-trimming: a
    // server that left drops out of storage the next time the user drags
    // anything, rather than lingering in the JSON forever.
    const persist = useCallback((next: string[]) => {
        dirtyRef.current = true;
        setSavedOrder(next);
    }, []);

    /** Drag-and-drop: drop `activeId` where `overId` currently sits. */
    const reorder = useCallback((activeId: string, overId: string) => {
        const next = moveServerToRailPosition(orderedIds, activeId, overId);
        if (next !== orderedIds) persist(next);
    }, [orderedIds, persist]);

    /** Keyboard: Alt+ArrowUp/Down on a focused server tile. */
    const moveByKeyboard = useCallback((id: string, delta: number) => {
        const next = moveServerInRailOrder(orderedIds, id, delta);
        if (next !== orderedIds) persist(next);
    }, [orderedIds, persist]);

    return useMemo(() => ({ orderedIds, reorder, moveByKeyboard }), [orderedIds, reorder, moveByKeyboard]);
}

export type ServerRailOrderHook = ReturnType<typeof useServerRailOrder>;
