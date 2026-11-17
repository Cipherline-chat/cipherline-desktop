import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, Search } from 'lucide-react';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useEscape } from '../../hooks/useEscape';
import { playIco } from '../../utils/clPhysics';
import { computeSelectPlacement } from './selectPlacement';
import { DRAG_THRESHOLD_PX, computeReorderDropIndex, applyReorderDrop } from './reorderMath';
import { ClSearch } from './ClInput';

export interface ClSelectOption<T extends string> {
    value: T;
    label: React.ReactNode;
    /** What the closed trigger shows when this option is selected. Defaults
     *  to `label`; set it when the menu row is richer (two lines, a clock…)
     *  than fits the single-line, ellipsizing trigger. */
    triggerLabel?: React.ReactNode;
}

/**
 * Opt-in search box at the top of the open menu (type to filter). Omitting
 * the prop leaves `ClSelect` exactly as it was. With it, the menu becomes a
 * combobox: focus moves into the search field on open (and is held there —
 * Tab doesn't leave the popover), arrows / PageUp / PageDown move the
 * highlight, Enter picks, Escape closes and returns focus to the trigger, and
 * typing a character on the focused, closed trigger opens the menu with that
 * character already searched.
 */
export interface ClSelectSearchConfig<T extends string> {
    /** Filter (and optionally rank) for a non-empty query. */
    filter: (options: ClSelectOption<T>[], query: string) => ClSelectOption<T>[];
    placeholder?: string;
    /** Accessible name for the search field. Defaults to the placeholder. */
    ariaLabel?: string;
    /** Shown in place of the rows when nothing matches. */
    emptyText?: (query: string) => React.ReactNode;
    /** Fixed row height in px. When set, the list is windowed: only the rows
     *  in view (plus a small overscan) are mounted, so a several-hundred-row
     *  list opens and filters without a long task. Every row must render at
     *  exactly this height (ClSelect pins it inline). */
    rowHeight?: number;
}

/**
 * Opt-in drag-to-reorder for the open option list (see `computeReorderDropIndex`
 * / `applyReorderDrop` below for the pure math). Omitting this prop entirely
 * leaves `ClSelect` exactly as it was — this is additive, not a mode switch.
 */
export interface ClSelectReorderConfig<T extends string> {
    /** True for a value that can neither be picked up NOR be displaced from
     *  its slot by another option landing on/after it — e.g. Cipherline's
     *  `@everyone` role, which must always stay pinned last as the implicit
     *  base role. Assumes locked values are TRAILING in `options` (true for
     *  every current caller); an interior locked value would only get the
     *  "can't be picked up" half enforced. */
    isLocked: (value: T) => boolean;
    /** Fired once per completed move (pointer drop or keyboard nudge) that
     *  actually changes the order — never for a drag that lands back where
     *  it started. `newOrder` is the full resulting value order; `movedValue`
     *  is the one that relocated, so a caller with its own reorderable
     *  subset (e.g. everything except a pinned trailing value) can do
     *  `mySubset.indexOf(movedValue)` on `newOrder` filtered to that subset
     *  to get a plain "moved to index N" for its own persistence logic. */
    onReorder: (movedValue: T, newOrder: T[]) => void;
    /** Plain-text name for aria-live move announcements. Defaults to the
     *  raw value when omitted (fine for plain-text options; supply this
     *  when `label` is a rich node like a colour swatch + name). */
    describeValue?: (value: T) => string;
}

interface ClSelectProps<T extends string> {
    options: ClSelectOption<T>[];
    value: T;
    onChange: (v: T) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    style?: React.CSSProperties;
    /**
     * Accessible name for the trigger button. Optional because most callers
     * already have a visible adjacent `<label>`-style element (see e.g.
     * `ChannelSettingsDialog`'s "Category" `<p>`) that gives the select
     * context — pass this when there isn't one, e.g. an option label that's
     * a rich node (icon/colour swatch + text) rather than plain text a
     * screen reader can read as-is.
     */
    ariaLabel?: string;
    /** Enables drag-to-reorder (+ a keyboard equivalent) inside the open
     *  menu. Omit for a plain select — fully backward compatible. */
    reorder?: ClSelectReorderConfig<T>;
    /** Adds a search box to the menu — see ClSelectSearchConfig. Takes
     *  precedence over `reorder` (reordering a filtered view is meaningless). */
    search?: ClSelectSearchConfig<T>;
    /** Fired when the menu opens / closes (e.g. to refresh live labels). */
    onOpenChange?: (open: boolean) => void;
    /** id for the trigger button, so an external `<label htmlFor>` names it. */
    id?: string;
}

/** Opens-without-picking before the chevron shrugs (catalog). */
const SHRUG_AT = 4;
/** `.sel.open .chev`'s rotate-back transition is .35s — wait it out. */
const CHEV_SETTLE_MS = 360;
/** Searchable menus keep ONE height while you type (no jumping as matches
 *  come and go); the rows scroll beneath the pinned search field. */
const SEARCH_MENU_H = 340;
/** Windowed lists mount this many rows beyond each edge of the view. */
const LIST_OVERSCAN = 6;

let selectSeq = 0;

// Guide SVGs, verbatim.
const Chev = React.forwardRef<SVGSVGElement>((_props, ref) => (
    <svg ref={ref} className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
));
Chev.displayName = 'Chev';
const MChk = () => (
    <svg className="mchk" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--lume)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" /></svg>
);

/**
 * Select — guide markup verbatim: `.sel` > `.selt` trigger (+ `.chev`) and the
 * `.selm` menu that springs open. Picking a row flashes it lume (`.picked` →
 * mflash) then the choice pops into the trigger. Closes on outside click + Esc.
 *
 * The menu uses `position: fixed` + getBoundingClientRect so it escapes any
 * `overflow: hidden` ancestor (e.g. the SettingsModal container).
 */
export function ClSelect<T extends string>({
    options, value, onChange, placeholder, disabled, className, style, ariaLabel, reorder: reorderProp, search, onOpenChange, id,
}: ClSelectProps<T>) {
    const reorder = search ? undefined : reorderProp;
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);
    const [uid] = useState(() => `clsel-${++selectSeq}`);
    // What the menu lists: every option, or (searchable + a query) the matches.
    // Without `search` this is `options` itself, so every index below means
    // exactly what it did before the search feature existed.
    const shown = useMemo(
        () => (search && query.trim() ? search.filter(options, query) : options),
        [search, options, query],
    );
    // Windowing (search.rowHeight): which slice of `shown` is mounted.
    const rowH = search?.rowHeight ?? 0;
    const listRef = useRef<HTMLDivElement>(null);
    const [listScroll, setListScroll] = useState(0);
    const win = rowH
        ? (() => {
            // The list is never taller than the whole menu, so sizing the
            // window by SEARCH_MENU_H can only over-render a row or two (when
            // the menu is clamped by the viewport) — never leave a gap.
            const h = SEARCH_MENU_H;
            const top = Math.max(0, Math.min(listScroll, shown.length * rowH - h));
            const start = Math.max(0, Math.floor(top / rowH) - LIST_OVERSCAN);
            const end = Math.min(shown.length, Math.ceil((top + h) / rowH) + LIST_OVERSCAN);
            return { start, end };
        })()
        : { start: 0, end: shown.length };
    const [picked, setPicked] = useState<T | null>(null);
    const [swapping, setSwapping] = useState(false);
    const [hl, setHl] = useState(-1);
    const [menuPos, setMenuPos] = useState<{ top: number; bottom: number; left: number; width: number; vh: number } | null>(null);
    // Natural (uncapped) menu height, measured after mount so the placement can
    // flip upward / clamp when the trigger is near the bottom of the window.
    const [menuNatH, setMenuNatH] = useState(0);

    // Escape closes the open menu through the shared stack — the trigger's own
    // onKeyDown never sees the press once a layer above it is open (or once
    // this one is), so the branch that used to live in onTriggerKey moved here.
    useEscape(() => setOpen(false), open);
    // ── Drag-to-reorder (opt-in via `reorder`) ──────────────────────────
    // A press-and-hold on an option becomes a drag only past DRAG_THRESHOLD_PX
    // of vertical movement; below that it's a normal click (see
    // handleOptionPointerDown/Move). `dragValue` drives the dimmed "lifted"
    // style on the source row; `dropAt` is the absolute insertion index the
    // indicator bar renders at. `suppressClickRef` stops the click event a
    // completed drag's pointerup still generates (pointer capture forces
    // pointerup — and therefore the synthesized click — back onto the row
    // the drag started on, however far the pointer actually travelled).
    const [dragValue, setDragValue] = useState<T | null>(null);
    const [dropAt, setDropAt] = useState<number | null>(null);
    const [liveMsg, setLiveMsg] = useState('');
    const dragStateRef = useRef<{ pointerId: number; startY: number; fromIndex: number; value: T; dragging: boolean } | null>(null);
    const rowRectsRef = useRef<(DOMRect | null)[]>([]);
    const suppressClickRef = useRef(false);
    // Above whatever open modal this select happens to live inside — modals
    // pick their own overlay z-index ad hoc (1100 up to 100000) to sit above
    // wherever they were opened from, so a hardcoded menu z-index inevitably
    // loses to one of them eventually (a report/kick/upgrade dialog's `.mod`
    // backdrop painted over the menu AND ate its clicks — the picker looked
    // broken). Recomputed on open/scroll/resize against whatever `.mod.open`
    // is on screen right now, so it stays correct as those numbers drift.
    const [menuZ, setMenuZ] = useState(9999);
    // Portaled menu is outside the `.sel.open` ancestor that normally drives
    // the guide's spring, so the open/exit transition is reproduced here:
    // mount closed → flip .open a frame later; on close, keep mounted 200ms
    // with .open removed so the exit transition can play.
    const [menuMounted, setMenuMounted] = useState(false);
    const [menuShown, setMenuShown] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const optRefs = useRef<(HTMLButtonElement | null)[]>([]);

    // ── Chevron shrug (catalog): open the menu repeatedly without picking
    // anything and the chevron shrugs. Driven off the open→closed transition
    // rather than the five separate setOpen call sites, so no close path can
    // be missed. `picked` is flagged by choose() below.
    const chevRef = useRef<SVGSVGElement>(null);
    const emptyClosesRef = useRef(0);
    const pickedWhileOpenRef = useRef(false);
    const shruggedRef = useRef(false);
    const prevOpenRef = useRef(false);
    const shrugTimerRef = useRef(0);
    useEffect(() => {
        const wasOpen = prevOpenRef.current;
        prevOpenRef.current = open;
        if (!wasOpen || open) return;              // only on open → closed
        if (pickedWhileOpenRef.current) {
            pickedWhileOpenRef.current = false;
            emptyClosesRef.current = 0;            // picking resets the streak
            return;
        }
        emptyClosesRef.current++;
        if (emptyClosesRef.current === SHRUG_AT && !shruggedRef.current) {
            shruggedRef.current = true;            // once per mount (rule 6)
            // Delayed: `.sel.open .chev` holds a 180° rotate that transitions
            // back over .35s on close, and @keyframes shrug drives the same
            // property — firing immediately makes the chevron snap.
            shrugTimerRef.current = window.setTimeout(
                () => playIco(chevRef.current, 'shrug'), CHEV_SETTLE_MS,
            );
        }
    }, [open]);
    useEffect(() => () => window.clearTimeout(shrugTimerRef.current), []);

    // The menu is portaled to <body> so a transformed/filtered ancestor (e.g. the
    // onboarding wizard's animated step body) can't capture its position:fixed and
    // fling it off-screen. Since it's no longer a DOM child of wrapRef, the
    // outside-click check must treat BOTH the trigger wrap and the menu as inside.
    const isInsideSelect = useCallback(
        (target: Node) => !!(wrapRef.current?.contains(target) || menuRef.current?.contains(target)),
        [],
    );
    useDismissOnOutsideClick(isInsideSelect, open, () => setOpen(false));

    const selected = options.find((o) => o.value === value);

    const calcMenuPos = useCallback(() => {
        if (triggerRef.current) {
            const r = triggerRef.current.getBoundingClientRect();
            setMenuPos({ top: r.top, bottom: r.bottom, left: r.left, width: r.width, vh: window.innerHeight });
        }
        let maxZ = 9999;
        document.querySelectorAll<HTMLElement>('.mod.open').forEach((el) => {
            const z = parseInt(getComputedStyle(el).zIndex, 10);
            if (!Number.isNaN(z) && z > maxZ) maxZ = z;
        });
        setMenuZ(maxZ + 1);
    }, []);

    const onOpenChangeRef = useRef(onOpenChange);
    useEffect(() => { onOpenChangeRef.current = onOpenChange; });
    const openSeenRef = useRef(false);
    useEffect(() => {
        if (open) openSeenRef.current = true;
        if (openSeenRef.current) onOpenChangeRef.current?.(open);
        if (open) {
            setMenuMounted(true);
            const r = requestAnimationFrame(() => setMenuShown(true));
            return () => cancelAnimationFrame(r);
        }
        // Closing with focus inside the (portaled) menu — the search field, a
        // row — hands it back to the trigger instead of dropping it on <body>.
        // An outside click that put focus somewhere else is left alone.
        const active = document.activeElement;
        if (active && menuRef.current?.contains(active)) triggerRef.current?.focus({ preventScroll: true });
        setMenuShown(false);
        const t = setTimeout(() => setMenuMounted(false), 200);
        return () => clearTimeout(t);
    }, [open]);

    useLayoutEffect(() => {
        const el = menuRef.current;
        if (!menuMounted || !el || search) return;
        // scrollHeight ignores the inline max-height cap; +2 for the border.
        const h = Math.min(280, el.scrollHeight + 2);
        if (h !== menuNatH) setMenuNatH(h);
    }, [menuMounted, menuPos, options.length, menuNatH, search]);

    // Keep the fixed-position menu aligned when the user scrolls or resizes.
    useEffect(() => {
        if (!open) return;
        window.addEventListener('scroll', calcMenuPos, true);
        window.addEventListener('resize', calcMenuPos);
        return () => {
            window.removeEventListener('scroll', calcMenuPos, true);
            window.removeEventListener('resize', calcMenuPos);
        };
    }, [open, calcMenuPos]);

    // On open, seed the highlight at the current value and scroll it into view.
    const scrolledOnOpenRef = useRef(false);
    // While searching, the highlight follows the query: the selected value if
    // it is still listed, else the best (first) match.
    // A searchable list may also be (re)built just AFTER opening — e.g. a
    // caller refreshing live labels from onOpenChange — so for one, a new
    // `options` re-seeds too (and re-centres the selected row), or the
    // highlight would keep pointing at an index into the old list.
    useEffect(() => {
        if (!open) { setHl(-1); return; }
        const idx = Math.max(0, shown.findIndex((o) => o.value === value));
        setHl(idx);
        if (search && !query.trim()) scrolledOnOpenRef.current = false;
    }, [open, query, search ? options : null]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!search && open && hl >= 0) optRefs.current[hl]?.scrollIntoView({ block: 'nearest' });
    }, [open, hl]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!search) return;
        // Searchable lists are long: the selected row opens CENTRED (it may
        // be 200 rows down); moves after that scroll only as far as needed.
        if (!open) { scrolledOnOpenRef.current = false; return; }
        if (hl < 0) return;
        const mode = scrolledOnOpenRef.current ? 'nearest' : 'center';
        if (rowH) {
            // Windowed: the target row may not be mounted, so scroll by
            // arithmetic, and mirror the position into state straight away
            // (the scroll event lands a frame later) so the right slice renders.
            const list = listRef.current;
            if (!list) return;
            const h = list.clientHeight || SEARCH_MENU_H;
            const top = hl * rowH;
            let next = list.scrollTop;
            if (mode === 'center') next = top - (h - rowH) / 2;
            else if (top < next) next = top;
            else if (top + rowH > next + h) next = top + rowH - h;
            next = Math.max(0, Math.min(next, shown.length * rowH - h));
            list.scrollTop = next;
            setListScroll(next);
            scrolledOnOpenRef.current = true;
            return;
        }
        const el = optRefs.current[hl];
        if (!el) return;
        el.scrollIntoView?.({ block: mode });
        scrolledOnOpenRef.current = true;
    }, [open, hl, search, menuMounted, shown, rowH]);

    // Searchable menu: focus the search field once the portal has mounted;
    // the query starts fresh on every open (type-to-search may seed it).
    useEffect(() => {
        if (search && open && menuMounted) searchRef.current?.focus({ preventScroll: true });
    }, [search, open, menuMounted]);

    // Keyboard equivalent of the pointer drag: Alt+Arrow on the highlighted
    // option swaps it with its neighbour. Raw HTML5 drag-and-drop has no
    // keyboard path at all; this keeps reordering reachable without a mouse.
    // Announced via the aria-live region below so the move is audible, not
    // just visible (the highlight following the moved row).
    const announceMove = useCallback((v: T, newIndex: number) => {
        if (newIndex < 0) return;
        const name = reorder?.describeValue ? reorder.describeValue(v) : v;
        setLiveMsg(`Moved ${name} to position ${newIndex + 1} of ${options.length}.`);
    }, [reorder, options.length]);

    const moveByKeyboard = useCallback((index: number, dir: -1 | 1) => {
        if (!reorder) return;
        const opt = options[index];
        if (!opt || reorder.isLocked(opt.value)) return;
        const neighbourIndex = index + dir;
        if (neighbourIndex < 0 || neighbourIndex >= options.length) return;
        if (reorder.isLocked(options[neighbourIndex].value)) return;
        const dropAtAbs = dir === 1 ? index + 2 : index - 1;
        const newOrder = applyReorderDrop(options, index, dropAtAbs);
        if (!newOrder) return;
        reorder.onReorder(opt.value, newOrder);
        setHl(neighbourIndex);
        announceMove(opt.value, neighbourIndex);
    }, [reorder, options, announceMove]);

    const onTriggerKey = (e: React.KeyboardEvent) => {
        if (disabled) return;
        if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                calcMenuPos();
                setQuery('');
                setOpen(true);
            } else if (search && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                // Type-to-search: the keystroke that opens the menu becomes
                // the first character of the query instead of being lost.
                e.preventDefault();
                calcMenuPos();
                setQuery(e.key);
                setOpen(true);
            }
            return;
        }
        if (reorder && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && hl >= 0) {
            e.preventDefault();
            moveByKeyboard(hl, e.key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); setHl((i) => Math.min(options.length - 1, i + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((i) => Math.max(0, i - 1)); }
        else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (hl >= 0 && options[hl]) choose(options[hl].value);
        }
    };

    // ── Pointer-driven drag (mirrors the old rail's dnd-kit PointerSensor
    // distance-activation, hand-rolled here so the drop indicator + the
    // portaled/position:fixed menu stay under our control). setPointerCapture
    // pins all further pointer AND compatibility-mouse events (move/up, and
    // crucially the eventual `click`) to the row the press started on,
    // regardless of where the pointer physically ends up — see
    // `suppressClickRef` above for why that means a completed drag's click
    // must be swallowed explicitly rather than relying on it not firing.
    const handleOptionPointerDown = (e: React.PointerEvent<HTMLButtonElement>, index: number) => {
        if (!reorder || e.button !== 0) return;
        const opt = options[index];
        if (reorder.isLocked(opt.value)) return;
        dragStateRef.current = { pointerId: e.pointerId, startY: e.clientY, fromIndex: index, value: opt.value, dragging: false };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const handleOptionPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
        const st = dragStateRef.current;
        if (!st || st.pointerId !== e.pointerId || !reorder) return;
        if (!st.dragging) {
            if (Math.abs(e.clientY - st.startY) < DRAG_THRESHOLD_PX) return;
            st.dragging = true;
            // Snapshot every row's rect ONCE, before any drag-visual (the
            // dimmed source row, the indicator bar) can shift layout —
            // comparing the live pointer Y against a stable snapshot for the
            // rest of the drag avoids feedback jitter as rows shift to make
            // room for the indicator.
            rowRectsRef.current = optRefs.current.map((el) => el?.getBoundingClientRect() ?? null);
            setDragValue(st.value);
        }
        setDropAt(computeReorderDropIndex(e.clientY, options, rowRectsRef.current, reorder.isLocked));
    };

    const finishOptionDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
        const st = dragStateRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        dragStateRef.current = null;
        const wasDragging = st.dragging;
        const landedAt = dropAt;
        setDragValue(null);
        setDropAt(null);
        if (!wasDragging || !reorder) return;
        suppressClickRef.current = true;
        if (landedAt === null) return;
        const newOrder = applyReorderDrop(options, st.fromIndex, landedAt);
        if (!newOrder) return;
        reorder.onReorder(st.value, newOrder);
        const newIndex = newOrder.indexOf(st.value);
        setHl(newIndex);
        announceMove(st.value, newIndex);
    };

    // Keys in the search field. Escape goes through the shared stack
    // (useEscape above); Tab is swallowed so focus stays in the popover.
    const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const last = shown.length - 1;
        const page = 6;
        if (e.key === 'ArrowDown') { e.preventDefault(); setHl((i) => Math.min(last, i + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((i) => Math.max(0, i - 1)); }
        else if (e.key === 'PageDown') { e.preventDefault(); setHl((i) => Math.min(last, i + page)); }
        else if (e.key === 'PageUp') { e.preventDefault(); setHl((i) => Math.max(0, i - page)); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (hl >= 0 && shown[hl]) choose(shown[hl].value);
        } else if (e.key === 'Tab') {
            e.preventDefault();
        }
    };

    const choose = (v: T) => {
        // Guide order: the row flashes (mflash) for 170ms while the menu is
        // still open and the trigger STILL shows the old label — only when the
        // menu closes does the new choice pop into the trigger (swap). So the
        // parent onChange is deferred to that moment; until then the trigger
        // reads from `value` (unchanged) and the picked row carries the flash.
        setPicked(v);
        pickedWhileOpenRef.current = true;   // this close doesn't count toward the shrug
        setTimeout(() => {
            onChange(v);          // trigger label updates now, together with…
            setSwapping(true);    // …the swap pop, as the menu closes
            setOpen(false);
            setTimeout(() => { setSwapping(false); setPicked(null); }, 420);
        }, 170);
    };

    // Searchable: the rows scroll in their own listbox under the pinned search
    // field. Plain: rows stay direct children of the menu (unchanged DOM).
    const wrapList = (rows: React.ReactNode) => (search
        ? (
            <div
                ref={listRef}
                className="selm-list"
                role="listbox"
                id={`${uid}-list`}
                aria-label={ariaLabel}
                onScroll={rowH > 0 ? (e) => setListScroll(e.currentTarget.scrollTop) : undefined}
            >
                {rows}
            </div>
        )
        : rows);

    return (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <div
                ref={wrapRef}
                className={['sel', open ? 'open' : '', className ?? ''].filter(Boolean).join(' ')}
                style={style}
            >
                <button
                    ref={triggerRef}
                    type="button"
                    className="selt"
                    disabled={disabled}
                    onClick={() => {
                        if (disabled) return;
                        if (!open) { calcMenuPos(); setQuery(''); }
                        setOpen((v) => !v);
                    }}
                    onKeyDown={onTriggerKey}
                    id={id}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-label={ariaLabel}
                >
                    <span className={swapping ? 'swap' : undefined}>{selected ? (selected.triggerLabel ?? selected.label) : (placeholder ?? 'Select…')}</span>
                    <Chev ref={chevRef} />
                </button>
            </div>
            {menuMounted && menuPos && (() => {
                const pl = computeSelectPlacement(
                    { top: menuPos.top, bottom: menuPos.bottom },
                    search ? SEARCH_MENU_H : (menuNatH || Math.min(280, options.length * 38 + 14)),
                    menuPos.vh,
                );
                return createPortal(
                <div className="cl-kit">
                    <div
                        ref={menuRef}
                        className={`selm cl-portal${search ? ' selm--search' : ''}${menuShown ? ' open' : ''}`}
                        role={search ? undefined : 'listbox'}
                        style={{
                            position: 'fixed',
                            ...(pl.openUp ? { top: 'auto', bottom: pl.bottom } : { top: pl.top }),
                            maxHeight: pl.maxHeight,
                            ...(search ? { height: pl.maxHeight } : undefined),
                            left: menuPos.left,
                            width: menuPos.width,
                            right: 'auto',  // override CSS `right: 0`
                            zIndex: menuZ,
                        }}
                    >
                        {search && (
                            <div className="selm-search">
                                <ClSearch
                                    ref={searchRef}
                                    icon={<Search size={15} aria-hidden="true" />}
                                    type="text"
                                    role="combobox"
                                    aria-expanded={open}
                                    aria-controls={`${uid}-list`}
                                    aria-autocomplete="list"
                                    aria-activedescendant={hl >= win.start && hl < win.end ? `${uid}-o-${hl}` : undefined}
                                    aria-label={search.ariaLabel ?? search.placeholder ?? 'Search'}
                                    placeholder={search.placeholder ?? 'Search…'}
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={onSearchKey}
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </div>
                        )}
                        {wrapList(<>
                        {search && shown.length === 0 && (
                            <div className="selm-empty" role="status">
                                {search.emptyText ? search.emptyText(query) : `Nothing matches “${query.trim()}”.`}
                            </div>
                        )}
                        {reorder && (
                            // Visually hidden — announces keyboard AND pointer
                            // moves, since neither is otherwise conveyed to a
                            // screen reader (the visible feedback is the
                            // indicator bar / the highlight following the row).
                            <div
                                aria-live="polite"
                                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
                            >
                                {liveMsg}
                            </div>
                        )}
                        {rowH > 0 && win.start > 0 && (
                            <div aria-hidden="true" style={{ height: win.start * rowH, flex: 'none' }} />
                        )}
                        {(rowH > 0 ? shown.slice(win.start, win.end) : shown).map((o, k) => {
                            const i = win.start + k;   // index into `shown` (win.start is 0 unless windowed)
                            // While picking, only the picked row reads as selected
                            // (guide clears the others on click); otherwise value-based.
                            const isOn = picked !== null ? picked === o.value : value === o.value;
                            const locked = reorder?.isLocked(o.value) ?? false;
                            const draggableRow = !!reorder && !locked;
                            const isDraggingThis = dragValue === o.value;
                            return (
                                <React.Fragment key={o.value}>
                                    {reorder && dropAt === i && (
                                        <div
                                            role="presentation"
                                            style={{ height: 2, margin: '2px 10px', borderRadius: 1, background: 'var(--cl-lume, #25e0c8)', boxShadow: '0 0 6px var(--cl-lume, #25e0c8)' }}
                                        />
                                    )}
                                    <button
                                        ref={(n) => { optRefs.current[i] = n; }}
                                        type="button"
                                        role="option"
                                        id={search ? `${uid}-o-${i}` : undefined}
                                        // Searchable: the search field is the one tab stop
                                        // (the popover's focus trap); rows are reached by
                                        // arrow keys via aria-activedescendant.
                                        tabIndex={search ? -1 : undefined}
                                        aria-selected={isOn}
                                        // Windowed rows: tell AT where this row sits in the full list.
                                        aria-setsize={rowH > 0 ? shown.length : undefined}
                                        aria-posinset={rowH > 0 ? i + 1 : undefined}
                                        className={[isOn ? 'on' : '', picked === o.value ? 'picked' : ''].filter(Boolean).join(' ')}
                                        style={{
                                            ...(rowH > 0 ? { height: rowH, flex: 'none', boxSizing: 'border-box' } : undefined),
                                            ...(hl === i ? { background: 'rgba(37,224,200,.1)', color: 'var(--cl-text)' } : undefined),
                                            ...(isDraggingThis ? { opacity: 0.35 } : undefined),
                                            ...(draggableRow ? { cursor: isDraggingThis ? 'grabbing' : 'grab', touchAction: 'none' } : undefined),
                                        }}
                                        // Searchable lists scroll under a still pointer as
                                        // the arrow keys move; only a REAL pointer move may
                                        // take the highlight, or it would snap back to
                                        // whatever row slid beneath the cursor.
                                        onMouseEnter={search ? undefined : () => { if (!dragStateRef.current) setHl(i); }}
                                        onMouseMove={search ? (e) => { if ((e.movementX || e.movementY) && hl !== i) setHl(i); } : undefined}
                                        onMouseDown={search ? (e) => e.preventDefault() : undefined}
                                        onClick={() => {
                                            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                                            choose(o.value);
                                        }}
                                        onPointerDown={draggableRow ? (e) => handleOptionPointerDown(e, i) : undefined}
                                        onPointerMove={draggableRow ? handleOptionPointerMove : undefined}
                                        onPointerUp={draggableRow ? finishOptionDrag : undefined}
                                        onPointerCancel={draggableRow ? finishOptionDrag : undefined}
                                    >
                                        {reorder ? (
                                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                                                {draggableRow && (
                                                    <GripVertical size={12} aria-hidden="true" style={{ opacity: 0.4, flexShrink: 0 }} />
                                                )}
                                                {o.label}
                                            </span>
                                        ) : o.label}
                                        <MChk />
                                    </button>
                                </React.Fragment>
                            );
                        })}
                        {reorder && dropAt === options.length && (
                            <div
                                role="presentation"
                                style={{ height: 2, margin: '2px 10px', borderRadius: 1, background: 'var(--cl-lume, #25e0c8)', boxShadow: '0 0 6px var(--cl-lume, #25e0c8)' }}
                            />
                        )}
                        {rowH > 0 && win.end < shown.length && (
                            <div aria-hidden="true" style={{ height: (shown.length - win.end) * rowH, flex: 'none' }} />
                        )}
                        </>)}
                    </div>
                </div>,
                document.body,
                );
            })()}
        </span>
    );
}

export default ClSelect;
