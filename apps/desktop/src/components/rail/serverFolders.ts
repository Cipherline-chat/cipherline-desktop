/**
 * Pure model for the left server rail: servers and server FOLDERS interleaved
 * in one user-chosen order.
 *
 * Kept free of React, dnd-kit and secureLocalStore so every rule here is
 * unit-tested in isolation (serverFolders.test.ts). The React half —
 * persistence and per-account rebinding — is useServerRailLayout.ts; the
 * drag-and-drop state machine is useRailFolderDnd.ts.
 *
 * Client-owned on purpose (server-lean, and "the social graph lives
 * on-device only"): folder names, colours and membership are a personal
 * display preference. They are persisted per account in secureLocalStore and
 * travel in the encrypted backup; the server never sees any of it.
 *
 * Invariants every exported operation returns with (enforced by `normalize`):
 *   - every server id appears AT MOST ONCE in the whole layout (top level or
 *     inside exactly one folder);
 *   - a folder holds AT LEAST TWO servers — a folder left with one server
 *     dissolves into that server at the folder's position, an empty one is
 *     dropped. A folder therefore never "eats" a server;
 *   - folder ids are unique.
 * Operations never mutate their input and return the SAME reference when they
 * are a no-op, so callers can skip a persist/re-render with `===`.
 */

import type { BadgeState } from '../../utils/unreadBadges';

// ── Types ────────────────────────────────────────────────────────────────

/** A few palette swatches, stored by NAME (never a raw colour string) so a
 *  restored backup can't inject arbitrary CSS and a theme change re-tints. */
export const FOLDER_COLORS = ['lume', 'glow', 'flash', 'ok', 'slate'] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

export const FOLDER_COLOR_VAR: Record<FolderColor, string> = {
    lume: 'var(--cl-lume)',
    glow: 'var(--cl-glow)',
    flash: 'var(--cl-flash)',
    ok: 'var(--cl-ok)',
    slate: 'var(--cl-muted)',
};

export const FOLDER_COLOR_LABEL: Record<FolderColor, string> = {
    lume: 'Aqua', glow: 'Amber', flash: 'Coral', ok: 'Green', slate: 'Slate',
};

export const DEFAULT_FOLDER_NAME = 'Folder';
export const MAX_FOLDER_NAME = 32;

export interface RailFolder {
    id: string;
    name: string;
    color: FolderColor | null;
    /** Ordered; the first four are the folder icon's 2×2 preview. */
    serverIds: string[];
}

export type RailItem =
    | { kind: 'server'; id: string }
    | { kind: 'folder'; folder: RailFolder };

export interface RailLayout { items: RailItem[] }

export const EMPTY_LAYOUT: RailLayout = { items: [] };

// ── dnd keys ─────────────────────────────────────────────────────────────
// One DndContext hosts the rail AND the open folder's popover, so ids are
// namespaced by where the draggable lives.

export const serverKey = (id: string) => `srv:${id}`;
export const folderKey = (id: string) => `fld:${id}`;
/** A server tile inside the open folder popover. */
export const folderServerKey = (id: string) => `fsrv:${id}`;
/** The popover's own drop area (its empty space). */
export const folderPopoverKey = (id: string) => `fpop:${id}`;

export type ParsedKey =
    | { kind: 'server'; id: string }
    | { kind: 'folder'; id: string }
    | { kind: 'folderServer'; id: string }
    | { kind: 'folderPopover'; id: string };

export function parseKey(key: string): ParsedKey | null {
    const i = key.indexOf(':');
    if (i < 0) return null;
    const prefix = key.slice(0, i);
    const id = key.slice(i + 1);
    if (!id) return null;
    switch (prefix) {
        case 'srv': return { kind: 'server', id };
        case 'fld': return { kind: 'folder', id };
        case 'fsrv': return { kind: 'folderServer', id };
        case 'fpop': return { kind: 'folderPopover', id };
        default: return null;
    }
}

export function railItemKey(item: RailItem): string {
    return item.kind === 'server' ? serverKey(item.id) : folderKey(item.folder.id);
}

// ── Persistence (de)serialisation ────────────────────────────────────────

/**
 * Read whatever JSON was on disk. Accepts:
 *   - the v2 object `{ v: 2, items: [...] }` this module writes;
 *   - the LEGACY flat order (a bare `string[]` of server ids, what
 *     useServerRailOrder wrote before folders existed) — migrated to a
 *     folder-less layout in the same order.
 * Anything malformed is dropped piece by piece; nothing throws.
 */
export function parseRailLayout(raw: unknown): RailLayout {
    if (Array.isArray(raw)) {
        return normalize({ items: raw.filter((x): x is string => typeof x === 'string' && !!x).map(id => ({ kind: 'server' as const, id })) });
    }
    if (!raw || typeof raw !== 'object') return EMPTY_LAYOUT;
    const items = (raw as { items?: unknown }).items;
    if (!Array.isArray(items)) return EMPTY_LAYOUT;
    const out: RailItem[] = [];
    for (const it of items) {
        if (typeof it === 'string' && it) { out.push({ kind: 'server', id: it }); continue; }
        if (!it || typeof it !== 'object') continue;
        const f = it as { id?: unknown; name?: unknown; color?: unknown; servers?: unknown };
        if (typeof f.id !== 'string' || !f.id || !Array.isArray(f.servers)) continue;
        out.push({
            kind: 'folder',
            folder: {
                id: f.id,
                name: sanitizeFolderName(typeof f.name === 'string' ? f.name : ''),
                color: isFolderColor(f.color) ? f.color : null,
                serverIds: f.servers.filter((x): x is string => typeof x === 'string' && !!x),
            },
        });
    }
    return normalize({ items: out });
}

/** Compact on-disk form: a server is its bare id string, a folder an object. */
export function serializeRailLayout(layout: RailLayout): string {
    return JSON.stringify({
        v: 2,
        items: layout.items.map(it => it.kind === 'server'
            ? it.id
            : { id: it.folder.id, name: it.folder.name, color: it.folder.color, servers: it.folder.serverIds }),
    });
}

export function isFolderColor(c: unknown): c is FolderColor {
    return typeof c === 'string' && (FOLDER_COLORS as readonly string[]).includes(c);
}

export function sanitizeFolderName(name: string): string {
    // Collapse whitespace (incl. newlines a paste could carry) and cap length.
    const t = name.replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME).trim();
    return t || DEFAULT_FOLDER_NAME;
}

// ── Queries ──────────────────────────────────────────────────────────────

/** Every server id in display order (folders expanded in place). */
export function flattenServerIds(layout: RailLayout): string[] {
    const out: string[] = [];
    for (const it of layout.items) {
        if (it.kind === 'server') out.push(it.id);
        else out.push(...it.folder.serverIds);
    }
    return out;
}

export function findFolder(layout: RailLayout, folderId: string): RailFolder | null {
    for (const it of layout.items) if (it.kind === 'folder' && it.folder.id === folderId) return it.folder;
    return null;
}

export function folderOfServer(layout: RailLayout, serverId: string): RailFolder | null {
    for (const it of layout.items) if (it.kind === 'folder' && it.folder.serverIds.includes(serverId)) return it.folder;
    return null;
}

/** Index of the TOP-LEVEL rail item that shows `serverId` — the server's own
 *  tile, or the folder containing it. -1 when absent. Drives the active pill
 *  and scroll-into-view. */
export function railIndexOfServer(layout: RailLayout, serverId: string): number {
    return layout.items.findIndex(it => it.kind === 'server' ? it.id === serverId : it.folder.serverIds.includes(serverId));
}

// ── Normalisation & reconciliation ───────────────────────────────────────

/**
 * Enforce the module invariants: de-duplicate servers (first occurrence wins),
 * de-duplicate folder ids, dissolve one-server folders in place, drop empty
 * ones. Returns `layout` itself when already normal.
 */
export function normalize(layout: RailLayout): RailLayout {
    const seenServers = new Set<string>();
    const seenFolders = new Set<string>();
    const out: RailItem[] = [];
    let changed = false;
    for (const it of layout.items) {
        if (it.kind === 'server') {
            if (seenServers.has(it.id)) { changed = true; continue; }
            seenServers.add(it.id);
            out.push(it);
            continue;
        }
        const f = it.folder;
        if (seenFolders.has(f.id)) {
            // A duplicate folder id: keep its servers, as plain tiles, rather
            // than lose them.
            changed = true;
            for (const id of f.serverIds) if (!seenServers.has(id)) { seenServers.add(id); out.push({ kind: 'server', id }); }
            continue;
        }
        seenFolders.add(f.id);
        const ids = f.serverIds.filter(id => !seenServers.has(id) && (seenServers.add(id), true));
        // `filter` with a side-effecting predicate is deliberate: one pass that
        // both checks and claims, so a duplicate WITHIN a folder is caught too.
        if (ids.length === 0) { changed = true; continue; }
        if (ids.length === 1) { changed = true; out.push({ kind: 'server', id: ids[0] }); continue; }
        if (ids.length !== f.serverIds.length) { changed = true; out.push({ kind: 'folder', folder: { ...f, serverIds: ids } }); continue; }
        out.push(it);
    }
    return changed ? { items: out } : layout;
}

/**
 * Reconcile the saved layout against the servers the user belongs to RIGHT
 * NOW (`currentIds`, API order):
 *   - a server the user left / was removed from disappears (from its folder
 *     too — which may dissolve that folder);
 *   - an unknown id (garbage, a server from another era) is dropped silently;
 *   - a server not in the layout (newly joined, or first run) is appended at
 *     the END, top level, outside every folder, in `currentIds` order.
 * Runs on every render, so it must be cheap and never throw.
 */
export function reconcileRailLayout(layout: RailLayout, currentIds: readonly string[]): RailLayout {
    const current = new Set(currentIds);
    const kept: RailItem[] = [];
    for (const it of layout.items) {
        if (it.kind === 'server') {
            if (current.has(it.id)) kept.push(it);
        } else {
            const ids = it.folder.serverIds.filter(id => current.has(id));
            kept.push(ids.length === it.folder.serverIds.length ? it : { kind: 'folder', folder: { ...it.folder, serverIds: ids } });
        }
    }
    const normal = normalize({ items: kept });
    const placed = new Set(flattenServerIds(normal));
    const appended = currentIds.filter(id => !placed.has(id) && (placed.add(id), true));
    if (appended.length === 0) {
        return normal.items.length === layout.items.length && normal.items.every((it, i) => it === layout.items[i]) ? layout : normal;
    }
    return { items: [...normal.items, ...appended.map(id => ({ kind: 'server' as const, id }))] };
}

// ── Internal helpers ─────────────────────────────────────────────────────

/** Remove a server from wherever it lives (top level or a folder). Does NOT
 *  normalise — callers insert first, then normalise once, so a folder that
 *  briefly has one member during a move is not dissolved mid-operation in a
 *  way that shifts indices under the caller. */
function detachServer(items: RailItem[], serverId: string): RailItem[] {
    const out: RailItem[] = [];
    for (const it of items) {
        if (it.kind === 'server') {
            if (it.id !== serverId) out.push(it);
        } else if (it.folder.serverIds.includes(serverId)) {
            out.push({ kind: 'folder', folder: { ...it.folder, serverIds: it.folder.serverIds.filter(id => id !== serverId) } });
        } else {
            out.push(it);
        }
    }
    return out;
}

function keyIndex(items: RailItem[], key: string): number {
    return items.findIndex(it => railItemKey(it) === key);
}

function mapFolder(layout: RailLayout, folderId: string, fn: (f: RailFolder) => RailFolder): RailLayout {
    let hit = false;
    const items = layout.items.map(it => {
        if (it.kind !== 'folder' || it.folder.id !== folderId) return it;
        const next = fn(it.folder);
        if (next === it.folder) return it;
        hit = true;
        return { kind: 'folder' as const, folder: next };
    });
    return hit ? normalize({ items }) : layout;
}

// ── Operations ───────────────────────────────────────────────────────────

export type Side = 'before' | 'after';

/**
 * Move a top-level item (server or folder, by dnd key) next to another
 * top-level item. A server that currently sits inside a folder may also be
 * passed as `srv:<id>`: it is taken OUT of its folder and placed at the
 * target (this is "drag a server out of the popover onto the rail").
 */
export function moveToRailPosition(layout: RailLayout, activeKey: string, targetKey: string, side: Side): RailLayout {
    if (activeKey === targetKey) return layout;
    const a = parseKey(activeKey);
    if (!a || (a.kind !== 'server' && a.kind !== 'folder')) return layout;
    let items = layout.items;
    let moving: RailItem;
    if (a.kind === 'server') {
        const exists = flattenServerIds(layout).includes(a.id);
        if (!exists) return layout;
        moving = { kind: 'server', id: a.id };
        items = detachServer(items, a.id);
    } else {
        const at = keyIndex(items, activeKey);
        if (at < 0) return layout;
        moving = items[at];
        items = items.filter((_, i) => i !== at);
    }
    const t = keyIndex(items, targetKey);
    if (t < 0) return layout;
    const insertAt = side === 'before' ? t : t + 1;
    const next = [...items.slice(0, insertAt), moving, ...items.slice(insertAt)];
    const result = normalize({ items: next });
    return sameOrder(layout, result) ? layout : result;
}

/** Alt+ArrowUp/Down on a top-level tile: swap with the neighbouring item. */
export function moveRailItemBy(layout: RailLayout, key: string, delta: number): RailLayout {
    const from = keyIndex(layout.items, key);
    if (from < 0) return layout;
    const to = Math.max(0, Math.min(layout.items.length - 1, from + delta));
    if (to === from) return layout;
    const items = layout.items.slice();
    const [m] = items.splice(from, 1);
    items.splice(to, 0, m);
    return { items };
}

/**
 * The iPhone gesture: `draggedId` was held over `targetId` → a new folder in
 * TARGET's slot holding [target, dragged]. The dragged server leaves wherever
 * it was (possibly another folder, which may dissolve). No-op if either is
 * missing, they are the same, or the target is not a top-level server.
 */
export function createFolder(layout: RailLayout, targetId: string, draggedId: string, folderId: string, name = DEFAULT_FOLDER_NAME): RailLayout {
    if (targetId === draggedId) return layout;
    if (keyIndex(layout.items, serverKey(targetId)) < 0) return layout;
    if (!flattenServerIds(layout).includes(draggedId)) return layout;
    if (findFolder(layout, folderId)) return layout;
    const items = detachServer(layout.items, draggedId);
    const t = keyIndex(items, serverKey(targetId));
    if (t < 0) return layout;
    items[t] = { kind: 'folder', folder: { id: folderId, name: sanitizeFolderName(name), color: null, serverIds: [targetId, draggedId] } };
    return normalize({ items });
}

/**
 * Put `serverId` into folder `folderId` at `index` (default: the end). The
 * server leaves wherever it was. Moving a server to another slot WITHIN the
 * same folder is also this call.
 */
export function addServerToFolder(layout: RailLayout, folderId: string, serverId: string, index?: number): RailLayout {
    const target = findFolder(layout, folderId);
    if (!target || !flattenServerIds(layout).includes(serverId)) return layout;
    const before = target.serverIds;
    const fromIdx = before.indexOf(serverId);
    // Index is expressed against the folder AS THE CALLER SAW IT (with the
    // server still in place); removing it first shifts later slots by one.
    let at = index === undefined ? before.length : Math.max(0, Math.min(before.length, index));
    if (fromIdx >= 0 && fromIdx < at) at -= 1;
    const items = detachServer(layout.items, serverId).map(it => {
        if (it.kind !== 'folder' || it.folder.id !== folderId) return it;
        const ids = it.folder.serverIds.slice();
        ids.splice(Math.min(at, ids.length), 0, serverId);
        return { kind: 'folder' as const, folder: { ...it.folder, serverIds: ids } };
    });
    const result = normalize({ items });
    return sameOrder(layout, result) ? layout : result;
}

/** Reorder inside one folder: put `serverId` before/after `targetId`. */
export function reorderInFolder(layout: RailLayout, folderId: string, serverId: string, targetId: string, side: Side): RailLayout {
    const f = findFolder(layout, folderId);
    if (!f || serverId === targetId) return layout;
    const t = f.serverIds.indexOf(targetId);
    if (t < 0 || !f.serverIds.includes(serverId)) return layout;
    return addServerToFolder(layout, folderId, serverId, side === 'before' ? t : t + 1);
}

/**
 * Take a server out of its folder. Default placement: right AFTER the folder
 * (where the eye already is). If that leaves one server, the folder dissolves
 * in place — which is the "a folder left with one server becomes that
 * server" rule.
 */
export function removeFromFolder(layout: RailLayout, serverId: string): RailLayout {
    const f = folderOfServer(layout, serverId);
    if (!f) return layout;
    return moveToRailPosition(layout, serverKey(serverId), folderKey(f.id), 'after');
}

/** "Remove folder": its servers return to the rail, in order, where the
 *  folder was. Never drops a server. */
export function ungroupFolder(layout: RailLayout, folderId: string): RailLayout {
    const at = keyIndex(layout.items, folderKey(folderId));
    if (at < 0) return layout;
    const f = (layout.items[at] as { kind: 'folder'; folder: RailFolder }).folder;
    const items = [...layout.items.slice(0, at), ...f.serverIds.map(id => ({ kind: 'server' as const, id })), ...layout.items.slice(at + 1)];
    return normalize({ items });
}

export function renameFolder(layout: RailLayout, folderId: string, name: string): RailLayout {
    const clean = sanitizeFolderName(name);
    return mapFolder(layout, folderId, f => f.name === clean ? f : { ...f, name: clean });
}

export function setFolderColor(layout: RailLayout, folderId: string, color: FolderColor | null): RailLayout {
    const c = isFolderColor(color) ? color : null;
    return mapFolder(layout, folderId, f => f.color === c ? f : { ...f, color: c });
}

/** Explicitly forget a server (the user left it): removed from the layout
 *  and from its folder, so a later re-join lands at the end like any new
 *  server rather than resurrecting its old folder slot. */
export function forgetServer(layout: RailLayout, serverId: string): RailLayout {
    if (!flattenServerIds(layout).includes(serverId)) return layout;
    return normalize({ items: detachServer(layout.items, serverId) });
}

function sameOrder(a: RailLayout, b: RailLayout): boolean {
    if (a === b) return true;
    return serializeRailLayout(a) === serializeRailLayout(b);
}

// ── Drag-and-drop resolution ─────────────────────────────────────────────

/** Where in a tile the pointer is. The middle band is the "merge" zone; the
 *  outer quarters are unambiguous reorder zones. */
export type DropZone = 'before' | 'center' | 'after';

/** Fraction of the tile (each end) that always means "reorder". */
export const EDGE_FRACTION = 0.25;
/** How long the pointer must rest in the merge zone before a drop merges. */
export const MERGE_DWELL_MS = 450;

export function dropZoneFor(pointer: number, start: number, size: number): DropZone {
    if (size <= 0) return 'after';
    const rel = (pointer - start) / size;
    if (rel < EDGE_FRACTION) return 'before';
    if (rel > 1 - EDGE_FRACTION) return 'after';
    return 'center';
}

/** Reorder side for a drop that is NOT a merge — the half the pointer is in. */
export function sideFor(pointer: number, start: number, size: number): Side {
    return pointer < start + size / 2 ? 'before' : 'after';
}

export type RailDropAction =
    | { type: 'none' }
    | { type: 'move'; activeKey: string; targetKey: string; side: Side }
    | { type: 'createFolder'; targetId: string; draggedId: string }
    | { type: 'addToFolder'; folderId: string; serverId: string; index?: number }
    | { type: 'reorderInFolder'; folderId: string; serverId: string; targetId: string; side: Side };

/**
 * Can `activeKey` merge into `overKey` (i.e. should a dwell over the middle of
 * that tile arm the merge highlight)? Only a SERVER can be put in a folder —
 * folders never nest — and a server cannot merge into the folder it is
 * already in, or with itself.
 */
export function canMerge(layout: RailLayout, activeKey: string, overKey: string): boolean {
    const a = parseKey(activeKey);
    const o = parseKey(overKey);
    if (!a || !o) return false;
    if (a.kind !== 'server' && a.kind !== 'folderServer') return false;
    if (o.kind === 'server') return o.id !== a.id;
    if (o.kind === 'folder') {
        const f = findFolder(layout, o.id);
        return !!f && !f.serverIds.includes(a.id);
    }
    return false;
}

/**
 * Turn a finished drag into one layout operation. `merge` is true only when
 * the merge highlight was armed on `overKey` at drop time (dwell complete);
 * otherwise the drop is a reorder by `side`.
 */
export function resolveRailDrop(
    layout: RailLayout,
    activeKey: string,
    overKey: string | null,
    side: Side,
    merge: boolean,
): RailDropAction {
    if (!overKey || activeKey === overKey) return { type: 'none' };
    const a = parseKey(activeKey);
    const o = parseKey(overKey);
    if (!a || !o) return { type: 'none' };

    if (merge && canMerge(layout, activeKey, overKey)) {
        if (o.kind === 'server') return { type: 'createFolder', targetId: o.id, draggedId: a.id };
        if (o.kind === 'folder') return { type: 'addToFolder', folderId: o.id, serverId: a.id };
    }

    if (a.kind === 'folder') {
        // A folder only moves within the top level.
        if (o.kind === 'server' || o.kind === 'folder') return { type: 'move', activeKey, targetKey: overKey, side };
        return { type: 'none' };
    }

    // a is a server — top-level (srv) or from the open popover (fsrv).
    if (o.kind === 'server' || o.kind === 'folder') {
        // Same id under the other namespace (a popover tile dropped on… itself
        // can't happen, but a srv over its own folder can) — moving next to
        // its own folder is a legitimate "take it out" drop.
        return { type: 'move', activeKey: serverKey(a.id), targetKey: overKey, side };
    }
    if (o.kind === 'folderServer') {
        if (o.id === a.id) return { type: 'none' };
        const f = folderOfServer(layout, o.id);
        if (!f) return { type: 'none' };
        if (f.serverIds.includes(a.id)) return { type: 'reorderInFolder', folderId: f.id, serverId: a.id, targetId: o.id, side };
        const t = f.serverIds.indexOf(o.id);
        return { type: 'addToFolder', folderId: f.id, serverId: a.id, index: side === 'before' ? t : t + 1 };
    }
    // Popover background.
    const f = findFolder(layout, o.id);
    if (!f || f.serverIds.includes(a.id)) return { type: 'none' };
    return { type: 'addToFolder', folderId: f.id, serverId: a.id };
}

export function applyRailDrop(layout: RailLayout, action: RailDropAction, newFolderId: () => string): RailLayout {
    switch (action.type) {
        case 'none': return layout;
        case 'move': return moveToRailPosition(layout, action.activeKey, action.targetKey, action.side);
        case 'createFolder': return createFolder(layout, action.targetId, action.draggedId, newFolderId());
        case 'addToFolder': return addServerToFolder(layout, action.folderId, action.serverId, action.index);
        case 'reorderInFolder': return reorderInFolder(layout, action.folderId, action.serverId, action.targetId, action.side);
    }
}

// ── Badges ───────────────────────────────────────────────────────────────

/**
 * A collapsed folder's badge from its servers' already-resolved badges
 * (utils/unreadBadges.resolveBadge — mute and @mentions-only are applied per
 * server BEFORE this, so a muted server contributes only its mentions).
 * Any loud badge → a loud pill with the summed count; otherwise any quiet
 * badge → the quiet dot; otherwise nothing.
 */
export function aggregateFolderBadge(badges: readonly (BadgeState | null | undefined)[]): BadgeState | null {
    let alert = 0;
    let quiet = false;
    for (const b of badges) {
        if (!b || b.count <= 0) continue;
        if (b.tone === 'alert') alert += b.count;
        else quiet = true;
    }
    if (alert > 0) return { count: alert, tone: 'alert' };
    if (quiet) return { count: 1, tone: 'quiet' };
    return null;
}

/** Grid columns for the open-folder popover: 2 up to four servers, 3 up to
 *  nine, then 4 — a compact Android-style folder that never gets taller than
 *  it is wide for small folders. */
export function popoverColumns(n: number): number {
    if (n <= 1) return 1;
    if (n <= 4) return 2;
    if (n <= 9) return 3;
    return 4;
}

/** Arrow-key navigation in the popover grid (reading order, clamped). */
export function gridNeighbor(index: number, key: string, count: number, cols: number): number {
    if (count <= 0) return -1;
    switch (key) {
        case 'ArrowRight': return Math.min(count - 1, index + 1);
        case 'ArrowLeft': return Math.max(0, index - 1);
        case 'ArrowDown': return index + cols < count ? index + cols : index;
        case 'ArrowUp': return index - cols >= 0 ? index - cols : index;
        case 'Home': return 0;
        case 'End': return count - 1;
        default: return index;
    }
}

/**
 * Popover placement: to the right of the rail, vertically aligned with the
 * folder tile, clamped inside the viewport. `anchorTop` is the folder tile's
 * top already clamped to the visible part of the rail box.
 */
export function placePopover(
    anchor: { top: number; height: number; right: number },
    pop: { width: number; height: number },
    viewport: { width: number; height: number },
    margin = 8,
    gap = 12,
): { left: number; top: number; originY: number } {
    const left = Math.max(margin, Math.min(anchor.right + gap, viewport.width - pop.width - margin));
    const ideal = anchor.top - 10;
    const top = Math.max(margin, Math.min(ideal, viewport.height - pop.height - margin));
    // Scale origin: the folder tile's vertical centre, in popover coordinates,
    // so the open animation grows out of the tile.
    const originY = Math.max(0, Math.min(pop.height, anchor.top + anchor.height / 2 - top));
    return { left, top, originY };
}
