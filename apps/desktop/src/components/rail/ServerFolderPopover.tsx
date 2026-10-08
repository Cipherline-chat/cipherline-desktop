/**
 * ServerFolderPopover — the open state of a rail folder: a small floating
 * window to the RIGHT of the rail (Android-folder style), never an expansion
 * of the rail itself.
 *
 *   - Header: the folder name; click it (or press F2 anywhere in the
 *     popover) to rename inline — Enter/blur saves, Esc cancels.
 *   - Body: a grid of the folder's servers (icon + name), each with its own
 *     unread/mention badge and live-call speaker, the active one ringed.
 *     Click/Enter opens a server (the caller closes the popover).
 *   - Drag: tiles are sortable within the grid; dragging one OUT onto the rail
 *     takes it out of the folder; a rail server dropped on a tile or on the
 *     popover's empty space joins the folder. All in the rail's DndContext —
 *     this component only registers draggables/droppables.
 *   - Keyboard: focus moves in on open (the active server, else the first),
 *     Tab is trapped inside, arrows move between servers in reading order,
 *     Home/End jump, Esc closes and returns focus to the folder tile.
 *   - Closes on outside click / Esc / opening a server (caller).
 *
 * Position: anchored to the folder tile, clamped to the viewport, and it
 * FOLLOWS the rail's scroll rather than closing on it. Closing on scroll
 * would be the simpler rule, but dnd-kit auto-scrolls the rail while a server
 * is being dragged out of this popover toward a far end of the list — closing
 * then would unmount the drag source mid-drag and drop the gesture on the
 * floor. Following costs one rect read per scroll frame. When the folder tile
 * scrolls out of the visible box the anchor is clamped to the box's edge, so
 * the popover stays attached to the rail instead of sliding off-screen.
 *
 * Animation (rail/folderMotion.ts): grows out of the folder tile
 * (transform-origin = the tile's centre) with a fade and a slight overshoot,
 * icons staggering in; closes back into the tile, quicker. Fade only under
 * prefers-reduced-motion.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable } from '@dnd-kit/sortable';
import { Volume2 } from 'lucide-react';
import { RailBadge } from '../RailBadge';
import type { BadgeState } from '../../utils/unreadBadges';
import {
    FOLDER_COLOR_VAR, MAX_FOLDER_NAME, folderKey, folderPopoverKey, folderServerKey, gridNeighbor,
    placePopover, popoverColumns, type RailFolder,
} from './serverFolders';
import { staticSortingStrategy, type RailDropLine } from './useRailFolderDnd';
import { iconMotion, popoverMotion } from './folderMotion';
import { useEscape } from '../../hooks/useEscape';
import '../../styles/server-folders.css';

export interface PopoverServer { id: string; name: string }

interface Props {
    folder: RailFolder;
    /** The folder's servers that exist right now, in folder order. */
    servers: PopoverServer[];
    renderIcon: (serverId: string) => React.ReactNode;
    getBadge: (serverId: string) => BadgeState | null;
    getCallCount: (serverId: string) => number;
    activeServerId: string | null;
    /** Open straight into rename mode (context menu → Rename). */
    initialRename?: boolean;
    onOpenServer: (serverId: string) => void;
    onRename: (name: string) => void;
    onClose: (opts: { restoreFocus: boolean }) => void;
    onServerContextMenu: (e: React.MouseEvent, serverId: string) => void;
    dropLineFor: (key: string) => RailDropLine | null;
    /** dnd key being dragged, if any. */
    dragActiveKey: string | null;
    /** dnd key currently under the pointer, if any. */
    dragOverKey: string | null;
    lastDragEndAt: React.MutableRefObject<number>;
}

/** The folder's rail tile, and the rail's scrolling box it lives in (found
 *  from the tile, so the popover needs no extra wiring to follow its scroll). */
function railAnchor(folderId: string): { tile: HTMLElement | null; box: HTMLElement | null } {
    const tile = document.querySelector<HTMLElement>(`[data-rail-id="${folderKey(folderId)}"]`);
    return { tile, box: tile?.closest<HTMLElement>('.cl-rail-track--scroll') ?? null };
}

const POP_GAP = 12;

const PopoverTile: React.FC<{
    server: PopoverServer;
    index: number;
    active: boolean;
    badge: BadgeState | null;
    callCount: number;
    dropLine: RailDropLine | null;
    dragging: boolean;
    /** Roving tabindex: exactly one grid tile is in the Tab order. */
    tabbable: boolean;
    icon: React.ReactNode;
    btnRef: (el: HTMLButtonElement | null) => void;
    onOpen: () => void;
    onKeyDown: (e: React.KeyboardEvent, index: number) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    reduced: boolean;
}> = ({ server, index, active, badge, callCount, dropLine, dragging, tabbable, icon, btnRef, onOpen, onKeyDown, onContextMenu, reduced }) => {
    const key = folderServerKey(server.id);
    const { setNodeRef, listeners } = useSortable({ id: key });
    const parts = [server.name];
    if (active) parts.push('current server');
    if (badge && badge.tone === 'alert') parts.push(`${badge.count} unread`);
    else if (badge) parts.push('unread');
    if (callCount > 0) parts.push(`${callCount} in call`);
    return (
        <div ref={setNodeRef} className="cl-folder-pop-cell" data-rail-id={key} role="listitem" style={{ opacity: dragging ? 0.4 : 1 }} {...listeners}>
            {dropLine === 'left' && <span aria-hidden className="cl-folder-pop-drop" data-side="left" />}
            <motion.button
                {...iconMotion(reduced, index)}
                ref={btnRef}
                type="button"
                className="cl-folder-pop-btn no-drag"
                data-active={active ? 'true' : undefined}
                aria-label={parts.join(', ')}
                aria-current={active ? 'page' : undefined}
                title={server.name}
                tabIndex={tabbable ? 0 : -1}
                data-pop-stop={tabbable ? 'true' : undefined}
                onClick={onOpen}
                onKeyDown={(e) => onKeyDown(e, index)}
                onContextMenu={onContextMenu}
            >
                <span className="cl-folder-pop-icon">
                    {icon}
                    {!active && <RailBadge badge={badge} className="z-10 pointer-events-none" />}
                    {callCount > 0 && (
                        <span
                            aria-hidden
                            className="absolute -bottom-1 -right-1 z-10 pointer-events-none flex items-center justify-center rounded-full bg-cl-lume text-cl-on-lume ring-2 ring-cl-deep"
                            style={{ width: 16, height: 16 }}
                        >
                            <Volume2 size={9} strokeWidth={2.75} aria-hidden />
                        </span>
                    )}
                </span>
                <span className="cl-folder-pop-label">{server.name}</span>
            </motion.button>
            {dropLine === 'right' && <span aria-hidden className="cl-folder-pop-drop" data-side="right" />}
        </div>
    );
};

export const ServerFolderPopover: React.FC<Props> = ({
    folder, servers, renderIcon, getBadge, getCallCount, activeServerId, initialRename,
    onOpenServer, onRename, onClose, onServerContextMenu, dropLineFor, dragActiveKey, dragOverKey,
    lastDragEndAt,
}) => {
    const reduced = useReducedMotion();
    const panelRef = useRef<HTMLDivElement | null>(null);
    const { setNodeRef: setDropRef } = useDroppable({ id: folderPopoverKey(folder.id) });
    const setPanel = useCallback((el: HTMLDivElement | null) => { panelRef.current = el; setDropRef(el); }, [setDropRef]);
    const btns = useRef<(HTMLButtonElement | null)[]>([]);
    const nameBtn = useRef<HTMLButtonElement | null>(null);
    const [renaming, setRenaming] = useState(!!initialRename);
    const [draft, setDraft] = useState(folder.name);
    const [pos, setPos] = useState<{ left: number; top: number; originX: number; originY: number } | null>(null);
    /** Roving tabindex: the one grid button that is tabbable. */
    const [focusIdx, setFocusIdx] = useState(() => Math.max(0, servers.findIndex(s => s.id === activeServerId)));
    const cols = popoverColumns(servers.length);

    // ── Placement ──────────────────────────────────────────────────────
    const place = useCallback(() => {
        const panel = panelRef.current;
        const { tile, box: scroller } = railAnchor(folder.id);
        if (!panel || !tile) return;
        const t = tile.getBoundingClientRect();
        const box = scroller?.getBoundingClientRect();
        const rail = tile.closest('.app-rail')?.getBoundingClientRect();
        // Keep the anchor on the VISIBLE part of the rail box.
        const top = box ? Math.max(box.top, Math.min(t.top, box.bottom - t.height)) : t.top;
        const placed = placePopover(
            { top, height: t.height, right: rail ? rail.right : t.right },
            { width: panel.offsetWidth, height: panel.offsetHeight },
            { width: window.innerWidth, height: window.innerHeight },
            8, POP_GAP,
        );
        // Grow out of the tile's centre (to the left of the popover).
        const next = { ...placed, originX: Math.round(t.left + t.width / 2 - placed.left) };
        setPos(prev => (prev && prev.left === next.left && prev.top === next.top && prev.originX === next.originX && prev.originY === next.originY) ? prev : next);
    }, [folder.id]);

    useLayoutEffect(() => { place(); }, [place, servers.length, renaming]);

    useEffect(() => {
        let raf = 0;
        const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };
        const box = railAnchor(folder.id).box;
        box?.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        const ro = typeof ResizeObserver !== 'undefined' && panelRef.current ? new ResizeObserver(schedule) : null;
        if (ro && panelRef.current) ro.observe(panelRef.current);
        return () => {
            box?.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            ro?.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [place, folder.id]);

    // ── Focus in on open ───────────────────────────────────────────────
    // Once, as soon as the popover has been PLACED: before that it is
    // visibility:hidden (unmeasured), and focus() on a hidden element is a
    // silent no-op — which is exactly how keyboard focus used to stay behind
    // on the folder tile. Not re-run on badge ticks (would yank focus around).
    const focusedRef = useRef(false);
    const placed = !!pos;
    useEffect(() => {
        if (!placed || focusedRef.current) return;
        focusedRef.current = true;
        if (renaming) {
            const input = panelRef.current?.querySelector<HTMLInputElement>('.cl-folder-pop-input');
            input?.focus({ preventScroll: true });
            input?.select();
            return;
        }
        const i = Math.max(0, servers.findIndex(s => s.id === activeServerId));
        btns.current[i]?.focus({ preventScroll: true });
    }, [placed, renaming, servers, activeServerId]);

    // Clamp the roving index when servers leave.
    const safeFocusIdx = Math.min(focusIdx, Math.max(0, servers.length - 1));

    /** Close; when focus was inside, hand it back to the folder tile (the
     *  popover is the only party that knows focus is about to vanish). */
    const close = useCallback((restoreFocus: boolean) => {
        onClose({ restoreFocus });
        if (!restoreFocus) return;
        const id = folder.id;
        requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(`[data-rail-id="${folderKey(id)}"] button`)?.focus();
        });
    }, [onClose, folder.id]);

    // ── Outside click / Esc ────────────────────────────────────────────
    // `click`, not mousedown: a press on the rail may be the start of a drag
    // INTO this popover, which must not close it. A click that is really the
    // tail of a drag (the browser can synthesise one on the common ancestor)
    // is ignored via lastDragEndAt. The folder's own tile is excluded — it
    // toggles the popover itself.
    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (panelRef.current?.contains(target)) return;
            const tile = document.querySelector(`[data-rail-id="${folderKey(folder.id)}"]`);
            if (tile?.contains(target)) return;
            if (performance.now() - lastDragEndAt.current < 300) return;
            close(false);
        };
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, [folder.id, lastDragEndAt, close]);

    // Esc goes through the app's shared escape stack (hooks/useEscape): the
    // popover is one layer, an in-progress rename is a layer ABOVE it, so the
    // first Esc cancels the rename and only the next one closes the popover —
    // and a dialog opened on top of either still takes Esc first.
    const cancelRenameRef = useRef(false);
    useEscape(() => close(!!panelRef.current?.contains(document.activeElement)), true);
    useEscape(() => {
        cancelRenameRef.current = true;
        setDraft(folder.name);
        setRenaming(false);
        requestAnimationFrame(() => nameBtn.current?.focus());
    }, renaming);

    // ── Keyboard ───────────────────────────────────────────────────────
    const focusTile = (i: number) => {
        if (i < 0) return;
        setFocusIdx(i);
        btns.current[i]?.focus();
    };
    const onTileKeyDown = (e: React.KeyboardEvent, index: number) => {
        if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            focusTile(gridNeighbor(index, e.key, servers.length, cols));
        }
    };
    const onPanelKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'F2' && !renaming) {
            e.preventDefault();
            cancelRenameRef.current = false;
            setDraft(folder.name);
            setRenaming(true);
            return;
        }
        if (e.key === 'Tab') {
            // Focus trap: the name control and the (single, roving) grid stop.
            const stops = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-pop-stop="true"]') ?? [])
                .filter(el => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
            if (stops.length === 0) return;
            const i = stops.indexOf(document.activeElement as HTMLElement);
            const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : (i === -1 || i === stops.length - 1 ? 0 : i + 1);
            e.preventDefault();
            stops[next].focus();
        }
    };

    const commitRename = () => {
        // The blur that follows an Esc-cancel (the input unmounts) must not
        // save the abandoned draft.
        if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }
        setRenaming(false);
        if (draft.trim() && draft !== folder.name) onRename(draft);
        requestAnimationFrame(() => nameBtn.current?.focus());
    };

    const accent = folder.color ? FOLDER_COLOR_VAR[folder.color] : undefined;
    const dropTarget = !!dragActiveKey && dragOverKey === folderPopoverKey(folder.id);
    const keys = servers.map(s => folderServerKey(s.id));

    const body = (
        <motion.div
            ref={setPanel}
            className="cl-folder-pop cl-kit"
            role="dialog"
            aria-modal="true"
            aria-label={`${folder.name} folder`}
            data-color={folder.color ?? undefined}
            data-drop-target={dropTarget ? 'true' : undefined}
            data-testid="folder-popover"
            onKeyDown={onPanelKeyDown}
            onFocus={(e) => {
                // Keep the roving index on whatever tile took focus (mouse or keys).
                const i = btns.current.findIndex(b => b !== null && b === (e.target as Node));
                if (i >= 0 && i !== focusIdx) setFocusIdx(i);
            }}
            {...popoverMotion(!!reduced)}
            style={{
                left: pos?.left ?? -9999,
                top: pos?.top ?? 0,
                visibility: pos ? 'visible' : 'hidden',
                transformOrigin: `${pos?.originX ?? -POP_GAP}px ${pos?.originY ?? 22}px`,
                ['--cl-folder-accent' as string]: accent,
            }}
        >
            <div className="cl-folder-pop-head">
                <span className="cl-folder-pop-swatch" aria-hidden />
                {renaming ? (
                    <input
                        className="cl-folder-pop-input"
                        aria-label="Folder name"
                        autoFocus
                        maxLength={MAX_FOLDER_NAME}
                        value={draft}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                            else if (e.key === 'Tab') {
                                commitRename();
                            }
                        }}
                        data-pop-stop="true"
                    />
                ) : (
                    <button
                        ref={nameBtn}
                        type="button"
                        className="cl-folder-pop-name"
                        title="Rename folder (F2)"
                        aria-label={`${folder.name}, rename folder`}
                        aria-keyshortcuts="F2"
                        data-pop-stop="true"
                        onClick={() => { cancelRenameRef.current = false; setDraft(folder.name); setRenaming(true); }}
                    >
                        {folder.name}
                    </button>
                )}
                <span className="cl-folder-pop-count" aria-hidden>{servers.length}</span>
            </div>
            <SortableContext items={keys} strategy={staticSortingStrategy}>
                <div
                    className="cl-folder-pop-grid"
                    role="list"
                    aria-label={`Servers in ${folder.name}`}
                    style={{ gridTemplateColumns: `repeat(${cols}, 72px)`, maxHeight: 'calc(100vh - 120px)' }}
                >
                    {servers.map((s, i) => (
                        <PopoverTile
                            key={s.id}
                            server={s}
                            index={i}
                            active={s.id === activeServerId}
                            badge={getBadge(s.id)}
                            callCount={getCallCount(s.id)}
                            dropLine={dropLineFor(folderServerKey(s.id))}
                            dragging={dragActiveKey === folderServerKey(s.id)}
                            icon={renderIcon(s.id)}
                            tabbable={i === safeFocusIdx}
                            btnRef={(el) => { btns.current[i] = el; }}
                            onOpen={() => onOpenServer(s.id)}
                            onKeyDown={onTileKeyDown}
                            onContextMenu={(e) => onServerContextMenu(e, s.id)}
                            reduced={!!reduced}
                        />
                    ))}
                </div>
            </SortableContext>
            {dragActiveKey && !dragActiveKey.startsWith('fsrv:') && !dragActiveKey.startsWith('fld:') && (
                <div className="cl-folder-pop-hint" aria-hidden>Drop here to add to {folder.name}</div>
            )}
        </motion.div>
    );
    return createPortal(body, document.body);
};
