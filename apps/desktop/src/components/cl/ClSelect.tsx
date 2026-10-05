import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical } from 'lucide-react';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useEscape } from '../../hooks/useEscape';
import { playIco } from '../../utils/clPhysics';
import { DRAG_THRESHOLD_PX, computeReorderDropIndex, applyReorderDrop } from './reorderMath';

export interface ClSelectOption<T extends string> {
    value: T;
    label: React.ReactNode;
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
}

/** Opens-without-picking before the chevron shrugs (catalog). */
const SHRUG_AT = 4;
/** `.sel.open .chev`'s rotate-back transition is .35s — wait it out. */
const CHEV_SETTLE_MS = 360;

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
    options, value, onChange, placeholder, disabled, className, style, ariaLabel, reorder,
}: ClSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState<T | null>(null);
    const [swapping, setSwapping] = useState(false);
    const [hl, setHl] = useState(-1);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

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
            setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
        }
        let maxZ = 9999;
        document.querySelectorAll<HTMLElement>('.mod.open').forEach((el) => {
            const z = parseInt(getComputedStyle(el).zIndex, 10);
            if (!Number.isNaN(z) && z > maxZ) maxZ = z;
        });
        setMenuZ(maxZ + 1);
    }, []);

    useEffect(() => {
        if (open) {
            setMenuMounted(true);
            const r = requestAnimationFrame(() => setMenuShown(true));
            return () => cancelAnimationFrame(r);
        }
        setMenuShown(false);
        const t = setTimeout(() => setMenuMounted(false), 200);
        return () => clearTimeout(t);
    }, [open]);

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
    useEffect(() => {
        if (!open) { setHl(-1); return; }
        const idx = Math.max(0, options.findIndex((o) => o.value === value));
        setHl(idx);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (open && hl >= 0) optRefs.current[hl]?.scrollIntoView({ block: 'nearest' });
    }, [open, hl]);

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
                        if (!open) calcMenuPos();
                        setOpen((v) => !v);
                    }}
                    onKeyDown={onTriggerKey}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-label={ariaLabel}
                >
                    <span className={swapping ? 'swap' : undefined}>{selected ? selected.label : (placeholder ?? 'Select…')}</span>
                    <Chev ref={chevRef} />
                </button>
            </div>
            {menuMounted && menuPos && createPortal(
                <div className="cl-kit">
                    <div
                        ref={menuRef}
                        className={`selm cl-portal${menuShown ? ' open' : ''}`}
                        role="listbox"
                        style={{
                            position: 'fixed',
                            top: menuPos.top,
                            left: menuPos.left,
                            width: menuPos.width,
                            right: 'auto',  // override CSS `right: 0`
                            zIndex: menuZ,
                        }}
                    >
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
                        {options.map((o, i) => {
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
                                        aria-selected={isOn}
                                        className={[isOn ? 'on' : '', picked === o.value ? 'picked' : ''].filter(Boolean).join(' ')}
                                        style={{
                                            ...(hl === i ? { background: 'rgba(37,224,200,.1)', color: 'var(--cl-text)' } : undefined),
                                            ...(isDraggingThis ? { opacity: 0.35 } : undefined),
                                            ...(draggableRow ? { cursor: isDraggingThis ? 'grabbing' : 'grab', touchAction: 'none' } : undefined),
                                        }}
                                        onMouseEnter={() => { if (!dragStateRef.current) setHl(i); }}
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
                    </div>
                </div>,
                document.body,
            )}
        </span>
    );
}

export default ClSelect;
