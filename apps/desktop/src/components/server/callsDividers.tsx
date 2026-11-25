/**
 * Dividers in the right-hand Calls panel (ServerContextPanel).
 *
 * The Calls list is its own list (`list_kind: 'calls'`): the same decorative
 * dividers as the channel list (same component, styles, hit area and rules),
 * placed among Calls channels and Calls categories. No sub-categories here.
 *
 * The pure drop planning lives in ./callsLayout.ts.
 */

import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { callsDividerKey } from './callsLayout';

/** A Calls divider row that can be dragged among Calls channels. */
export function SortableCallsDivider({ id, disabled, isDragging, dropLine, children }: {
    id: string;
    disabled: boolean;
    isDragging: boolean;
    dropLine: React.ReactNode;
    children: React.ReactNode;
}) {
    const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: callsDividerKey(id), disabled });
    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            className="relative"
            data-calls-divider-id={id}
            {...(disabled ? {} : { ...attributes, ...listeners })}
        >
            {dropLine}
            <div style={{ opacity: isDragging ? 0.35 : 1 }} className={disabled ? '' : 'touch-none select-none'}>
                {children}
            </div>
        </div>
    );
}

/** dnd-kit id of the end-of-Calls-list drop zone (the top of the Calls list: under no category). */
export const CALLS_TOP_END_ID = 'calls-top-end';

/**
 * Drop target for "the end of the Calls list's top level" - how a divider is
 * dragged out of a Calls category to sit under none (the text list's
 * UncategorizedDropzone does the same). Always mounted, so a Calls list whose
 * top level is empty still has somewhere to drop; only opens up (and only for a
 * divider drag, `dragActive`) while a drag is in progress. Calls channels never
 * live at the top (they need a category), so a channel drag leaves it closed.
 */
export function CallsTopDropzone({ dragActive, overHere }: { dragActive: boolean; overHere: boolean }) {
    const { setNodeRef, isOver } = useDroppable({ id: CALLS_TOP_END_ID, disabled: !dragActive });
    const over = isOver || overHere;
    return (
        <div
            ref={setNodeRef}
            data-calls-top-drop={dragActive && over ? 'over' : undefined}
            className={`rounded-md transition-colors ${dragActive ? (over ? 'h-7 my-0.5 bg-cl-lume/10 ring-1 ring-cl-lume/30' : 'h-5') : 'h-0'}`}
        />
    );
}
