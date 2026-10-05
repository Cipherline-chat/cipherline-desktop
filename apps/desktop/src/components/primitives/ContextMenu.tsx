/**
 * ContextMenu — the canonical right-click menu primitive for the app.
 *
 * Usage:
 *   const ctx = useContextMenu();
 *   <div onContextMenu={(e) => ctx.open(e, [
 *     { icon: <Pin/>, label: 'Pin', onSelect: () => pin(id) },
 *     { divider: true },
 *     { icon: <Trash/>, label: 'Delete', onSelect: () => del(id), danger: true },
 *   ])}>...</div>
 *   {ctx.menu}
 *
 * Visuals ride the kit's select-menu vocabulary (.ctxm in cl-kit-ext.css):
 * spring entrance, lume hover, flash-tinted danger rows, mono eyebrow title.
 * Picking a row flashes it (guide mflash, 170ms) before the action runs and
 * the menu fades out — the same ceremony as ClSelect. Checkbox rows toggle
 * instantly and keep the menu open, as before.
 *
 * Submenus open on hover and can also be opened with ArrowRight. The flyout
 * and the main menu are portalled to document.body as siblings — NEVER nest
 * the flyout inside the main menu div. Reason: the main menu animates with a
 * transform; any `animation`/`transform` on a parent creates a new containing
 * block for `position:fixed` descendants, breaking their viewport-relative
 * coords. (The plain .cl-kit wrapper div is safe: no transform, no animation.)
 *
 * useDismissOnOutsideClick is given a predicate that returns true for clicks
 * inside EITHER the main menu or the submenu ref, so clicking a role item
 * in the flyout is not mistaken for an outside click (which would fire
 * onClose on mousedown, swallow the click, and prevent onSelect from running).
 */

import React from 'react';
import ReactDOM from 'react-dom';
import { ChevronRight, Check } from 'lucide-react';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useEscape } from '../../hooks/useEscape';

export type ContextMenuItem =
    | { divider: true }
    /**
     * Escape hatch for content that doesn't fit a menu row — a device
     * picker's volume slider is the motivating case. Renders as-is, inside
     * the same .ctxm container so it's included in the real DOM height the
     * menu measures itself against (no special-casing needed there).
     *
     * Deliberately excluded from keyboard nav (ArrowUp/Down skip it) and from
     * autoFocus/select — a slider has no sensible "activate via Enter"
     * behaviour, and role="none" tells assistive tech the same thing. Give
     * the node its own interactive semantics (e.g. an <input type="range">)
     * if it needs to be operable via keyboard at all.
     */
    | { custom: React.ReactNode }
    | {
        icon?: React.ReactNode;
        label: string;
        accessory?: React.ReactNode;
        onSelect: () => void;
        danger?: boolean;
        disabled?: boolean;
        /** Renders a neutral checkbox — true=filled, false=empty. Never role-coloured. */
        checked?: boolean;
        /** Nested items rendered in a hover/keyboard flyout to the right. */
        submenu?: ContextMenuItem[];
    };

interface ContextMenuProps {
    anchor: { x: number; y: number };
    items: ContextMenuItem[];
    onClose: () => void;
    title?: string;
}

const MENU_WIDTH = 220;
const MENU_MIN_HEIGHT = 40;
const VIEWPORT_MARGIN = 8;
const SUBMENU_CLOSE_DELAY = 200;
/** Guide ceremony: picked row flashes this long before the action runs. */
const PICK_FLASH_MS = 170;
/** Matches .ctxm.exit's fade duration in cl-kit-ext.css. */
const EXIT_MS = 120;

function calcMenuPos(
    anchor: { x: number; y: number },
    height: number,
): { top: number; left: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top  = anchor.y;
    if (left + MENU_WIDTH > vw - VIEWPORT_MARGIN) left = Math.max(VIEWPORT_MARGIN, anchor.x - MENU_WIDTH);
    if (top  + height    > vh - VIEWPORT_MARGIN)  top  = Math.max(VIEWPORT_MARGIN, anchor.y - height);
    return { top, left };
}

// ─── Shared row renderer ─────────────────────────────────────────────────────

interface RowProps {
    item: Exclude<ContextMenuItem, { divider: true } | { custom: React.ReactNode }>;
    focused: boolean;
    picked: boolean;
    submenuOpen?: boolean;
    btnRef: (el: HTMLButtonElement | null) => void;
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseLeave?: () => void;
    onFocus: () => void;
    onClick: () => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
}

const MenuRow: React.FC<RowProps> = ({
    item, focused, picked, submenuOpen, btnRef, onMouseEnter, onMouseLeave, onFocus, onClick, onKeyDown,
}) => {
    const hasSubmenu = !!item.submenu?.length;
    const role = typeof item.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem';
    const cls = [
        'ctxm-row',
        item.danger ? 'danger' : '',
        (focused || submenuOpen) && !item.disabled ? 'focus' : '',
        picked ? 'picked' : '',
    ].filter(Boolean).join(' ');
    return (
        <button
            ref={btnRef}
            type="button"
            role={role}
            aria-checked={typeof item.checked === 'boolean' ? item.checked : undefined}
            aria-haspopup={hasSubmenu ? 'menu' : undefined}
            aria-expanded={hasSubmenu ? submenuOpen : undefined}
            aria-disabled={item.disabled}
            disabled={item.disabled}
            tabIndex={focused ? 0 : -1}
            className={cls}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            onFocus={onFocus}
            onClick={onClick}
            onKeyDown={onKeyDown}
        >
            {item.icon && <span className="ci" aria-hidden="true">{item.icon}</span>}
            <span className="clabel">{item.label}</span>
            {hasSubmenu ? (
                <ChevronRight size={14} className="ctxm-acc" aria-hidden="true" />
            ) : typeof item.checked === 'boolean' ? (
                <span className={`ctxm-chk${item.checked ? ' on' : ''}`} aria-hidden="true">
                    {item.checked && <Check size={11} strokeWidth={3} />}
                </span>
            ) : item.accessory ? (
                <span className="ctxm-acc" aria-hidden="true">{item.accessory}</span>
            ) : null}
        </button>
    );
};

/**
 * Pick ceremony shared by menu + flyout: flash the row, then run the action.
 * Checkbox rows skip it — they toggle instantly and keep the menu open.
 */
function usePickFlash() {
    const [pickedIdx, setPickedIdx] = React.useState<number | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
    const pick = React.useCallback((idx: number, run: () => void) => {
        if (timerRef.current) return; // a pick is already in flight
        setPickedIdx(idx);
        timerRef.current = setTimeout(run, PICK_FLASH_MS);
    }, []);
    return { pickedIdx, pick, pickPending: () => timerRef.current !== null };
}

// ─── Submenu flyout ──────────────────────────────────────────────────────────

interface SubMenuProps {
    items:       ContextMenuItem[];
    rowTop:      number;   // viewport-y of the hovered row's top edge
    parentLeft:  number;   // viewport-x of the parent menu's left edge
    exiting:     boolean;  // parent menu is fading out — fade with it
    onClose:     () => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    forwardRef:  React.RefObject<HTMLDivElement | null>;
    /** When true the submenu auto-focuses its first item (keyboard-initiated). */
    autoFocus?: boolean;
}

const SubMenu: React.FC<SubMenuProps> = ({
    items, rowTop, parentLeft, exiting, onClose, onMouseEnter, onMouseLeave, forwardRef, autoFocus,
}) => {
    const [pos, setPos] = React.useState<{ top: number; left: number }>({
        top:  rowTop,
        left: parentLeft + MENU_WIDTH + 4,
    });
    const [focusedIdx, setFocusedIdx] = React.useState<number | null>(autoFocus ? -1 : null);
    const btnRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
    const { pickedIdx, pick } = usePickFlash();

    // Escape closes just the flyout through the shared stack — mounting is
    // "open" for this component, so the layer is always active while it
    // exists. Registered after (so on top of) the parent menu's own layer,
    // which is what makes one press close the submenu first, a second the
    // whole menu, regardless of whether focus happens to be in the submenu.
    useEscape(onClose);

    React.useLayoutEffect(() => {
        const el = forwardRef.current;
        if (!el) return;
        const h  = el.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = parentLeft + MENU_WIDTH + 4;
        let top  = rowTop;
        if (left + MENU_WIDTH > vw - VIEWPORT_MARGIN) left = parentLeft - MENU_WIDTH - 4;
        if (top  + h          > vh - VIEWPORT_MARGIN) top  = Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN);
        setPos(prev => prev.top === top && prev.left === left ? prev : { top, left });
    }, [rowTop, parentLeft, forwardRef]);

    // Auto-focus first item when opened via keyboard.
    React.useEffect(() => {
        if (!autoFocus) return;
        const firstIdx = items.findIndex(it => !('divider' in it) && !('custom' in it) && !it.disabled);
        if (firstIdx !== -1) {
            setFocusedIdx(firstIdx);
            btnRefs.current[firstIdx]?.focus();
        }
    }, [autoFocus, items]);

    const actionItems = items.map((it, i) => ({ it, i })).filter(({ it }) => !('divider' in it) && !('custom' in it));

    const moveFocus = (delta: 1 | -1) => {
        const cur = focusedIdx ?? -1;
        const eligible = actionItems.filter(({ it }) => !('disabled' in it && it.disabled));
        if (!eligible.length) return;
        const curPos = eligible.findIndex(({ i }) => i === cur);
        const nextPos = (curPos + delta + eligible.length) % eligible.length;
        const nextIdx = eligible[nextPos].i;
        setFocusedIdx(nextIdx);
        btnRefs.current[nextIdx]?.focus();
    };

    const moveFocusToEdge = (edge: 'start' | 'end') => {
        const eligible = actionItems.filter(({ it }) => !('disabled' in it && it.disabled));
        if (!eligible.length) return;
        const nextIdx = edge === 'start' ? eligible[0].i : eligible[eligible.length - 1].i;
        setFocusedIdx(nextIdx);
        btnRefs.current[nextIdx]?.focus();
    };

    const select = (item: Exclude<ContextMenuItem, { divider: true } | { custom: React.ReactNode }>, i: number) => {
        if (item.disabled) return;
        if (typeof item.checked === 'boolean') {
            // Toggle rows respond instantly and keep the flyout open.
            item.onSelect();
            return;
        }
        pick(i, () => { item.onSelect(); onClose(); });
    };

    return (
        <div
            ref={forwardRef}
            role="menu"
            aria-orientation="vertical"
            className={`ctxm ctxm--sub${exiting ? ' exit' : ''}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH, maxWidth: '90vw', zIndex: 10010 }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
                if (e.key === 'ArrowDown')  { e.preventDefault(); moveFocus(1); }
                if (e.key === 'ArrowUp')    { e.preventDefault(); moveFocus(-1); }
                if (e.key === 'Home')       { e.preventDefault(); moveFocusToEdge('start'); }
                if (e.key === 'End')        { e.preventDefault(); moveFocusToEdge('end'); }
                if (e.key === 'ArrowLeft') { e.preventDefault(); onClose(); }
            }}
        >
            {items.map((item, i) => {
                if ('divider' in item) {
                    return <div key={`d${i}`} role="separator" className="ctxm-sep" />;
                }
                if ('custom' in item) {
                    return <div key={`c${i}`} role="none" className="ctxm-custom">{item.custom}</div>;
                }
                return (
                    <MenuRow
                        key={i}
                        item={item}
                        focused={focusedIdx === i}
                        picked={pickedIdx === i}
                        btnRef={el => { btnRefs.current[i] = el; }}
                        onFocus={() => setFocusedIdx(i)}
                        onMouseEnter={() => setFocusedIdx(i)}
                        onClick={() => select(item, i)}
                    />
                );
            })}
        </div>
    );
};

// ─── Main menu ───────────────────────────────────────────────────────────────

export const ContextMenu: React.FC<ContextMenuProps> = ({ anchor, items, onClose, title }) => {
    const mainRef    = React.useRef<HTMLDivElement>(null);
    const subMenuRef = React.useRef<HTMLDivElement>(null);

    const [pos, setPos] = React.useState<{ top: number; left: number }>(() =>
        calcMenuPos(anchor, MENU_MIN_HEIGHT),
    );
    const [openSubmenuIdx, setOpenSubmenuIdx] = React.useState<number | null>(null);
    const [submenuRowTop,  setSubmenuRowTop]  = React.useState<number | null>(null);
    const [submenuViaKey,  setSubmenuViaKey]  = React.useState(false);
    const [focusedIdx,     setFocusedIdx]     = React.useState<number | null>(null);
    const [exiting,        setExiting]        = React.useState(false);
    const { pickedIdx, pick } = usePickFlash();

    const btnRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

    // All close paths route here so the .exit fade plays before unmount.
    const exitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestClose = React.useCallback(() => {
        if (exitTimerRef.current) return;
        setExiting(true);
        exitTimerRef.current = setTimeout(onClose, EXIT_MS);
    }, [onClose]);
    React.useEffect(() => () => { if (exitTimerRef.current) clearTimeout(exitTimerRef.current); }, []);

    // Escape closes the whole menu through the shared stack. Mounted = open
    // for this component, so this is always active; a submenu's own layer
    // (SubMenu, above) registers later and sits on top, so it is what a press
    // closes first while a flyout is showing.
    useEscape(requestClose);

    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelClose = React.useCallback(() => {
        if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    }, []);
    const scheduleClose = React.useCallback(() => {
        cancelClose();
        closeTimerRef.current = setTimeout(() => {
            setOpenSubmenuIdx(null);
            setSubmenuRowTop(null);
            setSubmenuViaKey(false);
        }, SUBMENU_CLOSE_DELAY);
    }, [cancelClose]);
    React.useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

    // Reposition after mount (real height may differ from MENU_MIN_HEIGHT estimate).
    React.useLayoutEffect(() => {
        if (!mainRef.current) return;
        const realH = mainRef.current.offsetHeight;
        setPos(prev => {
            const next = calcMenuPos(anchor, realH);
            return prev.top === next.top && prev.left === next.left ? prev : next;
        });
    }, [anchor]);

    // Auto-focus first non-disabled item on open.
    React.useEffect(() => {
        const firstIdx = items.findIndex(it => !('divider' in it) && !('custom' in it) && !it.disabled);
        if (firstIdx !== -1) {
            setFocusedIdx(firstIdx);
            // Defer until after the layout effect positions the menu.
            requestAnimationFrame(() => btnRefs.current[firstIdx]?.focus());
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // useDismissOnOutsideClick accepts a predicate so we can cover BOTH the
    // main menu and the submenu flyout. Without this, clicking a role item in
    // the flyout is seen as an outside click → onClose fires on mousedown →
    // the click is swallowed before onSelect ever runs.
    const isInsideEither = React.useCallback((target: Node) => {
        return !!(
            (mainRef.current    && mainRef.current.contains(target)) ||
            (subMenuRef.current && subMenuRef.current.contains(target))
        );
    }, []);
    useDismissOnOutsideClick(isInsideEither, true, requestClose);

    React.useEffect(() => {
        // Another popover/menu is opening — yield instantly, no exit fade.
        const onAll = () => onClose();
        window.addEventListener('close-all-popovers', onAll);
        return () => window.removeEventListener('close-all-popovers', onAll);
    }, [onClose]);

    // Keyboard navigation helpers.
    const actionItems = React.useMemo(
        () => items.map((it, i) => ({ it, i })).filter(({ it }) => !('divider' in it) && !('custom' in it)),
        [items],
    );

    const moveFocus = React.useCallback((delta: 1 | -1) => {
        setOpenSubmenuIdx(null);
        setSubmenuRowTop(null);
        setSubmenuViaKey(false);
        const cur = focusedIdx ?? -1;
        const eligible = actionItems.filter(({ it }) => !('disabled' in it && it.disabled));
        if (!eligible.length) return;
        const curPos = eligible.findIndex(({ i }) => i === cur);
        const nextPos = (curPos + delta + eligible.length) % eligible.length;
        const nextIdx = eligible[nextPos].i;
        setFocusedIdx(nextIdx);
        btnRefs.current[nextIdx]?.focus();
    }, [focusedIdx, actionItems]);

    const moveFocusToEdge = React.useCallback((edge: 'start' | 'end') => {
        setOpenSubmenuIdx(null);
        setSubmenuRowTop(null);
        setSubmenuViaKey(false);
        const eligible = actionItems.filter(({ it }) => !('disabled' in it && it.disabled));
        if (!eligible.length) return;
        const nextIdx = edge === 'start' ? eligible[0].i : eligible[eligible.length - 1].i;
        setFocusedIdx(nextIdx);
        btnRefs.current[nextIdx]?.focus();
    }, [actionItems]);

    const openSubmenuForIdx = React.useCallback((idx: number, viaKey: boolean) => {
        const btn = btnRefs.current[idx];
        if (!btn) return;
        const r = btn.getBoundingClientRect();
        cancelClose();
        setOpenSubmenuIdx(idx);
        setSubmenuRowTop(r.top);
        setSubmenuViaKey(viaKey);
    }, [cancelClose]);

    const select = (item: Exclude<ContextMenuItem, { divider: true } | { custom: React.ReactNode }>, i: number) => {
        if (item.disabled || item.submenu?.length) return;
        if (typeof item.checked === 'boolean') {
            // Toggle rows respond instantly and keep the menu open.
            item.onSelect();
            return;
        }
        pick(i, () => { item.onSelect(); requestClose(); });
    };

    const activeParentItem =
        openSubmenuIdx !== null && submenuRowTop !== null
            ? items[openSubmenuIdx]
            : null;
    const subMenuNode =
        activeParentItem && !('divider' in activeParentItem) && !('custom' in activeParentItem) && activeParentItem.submenu
            ? (
                <SubMenu
                    items={activeParentItem.submenu}
                    rowTop={submenuRowTop!}
                    parentLeft={pos.left}
                    exiting={exiting}
                    onClose={() => { setOpenSubmenuIdx(null); setSubmenuRowTop(null); setSubmenuViaKey(false); }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                    forwardRef={subMenuRef}
                    autoFocus={submenuViaKey}
                />
            )
            : null;

    const mainMenu = (
        <div
            ref={mainRef}
            role="menu"
            aria-orientation="vertical"
            className={`ctxm${exiting ? ' exit' : ''}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH, maxWidth: '90vw', zIndex: 10009 }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
                if (e.key === 'ArrowDown')  { e.preventDefault(); moveFocus(1); }
                if (e.key === 'ArrowUp')    { e.preventDefault(); moveFocus(-1); }
                if (e.key === 'Home')       { e.preventDefault(); moveFocusToEdge('start'); }
                if (e.key === 'End')        { e.preventDefault(); moveFocusToEdge('end'); }
                if (e.key === 'ArrowRight' && focusedIdx !== null) {
                    const it = items[focusedIdx];
                    if (!('divider' in it) && !('custom' in it) && it.submenu?.length) {
                        e.preventDefault();
                        openSubmenuForIdx(focusedIdx, true);
                    }
                }
                if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    if (openSubmenuIdx !== null) {
                        setOpenSubmenuIdx(null);
                        setSubmenuRowTop(null);
                        setSubmenuViaKey(false);
                    } else {
                        requestClose();
                    }
                }
            }}
        >
            {title && (
                <div className="ctxm-title" aria-hidden="true">
                    {title}
                </div>
            )}
            {items.map((item, i) => {
                if ('divider' in item) {
                    return <div key={`d${i}`} role="separator" className="ctxm-sep" />;
                }
                if ('custom' in item) {
                    return <div key={`c${i}`} role="none" className="ctxm-custom">{item.custom}</div>;
                }
                const hasSubmenu    = !!item.submenu?.length;
                const isSubmenuOpen = hasSubmenu && openSubmenuIdx === i;
                return (
                    <MenuRow
                        key={i}
                        item={item}
                        focused={focusedIdx === i}
                        picked={pickedIdx === i}
                        submenuOpen={isSubmenuOpen}
                        btnRef={el => { btnRefs.current[i] = el; }}
                        onMouseEnter={(e) => {
                            setFocusedIdx(i);
                            if (item.disabled) return;
                            if (hasSubmenu) {
                                cancelClose();
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setOpenSubmenuIdx(i);
                                setSubmenuRowTop(r.top);
                                setSubmenuViaKey(false);
                            } else {
                                scheduleClose();
                            }
                        }}
                        onMouseLeave={() => {
                            if (hasSubmenu && isSubmenuOpen) scheduleClose();
                        }}
                        onFocus={() => setFocusedIdx(i)}
                        onClick={() => select(item, i)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                if (item.disabled) return;
                                if (hasSubmenu) {
                                    openSubmenuForIdx(i, true);
                                } else {
                                    select(item, i);
                                }
                            }
                        }}
                    />
                );
            })}
        </div>
    );

    return ReactDOM.createPortal(
        // Plain .cl-kit div (no display:contents, no transform) — @scope-safe
        // and doesn't become a containing block for the fixed menus inside.
        <div className="cl-kit">{mainMenu}{subMenuNode}</div>,
        document.body,
    );
};
