import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { wordmarkSide } from './wordmarkSide';
import { TinyKeys } from './TinyKeys';
import { createClickBurst } from '../utils/clickBurst';
import { recordEggFound } from '../utils/eggProgress';
import '../styles/titlebar-lap.css';

/** The egg id, counted when Keys sets off. */
export const TITLEBAR_LAP_EGG = 'titlebar-lap';
/** How long the lap (or, under reduced motion, the still cameo) stays up. */
export const LAP_MS = 6200;
export const LAP_STILL_MS = 2200;

const prefersReducedMotion = (): boolean => {
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
};

/**
 * "Cipherline" text mark for the custom title bar (no logo icon — the rail
 * already carries the mascot). Rendered INSIDE the drag region as a plain
 * flex child, unselectable. Left on Windows/Linux, right on macOS — see
 * wordmarkSide.ts for why.
 *
 * Hidden egg: click the mark ten times within four seconds and a tiny Keys swims
 * a lap along the title bar (once, then a 12 s rest). To receive clicks at all
 * the word itself is carved out of the drag region (`no-drag`, and above the
 * app's full-width drag strip): everything else in the bar still drags the
 * window, only the ~70 px of the word does not. Under reduced motion Keys does
 * not swim: he appears still beside the word for a couple of seconds.
 * Counted as the `titlebar-lap` egg.
 */
export const TitleBarWordmark: React.FC = () => {
    const side = wordmarkSide(window.electronAPI?.platform, navigator.userAgent);
    const burst = useRef(createClickBurst());
    const [lap, setLap] = useState<null | 'swim' | 'still'>(null);

    const onClick = useCallback(() => {
        if (!burst.current.hit(Date.now())) return;
        recordEggFound('titlebar-lap');
        setLap(prefersReducedMotion() ? 'still' : 'swim');
    }, []);

    useEffect(() => {
        if (!lap) return;
        const t = window.setTimeout(() => setLap(null), lap === 'swim' ? LAP_MS : LAP_STILL_MS);
        return () => window.clearTimeout(t);
    }, [lap]);

    return (
        <>
            <span
                className={`cl-titlebar-wordmark is-clickable${side === 'right' ? ' ml-auto' : ''}`}
                data-testid="titlebar-wordmark"
                data-side={side}
                aria-hidden
                onClick={onClick}
            >
                Cipherline
            </span>
            {lap && typeof document !== 'undefined' && ReactDOM.createPortal(
                <div className={`tb-lap tb-lap--${lap} tb-lap--from-${side}`} data-testid="titlebar-lap" aria-hidden="true">
                    <div className="tb-lap-keys"><div className="tb-lap-bob"><TinyKeys /></div></div>
                </div>,
                document.body,
            )}
        </>
    );
};

export default TitleBarWordmark;
