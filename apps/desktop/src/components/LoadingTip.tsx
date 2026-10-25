/**
 * LoadingTip: the one short line under the loading screen's status text (a tip
 * or something dry; the lines are in utils/loadingTips.ts), changing every
 * TIP_MS with a gentle fade.
 *
 * It never delays or blocks boot: it is a single absolutely-positioned DOM
 * node, aria-hidden (the status line is what a screen reader hears), and one
 * chained timeout per line, only while `running`. The fade is a CSS
 * transform/opacity animation (styles/app-loading.css, `lo-tip`), so a busy
 * main thread cannot stutter it. The position in the list comes from the wait
 * clock, not from this component's mount time, so the App -> HydrationGate
 * handoff remount continues the same line rather than restarting the cycle.
 *
 * Reduced motion: one static line, no timer, no animation.
 */
import React, { useEffect, useState } from 'react';
import { TIP_MS, pickTipStart, tipAt } from '../utils/loadingTips';
import { now } from './loadingWait';

/** Where in the list this launch begins. Chosen once per renderer so a handoff remount agrees. */
let tipStart: number | null = null;
const startIndex = (): number => (tipStart ??= pickTipStart());

interface Props {
    /** performance.now() at which the wait began (loadingWait's beginWait). */
    t0: number;
    /** Rotate. False once the app is loaded or a game is up: the line holds still, no timer. */
    running: boolean;
    reduced: boolean;
}

export const LoadingTip: React.FC<Props> = ({ t0, running, reduced }) => {
    const [, setTick] = useState(0);
    const elapsed = reduced ? 0 : Math.max(0, now() - t0);

    useEffect(() => {
        if (!running || reduced) return;
        const intoLine = Math.max(0, now() - t0) % TIP_MS;
        const timer = window.setTimeout(() => setTick(t => t + 1), Math.max(50, TIP_MS - intoLine));
        return () => window.clearTimeout(timer);
    });

    const text = tipAt(elapsed, startIndex());
    const step = Math.floor(elapsed / TIP_MS);
    return (
        <div className={`lo-tip${reduced ? ' is-still' : ''}`} aria-hidden="true">
            <div
                key={reduced ? 'still' : step}
                className="lo-tip-line"
                style={{ ['--lo-tip-el' as string]: `${((elapsed % TIP_MS) / 1000).toFixed(3)}s` }}
            >
                {text}
            </div>
        </div>
    );
};

export default LoadingTip;
