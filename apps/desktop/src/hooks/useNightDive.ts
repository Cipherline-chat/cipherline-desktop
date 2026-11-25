import { useEffect, useRef, useState } from 'react';
import {
    NIGHT_DIVE_EVENT, NIGHT_RECHECK_MS, DEPTH_ATTR, DEPTH_NIGHT,
    isNightHour, applyDepth, nightDiveReason, createTitleBarNightSync,
    type NightDiveDetail, type TitleBarNightSync,
} from '../utils/nightDive';
import { THEME_CHANGE_EVENT, getTheme } from '../theme/engine';
import type { Theme } from '../theme/themes';

/**
 * Binding of utils/nightDive.ts to `<html data-depth>` and to the
 * `cipherline:night-dive` window event. No setting, no storage: it follows the
 * local clock.
 */

/** The last state announced on the event bus (module-level so a StrictMode
 *  remount or a second mount can never re-announce the same state). */
let announced: boolean | null = null;

/**
 * Night by the clock, in Dark only. The night dive deepens the DARK palette
 * (styles/night-dive.css is navy by definition): Light, Midnight (already
 * black) and the high-contrast themes stay as they are all night. A custom
 * theme on a Dark base also stays as it is: its `data-theme` is "dark", but
 * night-dive.css paints Dark's navy over the rail / panels, which would
 * replace the user's own colours every night.
 */
export function nightDiveAppliesTo(theme: Pick<Theme, 'id' | 'customId'>): boolean {
    return theme.id === 'dark' && !theme.customId;
}

function nightNow(): boolean {
    return isNightHour(new Date()) && nightDiveAppliesTo(getTheme());
}

/**
 * Evaluate the clock and set/clear the root attribute. Called once from
 * main.tsx before first render, so a client launched after midnight paints its
 * very first frame already deep instead of fading in. Does not announce — the
 * mounted runtime does that. Returns the state applied.
 */
export function applyNightDiveNow(): boolean {
    try {
        return applyDepth(document.documentElement, nightNow());
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
            const next = applyDepth(document.documentElement, nightNow());
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
        window.addEventListener(THEME_CHANGE_EVENT, tick);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearInterval(id);
            window.removeEventListener('focus', tick);
            window.removeEventListener(THEME_CHANGE_EVENT, tick);
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
        // A flip between the first render and this subscription is not missed.
        onEvent();
        return () => window.removeEventListener(NIGHT_DIVE_EVENT, onEvent);
    }, []);
    return night;
}

/**
 * Mount where the darkened title bar is (Dashboard's drift shell): tells main
 * whether the night dive is on screen, so the Windows / Linux caption buttons
 * (drawn by the OS from main's colours) match the bar. main picks the colour
 * (electron/night-dive-chrome.ts) and applies it only to plain Dark with no
 * live preview, whatever order its theme and night messages arrive in.
 * Announces the starting state, then every enter / exit (clock, theme change,
 * wake from sleep: all go through the runtime's event); back to day when the
 * shell unmounts. A page reload resets main, and the new page re-announces.
 */
export function useNightDiveTitleBarSync(): void {
    const night = useNightDiveActive();
    const sync = useRef<TitleBarNightSync | null>(null);
    if (!sync.current) {
        sync.current = createTitleBarNightSync((active) => {
            (window as unknown as { electronAPI?: { setNightDive?: (a: boolean) => void } }).electronAPI?.setNightDive?.(active);
        });
    }
    useEffect(() => { sync.current?.update(night); }, [night]);
    useEffect(() => () => { sync.current?.dispose(); }, []);
}
