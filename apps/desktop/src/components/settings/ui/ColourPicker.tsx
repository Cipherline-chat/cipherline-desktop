import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pipette } from 'lucide-react';
import { useEscape } from '../../../hooks/useEscape';
import { useDismissOnOutsideClick } from '../../../hooks/useDismissOnOutsideClick';
import { clamp, hexToHsv, hsvToHex, normalizeHex, type Hsv } from '../../../utils/colourMath';
import { pushRecentColour, useRecentColours } from '../../../utils/recentColours';
import { HueSlider } from './HueSlider';
import '../../../styles/colour-picker.css';

/**
 * Cipherline's own colour picker - it replaces the native OS
 * `<input type="color">` (a different, off-brand dialog on every platform).
 *
 *  - `ColourPickerPanel`: the picker itself. It fills the width it is given:
 *    a saturation/brightness area, the hue slider (HueSlider: a big hit area,
 *    a thumb you can see on any colour, one change per frame while dragging),
 *    the colour + hex field + an eyedropper (Chromium's EyeDropper: pick any
 *    pixel on screen, e.g. your banner in the preview), then swatch rows:
 *    "From your banner" (suggested, when given), presets, recent.
 *  - `ColourSwatchButton`: a round swatch that opens the panel in a popover
 *    portaled to <body>, same behaviour as PickerPopover (under or above the
 *    trigger, above Settings modals, Escape closes only the popover, focus
 *    goes in on open and back to the trigger on close).
 *
 * State is kept as HSV so dragging saturation or brightness to 0 never loses
 * the hue. Everything is keyboard operable; every control is a real slider /
 * button / input with an accessible name.
 */

const BRAND_PRESETS: readonly string[] = [
    '#25e0c8', '#3bead6', '#5e8ee0', '#ffc94d', '#ff6b5e', '#ff8fb1', '#4ade80', '#a78bfa', '#f4f7ff', '#243056',
];

const FALLBACK = '#25e0c8';

export interface ColourPickerPanelProps {
    /** '#rrggbb' lowercase (uppercase / invalid tolerated; invalid -> the fallback '#25e0c8'). */
    value: string;
    /** Live: fires while dragging (at most once per frame), for live previews. */
    onChange: (hex: string) => void;
    /** The swatch row. Defaults to the brand palette. */
    presets?: readonly string[];
    /** Accessible group name, e.g. "Primary colour". */
    label: string;
    /** Show the "Recent" row when there are recents. Default true. */
    showRecent?: boolean;
    /** Colours suggested for this context (e.g. taken from your banner), drawn first. */
    suggested?: readonly string[];
    /** The suggested row's label. Default "Suggested". */
    suggestedLabel?: string;
}

/** HSV for a hex, keeping `keepHue` when the colour has no hue of its own (grey / black). */
function hsvFromHex(hex: string, keepHue: number): Hsv {
    const hsv = hexToHsv(hex) ?? { h: 0, s: 0, v: 0 };
    return hsv.s === 0 || hsv.v === 0 ? { ...hsv, h: keepHue } : hsv;
}

const pct = (n: number): number => Math.round(n * 100);
const HEX_PREFIX_OK = /^#?[0-9a-f]{0,6}$/i;

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperCtor | null =>
    (typeof window !== 'undefined' && typeof (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper === 'function')
        ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper : null;

export const ColourPickerPanel: React.FC<ColourPickerPanelProps> = ({
    value, onChange, presets = BRAND_PRESETS, label, showRecent = true, suggested, suggestedLabel = 'Suggested',
}) => {
    const valueHex = normalizeHex(value) ?? FALLBACK;
    const [hsv, setHsv] = useState<Hsv>(() => hsvFromHex(valueHex, 0));
    const [prevValue, setPrevValue] = useState(valueHex);
    // A new `value` from outside (a parent preset, a reset) re-seeds the area;
    // our own onChange echoing back is the same hex, so it does not.
    if (valueHex !== prevValue) {
        setPrevValue(valueHex);
        if (valueHex !== hsvToHex(hsv)) setHsv(hsvFromHex(valueHex, hsv.h));
    }
    const current = hsvToHex(hsv);

    const [draft, setDraft] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);
    const dragging = useRef(false);
    const recents = useRecentColours();
    const ids = useId();

    // One change per frame while dragging the area (the live previews re-render once per frame).
    const raf = useRef<number | null>(null);
    const pending = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; });
    useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);
    const emitSoon = (hex: string) => {
        pending.current = hex;
        if (raf.current !== null) return;
        raf.current = requestAnimationFrame(() => {
            raf.current = null;
            if (pending.current) onChangeRef.current(pending.current);
        });
    };

    const apply = (next: Hsv, soon = false) => {
        setHsv(next);
        setDraft(null);
        setSubmitted(false);
        if (soon) emitSoon(hsvToHex(next)); else onChange(hsvToHex(next));
    };
    const pick = (hex: string) => apply(hsvFromHex(hex, hsv.h));

    // ── the saturation / brightness area ─────────────────────────────────────
    const fromSvPointer = (e: React.PointerEvent<HTMLDivElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        const s = r.width > 0 ? clamp((e.clientX - r.left) / r.width, 0, 1) : hsv.s;
        const v = r.height > 0 ? 1 - clamp((e.clientY - r.top) / r.height, 0, 1) : hsv.v;
        apply({ ...hsv, s, v }, true);
    };
    const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();               // no text selection while dragging
        e.currentTarget.focus({ preventScroll: true });
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable (synthetic event) */ }
        dragging.current = true;
        fromSvPointer(e);
    };
    const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragging.current) return;
        dragging.current = false;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* nothing held */ }
    };
    const onSvKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        // Steps are added to the exact value (not a rounded percent), so Left then Right lands back where it started.
        const step = e.shiftKey ? 0.1 : 0.01;
        let { s, v } = hsv;
        switch (e.key) {
            case 'ArrowLeft': s -= step; break;
            case 'ArrowRight': s += step; break;
            case 'ArrowUp': v += step; break;
            case 'ArrowDown': v -= step; break;
            default: return;
        }
        e.preventDefault();
        e.stopPropagation();
        apply({ ...hsv, s: clamp(s, 0, 1), v: clamp(v, 0, 1) });
    };

    // ── hex field ────────────────────────────────────────────────────────────
    const shown = draft ?? current.slice(1);
    const draftHex = draft === null ? null : normalizeHex(draft);
    const invalid = draft !== null && draftHex === null && (submitted || !HEX_PREFIX_OK.test(draft.trim()));
    const commitDraft = () => {
        if (draft === null) return;
        if (draftHex) apply(hsvFromHex(draftHex, hsv.h));
        else setSubmitted(true);
    };

    const presetList = useMemo(() => {
        const out: string[] = [];
        for (const p of presets) { const n = normalizeHex(p); if (n && !out.includes(n)) out.push(n); }
        return out;
    }, [presets]);
    const suggestedList = useMemo(() => {
        const out: string[] = [];
        for (const p of suggested ?? []) { const n = normalizeHex(p); if (n && !out.includes(n)) out.push(n); }
        return out;
    }, [suggested]);

    const Dropper = eyeDropper();
    const sample = async () => {
        if (!Dropper) return;
        try {
            const r = await new Dropper().open();
            const n = normalizeHex(r.sRGBHex);
            if (n) pick(n);
        } catch { /* cancelled */ }
    };

    const hueOnly = hsvToHex({ h: hsv.h, s: 1, v: 1 });

    const swatch = (hex: string) => (
        <button
            key={hex}
            type="button"
            className="cp-swatch"
            aria-label={`Use ${hex}`}
            aria-pressed={hex === current}
            title={hex}
            style={{ background: hex }}
            onClick={() => pick(hex)}
        />
    );

    return (
        <div className="cp-panel" role="group" aria-label={label}>
            {/* The two overlay gradients (white -> clear, clear -> black) ARE the saturation/value model. */}
            <div
                className="cp-sv"
                role="slider"
                tabIndex={0}
                aria-label={`${label}: saturation and brightness`}
                aria-roledescription="2D slider"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct(hsv.s)}
                aria-valuetext={`saturation ${pct(hsv.s)}%, brightness ${pct(hsv.v)}%`}
                style={{ backgroundColor: hueOnly }}
                onPointerDown={startDrag}
                onPointerMove={(e) => { if (dragging.current) fromSvPointer(e); }}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onSvKey}
            >
                <span className="cp-thumb" aria-hidden="true" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }} />
            </div>

            <HueSlider
                className="cp-hue"
                label={`${label}: hue`}
                value={hsv.h}
                max={360}
                track="pure"
                onChange={(h) => apply({ ...hsv, h })}
            />

            <div className="cp-hexrow">
                <span className="cp-chip" aria-hidden="true" style={{ background: current }} />
                <label className="cp-hexfield" data-invalid={invalid ? '' : undefined}>
                    <span className="cp-hash" aria-hidden="true">#</span>
                    <input
                        id={`${ids}-hex`}
                        className="cp-hex"
                        type="text"
                        inputMode="text"
                        spellCheck={false}
                        autoComplete="off"
                        maxLength={7}
                        aria-label={`${label}: hex value`}
                        aria-invalid={invalid || undefined}
                        value={shown}
                        onChange={(e) => {
                            const text = e.target.value;
                            setDraft(text);
                            setSubmitted(false);
                            // A full 6-digit value is unambiguous: preview it live.
                            if (/^#?[0-9a-f]{6}$/i.test(text.trim())) {
                                const n = normalizeHex(text);
                                if (n) apply(hsvFromHex(n, hsv.h));
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            e.stopPropagation();
                            commitDraft();
                        }}
                        onBlur={() => {
                            if (draft === null) return;
                            if (draftHex) apply(hsvFromHex(draftHex, hsv.h));
                            else { setDraft(null); setSubmitted(false); }   // never coerce garbage: put the real value back
                        }}
                    />
                </label>
                {Dropper && (
                    <button type="button" className="cp-drop" onClick={() => void sample()} aria-label="Pick a color from the screen" title="Pick a color from the screen (your banner, your avatar...)">
                        <Pipette size={15} aria-hidden="true" />
                    </button>
                )}
            </div>

            {suggestedList.length > 0 && (
                <div className="cp-row">
                    <p className="cp-eyebrow">{suggestedLabel}</p>
                    <div className="cp-swatches" role="group" aria-label={suggestedLabel}>{suggestedList.map(swatch)}</div>
                </div>
            )}

            {presetList.length > 0 && (
                <div className="cp-row">
                    {(suggestedList.length > 0 || (showRecent && recents.length > 0)) && <p className="cp-eyebrow">Presets</p>}
                    <div className="cp-swatches" role="group" aria-label="Preset colors">{presetList.map(swatch)}</div>
                </div>
            )}

            {showRecent && recents.length > 0 && (
                <div className="cp-row">
                    <p className="cp-eyebrow">Recent</p>
                    <div className="cp-swatches" role="group" aria-label="Recent colors">{recents.map(swatch)}</div>
                </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────────

export interface ColourSwatchButtonProps extends Omit<ColourPickerPanelProps, 'onChange'> {
    /** Live while open (optional). */
    onChange?: (hex: string) => void;
    /** Once, when the popover closes with a value different from the one it opened with. */
    onCommit: (hex: string) => void;
    disabled?: boolean;
    /** Trigger swatch size in px. Default 32. */
    size?: number;
    /** aria-label for the trigger. Default `${label}: ${value}`. */
    triggerLabel?: string;
    /** Custom trigger content (else a round swatch of `value`). */
    children?: React.ReactNode;
    /** Extra class on the trigger (e.g. `cp-trigger--dashed` for a "+" add-colour look). */
    className?: string;
}

const PANEL_W = 264;
const GAP = 6;
const EDGE = 12;

type Placement = { top?: number; bottom?: number; left: number; maxHeight: number };

export const ColourSwatchButton: React.FC<ColourSwatchButtonProps> = ({
    value, label, presets, showRecent, onChange, onCommit, disabled, size = 32, triggerLabel, children, className,
}) => {
    const valueHex = normalizeHex(value) ?? FALLBACK;
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<Placement | null>(null);
    const [z, setZ] = useState(9999);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const panelId = useId();

    const openRef = useRef(false);
    const openedWith = useRef(valueHex);
    const latest = useRef<string | null>(null);
    const onCommitRef = useRef(onCommit);
    useEffect(() => { onCommitRef.current = onCommit; });

    /** Commit the final colour once, if it differs from the one the popover opened with. */
    const settle = useCallback(() => {
        if (!openRef.current) return;
        openRef.current = false;
        const l = latest.current;
        latest.current = null;
        if (l && l !== openedWith.current) {
            onCommitRef.current(l);
            pushRecentColour(l);
        }
    }, []);
    const close = useCallback((returnFocus: boolean) => {
        settle();
        setOpen(false);
        if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    }, [settle]);
    // Settings closing underneath an open popover must not lose the pick.
    useEffect(() => settle, [settle]);

    useEscape(() => close(true), open);
    const isInside = useCallback((t: Node) => !!(triggerRef.current?.contains(t) || panelRef.current?.contains(t)), []);
    useDismissOnOutsideClick(isInside, open, () => close(false));

    const place = useCallback(() => {
        const t = triggerRef.current;
        if (!t) return;
        const r = t.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.min(PANEL_W, vw - EDGE * 2);
        const left = Math.max(EDGE, Math.min(r.left, vw - w - EDGE));
        const below = vh - r.bottom - GAP - EDGE;
        const above = r.top - GAP - EDGE;
        if (below >= 340 || below >= above) setPos({ top: r.bottom + GAP, left, maxHeight: Math.max(160, below) });
        else setPos({ bottom: vh - r.top + GAP, left, maxHeight: Math.max(160, above) });
        let maxZ = 9999;
        document.querySelectorAll<HTMLElement>('.mod.open').forEach((el) => {
            const zi = parseInt(getComputedStyle(el).zIndex, 10);
            if (!Number.isNaN(zi) && zi > maxZ) maxZ = zi;
        });
        setZ(maxZ + 1);
    }, []);

    useLayoutEffect(() => { if (open) place(); }, [open, place]);
    useEffect(() => {
        if (!open) return;
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
    }, [open, place]);

    // Move focus into the panel (the area) once it is placed.
    const placed = !!pos;
    useEffect(() => {
        if (!open || !placed) return;
        const raf = requestAnimationFrame(() => {
            const el = panelRef.current;
            if (!el || el.contains(document.activeElement)) return;
            (el.querySelector<HTMLElement>('.cp-sv') ?? el).focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(raf);
    }, [open, placed]);

    const toggle = () => {
        if (open) { close(true); return; }
        openRef.current = true;
        openedWith.current = valueHex;
        latest.current = null;
        setPos(null);
        setOpen(true);
    };

    const handleChange = useCallback((hex: string) => {
        latest.current = hex;
        onChange?.(hex);
    }, [onChange]);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className={className ? `cp-trigger ${className}` : 'cp-trigger'}
                style={{ width: size, height: size }}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-label={triggerLabel ?? `${label}: ${valueHex}`}
                disabled={disabled}
                onClick={toggle}
            >
                {children ?? <span className="cp-trigger-fill" aria-hidden="true" style={{ background: valueHex }} />}
            </button>
            {open && createPortal(
                <div
                    ref={panelRef}
                    id={panelId}
                    role="dialog"
                    aria-label={label}
                    tabIndex={-1}
                    className="cp-pop"
                    style={{ position: 'fixed', zIndex: z, left: pos?.left ?? 0, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden' }}
                    onBlur={(e) => {
                        // Tabbing out of the panel closes it.
                        const next = e.relatedTarget as Node | null;
                        if (next && !panelRef.current?.contains(next) && !triggerRef.current?.contains(next)) close(false);
                    }}
                >
                    <ColourPickerPanel value={valueHex} onChange={handleChange} presets={presets} label={label} showRecent={showRecent} />
                </div>,
                document.body,
            )}
        </>
    );
};
