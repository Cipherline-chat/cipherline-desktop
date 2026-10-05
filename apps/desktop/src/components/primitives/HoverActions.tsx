/**
 * HoverActions — the canonical hover-revealed icon-button overlay.
 *
 * Many list rows in the app want a Discord-style "tiny gear / mute / X buttons
 * appear on hover." Today each one is hand-rolled. This is the reusable
 * version: drop it inside any container with `className="group ..."` and the
 * actions auto-hide unless the user is hovering.
 *
 * Convention: actions are right-aligned. Icons are 14×14, buttons 22×22.
 * Items whose `perm` predicate returns false are filtered out — convenient
 * for permission-gated actions (e.g. only show the gear if the user has
 * MANAGE_CHANNELS).
 *
 * The container is positioned absolutely, so the parent must establish its
 * own positioning context (`relative` is enough). Click events bubble-stop
 * automatically — the parent row's onClick won't fire when the user clicks
 * one of these buttons.
 */

import React from 'react';

export interface HoverAction {
    icon: React.ReactNode;
    label: string;
    onClick: (e: React.MouseEvent) => void;
    /** Return false to hide this action (e.g. user lacks permission). */
    perm?: () => boolean;
    /** `'danger'` renders red-tinted; default is neutral white. */
    variant?: 'default' | 'danger';
}

interface Props {
    actions: HoverAction[];
    /** Additional Tailwind classes for the wrapper. */
    className?: string;
    /** Render even when not hovering (for "always on" toolbars). */
    alwaysVisible?: boolean;
}

/**
 * FlatIconBtn — the single-button sibling of HoverActions: a quiet 22×22 flat
 * icon button for dense list rows and slim headers. Use this instead of
 * `ClButton icon` anywhere the kit's form-scale capsule would look oversized.
 */
export const FlatIconBtn = React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }
>(({ danger, className, children, ...rest }, ref) => (
    <button
        ref={ref}
        type="button"
        className={`shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-md transition-colors [&_svg]:w-3.5 [&_svg]:h-3.5 ${
            danger
                ? 'text-cl-faint hover:text-cl-flash hover:bg-cl-flash/10'
                : 'text-cl-faint hover:text-cl-text hover:bg-white/[0.08]'
        } ${className ?? ''}`}
        {...rest}
    >
        {children}
    </button>
));
FlatIconBtn.displayName = 'FlatIconBtn';

export const HoverActions: React.FC<Props> = ({ actions, className, alwaysVisible }) => {
    const visible = actions.filter(a => !a.perm || a.perm());
    if (!visible.length) return null;

    const visClasses = alwaysVisible
        ? 'opacity-100'
        : 'opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto';

    return (
        <div className={`flex items-center gap-0.5 transition-opacity ${visClasses} ${className ?? ''}`}>
            {visible.map((a, i) => (
                <FlatIconBtn
                    key={i}
                    title={a.label}
                    aria-label={a.label}
                    danger={a.variant === 'danger'}
                    onClick={(e) => {
                        e.stopPropagation();
                        a.onClick(e);
                    }}
                    onContextMenu={(e) => e.stopPropagation()}
                >
                    {a.icon}
                </FlatIconBtn>
            ))}
        </div>
    );
};
