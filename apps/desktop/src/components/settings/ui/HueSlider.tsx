import React, { useEffect, useRef, useState } from 'react';
import '../../../styles/colour-picker.css';

/**
 * The hue slider (owner: "the color slider is bad", 2026-10-24). One
 * component for the colour picker's hue track and the decoration / effect
 * "Color" option, so both feel the same:
 *
 *  - A 32px-tall hit area around a 14px track: you can grab it anywhere, not
 *    just on a hairline.
 *  - A 24px thumb filled with the colour it stands for, a light ring and a
 *    dark outer ring, so it reads on any part of the spectrum. It grows a
 *    little while dragged.
 *  - Pointer capture: the drag keeps going outside the track; the change is
 *    emitted at most once per frame (the live previews re-render once per
 *    frame, not per mouse event).
 *  - Keyboard: arrows 1 step (Shift 10), Page Up/Down 30, Home/End.
 *  - `track="tint"` paints the track in the exact tint the option produces
 *    (hsl(h 78% 62%) - utils/profileCosmetics hueTint), so what you see on the
 *    track is what lands on the card.
 */

export interface HueSliderProps {
    /** Degrees. */
    value: number;
    onChange: (deg: number) => void;
    /** Fired once when a drag ends (or after a key). */
    onCommit?: (deg: number) => void;
    label: string;
    valueText?: string;
    /** 'pure' = full-saturation hues (the colour picker); 'tint' = the cosmetic option's tint. */
    track?: 'pure' | 'tint';
    /** Highest value (360 for the picker, 359 for a cosmetic option). */
    max?: number;
    disabled?: boolean;
    /** Unset state (e.g. "Match theme"): the thumb is drawn hollow. */
    unset?: boolean;
    /** Double-click resets (a cosmetic option goes back to "Match theme"). */
    onReset?: () => void;
    className?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const hueColour = (deg: number, track: 'pure' | 'tint') =>
    (track === 'tint' ? `hsl(${Math.round(deg)} 78% 62%)` : `hsl(${Math.round(deg)} 100% 50%)`);

export const HueSlider: React.FC<HueSliderProps> = ({
    value, onChange, onCommit, label, valueText, track = 'pure', max = 360, disabled, unset, onReset, className,
}) => {
    const v = clamp(value, 0, max);
    const [drag, setDrag] = useState<number | null>(null);
    const shown = drag ?? v;
    const raf = useRef<number | null>(null);
    const pending = useRef<number | null>(null);
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; });
    useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);

    const emit = (deg: number) => {
        pending.current = deg;
        if (raf.current !== null) return;
        raf.current = requestAnimationFrame(() => {
            raf.current = null;
            if (pending.current !== null) onChangeRef.current(pending.current);
        });
    };
    const fromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        return r.width > 0 ? Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * max) : v;
    };
    const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
        const d = fromPointer(e);
        setDrag(d);
        emit(d);
    };
    const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (drag === null) return;
        const d = fromPointer(e);
        setDrag(d);
        emit(d);
    };
    const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (drag === null) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not held */ }
        const d = pending.current ?? drag;
        if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null; }
        onChangeRef.current(d);
        pending.current = null;
        setDrag(null);
        onCommit?.(d);
    };
    const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const step = e.shiftKey ? 10 : 1;
        let n = v;
        switch (e.key) {
            case 'ArrowLeft': case 'ArrowDown': n -= step; break;
            case 'ArrowRight': case 'ArrowUp': n += step; break;
            case 'PageDown': n -= 30; break;
            case 'PageUp': n += 30; break;
            case 'Home': n = 0; break;
            case 'End': n = max; break;
            default: return;
        }
        e.preventDefault();
        e.stopPropagation();
        n = clamp(n, 0, max);
        onChange(n);
        onCommit?.(n);
    };

    const stops = Array.from({ length: 7 }, (_, i) => hueColour((i * max) / 6, track)).join(', ');
    return (
        <div
            className={`hs${className ? ` ${className}` : ''}`}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={Math.round(shown)}
            aria-valuetext={valueText ?? `${Math.round(shown)} degrees`}
            aria-disabled={disabled || undefined}
            data-dragging={drag !== null ? 'true' : undefined}
            data-unset={unset ? 'true' : undefined}
            style={{ ['--hs-p' as string]: String(shown / max), ['--hs-c' as string]: hueColour(shown, track), ['--hs-track' as string]: `linear-gradient(90deg, ${stops})` } as React.CSSProperties}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey}
            onDoubleClick={onReset && !disabled ? () => onReset() : undefined}
            title={onReset ? 'Double-click to reset' : undefined}
        >
            <span className="hs-track" aria-hidden="true" />
            <span className="hs-thumb" aria-hidden="true" />
        </div>
    );
};

export default HueSlider;
