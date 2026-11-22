/**
 * Notifications that stay — Settings → Accessibility → Toast duration.
 * Normal = today's countdown; Long = twice as long; Sticky = no countdown, the
 * toast stays until it is closed (WCAG 2.2.1 timing adjustable). Applied to
 * every toast that has a countdown, whatever its kind (an error toast is
 * exactly the one you most need time to read); a toast that already has none
 * (durationMs 0) is untouched. Read at push time from secureLocalStore, so it
 * needs no provider wiring and applies to the next toast the moment it is set.
 */
import { secureLocalStore } from '../secureLocalStore';
import { READABILITY_SPECS, parseReadability, type ReadabilityValue } from './readability';

export type ToastDurationPref = ReadabilityValue<'toast'>;

export function toastDurationMs(baseMs: number, pref: ToastDurationPref): number {
    if (!(baseMs > 0)) return baseMs;
    if (pref === 'long') return baseMs * 2;
    if (pref === 'sticky') return 0;
    return baseMs;
}

export function readToastPref(): ToastDurationPref {
    try { return parseReadability('toast', secureLocalStore.getItem(READABILITY_SPECS.toast.key)); } catch { return 'normal'; }
}
