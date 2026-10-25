/**
 * Open Settings on a given pane from anywhere — e.g. the call's right-click
 * microphone / speaker menus → Voice & Video. Dashboard owns the Settings
 * screen and listens for this; the call controls live deep inside the call
 * tree and have no prop path to it.
 */
import type { PaneId } from '../components/settings/SettingsScreen';

export const OPEN_SETTINGS_EVENT = 'cipherline:open-settings';

export interface OpenSettingsDetail { pane: PaneId }

export function requestOpenSettings(pane: PaneId): void {
    try { window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { pane } })); } catch { /* no window */ }
}
