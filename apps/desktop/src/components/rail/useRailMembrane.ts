import { useEffect, useRef } from 'react';
import {
    stepMembrane, membraneSettled, membraneShape, initialMembrane,
    type MembraneState, type RestBox,
} from './railMembrane';

/** Checked once: the user asked for less motion, so the indicator jumps. */
const REDUCED = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/**
 * Drives the rail indicator's geometry on requestAnimationFrame, writing
 * STRAIGHT TO THE DOM NODE rather than through React state.
 *
 * Two deliberate choices, both of which were bugs in the first version:
 *
 * NO REACT STATE PER FRAME. The first version called setState every frame,
 * re-rendering Dashboard — a ~7.4k-line component — sixty times a second for
 * the length of every transition. The dropped frames that caused were half of
 * the visible overshoot: the old explicit-Euler integrator diverged as dt
 * grew (107px past the target at 30fps). railMembrane.ts fixed the integrator
 * so a slow frame can no longer overshoot; this removes the reason frames
 * were slow. The mobile reference says setState-per-frame is fine "at this
 * scale, and if it shows up in a profile, write to the node via a ref
 * instead" — on a four-button nav pill it does not show up; here it does.
 *
 * ONE PERSISTENT LOOP, not one per target. The first version keyed its effect
 * on `target`, so every click tore down the rAF and started a new one with a
 * fresh clock. Clicking through the rail quickly meant repeatedly restarting
 * mid-flight, which is what made fast switching look bad. The loop now lives
 * for the life of the component and reads its target from a ref, so a new
 * target is just a new aim — velocity and shape carry straight through, which
 * is the whole reason the membrane is a spring and not a transition.
 */
export function useRailMembrane(
    node: React.RefObject<HTMLElement | null>,
    target: number,
    rest: RestBox | null,
) {
    const targetRef = useRef(target);
    const restRef = useRef(rest);
    const st = useRef<MembraneState>(initialMembrane(target));
    const raf = useRef(0);
    const running = useRef(false);

    const paint = (s: MembraneState) => {
        const el = node.current, r = restRef.current;
        if (!el || !r) return;
        const box = membraneShape(s, targetRef.current, r);
        el.style.top = `${box.top}px`;
        el.style.left = `${box.left}px`;
        el.style.width = `${box.width}px`;
        el.style.height = `${box.height}px`;
        el.style.borderRadius = box.radius;
    };

    // Kept in refs so a re-render never restarts the loop; a changed target is
    // picked up on the very next frame instead.
    useEffect(() => {
        targetRef.current = target;
        restRef.current = rest;
        if (!rest) return;

        if (REDUCED) {
            st.current = initialMembrane(target);
            paint(st.current);
            return;
        }
        // A loop already in flight has just been handed the new aim through
        // the refs above and will pick it up on its next frame — restarting it
        // is what made fast switching look bad.
        if (running.current) return;

        running.current = true;
        let last = performance.now();
        const step = (now: number) => {
            const dt = (now - last) / 1000;
            last = now;
            // No dt clamp: the analytic integrator is exact at any dt, and a
            // clamp would make a slow frame animate in slow motion instead.
            const next = stepMembrane(st.current, targetRef.current,
                restRef.current?.height ?? 0, dt);
            if (membraneSettled(next, targetRef.current)) {
                // Snap so a resting indicator is EXACTLY the tile — at this
                // size a third of a pixel reads as a blurred edge.
                st.current = initialMembrane(targetRef.current);
                paint(st.current);
                running.current = false;
                return;
            }
            st.current = next;
            paint(next);
            raf.current = requestAnimationFrame(step);
        };
        raf.current = requestAnimationFrame(step);
    }, [target, rest, node]);

    useEffect(() => () => {
        cancelAnimationFrame(raf.current);
        running.current = false;
    }, []);
}
