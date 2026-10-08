/**
 * useServerRailLayout — persists the left server rail's layout (the order of
 * servers AND folders, plus each folder's name, colour and members), per
 * account, client-side only. Server-lean and on-device by design: this is a
 * personal display preference and part of the user's social graph, so there
 * is no API endpoint and the server never sees a folder name.
 *
 * Storage:
 *   `cipherline_server_rail_layout_{uid}` — v2 JSON (serverFolders.ts).
 *   `cipherline_server_rail_order_{uid}`  — the LEGACY flat order (a bare
 *     array of server ids) from before folders. Read once as a migration
 *     source when no v2 record exists yet, and still written alongside v2 as
 *     the flattened order, so a client downgraded to a pre-folder build (the
 *     staging channel does this) still shows the user's order instead of
 *     API order. Both keys are INCLUDED in the encrypted backup
 *     (services/backupRegistry.ts).
 *
 * Same dirtyRef discipline as before (and as useGameSettings.ts): the record
 * is loaded on mount/account-switch but never written back unless the user
 * actually changed something. Writing the just-loaded state back on mount is
 * the bug secure_local_store_account_rebind describes — a cold per-account
 * namespace right after sign-in reads as "nothing saved", and persisting THAT
 * would erase a real layout the moment its record becomes readable.
 */

import secureLocalStore from '../../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    EMPTY_LAYOUT, addServerToFolder, applyRailDrop, createFolder, flattenServerIds, forgetServer,
    moveRailItemBy, moveToRailPosition, parseRailLayout, reconcileRailLayout, removeFromFolder,
    renameFolder, serializeRailLayout, setFolderColor, ungroupFolder,
    type FolderColor, type RailDropAction, type RailLayout, type Side,
} from './serverFolders';

export const serverRailLayoutKey = (userId: string) => `cipherline_server_rail_layout_${userId}`;
export const serverRailOrderKey = (userId: string) => `cipherline_server_rail_order_${userId}`;

function readJson(key: string): unknown {
    const raw = secureLocalStore.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw);
}

export function loadRailLayout(userId: string | null | undefined): RailLayout {
    if (!userId) return EMPTY_LAYOUT;
    try {
        const v2 = readJson(serverRailLayoutKey(userId));
        if (v2 !== undefined) return parseRailLayout(v2);
    } catch { /* corrupt v2 record — fall through to the legacy order */ }
    try {
        const legacy = readJson(serverRailOrderKey(userId));
        if (legacy !== undefined) return parseRailLayout(legacy);
    } catch { /* corrupt — start fresh */ }
    return EMPTY_LAYOUT;
}

let folderSeq = 0;
/** Local, opaque folder id. Never leaves the device; only needs to be unique
 *  within this account's layout. */
export function newFolderId(): string {
    folderSeq = (folderSeq + 1) % 1_000_000;
    const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `f${Date.now().toString(36)}${folderSeq.toString(36)}${rand}`;
}

export function useServerRailLayout(userId: string | null | undefined, currentIds: string[]) {
    const [saved, setSaved] = useState<RailLayout>(() => loadRailLayout(userId));
    const dirtyRef = useRef(false);
    const boundUserRef = useRef(userId);

    // Account switch within a session: reload for the new account, and the
    // dirty flag must not carry over — otherwise the first write-back effect
    // for the new account would fire with the old account's data.
    useEffect(() => {
        if (boundUserRef.current === userId) return;
        boundUserRef.current = userId;
        dirtyRef.current = false;
        setSaved(loadRailLayout(userId));
    }, [userId]);

    useEffect(() => {
        if (!dirtyRef.current || !userId || !secureLocalStore.isAccountReady(userId)) return;
        // Both keys are spelled as literal templates rather than through the
        // helpers above on purpose: backupRegistry.test.ts's source scan only
        // recognises a literal `setItem(\`key…` head, so routing these through
        // a helper call would hide them from that check rather than satisfy it.
        try {
            secureLocalStore.setItem(`cipherline_server_rail_layout_${userId}`, serializeRailLayout(saved));
            secureLocalStore.setItem(`cipherline_server_rail_order_${userId}`, JSON.stringify(flattenServerIds(saved)));
        } catch { /* quota — non-fatal */ }
    }, [saved, userId]);

    // What is actually rendered: the saved layout reconciled against the
    // servers the user belongs to RIGHT NOW — left servers drop out (and out
    // of their folders), new servers land at the bottom outside any folder.
    const layout = useMemo(() => reconcileRailLayout(saved, currentIds), [saved, currentIds]);

    // Actions read the LATEST layout from a ref, so a callback captured
    // earlier (a context-menu item chosen seconds after the menu opened, a
    // drop handler bound before the last commit) never applies its change to
    // a stale snapshot and silently reverts something in between.
    const layoutRef = useRef(layout);
    useEffect(() => { layoutRef.current = layout; }, [layout]);

    // Every change persists the full RECONCILED layout (not the raw saved
    // one), which keeps the record self-trimming: a left server drops out of
    // storage the next time the user changes anything.
    const commit = useCallback((op: (base: RailLayout) => RailLayout): boolean => {
        const base = layoutRef.current;
        const next = op(base);
        if (next === base) return false;
        layoutRef.current = next;
        dirtyRef.current = true;
        setSaved(next);
        return true;
    }, []);

    const actions = useMemo(() => ({
        move: (activeKey: string, targetKey: string, side: Side) => commit(l => moveToRailPosition(l, activeKey, targetKey, side)),
        moveBy: (key: string, delta: number) => commit(l => moveRailItemBy(l, key, delta)),
        createFolder: (targetId: string, draggedId: string) => commit(l => createFolder(l, targetId, draggedId, newFolderId())),
        addToFolder: (folderId: string, serverId: string, index?: number) => commit(l => addServerToFolder(l, folderId, serverId, index)),
        removeFromFolder: (serverId: string) => commit(l => removeFromFolder(l, serverId)),
        ungroup: (folderId: string) => commit(l => ungroupFolder(l, folderId)),
        rename: (folderId: string, name: string) => commit(l => renameFolder(l, folderId, name)),
        setColor: (folderId: string, color: FolderColor | null) => commit(l => setFolderColor(l, folderId, color)),
        forget: (serverId: string) => commit(l => forgetServer(l, serverId)),
        applyDrop: (action: RailDropAction) => commit(l => applyRailDrop(l, action, newFolderId)),
    }), [commit]);

    return useMemo(() => ({ layout, ...actions }), [layout, actions]);
}

export type ServerRailLayoutHook = ReturnType<typeof useServerRailLayout>;
