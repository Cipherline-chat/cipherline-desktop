import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ClButton } from '../ClButton';

/**
 * One row in a composer autocomplete menu (@mention or :emoji:). Deliberately
 * generic — neither field encodes which menu it came from, so the same shape
 * covers a member/role row (icon = avatar-ish circle, hint = "Role" /
 * "Notify all members") and an emoji row (icon = glyph or <EmojiImage>,
 * hint = owning server name / "Custom").
 */
export interface SuggestionMenuItem {
    /** React key AND the identity used to scroll the selected row into view. */
    key: string;
    /** Rendered in a fixed 20×20 slot on the left. */
    icon: React.ReactNode;
    /** Primary row text — truncates with an ellipsis before wrapping ever
     *  kicks in; pair with a `title` when it can plausibly overflow. */
    label: string;
    /** Full text for the native tooltip when `label` might be truncated.
     *  Defaults to `label` itself. */
    title?: string;
    /** Optional right-aligned secondary text (e.g. "Role", a server name). */
    hint?: string;
    onSelect: () => void;
}

export interface SuggestionMenuProps {
    /** Anchor element the menu positions itself above-and-aligned-with —
     *  normally the composer's <textarea>. */
    anchorEl: HTMLElement;
    /** Uppercase section label at the top of the menu (e.g. "Members", "Emoji"). */
    sectionLabel: string;
    items: SuggestionMenuItem[];
    selectedIndex: number;
    minWidth?: number;
    maxWidth?: number;
    maxHeight?: number;
}

/**
 * The composer's shared autocomplete menu shell — extracted from the
 * @mention menu (the original, unchanged in appearance) so the :emoji: menu
 * can be rebuilt on identical markup instead of its previous divergent
 * horizontal-strip layout. Portals to `document.body`, fixed-positions itself
 * just above `anchorEl`, and caps its own height with internal scrolling
 * (rather than growing unbounded) so raising a result-count cap later stays
 * safe by construction.
 */
export function SuggestionMenu({
    anchorEl,
    sectionLabel,
    items,
    selectedIndex,
    minWidth = 200,
    maxWidth = 360,
    maxHeight = 240,
}: SuggestionMenuProps) {
    const selectedRowRef = useRef<HTMLDivElement | null>(null);

    // Keep the highlighted row in view when ↑/↓ moves it past the visible
    // window — only matters once `items.length` exceeds what maxHeight fits,
    // but costs nothing when it doesn't (scrollIntoView is a no-op then).
    useEffect(() => {
        selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    if (items.length === 0) return null;

    const r = anchorEl.getBoundingClientRect();

    return createPortal(
        <div
            style={{
                position: 'fixed',
                bottom: window.innerHeight - r.top + 6,
                left: r.left,
                zIndex: 9999,
                minWidth,
                maxWidth,
                maxHeight,
                overflowY: 'auto',
                overflowX: 'hidden',
            }}
            className="bg-cl-deep border border-white/[0.10] rounded-lg shadow-2xl p-1"
            onMouseDown={e => e.preventDefault()}
        >
            <div className="px-2 pt-0.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-white/30 select-none">
                {sectionLabel}
            </div>
            {items.map((item, i) => {
                const isSelected = i === selectedIndex;
                return (
                    <div key={item.key} ref={isSelected ? selectedRowRef : undefined}>
                        <ClButton
                            type="button"
                            onClick={item.onSelect}
                            variant="ghost"
                            row
                            size="sm"
                            fullWidth
                            active={isSelected}
                        >
                            <span className="w-5 h-5 shrink-0 flex items-center justify-center">{item.icon}</span>
                            <span className="text-[13px] font-semibold text-white/90 truncate min-w-0 flex-1 text-left" title={item.title ?? item.label}>
                                {item.label}
                            </span>
                            {item.hint && (
                                <span className="ml-auto pl-3 text-[10px] font-normal text-white/35 whitespace-nowrap shrink-0">
                                    {item.hint}
                                </span>
                            )}
                        </ClButton>
                    </div>
                );
            })}
        </div>,
        document.body,
    );
}
