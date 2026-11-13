/**
 * What the diagnostic report says about system-wide (works-while-unfocused) keys.
 *
 * Why: a Linux KDE-Wayland tester reported "cannot use the webcam keybind at all" and the report had no
 * shortcut information, so "the desktop never bound it" could not be told from "the key is taken" from
 * "the binding was cleared". The facts all exist in main (the sync result, the portal's bound/notBound
 * lists) but were only console lines.
 *
 * Privacy: our own fixed action ids, the accelerator strings the user typed (key combos, like the
 * keybinds screen shows them), and the status vocabulary of global-shortcut-mode.ts. Nothing from the
 * environment beyond the already-sanitised desktop name.
 */
import type { GlobalShortcutStatus } from './global-shortcut-mode';

/** One entry of the last sync, as main saw it. */
export interface GlobalShortcutSyncRecord {
    status: GlobalShortcutStatus;
    /** { accelerator: actionId } that was handed to the sync. */
    map: Record<string, string>;
    /** Action ids that did NOT end up registered (taken accelerator, refused by the portal, rejected payload entry). */
    failed: string[];
}

export type ShortcutActionState = 'registered' | 'failed';

export interface GlobalShortcutsReport {
    mode: GlobalShortcutStatus['mode'];
    reason: string;
    desktop: string;
    /** Portal id the desktop knows Cipherline by (portal mode only). */
    app_id?: string;
    /** Portal mode: action ids the desktop really bound / did not bind. */
    bound?: string[];
    not_bound?: string[];
    /** Every global action handed to main at the last sync, and whether it ended up registered. */
    actions: Array<{ action: string; accelerator: string; state: ShortcutActionState }>;
}

const MAX_ACTIONS = 24;

export function buildGlobalShortcutsReport(rec: GlobalShortcutSyncRecord | null): GlobalShortcutsReport | null {
    if (!rec) return null;
    const failed = new Set(rec.failed);
    const actions = Object.entries(rec.map)
        .slice(0, MAX_ACTIONS)
        .map(([accelerator, action]) => ({ action, accelerator, state: (failed.has(action) ? 'failed' : 'registered') as ShortcutActionState }));
    const out: GlobalShortcutsReport = {
        mode: rec.status.mode,
        reason: rec.status.reason,
        desktop: rec.status.desktop,
        actions,
    };
    if (rec.status.appId) out.app_id = rec.status.appId;
    if (rec.status.portal) {
        out.bound = [...rec.status.portal.bound];
        out.not_bound = [...rec.status.portal.notBound];
    }
    return out;
}
