/**
 * SortableServerTile — dnd-kit wrapper for one server icon on the left rail.
 *
 * Same underlying primitives as ServerChannelList's channel/category reorder
 * (@dnd-kit/core + @dnd-kit/sortable, PointerSensor with an 8px activation
 * threshold so a plain click still works) — see Dashboard.tsx's DndContext
 * around the server rail for the sensor/onDragEnd wiring.
 *
 * One deliberate difference from ServerChannelList's wrappers: THIS component
 * does not spread dnd-kit's `attributes` (the ARIA role="button"/tabIndex
 * bundle) onto its wrapping div. ServerChannelList's rows are plain
 * `<div onClick>`s, so `attributes` supplies their only interactive
 * semantics. A server rail tile's child IS a real `<button>` already, so
 * adding a second, outer `role="button"` would nest an interactive element
 * inside another and create a redundant tab stop. Only `listeners` (the
 * pointer-drag activator) is spread here; the inner button keeps its own
 * focus/click/keyboard behaviour completely unchanged, which is what "don't
 * break existing keyboard nav" requires. Reorder-by-keyboard is a separate,
 * explicit Alt+ArrowUp/Down handler on that same button (see Dashboard.tsx),
 * matching the app's existing convention in cl/ClSelect.tsx rather than
 * dnd-kit's own KeyboardSensor.
 */

import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import '../../styles/server-folders.css';

const REDUCED_MOTION = typeof window !== 'undefined' && !!window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/** Thin drop-indicator line above/below a tile mid-drag — same visual
 *  language as ServerChannelList's DropIndicator, adapted to a narrow
 *  vertical rail (centered dash instead of a leading dot + full-width bar,
 *  which would look wrong at 44px wide). */
function RailDropIndicator({ position }: { position: 'top' | 'bottom' }) {
    const posClass = position === 'top' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2';
    return (
        <div aria-hidden className={`absolute ${posClass} left-0 right-0 z-30 pointer-events-none flex justify-center`}>
            <div className="h-0.5 w-8 rounded-full bg-cl-lume" />
        </div>
    );
}

interface Props {
    id: string;
    dropLine: 'top' | 'bottom' | null;
    isDragging: boolean;
    /** The dwell-armed "drop INTO this tile" state (create / add to a folder)
     *  — deliberately a different visual language from the gap line: the
     *  target lifts and gets a ring, instead of a line appearing between
     *  tiles. See useRailFolderDnd.ts. */
    merge?: boolean;
    children: React.ReactNode;
}

export const SortableServerTile: React.FC<Props> = ({ id, dropLine, isDragging, merge, children }) => {
    const { setNodeRef, listeners, transform, transition } = useSortable({ id });
    return (
        <div
            ref={setNodeRef}
            style={{
                transform: CSS.Transform.toString(transform),
                // Mid-drag reposition is a layout aid, not decoration — still,
                // reduced-motion means it jumps rather than eases.
                transition: REDUCED_MOTION ? undefined : transition,
            }}
            className="relative"
            data-rail-id={id}
            {...listeners}
        >
            {dropLine === 'top' && <RailDropIndicator position="top" />}
            {merge && <span aria-hidden className="cl-rail-merge" />}
            <div className="cl-rail-merge-lift" data-merge={merge ? 'true' : undefined} style={{ opacity: isDragging ? 0.4 : 1 }}>
                {children}
            </div>
            {dropLine === 'bottom' && <RailDropIndicator position="bottom" />}
        </div>
    );
};
