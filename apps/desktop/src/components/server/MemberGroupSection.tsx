import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useKeepMountedForExit } from '../../hooks/useKeepMountedForExit';
import '../../styles/member-groups.css';

/** Matches the .cl-mgroup-body transition (member-groups.css) plus a frame of slack. */
const COLLAPSE_MS = 200;

interface MemberGroupSectionProps {
    /** Visible group name, e.g. a role name, "Online", "Offline". */
    label: string;
    /** Members in the group — stays visible while collapsed ("Moderators — 4"). */
    count: number;
    collapsed: boolean;
    onToggle: () => void;
    /** The rows. Ignored (and unmounted after the close animation) while collapsed. */
    children: React.ReactNode;
    /** Class for the element that directly wraps the rows (spacing between them). */
    rowsClassName?: string;
}

/**
 * One group of the server member list: a header that is a real <button>
 * (click, Enter, Space; aria-expanded / aria-controls), and a body that folds
 * away with a short grid-rows transition (none under prefers-reduced-motion).
 *
 * A collapsed group mounts no rows at all — the panel's row budget
 * (utils/incrementalRows) is not spent on members nobody can see. While it is
 * closing, the last rows it showed are kept so they can fold out instead of
 * vanishing on the first frame.
 */
export const MemberGroupSection: React.FC<MemberGroupSectionProps> = ({
    label, count, collapsed, onToggle, children, rowsClassName,
}) => {
    const open = !collapsed;
    const bodyId = useId();
    const keepRows = useKeepMountedForExit(open, COLLAPSE_MS);
    const lastRows = useRef<React.ReactNode>(children);
    // eslint-disable-next-line react-hooks/refs -- render-time cache of the last open children, read only while closing
    if (open) lastRows.current = children;

    // `moving` clips the body only during a transition; an open, settled group
    // must not clip (row tooltips hang outside it). Set by a user toggle only.
    const [moving, setMoving] = useState(false);
    const firstRender = useRef(true);
    useEffect(() => {
        if (firstRender.current) { firstRender.current = false; return; }
        setMoving(true);
        const t = setTimeout(() => setMoving(false), COLLAPSE_MS);
        return () => clearTimeout(t);
    }, [open]);

    return (
        <div>
            <button
                type="button"
                className="cl-mgroup-head"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={onToggle}
            >
                <ChevronRight className="cl-mgroup-chev" aria-hidden="true" strokeWidth={2.5} />
                <span className="cl-mgroup-label">{label}</span>
                <span className="cl-mgroup-count">&nbsp;— {count}</span>
            </button>
            <div
                id={bodyId}
                className="cl-mgroup-body"
                data-open={open ? 'true' : 'false'}
                data-moving={moving ? 'true' : undefined}
                aria-hidden={open ? undefined : true}
                // A closing group's stale rows must not take focus or clicks.
                inert={!open}
            >
                <div className="cl-mgroup-inner">
                    {(open || keepRows) && (
                        <div className={rowsClassName}>
                            {/* eslint-disable-next-line react-hooks/refs -- see lastRows above */}
                            {open ? children : lastRows.current}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
