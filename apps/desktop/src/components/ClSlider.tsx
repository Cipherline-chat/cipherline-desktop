import React, { useCallback, useEffect, useRef, useState } from 'react';
import { resolveSliderReset, useSliderResetHint } from './sliderReset';

interface ClSliderProps {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    formatLabel?: (v: number) => string;
    /**
     * The setting's default. When given, double-clicking the slider commits it
     * through the same `onChange` a drag uses, and the slider shows a
     * "Double-click to reset" hint. Omit it for a slider with no meaningful
     * default.
     */
    resetValue?: number;
    disabled?: boolean;
    className?: string;
    style?: React.CSSProperties;
    /** Accessible name, for a slider with no visible <label> pointing at it. */
    ariaLabel?: string;
    /** Human-readable value for screen readers (e.g. "0:12.4"). */
    ariaValueText?: string;
}

/**
 * Slider — guide markup verbatim (`.cls` > `.sbody` > `.strk`/`.sfill`/`.sthw`
 * > `.ssh`/`.sth`, sibling `.sbub`) with the guide's iOS rubber-band physics:
 * overflow stretch on `.sbody`, thumb squash keyed to drag speed, snap-back on
 * release. Generalised over min/max/step for app use; styles in cl-kit.css.
 *
 * Visual position is updated via direct DOM refs on every pointer event —
 * no React setState in the hot path — so the fill and thumb track the pointer
 * with zero scheduler latency. Parent onChange fires via requestAnimationFrame
 * (≤60fps) and once more synchronously on release.
 */
export const ClSlider: React.FC<ClSliderProps> = ({
    value, min, max, step = 1, onChange,
    formatLabel, resetValue, disabled, className, style, ariaLabel, ariaValueText,
}) => {
    const [grabbing, setGrabbing] = useState(false);
    const [snapping, setSnapping] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLSpanElement>(null);
    const fillRef = useRef<HTMLSpanElement>(null);
    const thumbWrapRef = useRef<HTMLSpanElement>(null);
    const bubbleRef = useRef<HTMLSpanElement>(null);
    const thumbRef = useRef<HTMLSpanElement>(null);
    const isGrabRef = useRef(false);
    const lastXRef = useRef(0);
    const relaxRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dragValueRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    // Always-current onChange so RAF closures never go stale.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const canReset = resolveSliderReset(resetValue, min, max, disabled) !== null;
    const hint = useSliderResetHint(canReset);
    const { anchorRef: hintAnchorRef } = hint;
    const setRoot = useCallback((node: HTMLDivElement | null) => {
        rootRef.current = node;
        hintAnchorRef(node);
    }, [hintAnchorRef]);

    const reduced = typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const pct = Math.min(Math.max(((value - min) / (max - min)) * 100, 0), 100);
    const label = formatLabel ? formatLabel(value) : String(Math.round(value));

    useEffect(() => () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    }, []);

    const snap = useCallback((v: number) => {
        const snapped = Math.round((v - min) / step) * step + min;
        return Math.min(Math.max(snapped, min), max);
    }, [min, max, step]);

    // Paint a value straight onto the DOM — fill, thumb, bubble, aria. The
    // slider is deliberately not driven by React state while the pointer is
    // down, so anything that changes the value outside a drag (a double-click
    // reset) must repaint here too: a parent that debounces its write, or hands
    // in a snapshot `value` (the call-bar context menu), would otherwise never
    // re-render the slider to the value it was just reset to.
    const paintValue = useCallback((v: number) => {
        const newPct = `${((v - min) / (max - min)) * 100}%`;
        if (fillRef.current)     fillRef.current.style.width = newPct;
        if (thumbWrapRef.current) thumbWrapRef.current.style.left = newPct;
        if (bubbleRef.current) {
            bubbleRef.current.style.left = newPct;
            bubbleRef.current.textContent = formatLabel ? formatLabel(v) : String(Math.round(v));
        }
        rootRef.current?.setAttribute('aria-valuenow', String(v));
    }, [min, max, formatLabel]);

    const applyFromX = useCallback((clientX: number) => {
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const raw = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
        const newValue = snap(min + raw * (max - min));

        // Synchronous DOM updates — no React render cycle, no scheduler delay.
        paintValue(newValue);

        dragValueRef.current = newValue;

        // Propagate to parent at most once per animation frame.
        if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                if (dragValueRef.current !== null) {
                    onChangeRef.current(dragValueRef.current);
                }
            });
        }

        let px = 0;
        if (clientX < r.left) px = clientX - r.left;
        else if (clientX > r.right) px = clientX - r.right;
        const ov = px === 0 ? 0 : Math.sign(px) * 12 * (1 - Math.exp(-Math.abs(px) / 55));
        const body = bodyRef.current;
        if (body) {
            if (ov !== 0 && !reduced) {
                const a = Math.min(Math.abs(ov), 12);
                const sx = 1 + a / 240;
                const sy = 1 - (a / 12) * 0.3;
                body.style.transformOrigin = `${ov > 0 ? 'left' : 'right'} center`;
                body.style.transform = `scaleX(${sx.toFixed(4)}) scaleY(${sy.toFixed(3)})`;
            } else {
                body.style.transform = '';
            }
        }
    }, [min, max, snap, reduced, paintValue]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        hint.closeHint();
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        isGrabRef.current = true;
        lastXRef.current = e.clientX;
        if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
        setSnapping(false);
        setGrabbing(true);
        applyFromX(e.clientX);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!isGrabRef.current || disabled) return;
        applyFromX(e.clientX);
        const th = thumbRef.current;
        if (th && !reduced) {
            const v = Math.min(Math.abs(e.clientX - lastXRef.current) * 0.014, 0.28);
            lastXRef.current = e.clientX;
            th.style.transform = `translateY(1px) scaleX(${(1.12 + v).toFixed(3)}) scaleY(${(0.95 - v * 0.5).toFixed(3)})`;
            if (relaxRef.current) clearTimeout(relaxRef.current);
            relaxRef.current = setTimeout(() => {
                if (isGrabRef.current && th) th.style.transform = '';
            }, 90);
        }
    };

    const release = () => {
        if (!isGrabRef.current) return;
        isGrabRef.current = false;

        // Cancel pending RAF and commit the final value synchronously.
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        const finalValue = dragValueRef.current;
        dragValueRef.current = null;
        if (finalValue !== null) onChangeRef.current(finalValue);

        setGrabbing(false);
        setSnapping(true);
        if (bodyRef.current) bodyRef.current.style.transform = '';
        if (thumbRef.current) thumbRef.current.style.transform = '';
        snapTimerRef.current = setTimeout(() => setSnapping(false), 520);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { onChange(snap(value + step)); e.preventDefault(); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { onChange(snap(value - step)); e.preventDefault(); }
    };

    // A double-click is pointerdown/up, pointerdown/up, THEN dblclick — so by
    // the time this runs the two clicks have already moved the thumb to the
    // clicked spot and committed that value (release() fires onChange). This
    // runs last, so the default is the final value any debounced save lands on.
    const onDoubleClick = () => {
        const target = resolveSliderReset(resetValue, min, max, disabled);
        if (target === null) return;
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        dragValueRef.current = null;
        paintValue(target);
        if (bodyRef.current) bodyRef.current.style.transform = '';
        onChangeRef.current(target);
    };

    return (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <div
                ref={setRoot}
                className={[
                    'cls',
                    grabbing ? 'grab' : '',
                    snapping ? 'snap' : '',
                    className ?? '',
                ].filter(Boolean).join(' ')}
                style={{ ...(disabled ? { opacity: 0.4, pointerEvents: 'none' } : null), ...style }}
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={value}
                aria-label={ariaLabel}
                aria-valuetext={ariaValueText}
                aria-disabled={disabled}
                aria-describedby={hint.describedBy}
                {...hint.handlers}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={release}
                onPointerCancel={release}
                onKeyDown={onKeyDown}
                onDoubleClick={onDoubleClick}
            >
                <span ref={bodyRef} className="sbody">
                    <span className="strk" />
                    <span ref={fillRef} className="sfill" style={{ width: `${pct}%` }} />
                    <span ref={thumbWrapRef} className="sthw" style={{ left: `${pct}%` }}>
                        <span className="ssh" />
                        <span ref={thumbRef} className="sth" />
                    </span>
                </span>
                <span ref={bubbleRef} className="sbub" style={{ left: `${pct}%` }}>{label}</span>
            </div>
            {hint.tip}
        </span>
    );
};

export default ClSlider;
