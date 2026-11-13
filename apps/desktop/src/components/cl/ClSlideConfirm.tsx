import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Slide-to-confirm — a deliberate, hard-to-trigger-by-accident confirmation for
 * destructive actions (first use: a founding member cancelling, which loses the
 * founding price for good). Shared by the desktop app and the website account
 * portal (via the `@app-cl` alias), so it uses inline styles + design tokens
 * only, no app stylesheet and no extra dependency.
 *
 * Only a COMPLETED slide calls `onConfirm`, exactly once. Ways to complete it:
 *   - pointer (mouse, touch, pen): drag the thumb to the end of the track; let
 *     go short of the end and it springs back, nothing happens;
 *   - keyboard: focus the thumb (role="slider") and HOLD Enter or Space for
 *     `holdMs` (releasing early resets it), or press the arrow keys to walk it
 *     to the end (Home / Left back off). End deliberately does NOT jump there.
 * Reduced motion: no spring-back / fill animation, the position just changes.
 */
export interface ClSlideConfirmProps {
    /** Text on the track ("Slide to cancel"). */
    label: string;
    /** Accessible name of the slider ("Slide to cancel and lose founding price"). */
    ariaLabel: string;
    onConfirm: () => void;
    /** While true the control shows `busyLabel` and ignores input. When it drops
     *  back to false (the action failed) the thumb resets so it can be retried. */
    busy?: boolean;
    busyLabel?: string;
    disabled?: boolean;
    /** How long Enter / Space must be held. */
    holdMs?: number;
    /** Keyboard arrow step, as a fraction of the track. */
    step?: number;
    'data-testid'?: string;
}

const THUMB = 48;
const PAD = 4;
/** Fraction of the track that counts as "reached the end" for a drag. */
const DRAG_COMMIT = 0.96;

function prefersReducedMotion(): boolean {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export const ClSlideConfirm: React.FC<ClSlideConfirmProps> = ({
    label, ariaLabel, onConfirm, busy = false, busyLabel = 'Working…', disabled = false,
    holdMs = 1500, step = 0.1, 'data-testid': testId,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    /** 0..1 */
    const [progress, setProgress] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [holding, setHolding] = useState(false);
    const [focused, setFocused] = useState(false);
    const confirmedRef = useRef(false);
    const dragRef = useRef<{ startX: number; startP: number; pointerId: number } | null>(null);
    const holdRef = useRef<{ raf: number; start: number } | null>(null);
    const reduced = prefersReducedMotion();
    const inert = disabled || busy;

    const travel = useCallback(() => {
        const w = trackRef.current?.clientWidth ?? 0;
        return Math.max(1, w - THUMB - PAD * 2);
    }, []);

    const commit = useCallback(() => {
        if (confirmedRef.current) return;
        confirmedRef.current = true;
        setProgress(1);
        onConfirm();
    }, [onConfirm]);

    const stopHold = useCallback(() => {
        if (holdRef.current) cancelAnimationFrame(holdRef.current.raf);
        holdRef.current = null;
        setHolding(false);
    }, []);

    // A failed action (busy true -> false) hands the control back, reset.
    const wasBusy = useRef(busy);
    useEffect(() => {
        if (wasBusy.current && !busy) { confirmedRef.current = false; setProgress(0); }
        wasBusy.current = busy;
    }, [busy]);

    useEffect(() => () => { if (holdRef.current) cancelAnimationFrame(holdRef.current.raf); }, []);

    /* ── pointer ── */
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (inert || confirmedRef.current) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / old engines */ }
        dragRef.current = { startX: e.clientX, startP: progress, pointerId: e.pointerId };
        setDragging(true);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const p = Math.min(1, Math.max(0, d.startP + (e.clientX - d.startX) / travel()));
        setProgress(p);
    };
    const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        const p = Math.min(1, Math.max(0, d.startP + (e.clientX - d.startX) / travel()));
        if (p >= DRAG_COMMIT) commit();
        else setProgress(0);               // short of the end: spring back, nothing sent
    };

    /* ── keyboard ── */
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (inert || confirmedRef.current) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            if (e.repeat || holdRef.current) return;
            setHolding(true);
            const start = performance.now();
            const from = progress;
            const tick = () => {
                const t = (performance.now() - start) / holdMs;
                const p = Math.min(1, from + t * (1 - from));
                setProgress(p);
                if (p >= 1) { holdRef.current = null; setHolding(false); commit(); return; }
                if (holdRef.current) holdRef.current.raf = requestAnimationFrame(tick);
            };
            holdRef.current = { raf: requestAnimationFrame(tick), start };
            return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            const p = Math.min(1, Math.round((progress + step) * 1000) / 1000);
            if (p >= 1) commit(); else setProgress(p);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            setProgress(Math.max(0, Math.round((progress - step) * 1000) / 1000));
        } else if (e.key === 'Home') {
            e.preventDefault();
            setProgress(0);
        }
    };
    const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && holdRef.current) {
            stopHold();
            if (!confirmedRef.current) setProgress(0);   // let go early: nothing sent
        }
    };

    const animate = !reduced && !dragging && !holding;
    const pct = Math.round(progress * 100);
    const thumbLeft = `calc(${PAD}px + (100% - ${THUMB + PAD * 2}px) * ${progress})`;

    return (
        <div
            ref={trackRef}
            data-testid={testId}
            data-progress={pct}
            style={{
                position: 'relative', height: THUMB + PAD * 2, borderRadius: 999, userSelect: 'none', touchAction: 'none',
                background: 'var(--cl-surface)', border: '1px solid rgba(255,107,94,.35)', overflow: 'hidden',
                opacity: disabled ? 0.5 : 1,
            }}
        >
            {/* fill behind the thumb */}
            <div
                aria-hidden
                style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `calc(${THUMB + PAD * 2}px + (100% - ${THUMB + PAD * 2}px) * ${progress})`,
                    background: 'rgba(255,107,94,.16)', borderRadius: 999,
                    transition: animate ? 'width .32s cubic-bezier(.3,1.3,.5,1)' : 'none',
                }}
            />
            {/* track label, fades as the thumb covers it */}
            <div
                aria-hidden
                style={{
                    position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', paddingLeft: THUMB,
                    fontWeight: 800, fontSize: 14.5, letterSpacing: '.01em', color: 'var(--cl-flash)',
                    opacity: busy ? 1 : Math.max(0, 1 - progress * 1.6), pointerEvents: 'none',
                }}
            >
                {busy ? busyLabel : label}
            </div>
            {/* thumb */}
            <div
                role="slider"
                tabIndex={inert ? -1 : 0}
                aria-label={ariaLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={busy ? busyLabel : pct >= 100 ? 'Confirmed' : `${pct}%. Slide to the end, hold Enter, or use the arrow keys to confirm.`}
                aria-disabled={inert || undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onFocus={() => setFocused(true)}
                onBlur={() => { setFocused(false); if (holdRef.current) { stopHold(); if (!confirmedRef.current) setProgress(0); } }}
                style={{
                    position: 'absolute', top: PAD, left: thumbLeft, width: THUMB, height: THUMB, borderRadius: 999,
                    display: 'grid', placeItems: 'center', cursor: inert ? 'default' : dragging ? 'grabbing' : 'grab',
                    background: 'var(--cl-flash)', color: '#2A0B07',
                    boxShadow: focused ? '0 0 0 3px var(--cl-deep), 0 0 0 5px var(--cl-flash)' : '0 2px 0 rgba(0,0,0,.35)',
                    transition: animate ? 'left .32s cubic-bezier(.3,1.3,.5,1)' : 'none', outline: 'none',
                }}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12h12" /><path d="m13 6 6 6-6 6" />
                </svg>
            </div>
        </div>
    );
};
