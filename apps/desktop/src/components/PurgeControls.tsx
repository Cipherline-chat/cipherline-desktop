import React, { useState, useRef, useCallback, useId, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Trash2, AlertTriangle } from 'lucide-react';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useEscape } from '../hooks/useEscape';
import { ClButton, ClModal } from './cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText, DialogCallout } from './dialog/DialogFrame';
import '../styles/purge-menu.css';
import { computePurgeMenuPlacement, formatPurgeCount, MENU_MIN_WIDTH, type PurgeMenuPlacement } from '../utils/purgeMenuPlacement';

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export const PURGE_OPTIONS: { ms: number; label: string }[] = [
    { ms: 365 * 24 * 3600 * 1000, label: '1 year' },
    { ms: 182 * 24 * 3600 * 1000, label: '6 months' },
    { ms: 30  * 24 * 3600 * 1000, label: '1 month' },
    { ms: 7   * 24 * 3600 * 1000, label: '1 week' },
    { ms: 0,                      label: 'Everything' },
];

/**
 * Count how many messages in the array WOULD be deleted by a purge with this
 * threshold. Mirrors the filter logic in Dashboard's handlePurgeConversation so
 * the count shown in the confirm modal matches what actually gets deleted.
 * Pending (unsent) messages are never purged.
 */
// eslint-disable-next-line react-refresh/only-export-components, @typescript-eslint/no-explicit-any -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour; untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
export function countMessagesToPurge(messages: any[] | undefined, olderThanMs: number): number {
    if (!Array.isArray(messages)) return 0;
    if (olderThanMs === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
        return messages.filter((m: any) => !m?._pending).length;
    }
    const now = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped REST/WS payload or third-party shape; modelling it is tracked typing debt
    return messages.filter((m: any) => {
        if (m?._pending) return false;
        const t = m?.timestamp ?? m?.sent_at ?? m?.created_at ?? m?.received_at ?? null;
        let ts = typeof t === 'number' ? t : (t ? Date.parse(t) : Date.now());
        if (!Number.isFinite(ts)) ts = Date.now();
        return (now - ts) >= olderThanMs;
    }).length;
}

interface PurgeDropdownProps {
    onSelect: (olderThanMs: number, label: string) => void;
    size?: 'sm' | 'md';
    disabled?: boolean;
    /**
     * The conversation's messages. When given, each row shows how many of them
     * that option would delete (computed lazily, only while the menu is open).
     * Omit it and the rows show no counts.
     */
    messages?: unknown[];
    /** Precomputed counts keyed by `ms` — wins over `messages` when both are given. */
    counts?: Partial<Record<number, number>>;
    /**
     * Lazy per-option count for callers whose messages aren't one array (a
     * server's channels, minus its pins). Runs only while the menu is open;
     * `counts` and `messages` are ignored when it is given.
     */
    countFor?: (olderThanMs: number) => number;
}

/**
 * One-shot menu to pick a purge window. Not a persistent-value selector, so
 * ClSelect doesn't fit — keeps its own open/close state.
 *
 * Trigger: the kit's `.selt` input look (same as the retention selects beside
 * it). Panel: the app's `.ctxm` menu vocabulary (see purge-menu.css), portaled
 * to <body> so the scrolling settings pane can't clip it, placed below the
 * trigger and flipped above when there is no room.
 *
 * Keyboard: ArrowUp/Down (wrapping), Home/End, Enter/Space select, Esc closes
 * and returns focus to the trigger, Tab closes. Focus lands on the first row
 * on open (roving tabindex).
 */
export const PurgeDropdown: React.FC<PurgeDropdownProps> = ({ onSelect, size = 'sm', disabled, messages, counts, countFor }) => {
    const [open, setOpen] = useState(false);
    const [focusedIdx, setFocusedIdx] = useState(0);
    const [placement, setPlacement] = useState<PurgeMenuPlacement | null>(null);
    const [zIndex, setZIndex] = useState(10010);
    const wrapRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const menuId = useId();

    const openMenu = useCallback(() => {
        setPlacement(null);
        setFocusedIdx(0);
        setOpen(true);
    }, []);

    const close = useCallback((returnFocus: boolean) => {
        setOpen(false);
        if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    }, []);

    const isInside = useCallback((target: Node) => !!(
        wrapRef.current?.contains(target) || panelRef.current?.contains(target)
    ), []);
    useDismissOnOutsideClick(isInside, open, () => close(false));
    useEscape(() => close(true), open);

    // Counts are only worth computing while the menu is on screen.
    const rowCounts = useMemo<(number | undefined)[]>(() => {
        if (!open) return PURGE_OPTIONS.map(() => undefined);
        return PURGE_OPTIONS.map(o => {
            if (countFor) return countFor(o.ms);
            if (counts && counts[o.ms] !== undefined) return counts[o.ms];
            return messages ? countMessagesToPurge(messages, o.ms) : undefined;
        });
    }, [open, messages, counts, countFor]);

    const reposition = useCallback(() => {
        const t = triggerRef.current;
        const p = panelRef.current;
        if (!t || !p) return;
        const r = t.getBoundingClientRect();
        const next = computePurgeMenuPlacement(
            { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
            p.scrollHeight + 2, // natural height (content + 1px borders), even while height-capped
            { width: window.innerWidth, height: window.innerHeight },
        );
        setPlacement(prev => (
            prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.side === next.side && prev.maxHeight === next.maxHeight
                ? prev : next
        ));
        // Above whatever open modal the settings pane lives in (see ClSelect).
        let z = 10010;
        document.querySelectorAll<HTMLElement>('.mod.open').forEach(el => {
            const v = parseInt(getComputedStyle(el).zIndex, 10);
            if (!Number.isNaN(v) && v >= z) z = v + 1;
        });
        setZIndex(prev => (prev === z ? prev : z));
    }, []);

    // Measure → place → focus the first row, all before the first paint.
    useLayoutEffect(() => {
        if (!open) return;
        reposition();
        itemRefs.current[0]?.focus({ preventScroll: true });
    }, [open, reposition]);

    useLayoutEffect(() => {
        if (!open) return;
        const onScroll = (e: Event) => {
            if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
            reposition();
        };
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', reposition);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', reposition);
        };
    }, [open, reposition]);

    const focusItem = (idx: number) => {
        setFocusedIdx(idx);
        itemRefs.current[idx]?.focus({ preventScroll: true });
    };

    const choose = (opt: { ms: number; label: string }) => {
        // Hand focus back to the trigger BEFORE the confirm modal opens, so
        // the modal records it as the element to restore on cancel.
        triggerRef.current?.focus({ preventScroll: true });
        setOpen(false);
        onSelect(opt.ms, opt.label);
    };

    const onPanelKeyDown = (e: React.KeyboardEvent) => {
        const last = PURGE_OPTIONS.length - 1;
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); focusItem(focusedIdx >= last ? 0 : focusedIdx + 1); break;
            case 'ArrowUp':   e.preventDefault(); focusItem(focusedIdx <= 0 ? last : focusedIdx - 1); break;
            case 'Home':      e.preventDefault(); focusItem(0); break;
            case 'End':       e.preventDefault(); focusItem(last); break;
            case 'Tab':       close(false); break;
            // Enter activates on keydown; Space on KEYUP, like a native button.
            // Selecting Space on keydown would open the confirm modal (whose
            // destructive button autofocuses) mid-press, and the key's release
            // would then land on — and click — that button.
            case 'Enter':
                e.preventDefault();
                if (!e.repeat) choose(PURGE_OPTIONS[focusedIdx]);
                break;
            case ' ': e.preventDefault(); break;
        }
    };

    const onPanelKeyUp = (e: React.KeyboardEvent) => {
        if (e.key === ' ') { e.preventDefault(); choose(PURGE_OPTIONS[focusedIdx]); }
    };

    const onTriggerKeyDown = (e: React.KeyboardEvent) => {
        if (disabled || open) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); }
    };

    const rows = PURGE_OPTIONS.map((o, i) => {
        const danger = o.ms === 0;
        const count = rowCounts[i];
        const cls = ['ctxm-row', danger ? 'danger' : '', focusedIdx === i ? 'focus' : ''].filter(Boolean).join(' ');
        return (
            <React.Fragment key={o.ms}>
                {danger && <div role="separator" className="ctxm-sep" />}
                <button
                    ref={el => { itemRefs.current[i] = el; }}
                    type="button"
                    role="menuitem"
                    className={cls}
                    tabIndex={focusedIdx === i ? 0 : -1}
                    onMouseEnter={() => focusItem(i)}
                    onFocus={() => setFocusedIdx(i)}
                    onClick={() => choose(o)}
                >
                    {danger && <span className="ci" aria-hidden="true"><Trash2 size={14} /></span>}
                    <span className="clabel">{o.label}</span>
                    {count !== undefined && <span className="ctxm-acc">{formatPurgeCount(count)}</span>}
                </button>
            </React.Fragment>
        );
    });

    return (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <div
                ref={wrapRef}
                className={`sel purge-wrap${open ? ' open' : ''}`}
                style={{ flex: 1, minWidth: 0 }}
            >
                <button
                    ref={triggerRef}
                    type="button"
                    className={`selt purge-trigger${open ? ' open' : ''}${size === 'md' ? ' selt--md' : ''}`}
                    disabled={disabled}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? menuId : undefined}
                    onClick={() => { if (disabled) return; if (open) close(false); else openMenu(); }}
                    onKeyDown={onTriggerKeyDown}
                >
                    <span className="purge-trigger-label">
                        <Trash2 size={14} aria-hidden="true" />
                        <span>Purge older than…</span>
                    </span>
                    <ChevronDown className="chev" size={14} aria-hidden="true" />
                </button>
            </div>
            {open && createPortal(
                <div className="cl-kit">
                    <div
                        ref={panelRef}
                        id={menuId}
                        role="menu"
                        aria-orientation="vertical"
                        aria-label="Purge older than"
                        className="ctxm purge-menu"
                        data-side={placement?.side ?? 'below'}
                        style={{
                            position: 'fixed',
                            top: placement?.top ?? -9999,
                            left: placement?.left ?? -9999,
                            width: placement?.width ?? MENU_MIN_WIDTH,
                            maxWidth: '90vw',
                            ...(placement?.maxHeight !== undefined ? { maxHeight: placement.maxHeight, overflowY: 'auto' as const } : {}),
                            zIndex,
                            ['--purge-origin' as string]: placement?.side === 'above' ? 'bottom left' : 'top left',
                        }}
                        onKeyDown={onPanelKeyDown}
                        onKeyUp={onPanelKeyUp}
                        onContextMenu={e => e.preventDefault()}
                    >
                        {rows}
                    </div>
                </div>,
                document.body,
            )}
        </span>
    );
};

interface PurgeConfirmModalProps {
    count: number;
    /** Human-readable threshold ("1 month", "Everything"). Drives copy. */
    label: string;
    /** Optional chat title to mention in the copy ("…from Alice"). */
    convTitle?: string;
    /**
     * Replaces the "This cannot be undone. Other devices and recipients keep
     * their copies." line, for surfaces where that is not the whole truth (a
     * server's history still exists on the server, pins are kept, …).
     */
    warning?: React.ReactNode;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Confirmation dialog for message purges. Shows the exact count of messages
 * that will be deleted so the user knows the scope before committing.
 */
export const PurgeConfirmModal: React.FC<PurgeConfirmModalProps> = ({ count, label, convTitle, warning, onConfirm, onCancel }) => {
    const isEverything = label === 'Everything';
    const msgNoun = count === 1 ? 'message' : 'messages';

    const accent = (v: React.ReactNode) => <strong style={{ color: 'var(--cl-flash)' }}>{v}</strong>;
    return (
        <ClModal open onClose={onCancel} width={440} label="Purge messages" cardClassName="dlg-card dlg-card--confirm">
            <DialogHeader
                tone={count === 0 ? 'default' : 'danger'}
                icon={<Trash2 size={18} strokeWidth={2.2} />}
                title={count === 0 ? 'Nothing to purge' : 'Purge messages'}
            />
            <DialogBody>
                {count === 0 ? (
                    <DialogText>
                        No messages match <strong>{label}</strong>
                        {convTitle ? <> in <strong>{convTitle}</strong></> : null}. Nothing to delete.
                    </DialogText>
                ) : (
                    <>
                        <DialogText>
                            {isEverything ? (
                                <>This will permanently delete {accent(count.toLocaleString())} {msgNoun}
                                {convTitle ? <> from <strong>{convTitle}</strong></> : null} on this device.</>
                            ) : (
                                <>This will permanently delete {accent(count.toLocaleString())} {msgNoun} older than <strong>{label}</strong>
                                {convTitle ? <> from <strong>{convTitle}</strong></> : null} on this device.</>
                            )}
                        </DialogText>
                        <DialogCallout icon={<AlertTriangle size={14} />}>
                            {warning ?? 'This cannot be undone. Other devices and recipients keep their copies.'}
                        </DialogCallout>
                    </>
                )}
            </DialogBody>
            <DialogFooter>
                {count === 0 ? (
                    <ClButton size="sm" onClick={onCancel}>Close</ClButton>
                ) : (
                    <>
                        <ClButton variant="ghost" size="sm" onClick={onCancel}>Cancel</ClButton>
                        <ClButton variant="danger" size="sm" onClick={onConfirm}>
                            Delete {count.toLocaleString()}
                        </ClButton>
                    </>
                )}
            </DialogFooter>
        </ClModal>
    );
};
