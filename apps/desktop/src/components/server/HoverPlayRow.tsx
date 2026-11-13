import React, { useCallback, useState } from 'react';

type RowProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>;

interface HoverPlayRowProps extends RowProps {
    /** Receives `true` while the pointer is over the row, or keyboard focus is
     *  anywhere inside it. Pass it to `<EncryptedAvatar playing={...}>` so an
     *  animated avatar plays for the whole row, not only under the pointer. */
    children: (playing: boolean) => React.ReactNode;
}

/**
 * A list row that tells its avatar when to animate.
 *
 * The hover/focus flag lives in THIS component, so a pointer sweeping down a
 * 60-member list re-renders one row on enter and one on leave - never the
 * panel that owns the list. (Declared at module level on purpose: a component
 * defined inside the panel body would be a new type every render and remount
 * every row.) Caller-supplied mouse/focus handlers still run.
 */
export const HoverPlayRow: React.FC<HoverPlayRowProps> = ({
    children,
    onMouseEnter,
    onMouseLeave,
    onFocus,
    onBlur,
    ...rest
}) => {
    const [hover, setHover] = useState(false);
    const [focus, setFocus] = useState(false);

    const handleEnter = useCallback((e: React.MouseEvent<HTMLDivElement>) => { setHover(true); onMouseEnter?.(e); }, [onMouseEnter]);
    const handleLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => { setHover(false); onMouseLeave?.(e); }, [onMouseLeave]);
    // Only KEYBOARD focus counts. A click focuses the row too, and that focus used to
    // outlive the pointer: the avatar kept playing until something else was focused.
    const handleFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
        let visible = true;
        try { visible = (e.target as Element).matches(':focus-visible'); } catch { /* old engine: keep the focus behaviour */ }
        setFocus(visible);
        onFocus?.(e);
    }, [onFocus]);
    const handleBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
        // focus-within: only clear when focus leaves the row, not when it moves between its children.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
        onBlur?.(e);
    }, [onBlur]);

    return (
        <div {...rest} onMouseEnter={handleEnter} onMouseLeave={handleLeave} onFocus={handleFocus} onBlur={handleBlur}>
            {children(hover || focus)}
        </div>
    );
};
