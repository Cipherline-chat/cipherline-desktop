import React from 'react';
import { Plus } from 'lucide-react';
import { useClTooltip } from './cl/useClTooltip';

interface GroupMembersHeadingProps {
    count: number;
    /** Show the "+" (see canAddGroupMembers: any active member, once loaded). */
    canAdd: boolean;
    onAdd: () => void;
}

/**
 * "MEMBERS (n)" heading of the group context panel, with an add-people "+" at
 * its right end.
 *
 * The typography is byte-for-byte the same style object as the "Shared"
 * heading above it in Dashboard (siblings in the same panel; they must read as
 * one system) — the only additions are the flex layout props. The button's
 * negative vertical margin keeps the row exactly as tall as the text-only
 * heading was, so the member list below does not shift when it appears.
 */
export const GroupMembersHeading: React.FC<GroupMembersHeadingProps> = ({ count, canAdd, onAdd }) => {
    const { anchorProps, tooltip, describedBy } = useClTooltip('Add people', { preferred: 'bottom' });
    const { ref: tipRef, ...tipHandlers } = anchorProps;

    return (
        <div
            className="flex items-center justify-between"
            style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)', padding: '2px 2px 8px' }}
        >
            <span>Members ({count})</span>
            {canAdd && (
                <>
                    <button
                        type="button"
                        ref={tipRef as React.Ref<HTMLButtonElement>}
                        {...tipHandlers}
                        onClick={onAdd}
                        aria-label="Add people"
                        aria-describedby={describedBy}
                        className="inline-flex items-center justify-center rounded-md border-0 bg-transparent cursor-pointer p-0 text-cl-faint hover:text-cl-text hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60"
                        style={{ width: 24, height: 24, margin: '-4px 0' }}
                    >
                        <Plus size={14} strokeWidth={2.5} />
                    </button>
                    {tooltip}
                </>
            )}
        </div>
    );
};
