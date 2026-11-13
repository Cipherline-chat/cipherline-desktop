/**
 * Open Settings on a given pane from anywhere — e.g. the call's right-click
 * microphone / speaker menus → Voice & Video. Dashboard owns the Settings
 * screen and listens for this; the call controls live deep inside the call
 * tree and have no prop path to it.
 */
import type { SettingsTarget } from '../components/settings/paneAliases';

export const OPEN_SETTINGS_EVENT = 'cipherline:open-settings';

/** `pane` may be an old id ('connections', 'personalize') or 'steam': SettingsScreen resolves it (paneAliases.ts). */
export interface OpenSettingsDetail { pane: SettingsTarget }

export function requestOpenSettings(pane: SettingsTarget): void {
    try { window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { pane } })); } catch { /* no window */ }
}
