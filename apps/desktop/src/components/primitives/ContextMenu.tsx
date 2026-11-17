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
 * ── Flyouts ─────────────────────────────────────────────────────────────────
 * A row with `submenu` (more rows) or `flyout` (a custom panel — the member
 * role picker is the motivating case) opens a flyout BESIDE the menu: to the
 * right, or to the left when there is no room, vertically clamped into the
 * window. Opening:
 *   - hover, after SUBMENU_OPEN_DELAY (so sweeping past a row does not flash
 *     its flyout open). Hover never moves DOM focus — the menu's arrow keys
 *     keep working while a flyout shows;
 *   - click (immediately, still without taking focus);
 *   - ArrowRight / Enter / Space — the flyout then takes focus (its first row,
 *     or for a panel whatever the panel autofocuses when `viaKeyboard`).
 * Closing: hovering a DIFFERENT row of the menu, ArrowLeft / Escape / Tab
 * inside the flyout (focus returns to the row that opened it), or the whole
 * menu closing. Merely moving the pointer off both surfaces leaves it open,
 * as native menus do — a role toggle never needs the menu reopened.
 *
 * Safe triangle: while the pointer travels from the open row toward the
 * flyout it may cross other rows. As long as it stays inside the triangle
 * between where it left the row and the flyout's near edge, those rows do NOT
 * take over (for up to SAFE_AREA_GRACE of no progress), so a diagonal move
 * into the flyout never closes it.
 *
 * The flyout and the main menu are portalled to document.body as siblings —
 * NEVER nest the flyout inside the main menu div. Reason: the main menu
 * animates with a transform; any `animation`/`transform` on a parent creates
 * a new containing block for `position:fixed` descendants, breaking their
 * viewport-relative coords. (The plain .cl-kit wrapper div is safe: no
 * transform, no animation.)
 *
 * useDismissOnOutsideClick is given a predicate that returns true for clicks
 * inside EITHER the main menu or the flyout ref, so clicking a role item in
 * the flyout is not mistaken for an outside click (which would fire onClose
 * on mousedown, swallow the click, and prevent onSelect from running).
 */

import React from 'react';
import ReactDOM from 'react-dom';
import { ChevronRight, Check } from 'lucide-react';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useEscape } from '../../hooks/useEscape';
import {
    MENU_WIDTH, VIEWPORT_MARGIN, SUBMENU_OPEN_DELAY, SUBMENU_CLOSE_DELAY, SAFE_AREA_GRACE,
    placeFlyout, inSafeTriangle,
} from './contextMenuGeometry';

/** What a custom `flyout` panel is handed when it renders. */
export interface FlyoutRenderContext {
    /**
     * Opened from the keyboard (ArrowRight / Enter / Space): the panel should
     * move focus into itself. A hover- or click-opened panel must NOT take
     * focus, or the menu's arrow-key navigation would break.
     */
    viaKeyboard: boolean;
    /** The tallest the panel may be: the window height minus margins, in px. */
    maxHeight: number;
    /** Close just this flyout (focus returns to its row when it was inside). */
    close: () => void;
}

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
        /** Nested items rendered in a hover/keyboard flyout beside the menu. */
        submenu?: ContextMenuItem[];
        /**
         * A custom panel rendered in the hover/keyboard flyout instead of rows
         * (e.g. the member role picker). Same open/close/placement rules as
         * `submenu`; the panel owns its own keyboard handling inside.
         */
        flyout?: (ctx: FlyoutRenderContext) => React.ReactNode;
        /** Width of the `flyout` panel, px (default: the menu width). */
        flyoutWidth?: number;
        /** Accessible name of the `flyout` panel (default: the row label). */
        flyoutLabel?: string;
    };

type ActionItem = Exclude<ContextMenuItem, { divider: true } | { custom: React.ReactNode }>;

interface ContextMenuProps {
    anchor: { x: number; y: number };
    items: ContextMenuItem[];
    onClose: () => void;
    title?: string;
}

const MENU_MIN_HEIGHT = 40;
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

const isActionItem = (it: ContextMenuItem): it is ActionItem => !('divider' in it) && !('custom' in it);
const hasFlyout = (it: ContextMenuItem): boolean => isActionItem(it) && (!!it.submenu?.length || !!it.flyout);

// ─── Shared row renderer ─────────────────────────────────────────────────────

interface RowProps {
    item: ActionItem;
    focused: boolean;
    picked: boolean;
    submenuOpen?: boolean;
    btnRef: (el: HTMLButtonElement | null) => void;
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseLeave?: (e: React.MouseEvent) => void;
    onFocus: () => void;
    onClick: () => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
}

const MenuRow: React.FC<RowProps> = ({
    item, focused, picked, submenuOpen, btnRef, onMouseEnter, onMouseLeave, onFocus, onClick, onKeyDown,
}) => {
    const opensFlyout = hasFlyout(item);
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
            aria-haspopup={opensFlyout ? (item.flyout ? 'dialog' : 'menu') : undefined}
            aria-expanded={opensFlyout ? !!submenuOpen : undefined}
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
            {opensFlyout ? (
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

// ─── Flyout placement ────────────────────────────────────────────────────────

/**
 * Position a flyout beside its parent menu and keep it there as its content
 * (a roster that finishes loading, a search that filters rows away) or the
 * window resizes. Also reports the window height so panels can cap theirs.
 */
function useFlyoutPlacement(
    ref: React.RefObject<HTMLDivElement | null>,
    rowTop: number,
    parentLeft: number,
    width: number,
) {
    const [vh, setVh] = React.useState(() => window.innerHeight);
    const [pos, setPos] = React.useState<{ top: number; left: number; side: 'right' | 'left' }>(() =>
        placeFlyout({ parentLeft, parentWidth: MENU_WIDTH, rowTop, width, height: 0, vw: window.innerWidth, vh: window.innerHeight }),
    );
    const place = React.useCallback(() => {
        const el = ref.current;
        if (!el) return;
        const next = placeFlyout({
            parentLeft, parentWidth: MENU_WIDTH, rowTop, width,
            height: el.offsetHeight, vw: window.innerWidth, vh: window.innerHeight,
        });
        setPos(prev => (prev.top === next.top && prev.left === next.left && prev.side === next.side ? prev : next));
    }, [ref, parentLeft, rowTop, width]);
    React.useLayoutEffect(place, [place]);
    React.useEffect(() => {
        const onResize = () => { setVh(window.innerHeight); place(); };
        window.addEventListener('resize', onResize);
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined' && ref.current) {
            ro = new ResizeObserver(() => place());
            ro.observe(ref.current);
        }
        return () => { window.removeEventListener('resize', onResize); ro?.disconnect(); };
    }, [place, ref]);
    return { pos, vh };
}

const flyoutStyle = (pos: { top: number; left: number }, width: number): React.CSSProperties => ({
    position: 'fixed', top: pos.top, left: pos.left, width, maxWidth: '90vw', zIndex: 10010,
    // A long flyout scrolls inside the window instead of running off its
    // bottom edge; keyboard focus scrolls the focused row into view on its own.
    maxHeight: `calc(100vh - ${2 * VIEWPORT_MARGIN}px)`, overflowY: 'auto', overscrollBehavior: 'contain',
});

// ─── Submenu flyout (rows) ───────────────────────────────────────────────────

interface FlyoutCommonProps {
    rowTop:      number;   // viewport-y of the opening row's top edge
    parentLeft:  number;   // viewport-x of the parent menu's left edge
    exiting:     boolean;  // parent menu is fading out — fade with it
    /** Close just the flyout. */
    onClose:     () => void;
    /** Close the flyout AND the whole menu (a picked row). */
    onCloseAll:  () => void;
    onMouseEnter: () => void;
    forwardRef:  React.RefObject<HTMLDivElement | null>;
    /** Opened via keyboard: take focus. */
    autoFocus?: boolean;
}

const SubMenu: React.FC<FlyoutCommonProps & { items: ContextMenuItem[] }> = ({
    items, rowTop, parentLeft, exiting, onClose, onCloseAll, onMouseEnter, forwardRef, autoFocus,
}) => {
    const { pos } = useFlyoutPlacement(forwardRef, rowTop, parentLeft, MENU_WIDTH);
    const [focusedIdx, setFocusedIdx] = React.useState<number | null>(autoFocus ? -1 : null);
    const btnRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
    const { pickedIdx, pick } = usePickFlash();

    // Escape closes just the flyout through the shared stack — mounting is
    // "open" for this component, so the layer is always active while it
    // exists. Registered after (so on top of) the parent menu's own layer,
    // which is what makes one press close the submenu first, a second the
    // whole menu, regardless of whether focus happens to be in the submenu.
    useEscape(onClose);

    // Auto-focus first item when opened via keyboard.
    React.useEffect(() => {
        if (!autoFocus) return;
        const firstIdx = items.findIndex(it => isActionItem(it) && !it.disabled);
        if (firstIdx !== -1) {
            setFocusedIdx(firstIdx);
            btnRefs.current[firstIdx]?.focus();
        }
    }, [autoFocus, items]);

    const actionItems = items.map((it, i) => ({ it, i })).filter(({ it }) => isActionItem(it));

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

    const select = (item: ActionItem, i: number) => {
        if (item.disabled) return;
        if (typeof item.checked === 'boolean') {
            // Toggle rows respond instantly and keep the flyout open.
            item.onSelect();
            return;
        }
        pick(i, () => { item.onSelect(); onCloseAll(); });
    };

    return (
        <div
            ref={forwardRef}
            role="menu"
            aria-orientation="vertical"
            className={`ctxm ctxm--sub${exiting ? ' exit' : ''}`}
            data-testid="ctxm-flyout"
            data-side={pos.side}
            style={flyoutStyle(pos, MENU_WIDTH)}
            onMouseEnter={onMouseEnter}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
                if (e.key === 'ArrowDown')  { e.preventDefault(); moveFocus(1); }
                if (e.key === 'ArrowUp')    { e.preventDefault(); moveFocus(-1); }
                if (e.key === 'Home')       { e.preventDefault(); moveFocusToEdge('start'); }
                if (e.key === 'End')        { e.preventDefault(); moveFocusToEdge('end'); }
                if (e.key === 'ArrowLeft' || e.key === 'Tab') { e.preventDefault(); onClose(); }
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

// ─── Panel flyout (custom content) ───────────────────────────────────────────

const PanelFlyout: React.FC<FlyoutCommonProps & {
    render: (ctx: FlyoutRenderContext) => React.ReactNode;
    width: number;
    label: string;
}> = ({ render, width, label, rowTop, parentLeft, exiting, onClose, onMouseEnter, forwardRef, autoFocus }) => {
    const { pos, vh } = useFlyoutPlacement(forwardRef, rowTop, parentLeft, width);
    // Same Escape layering as SubMenu: the first press closes this panel (a
    // panel's own inner layers — e.g. "clear the search" — sit above it).
    useEscape(onClose);
    const maxHeight = Math.max(0, vh - 2 * VIEWPORT_MARGIN);

    return (
        <div
            ref={forwardRef}
            role="dialog"
            aria-label={label}
            className={`ctxm ctxm--sub ctxm--panel${exiting ? ' exit' : ''}`}
            data-testid="ctxm-flyout"
            data-side={pos.side}
            style={{ ...flyoutStyle(pos, width), display: 'flex', flexDirection: 'column' }}
            onMouseEnter={onMouseEnter}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
                // The panel handles its own keys inside; these leave it. A text
                // field keeps ArrowLeft for its caret once it holds text.
                const t = e.target as HTMLElement;
                const typing = t instanceof HTMLInputElement && t.value !== '';
                if ((e.key === 'ArrowLeft' && !typing) || e.key === 'Tab') {
                    e.preventDefault();
                    onClose();
                }
                // Keep keystrokes (a search box's typing) from reaching shortcut
                // handlers on the React ancestors this menu was opened from.
                // The Escape stack listens on window in the capture phase, so
                // it is unaffected.
                e.stopPropagation();
            }}
        >
            {render({ viaKeyboard: !!autoFocus, maxHeight, close: onClose })}
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

    // Mirrors for timer callbacks, which outlive the render that armed them.
    const openIdxRef = React.useRef<number | null>(null);
    const focusedIdxRef = React.useRef<number | null>(null);
    React.useLayoutEffect(() => {
        openIdxRef.current = openSubmenuIdx;
        focusedIdxRef.current = focusedIdx;
    });

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
    // for this component, so this is always active; a flyout's own layer
    // registers later and sits on top, so it is what a press closes first
    // while a flyout is showing.
    useEscape(requestClose);

    // ── Flyout open / close, with hover intent ──────────────────────────────
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const openTimerRef  = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const graceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Row hovered while the pointer was inside the safe triangle — applied once it leaves it. */
    const pendingHoverRef = React.useRef<number | null>(null);
    /** Where the pointer left the open row: the safe triangle's apex. */
    const exitPointRef = React.useRef<{ x: number; y: number } | null>(null);
    /** The pointer's previous position over the menu (the leave event already sits on the next row). */
    const lastPointRef = React.useRef<{ x: number; y: number } | null>(null);

    const clearTimer = (r: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
        if (r.current) { clearTimeout(r.current); r.current = null; }
    };
    const cancelClose = React.useCallback(() => clearTimer(closeTimerRef), []);
    React.useEffect(() => () => {
        clearTimer(closeTimerRef); clearTimer(openTimerRef); clearTimer(graceTimerRef);
    }, []);

    /**
     * Close the open flyout. When focus was inside it, hand focus back to the
     * menu (the row being hovered, else the row that opened the flyout) —
     * otherwise unmounting the flyout drops focus on <body> and the menu's
     * arrow keys stop working.
     */
    const closeSubmenu = React.useCallback(() => {
        clearTimer(closeTimerRef);
        clearTimer(graceTimerRef);
        pendingHoverRef.current = null;
        exitPointRef.current = null;
        const parentIdx = openIdxRef.current;
        const active = document.activeElement;
        const focusWasInside = !!(subMenuRef.current && active && subMenuRef.current.contains(active));
        if (focusWasInside) {
            const target = focusedIdxRef.current ?? parentIdx;
            if (target !== null) {
                btnRefs.current[target]?.focus();
                setFocusedIdx(target);
            }
        }
        setOpenSubmenuIdx(null);
        setSubmenuRowTop(null);
        setSubmenuViaKey(false);
    }, []);

    const scheduleClose = React.useCallback(() => {
        clearTimer(closeTimerRef);
        closeTimerRef.current = setTimeout(closeSubmenu, SUBMENU_CLOSE_DELAY);
    }, [closeSubmenu]);

    const openSubmenuForIdx = React.useCallback((idx: number, viaKey: boolean) => {
        const btn = btnRefs.current[idx];
        if (!btn) return;
        const r = btn.getBoundingClientRect();
        clearTimer(openTimerRef);
        clearTimer(closeTimerRef);
        clearTimer(graceTimerRef);
        pendingHoverRef.current = null;
        setOpenSubmenuIdx(idx);
        setSubmenuRowTop(r.top);
        // A keyboard open of an already hover-opened flyout upgrades it (the
        // flyout then takes focus); a later hover never downgrades it.
        setSubmenuViaKey(prev => (openIdxRef.current === idx ? prev || viaKey : viaKey));
    }, []);

    /** The pointer is over row i (outside any safe triangle). */
    const applyRowHover = React.useCallback((i: number) => {
        pendingHoverRef.current = null;
        clearTimer(graceTimerRef);
        setFocusedIdx(i);
        const item = items[i];
        if (!item || !isActionItem(item)) return;
        if (hasFlyout(item) && !item.disabled) {
            if (openIdxRef.current === i) { cancelClose(); return; }
            clearTimer(openTimerRef);
            openTimerRef.current = setTimeout(() => openSubmenuForIdx(i, false), SUBMENU_OPEN_DELAY);
            return;
        }
        clearTimer(openTimerRef);
        if (openIdxRef.current !== null) scheduleClose();
    }, [items, cancelClose, openSubmenuForIdx, scheduleClose]);

    const pointerInSafeArea = (p: { x: number; y: number }): boolean => {
        const apex = exitPointRef.current;
        const fly = subMenuRef.current;
        if (!apex || !fly || openIdxRef.current === null) return false;
        return inSafeTriangle(apex, fly.getBoundingClientRect(), p);
    };

    const deferHover = (i: number) => {
        pendingHoverRef.current = i;
        cancelClose();
        clearTimer(graceTimerRef);
        graceTimerRef.current = setTimeout(() => {
            const pending = pendingHoverRef.current;
            if (pending !== null) applyRowHover(pending);
        }, SAFE_AREA_GRACE);
    };

    const onRowMouseEnter = (i: number, e: React.MouseEvent) => {
        const open = openIdxRef.current;
        if (open !== null && open !== i && pointerInSafeArea({ x: e.clientX, y: e.clientY })) {
            deferHover(i);
            return;
        }
        applyRowHover(i);
    };

    const onRowMouseLeave = (i: number, e: React.MouseEvent) => {
        // Not opened yet: the pointer only passed over it.
        if (openIdxRef.current !== i) { clearTimer(openTimerRef); return; }
        // The leave event's own coordinates are already on the next row, so
        // the apex is the last point seen over THIS row.
        exitPointRef.current = lastPointRef.current ?? { x: e.clientX, y: e.clientY };
    };

    const onMenuMouseMove = (e: React.MouseEvent) => {
        lastPointRef.current = { x: e.clientX, y: e.clientY };
        const pending = pendingHoverRef.current;
        if (pending === null) return;
        if (pointerInSafeArea({ x: e.clientX, y: e.clientY })) deferHover(pending); // still heading there
        else applyRowHover(pending);
    };

    const onFlyoutMouseEnter = React.useCallback(() => {
        cancelClose();
        clearTimer(openTimerRef);
        clearTimer(graceTimerRef);
        pendingHoverRef.current = null;
    }, [cancelClose]);

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
        const firstIdx = items.findIndex(it => isActionItem(it) && !it.disabled);
        if (firstIdx !== -1) {
            setFocusedIdx(firstIdx);
            // Defer until after the layout effect positions the menu.
            requestAnimationFrame(() => btnRefs.current[firstIdx]?.focus());
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // useDismissOnOutsideClick accepts a predicate so we can cover BOTH the
    // main menu and the flyout. Without this, clicking a role item in the
    // flyout is seen as an outside click → onClose fires on mousedown → the
    // click is swallowed before onSelect ever runs.
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
        () => items.map((it, i) => ({ it, i })).filter(({ it }) => isActionItem(it)),
        [items],
    );

    const moveFocus = React.useCallback((delta: 1 | -1) => {
        if (openIdxRef.current !== null) closeSubmenu();
        clearTimer(openTimerRef);
        const cur = focusedIdx ?? -1;
        const eligible = actionItems.filter(({ it }) => !('disabled' in it && it.disabled));
        if (!eligible.length) return;
        const curPos = eligible.findIndex(({ i }) => i === cur);
        const nextPos = (curPos + delta + eligible.length) % eligible.length;
        const nextIdx = eligible[nextPos].i;
        setFocusedIdx(nextIdx);
        btnRefs.current[nextIdx]?.focus();
    }, [focusedIdx, actionItems, closeSubmenu]);

    const moveFocusToEdge = React.useCallback((edge: 'start' | 'end') => {
        if (openIdxRef.current !== null) closeSubmenu();
        clearTimer(openTimerRef);
        const eligible = actionItems.filter(({ it }) => !('disabled' in it && it.disabled));
        if (!eligible.length) return;
        const nextIdx = edge === 'start' ? eligible[0].i : eligible[eligible.length - 1].i;
        setFocusedIdx(nextIdx);
        btnRefs.current[nextIdx]?.focus();
    }, [actionItems, closeSubmenu]);

    const select = (item: ActionItem, i: number) => {
        if (item.disabled) return;
        if (hasFlyout(item)) {
            // A click opens the flyout at once (no hover delay), without
            // moving focus — the same as hovering long enough.
            if (openIdxRef.current !== i) openSubmenuForIdx(i, false);
            return;
        }
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
    let subMenuNode: React.ReactNode = null;
    if (activeParentItem && isActionItem(activeParentItem)) {
        const common: FlyoutCommonProps = {
            rowTop: submenuRowTop!,
            parentLeft: pos.left,
            exiting,
            onClose: closeSubmenu,
            onCloseAll: requestClose,
            onMouseEnter: onFlyoutMouseEnter,
            forwardRef: subMenuRef,
            autoFocus: submenuViaKey,
        };
        if (activeParentItem.flyout) {
            subMenuNode = (
                <PanelFlyout
                    key={openSubmenuIdx}
                    {...common}
                    render={activeParentItem.flyout}
                    width={activeParentItem.flyoutWidth ?? MENU_WIDTH}
                    label={activeParentItem.flyoutLabel ?? activeParentItem.label}
                />
            );
        } else if (activeParentItem.submenu?.length) {
            subMenuNode = <SubMenu key={openSubmenuIdx} {...common} items={activeParentItem.submenu} />;
        }
    }

    const mainMenu = (
        <div
            ref={mainRef}
            role="menu"
            aria-orientation="vertical"
            className={`ctxm${exiting ? ' exit' : ''}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH, maxWidth: '90vw', zIndex: 10009 }}
            onContextMenu={(e) => e.preventDefault()}
            onMouseMove={onMenuMouseMove}
            onKeyDown={(e) => {
                if (e.key === 'ArrowDown')  { e.preventDefault(); moveFocus(1); }
                if (e.key === 'ArrowUp')    { e.preventDefault(); moveFocus(-1); }
                if (e.key === 'Home')       { e.preventDefault(); moveFocusToEdge('start'); }
                if (e.key === 'End')        { e.preventDefault(); moveFocusToEdge('end'); }
                if (e.key === 'ArrowRight' && focusedIdx !== null) {
                    const it = items[focusedIdx];
                    if (it && hasFlyout(it) && isActionItem(it) && !it.disabled) {
                        e.preventDefault();
                        openSubmenuForIdx(focusedIdx, true);
                    }
                }
                if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    if (openSubmenuIdx !== null) closeSubmenu();
                    else requestClose();
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
                const opensFlyout   = hasFlyout(item);
                const isSubmenuOpen = opensFlyout && openSubmenuIdx === i;
                return (
                    <MenuRow
                        key={i}
                        item={item}
                        focused={focusedIdx === i}
                        picked={pickedIdx === i}
                        submenuOpen={isSubmenuOpen}
                        btnRef={el => { btnRefs.current[i] = el; }}
                        onMouseEnter={(e) => onRowMouseEnter(i, e)}
                        onMouseLeave={(e) => onRowMouseLeave(i, e)}
                        onFocus={() => setFocusedIdx(i)}
                        onClick={() => select(item, i)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                if (item.disabled) return;
                                if (opensFlyout) {
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
