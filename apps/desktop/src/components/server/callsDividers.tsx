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
