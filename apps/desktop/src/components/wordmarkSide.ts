/**
 * Which end of the custom title bar carries the "Cipherline" wordmark.
 *
 * - Windows / Linux: LEFT. The window controls are on the right (the native
 *   titleBarOverlay on Windows, the in-app WindowControls on Linux).
 * - macOS: RIGHT. The traffic lights sit on the left there
 *   (titleBarStyle 'hiddenInset'), and nothing else lives on the right.
 *
 * `platform` is the preload-exposed `electronAPI.platform`
 * ('windows' | 'mac' | 'linux'); the user-agent string is only the fallback
 * for a plain-browser render (no preload), mirroring Dashboard's isMac.
 */
export type WordmarkSide = 'left' | 'right';

export function wordmarkSide(platform: string | undefined, userAgent: string): WordmarkSide {
    if (platform === 'mac') return 'right';
    if (platform === 'windows' || platform === 'linux') return 'left';
    return userAgent.toLowerCase().includes('macintosh') ? 'right' : 'left';
}
