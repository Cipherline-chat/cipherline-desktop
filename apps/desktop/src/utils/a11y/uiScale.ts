/**
 * Interface size, renderer side. The value lives in the MAIN process
 * (electron/ui-scale.ts: SecureStore key `uiScale`, device-level, applied with
 * the window's zoom factor before the page paints). This module only mirrors
 * the steps for the slider and validates what the host sends back — the
 * renderer cannot import electron/ (the electron rootDir trap), so
 * uiScale.test.ts pins the mirror to the source of truth.
 *
 * Host contract (Electron preload, and the Tauri host's electronAPI shim):
 *   getUiScale(): Promise<UiScaleState>
 *   setUiScale(percent: step): Promise<UiScaleState>
 *   onUiScaleChanged(cb(UiScaleState)): unsubscribe
 */

export const UI_SCALE_STEPS = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export const UI_SCALE_DEFAULT = 100;

export interface UiScaleState {
    /** The chosen size (a step). */
    percent: number;
    /** What is applied now (lower than `percent` when the display can't hold it). */
    effective: number;
    /** The largest step this window's display can hold. */
    max: number;
    source: 'shortcut' | 'set' | 'display' | 'init';
}

export function isUiScaleStep(v: unknown): v is number {
    return typeof v === 'number' && (UI_SCALE_STEPS as readonly number[]).includes(v);
}

const SOURCES = new Set(['shortcut', 'set', 'display', 'init']);

/** A host reply -> a sane state, or null (missing API, older main, junk). */
export function toUiScaleState(raw: unknown): UiScaleState | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!isUiScaleStep(r.percent) || !isUiScaleStep(r.effective) || !isUiScaleStep(r.max)) return null;
    return {
        percent: r.percent,
        effective: Math.min(r.effective, r.percent),
        max: r.max,
        source: (typeof r.source === 'string' && SOURCES.has(r.source) ? r.source : 'set') as UiScaleState['source'],
    };
}

/** True when the display is holding the size below what was chosen. */
export function isLimited(s: UiScaleState): boolean {
    return s.effective < s.percent;
}

export function uiScaleLabel(percent: number): string {
    return `${percent}%`;
}

/** aria-valuetext: screen readers say "125 percent", not "125". */
export function uiScaleValueText(percent: number, limitedTo?: number): string {
    const base = `${percent} percent`;
    return limitedTo !== undefined && limitedTo < percent ? `${base}, limited to ${limitedTo} percent by your display` : base;
}

/** The step a slider index lands on, and back. */
export function uiScaleAt(index: number): number {
    const i = Math.max(0, Math.min(UI_SCALE_STEPS.length - 1, Math.round(index)));
    return UI_SCALE_STEPS[i];
}
export function uiScaleIndex(percent: number): number {
    const i = (UI_SCALE_STEPS as readonly number[]).indexOf(percent);
    return i < 0 ? (UI_SCALE_STEPS as readonly number[]).indexOf(UI_SCALE_DEFAULT) : i;
}
