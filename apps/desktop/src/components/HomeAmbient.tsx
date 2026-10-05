import React, { useEffect, useRef, useState } from 'react';
import { moteCount, makeMotes } from '../utils/homeAmbient';

/**
 * HomeAmbient — bioluminescent motes rising through the home deck. The
 * inverse of SeasonalLayer's marine snow (which falls, app-wide, in
 * December); this rises, lives only inside the home pane, and runs
 * year-round behind its own "Home ambience" toggle.
 *
 * Same perf contract as the seasonal layer (documented at its CSS): the only
 * animated properties are transform and opacity, the container is
 * contain:strict + pointer-events:none, the field is deterministic (no
 * random — identical every mount), negative delays start it mid-drift, and
 * the count is clamped by the PANE's width (ResizeObserver — the home pane
 * is a drag-resized flex child, so window width is the wrong measure).
 *
 * Renders nothing under reduced motion or when toggled off.
 */

export const HomeAmbient: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const [motes, setMotes] = useState(() => makeMotes(moteCount(1080)));

    useEffect(() => {
        if (!enabled) return;
        const el = hostRef.current?.parentElement;
        if (!el) return;
        let last = -1;
        const ro = new ResizeObserver(entries => {
            const w = entries[0]?.contentRect.width ?? 0;
            const next = moteCount(w);
            if (next !== last) { last = next; setMotes(makeMotes(next)); }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [enabled]);

    if (!enabled) return null;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;

    return (
        <div ref={hostRef} className="hd-ambient" aria-hidden="true">
            {motes.map((m, i) => (
                <span
                    key={i}
                    className="hd-mote"
                    style={{
                        left: `${m.left}%`,
                        width: m.size,
                        height: m.size,
                        ['--dur' as string]: `${m.duration}s`,
                        ['--delay' as string]: `${m.delay}s`,
                        ['--drift' as string]: `${m.drift}px`,
                        ['--peak' as string]: String(m.opacity),
                    }}
                />
            ))}
        </div>
    );
};

export default HomeAmbient;
