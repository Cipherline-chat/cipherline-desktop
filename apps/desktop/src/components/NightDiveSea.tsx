import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    NIGHT_DIVE_EVENT, DEPTH_ATTR, DEPTH_NIGHT, TRANSITION_MS, bubbleSpecs, moteSpecs, transitionKind,
    type NightDiveDetail, type TransitionKind,
} from '../utils/nightDive';
import { useAmbientMotion } from '../hooks/useAmbientMotion';

/**
 * The deep sea the app floats in after midnight, and the slow descent into it.
 *
 * A single fixed layer at z-index -1 in the ROOT stacking context: it paints
 * above the canvas and below every in-flow box, so it is behind ALL content by
 * construction and can never cover a message, a card or a control. While it is
 * mounted, `<html data-nd-sea>` is set and styles/night-dive.css turns the
 * window's own water (Dashboard root, the drift row, the chat sheet)
 * transparent so this layer shows through, and the main views' backgrounds
 * become a translucent tint over it. Panels, cards, inputs, buttons, borders,
 * accents and text are untouched.
 *
 * Mounted while it is night, and for the ~5.8 s of an ascent at 05:00 (whose
 * final frame IS the day look, so unmounting it is invisible). The descent and
 * ascent are one-shot transform/opacity animations on this layer only: the
 * daylight glow sinks away upward, the night sea rises into place, a few
 * shafts of surface light dim and recede, and a handful of bubbles drift up
 * behind the content. Under prefers-reduced-motion nothing animates and the
 * background swaps instantly. A few very slow motes live in the night sea;
 * they follow the Home ambience switch and stop with the idle-motion gate.
 *
 * aria-hidden, pointer-events:none, no text.
 */

/** Set on <html> while the sea layer is mounted. */
export const SEA_ATTR = 'data-nd-sea';

const prefersReducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
const isNightNow = () => document.documentElement.getAttribute(DEPTH_ATTR) === DEPTH_NIGHT;

export const NightDiveSea: React.FC = () => {
    const [night, setNight] = useState(isNightNow);
    const [run, setRun] = useState<{ id: number; kind: TransitionKind } | null>(null);
    const seq = useRef(0);
    const timer = useRef<number | undefined>(undefined);
    const bubbles = useMemo(() => bubbleSpecs(), []);
    const motes = useMemo(() => moteSpecs(), []);
    const [ambientOn] = useAmbientMotion();

    useEffect(() => {
        const onEvent = (e: Event) => {
            const detail = (e as CustomEvent<NightDiveDetail>).detail;
            setNight(detail.active);
            const kind = transitionKind(detail);
            window.clearTimeout(timer.current);
            if (!kind || prefersReducedMotion()) { setRun(null); return; }
            setRun({ id: ++seq.current, kind });
            timer.current = window.setTimeout(() => setRun(null), TRANSITION_MS);
        };
        window.addEventListener(NIGHT_DIVE_EVENT, onEvent);
        return () => {
            window.removeEventListener(NIGHT_DIVE_EVENT, onEvent);
            window.clearTimeout(timer.current);
        };
    }, []);

    const mounted = night || run !== null;

    // Same commit as the portal, before paint: the window's own water turns
    // transparent in exactly the frame this layer appears (and back again).
    useLayoutEffect(() => {
        const root = document.documentElement;
        if (mounted) root.setAttribute(SEA_ATTR, '');
        else root.removeAttribute(SEA_ATTR);
        return () => root.removeAttribute(SEA_ATTR);
    }, [mounted]);

    if (!mounted) return null;
    return createPortal(
        <div
            className="nds"
            data-run={run?.kind}
            aria-hidden="true"
            data-testid="night-dive-sea"
        >
            <div className="nds-dayglow" />
            <div className="nds-night"><div className="nds-moon" /><div className="nds-vignette" /></div>
            {run && <div key={`s${run.id}`} className="nds-shafts"><i /><i /><i /><i /></div>}
            {ambientOn && (
                <div className="nds-motes">
                    {motes.map((m, i) => (
                        <i
                            key={i}
                            style={{
                                left: `${m.x}%`, width: m.size, height: m.size,
                                ['--dx' as string]: `${m.dx}px`, ['--peak' as string]: String(m.peak),
                                animationDuration: `${m.dur}s`, animationDelay: `${m.delay}s`,
                            }}
                        />
                    ))}
                </div>
            )}
            {run && (
                <div key={`b${run.id}`} className="nds-bubbles">
                    {bubbles.map((b, i) => (
                        <i
                            key={i}
                            style={{
                                left: `${b.x}%`, width: b.size, height: b.size,
                                ['--dx' as string]: `${b.dx}px`, ['--rise' as string]: `${-b.rise}vh`,
                                animationDelay: `${b.delay}ms`, animationDuration: `${b.dur}ms`,
                            }}
                        />
                    ))}
                </div>
            )}
        </div>,
        document.body,
    );
};
