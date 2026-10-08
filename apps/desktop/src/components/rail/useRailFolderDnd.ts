/**
 * useRailFolderDnd — the drag-and-drop state machine for the server rail and
 * the open folder popover (both live in ONE DndContext, so a server can be
 * dragged between them).
 *
 * Gesture model (iPhone-style folders on a vertical rail):
 *   - The pointer's position INSIDE the hovered tile picks the intent. The top
 *     and bottom quarters always mean "reorder" (a lume gap line, as before);
 *     the middle half is the merge zone.
 *   - Resting in the merge zone for MERGE_DWELL_MS arms the merge: the line
 *     disappears and the target tile gets the distinct merge highlight (a
 *     raised, ringed "drop into" state). Dropping now creates a folder (server
 *     on server) or adds to a folder (server on folder).
 *   - Dropping in the merge zone BEFORE the dwell completes is a reorder by the
 *     half the pointer is in — so a quick drag-and-drop never surprises anyone
 *     with a folder, and the gap between tiles always reorders.
 *   - Tiles do NOT slide out of the way mid-drag (the sortable strategy is a
 *     no-op): a target that moved away under a resting pointer would make the
 *     dwell impossible. The gap line shows where a reorder lands instead.
 * Inside the popover tiles are a grid, so the side is the horizontal half and
 * there is no merge (folders don't nest).
 *
 * All decisions are made by the pure resolveRailDrop (serverFolders.ts); this
 * hook only tracks pointer/zone/dwell and hands the action to the layout hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    PointerSensor, closestCenter, pointerWithin, useSensor, useSensors,
    type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import type { SortingStrategy } from '@dnd-kit/sortable';
import {
    MERGE_DWELL_MS, canMerge, dropZoneFor, findFolder, parseKey, resolveRailDrop, sideFor,
    type DropZone, type RailDropAction, type RailLayout, type Side,
} from './serverFolders';

/** Tiles stay put while dragging — see the header. */
export const staticSortingStrategy: SortingStrategy = () => null;

/**
 * Pointer-first collision: the droppable actually under the pointer wins (so
 * the merge zone is "the tile under your finger", not "the nearest centre"),
 * a popover TILE beats the popover background it sits on, and the gaps
 * between tiles fall back to the closest centre so a drop there still lands.
 */
export const railCollisionDetection: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    if (hits.length) {
        const tile = hits.find(h => !String(h.id).startsWith('fpop:'));
        return [tile ?? hits[0]];
    }
    // Outside every droppable: only rail/popover TILES are candidates for the
    // nearest-centre fallback (never the popover background from afar).
    return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(c => !String(c.id).startsWith('fpop:')),
    });
};

export type RailDropLine = 'top' | 'bottom' | 'left' | 'right';

function tileRect(key: string): DOMRect | null {
    if (typeof document === 'undefined') return null;
    const el = document.querySelector<HTMLElement>(`[data-rail-id="${key}"]`);
    return el ? el.getBoundingClientRect() : null;
}

export interface RailFolderDndOptions {
    layout: RailLayout;
    applyDrop: (action: RailDropAction) => boolean;
    nameOfServer: (serverId: string) => string;
}

export function useRailFolderDnd({ layout, applyDrop, nameOfServer }: RailFolderDndOptions) {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const [overKey, setOverKey] = useState<string | null>(null);
    const [zone, setZone] = useState<DropZone>('after');
    const [side, setSide] = useState<Side>('after');
    const [mergeKey, setMergeKey] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');

    const startPointer = useRef<{ x: number; y: number } | null>(null);
    const dwell = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
    /** performance.now() of the last drag end — lets the popover's
     *  outside-click handler ignore the click a browser may synthesise at the
     *  end of a drag that started outside it. */
    const lastDragEndAt = useRef(0);
    const layoutRef = useRef(layout);
    useEffect(() => { layoutRef.current = layout; }, [layout]);
    // The drop reads these from refs, not the render closure: dnd-kit may
    // dispatch onDragEnd from a handler bound before the last state commit.
    const sideRef = useRef<Side>('after');
    const mergeRef = useRef<string | null>(null);
    const arm = useCallback((key: string | null) => { mergeRef.current = key; setMergeKey(key); }, []);

    const clearDwell = useCallback(() => {
        if (dwell.current) clearTimeout(dwell.current.timer);
        dwell.current = null;
    }, []);
    useEffect(() => clearDwell, [clearDwell]);

    const reset = useCallback(() => {
        clearDwell();
        setActiveKey(null);
        setOverKey(null);
        arm(null);
        startPointer.current = null;
        lastDragEndAt.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }, [clearDwell, arm]);

    /** Recompute zone/side/dwell for the current pointer and hovered tile. */
    const track = useCallback((active: string, over: string | null, delta: { x: number; y: number }) => {
        setOverKey(over);
        const sp = startPointer.current;
        if (!over || !sp || over === active) {
            clearDwell();
            arm(null);
            return;
        }
        const r = tileRect(over);
        if (!r) return;
        const px = sp.x + delta.x;
        const py = sp.y + delta.y;
        const inPopover = parseKey(over)?.kind === 'folderServer';
        const z = inPopover ? (px < r.left + r.width / 2 ? 'before' : 'after') : dropZoneFor(py, r.top, r.height);
        const s = inPopover ? sideFor(px, r.left, r.width) : sideFor(py, r.top, r.height);
        setZone(z);
        setSide(s);
        sideRef.current = s;
        const mergeable = z === 'center' && canMerge(layoutRef.current, active, over);
        if (!mergeable) {
            clearDwell();
            arm(null);
            return;
        }
        if (dwell.current?.key === over) return; // already counting / armed
        clearDwell();
        arm(null);
        dwell.current = {
            key: over,
            timer: setTimeout(() => { arm(over); }, MERGE_DWELL_MS),
        };
    }, [clearDwell, arm]);

    const onDragStart = useCallback(({ active, activatorEvent }: DragStartEvent) => {
        const e = activatorEvent as PointerEvent | MouseEvent | null;
        startPointer.current = e && 'clientX' in e ? { x: e.clientX, y: e.clientY } : null;
        setActiveKey(String(active.id));
        setOverKey(null);
        arm(null);
    }, [arm]);

    const onDragMove = useCallback(({ active, over, delta }: DragMoveEvent) => {
        track(String(active.id), over ? String(over.id) : null, delta);
    }, [track]);

    const onDragOver = useCallback(({ active, over, delta }: DragOverEvent) => {
        track(String(active.id), over ? String(over.id) : null, delta);
    }, [track]);

    const onDragEnd = useCallback(({ active, over }: DragEndEvent) => {
        const a = String(active.id);
        const o = over ? String(over.id) : null;
        const merging = !!o && mergeRef.current === o;
        const action = resolveRailDrop(layoutRef.current, a, o, sideRef.current, merging);
        reset();
        if (action.type === 'none') return;
        const changed = applyDrop(action);
        if (!changed) return;
        setAnnouncement(describeDrop(layoutRef.current, action, nameOfServer));
    }, [reset, applyDrop, nameOfServer]);

    const onDragCancel = useCallback(() => reset(), [reset]);

    /** Gap line for a tile, or null. Never shown on the armed merge target. */
    const dropLineFor = useCallback((key: string): RailDropLine | null => {
        if (!activeKey || overKey !== key || activeKey === key || mergeKey === key) return null;
        const inPopover = parseKey(key)?.kind === 'folderServer';
        if (inPopover) {
            // Only a SERVER can land in the popover.
            const a = parseKey(activeKey);
            if (!a || a.kind === 'folder') return null;
            return side === 'before' ? 'left' : 'right';
        }
        return side === 'before' ? 'top' : 'bottom';
    }, [activeKey, overKey, mergeKey, side]);

    const dndProps = useMemo(() => ({
        sensors,
        collisionDetection: railCollisionDetection,
        onDragStart, onDragMove, onDragOver, onDragEnd, onDragCancel,
    }), [sensors, onDragStart, onDragMove, onDragOver, onDragEnd, onDragCancel]);

    return {
        dndProps,
        activeKey,
        overKey,
        zone,
        mergeKey,
        dropLineFor,
        announcement,
        setAnnouncement,
        lastDragEndAt,
        isDragging: activeKey !== null,
    };
}

export function describeDrop(layout: RailLayout, action: RailDropAction, nameOf: (id: string) => string): string {
    switch (action.type) {
        case 'createFolder':
            return `Created a folder with ${nameOf(action.targetId)} and ${nameOf(action.draggedId)}.`;
        case 'addToFolder': {
            const f = findFolder(layout, action.folderId);
            return `Added ${nameOf(action.serverId)} to folder ${f?.name ?? ''}.`.replace(' .', '.');
        }
        case 'reorderInFolder':
            return `Moved ${nameOf(action.serverId)} within the folder.`;
        case 'move': {
            const a = parseKey(action.activeKey);
            if (!a) return '';
            if (a.kind === 'folder') return `Moved folder ${findFolder(layout, a.id)?.name ?? ''}.`;
            return `Moved ${nameOf(a.id)}.`;
        }
        default:
            return '';
    }
}
