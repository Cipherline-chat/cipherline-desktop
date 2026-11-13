import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A temporary override for the composer's placeholder (the empty-send crash,
 * write-then-erase and arrow-up-shrug lines).
 *
 * The override lives in React state and is rendered through the textarea's own
 * `placeholder` prop, so when it expires the prop simply falls back to the
 * normal line. The old implementation poked the DOM directly
 * (`setAttribute` then `removeAttribute('placeholder')`) and relied on "React's
 * prop wins again on the next render" -- but React only writes an attribute
 * when the prop VALUE changes, so after the first flash the attribute stayed
 * removed and the composer showed no placeholder at all until the prop
 * happened to change (e.g. staging a file). One slot, one timer: a second
 * flash replaces the first instead of stacking.
 */
export function useFlashedPlaceholder(): readonly [string | null, (line: string, ms?: number) => void] {
    const [flashed, setFlashed] = useState<string | null>(null);
    const timer = useRef(0);
    const flash = useCallback((line: string, ms = 2400) => {
        window.clearTimeout(timer.current);
        setFlashed(line);
        timer.current = window.setTimeout(() => setFlashed(null), ms);
    }, []);
    useEffect(() => () => window.clearTimeout(timer.current), []);
    return [flashed, flash] as const;
}
