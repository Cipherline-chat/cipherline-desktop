/**
 * HomePinsGrid — the Home deck's Pinned card grid, with drag-to-reorder and a
 * keyboard equivalent.
 *
 * Same primitives and feel as the server rail (rail/useRailFolderDnd.ts +
 * SortableServerTile.tsx): @dnd-kit PointerSensor with the rail's 8px
 * activation distance (so a plain click still opens the pin — dnd-kit also
 * swallows the click that ends a real drag), a lifted ghost under the pointer
 * (DragOverlay) and Esc to cancel (built into the PointerSensor).
 *
 * One deliberate difference from the rail: pins SLIDE out of the way while you
 * drag (rectSortingStrategy), where rail tiles stay put. The rail keeps tiles
 * still because resting on a tile arms a folder merge, which a moving target
 * would make impossible; pins have no merge, so a live preview of the final
 * order is strictly more informative. The dragged pin's own slot travels with
 * that preview as a lume-dashed gap (the rail's gap line is lume too), so
 * "where it lands" is always the visible hole. rectSortingStrategy is what
 * makes this correct for a WRAPPING grid: it moves items between rows, not
 * just along one axis.
 *
 * Keyboard: Alt+Arrow (or Ctrl+Arrow) on a focused pin moves it one place
 * left/right in reading order, or one row up/down — the rail and ClSelect's
 * role reorder use Alt+Arrow too. Every move is announced through a polite
 * live region ("Moved X to position 3 of 6."); pointer drags announce through
 * dnd-kit's own live region with the same wording.
 *
 * Reduced motion: no slide, no lift, no drop glide — the order just changes.
 *
 * Order = array order: onMove hands (key, final index, visible order) to the
 * owner, which applies utils/homePins' moveVisiblePin through the existing
 * pins setter, so backups and cross-device restore carry the order for free.
 */

import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    DndContext, DragOverlay, PointerSensor, closestCenter, defaultDropAnimationSideEffects,
    useSensor, useSensors,
    type Announcements, type DragEndEvent, type DragStartEvent, type DropAnimation,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import {
    countGridColumns, describePinMove, gridMoveTarget, pinKey, pinReorderDirection,
    type PinnedHomeItem,
} from '../utils/homePins';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';

/** Same activation distance as the server rail's PointerSensor. */
const DRAG_ACTIVATION_PX = 8;
const SLIDE_MS = 220;
const SLIDE_EASE = 'cubic-bezier(.2, .8, .2, 1)';
/** The card's own resting transitions (home-deck.css .hd-card). An inline
 *  `transition` replaces the stylesheet's, so the slide is appended to these
 *  rather than wiping hover/border easing while a reorder is in flight. */
const CARD_TRANSITIONS = 'border-color .16s, background .16s';

const DROP_ANIMATION: DropAnimation = {
    duration: 170,
    easing: SLIDE_EASE,
    sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
};

type Listeners = ReturnType<typeof useSortable>['listeners'];

/** What a pin card needs to take part in the reorder. */
export interface PinDnd {
    pinKey: string;
    setNodeRef?: (el: HTMLElement | null) => void;
    style?: React.CSSProperties;
    listeners?: Listeners;
    /** 'source' = the dragged pin's own slot (the moving gap);
     *  'overlay' = the lifted ghost under the pointer. */
    state?: 'source' | 'overlay';
    /** Returns true when it handled the key (a reorder chord). */
    onReorderKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => boolean;
    /** id of the visually hidden "how to reorder" hint. */
    describedBy?: string;
}

interface SortablePinProps {
    id: string;
    reduced: boolean;
    disabled: boolean;
    children: (dnd: Omit<PinDnd, 'onReorderKeyDown' | 'describedBy'>) => React.ReactNode;
}

const SortablePin: React.FC<SortablePinProps> = ({ id, reduced, disabled, children }) => {
    const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
        id,
        disabled,
        transition: reduced ? null : { duration: SLIDE_MS, easing: SLIDE_EASE },
    });
    const style: React.CSSProperties = {};
    // The offset rides the independent `translate` property, NOT `transform`:
    // `.hd-cards > *` carries the deck's entry animation (hd-row-in, fill
    // `both`), and an animation's filled `transform` outranks any inline
    // transform — the cards would simply never move.
    if (transform) style.translate = `${Math.round(transform.x)}px ${Math.round(transform.y)}px`;
    if (transition && !reduced) style.transition = `${transition.replace(/\btransform\b/g, 'translate')}, ${CARD_TRANSITIONS}`;
    return <>{children({ pinKey: id, setNodeRef, listeners, style, state: isDragging ? 'source' : undefined })}</>;
};

export interface HomePinsGridProps<P extends { item: PinnedHomeItem }> {
    /** Resolved pins, in display order. */
    pins: P[];
    nameOf: (pin: P) => string;
    renderPin: (pin: P, dnd: PinDnd) => React.ReactNode;
    /** Absent = reordering off (the grid renders exactly as before). */
    onMove?: (key: string, toIndex: number, visibleKeys: string[]) => void;
    /** Rendered after the pins, inside the grid (the "Pin something" card). */
    children?: React.ReactNode;
}

export function HomePinsGrid<P extends { item: PinnedHomeItem }>({
    pins, nameOf, renderPin, onMove, children,
}: HomePinsGridProps<P>) {
    const reduced = usePrefersReducedMotion();
    const hintId = useId();
    const gridRef = useRef<HTMLDivElement>(null);
    const keys = useMemo(() => pins.map(p => pinKey(p.item)), [pins]);
    const byKey = useMemo(() => new Map(pins.map(p => [pinKey(p.item), p] as const)), [pins]);
    const name = useCallback((k: string | number) => {
        const p = byKey.get(String(k));
        return p ? nameOf(p) : 'pin';
    }, [byKey, nameOf]);

    const [activeKey, setActiveKey] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');
    /** Sticky once the user first reorders: turns off the deck's one-shot
     *  entry animation for these cards. A reorder MOVES DOM nodes, and Chrome
     *  restarts a CSS animation on a re-inserted node — the moved card would
     *  vanish and fade back up (hd-row-in has a backwards-filled delay). By the
     *  time anyone reorders the animation has long finished, so dropping it
     *  changes nothing visible (its end frame is the resting style). */
    const [settled, setSettled] = useState(false);
    /** Pin to re-focus after a keyboard move commits (React's reorder can
     *  detach the focused node, which drops focus to <body>). */
    const refocusKey = useRef<string | null>(null);

    const enabled = !!onMove && pins.length > 1;
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_PX } }));

    useLayoutEffect(() => {
        const k = refocusKey.current;
        if (!k) return;
        refocusKey.current = null;
        const el = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-pin-key]') ?? [])
            .find(n => n.dataset.pinKey === k);
        if (el && document.activeElement !== el) el.focus();
    }, [pins]);

    const columnsNow = useCallback(() => {
        const els = gridRef.current?.querySelectorAll<HTMLElement>('[data-pin-key]');
        return els ? countGridColumns(Array.from(els, el => el.offsetTop)) : 1;
    }, []);

    const keyHandlerFor = useCallback((k: string) => (e: React.KeyboardEvent<HTMLElement>): boolean => {
        if (!enabled || e.target !== e.currentTarget) return false;
        const dir = pinReorderDirection(e);
        if (!dir) return false;
        e.preventDefault();
        const from = keys.indexOf(k);
        const to = gridMoveTarget(from, keys.length, columnsNow(), dir);
        if (to === null) {
            setAnnouncement(`${name(k)} can't move ${dir === 'left' || dir === 'up' ? 'back' : 'forward'} any further. Position ${from + 1} of ${keys.length}.`);
            return true;
        }
        setSettled(true);
        refocusKey.current = k;
        onMove?.(k, to, keys);
        setAnnouncement(describePinMove(name(k), to, keys.length));
        return true;
    }, [enabled, keys, columnsNow, name, onMove]);

    const onDragStart = useCallback(({ active }: DragStartEvent) => {
        setSettled(true);
        setActiveKey(String(active.id));
    }, []);
    const onDragEnd = useCallback(({ active, over }: DragEndEvent) => {
        setActiveKey(null);
        if (!over || over.id === active.id) return;
        const to = keys.indexOf(String(over.id));
        if (to < 0) return;
        onMove?.(String(active.id), to, keys);
    }, [keys, onMove]);
    const onDragCancel = useCallback(() => setActiveKey(null), []);

    const announcements: Announcements = useMemo(() => {
        const pos = (k: string | number) => keys.indexOf(String(k)) + 1;
        return {
            onDragStart: ({ active }) => `Picked up ${name(active.id)}, position ${pos(active.id)} of ${keys.length}.`,
            onDragOver: ({ active, over }) => over
                ? `${name(active.id)} is over position ${pos(over.id)} of ${keys.length}.`
                : `${name(active.id)} is not over a position.`,
            onDragEnd: ({ active, over }) => over && over.id !== active.id
                ? describePinMove(name(active.id), pos(over.id) - 1, keys.length)
                : `${name(active.id)} dropped back at position ${pos(active.id)} of ${keys.length}.`,
            onDragCancel: ({ active }) => `Move cancelled. ${name(active.id)} stays at position ${pos(active.id)} of ${keys.length}.`,
        };
    }, [keys, name]);

    const activePin = activeKey ? byKey.get(activeKey) ?? null : null;

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
            accessibility={{ announcements, screenReaderInstructions: { draggable: '' } }}
        >
            <SortableContext items={keys} strategy={rectSortingStrategy} disabled={!enabled}>
                <div
                    ref={gridRef}
                    className="hd-cards"
                    data-sorting={activeKey ? 'true' : undefined}
                    data-settled={settled ? 'true' : undefined}
                    data-reduced-motion={reduced ? 'true' : undefined}
                >
                    {pins.map(p => {
                        const k = pinKey(p.item);
                        return (
                            <SortablePin key={k} id={k} reduced={reduced} disabled={!enabled}>
                                {dnd => renderPin(p, {
                                    ...dnd,
                                    onReorderKeyDown: enabled ? keyHandlerFor(k) : undefined,
                                    describedBy: enabled ? hintId : undefined,
                                })}
                            </SortablePin>
                        );
                    })}
                    {children}
                </div>
            </SortableContext>
            {enabled && (
                <span id={hintId} className="sr-only">
                    Drag to reorder, or press Alt plus an arrow key to move this pin.
                </span>
            )}
            <span aria-live="polite" className="sr-only">{announcement}</span>
            {/* Portaled: .hd-host is a size container, which makes it the
                containing block for position:fixed descendants — the ghost
                would be offset by the deck's own position. */}
            {typeof document !== 'undefined' && createPortal(
                <DragOverlay dropAnimation={reduced ? null : DROP_ANIMATION} zIndex={60}>
                    {activePin && (
                        <div className="hd-pinlift" data-reduced-motion={reduced ? 'true' : undefined}>
                            {renderPin(activePin, { pinKey: pinKey(activePin.item), state: 'overlay' })}
                        </div>
                    )}
                </DragOverlay>,
                document.body,
            )}
        </DndContext>
    );
}
