import React, { useEffect, useState } from 'react';
import { activeSeason, flakeCount, makeFlakes } from '../utils/seasonal';

/**
 * SeasonalLayer — ambient marine snow during its date window (see
 * utils/seasonal.ts for why marine snow specifically, and for the window).
 *
 * Renders nothing at all outside the window, under reduced motion, or when
 * the user has switched it off, so the common case for eleven months of the
 * year is a single null return.
 *
 * It re-checks the date on an hourly tick rather than only at mount: this app
 * is a desktop client people leave running for days, so a mount-time-only
 * check would mean the effect appears or disappears whenever they next happen
 * to restart, not when the date actually turns over.
 */

const HOUR_MS = 60 * 60 * 1000;

export const SeasonalLayer: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    const [season, setSeason] = useState(() => activeSeason(new Date()));
    const [flakes, setFlakes] = useState(() => makeFlakes(flakeCount(window.innerWidth)));

    // Date rollover for long-running sessions.
    useEffect(() => {
        const t = setInterval(() => setSeason(activeSeason(new Date())), HOUR_MS);
        return () => clearInterval(t);
    }, []);

    // Re-tier the field on resize, matching AuthScreen's bubble field.
    useEffect(() => {
        if (!season || !enabled) return;
        let last = flakeCount(window.innerWidth);
        const onResize = () => {
            const next = flakeCount(window.innerWidth);
            if (next !== last) { last = next; setFlakes(makeFlakes(next)); }
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [season, enabled]);

    if (!enabled || !season) return null;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;

    return (
        <div className="season-layer" aria-hidden="true">
            {flakes.map((f, i) => (
                <span
                    key={i}
                    className="season-flake"
                    style={{
                        left: f.left,
                        width: f.size,
                        height: f.size,
                        // Custom properties rather than inline animation shorthand
                        // so the keyframes stay in CSS where the perf contract is
                        // documented alongside them.
                        ['--dur' as string]: f.dur,
                        ['--delay' as string]: f.delay,
                        ['--drift' as string]: f.drift,
                        ['--peak' as string]: String(f.opacity),
                    }}
                />
            ))}
        </div>
    );
};
