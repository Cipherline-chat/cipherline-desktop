import { useEffect, useState } from 'react';
import {
    NIGHT_DIVE_EVENT, NIGHT_RECHECK_MS, DEPTH_ATTR, DEPTH_NIGHT,
    isNightHour, applyDepth, nightDiveReason,
    type NightDiveDetail,
} from '../utils/nightDive';

/**
 * Binding of utils/nightDive.ts to `<html data-depth>` and to the
 * `cipherline:night-dive` window event. No setting, no storage: it follows the
 * local clock.
 */

/** The last state announced on the event bus (module-level so a StrictMode
 *  remount or a second mount can never re-announce the same state). */
let announced: boolean | null = null;

/**
 * Evaluate the clock and set/clear the root attribute. Called once from
 * main.tsx before first render, so a client launched after midnight paints its
 * very first frame already deep instead of fading in. Does not announce — the
 * mounted runtime does that. Returns the state applied.
 */
export function applyNightDiveNow(): boolean {
    try {
        return applyDepth(document.documentElement, isNightHour(new Date()));
    } catch { return false; }
}

/**
 * Mount once at the app root. Keeps `<html data-depth="night">` in step with
 * the local clock: re-checked every minute and whenever the window regains
 * focus or becomes visible (a laptop waking from sleep fires neither timer
 * promptly nor reliably). Announces `cipherline:night-dive` once at startup
 * (reason 'initial') and then ONLY when the mode flips ('enter' / 'exit').
 */
export function useNightDiveRuntime(): void {
    useEffect(() => {
        const tick = () => {
            const next = applyDepth(document.documentElement, isNightHour(new Date()));
            const reason = nightDiveReason(announced, next);
            if (!reason) return;
            announced = next;
            const detail: NightDiveDetail = { active: next, reason };
            window.dispatchEvent(new CustomEvent<NightDiveDetail>(NIGHT_DIVE_EVENT, { detail }));
        };
        tick();
        const id = window.setInterval(tick, NIGHT_RECHECK_MS);
        const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
        window.addEventListener('focus', tick);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearInterval(id);
            window.removeEventListener('focus', tick);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);
}

/**
 * Is the root currently in night mode? For the odd consumer that has to
 * mirror the palette outside CSS (the Windows title-bar overlay colour).
 * Reads the attribute the runtime set, so it can never disagree with the paint.
 */
export function useNightDiveActive(): boolean {
    const read = () => document.documentElement.getAttribute(DEPTH_ATTR) === DEPTH_NIGHT;
    const [night, setNight] = useState(read);
    useEffect(() => {
        const onEvent = () => setNight(read());
        window.addEventListener(NIGHT_DIVE_EVENT, onEvent);
        return () => window.removeEventListener(NIGHT_DIVE_EVENT, onEvent);
    }, []);
    return night;
}
