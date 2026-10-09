/**
 * Renderer half of Settings → Appearance → "Around your OS". The decisions
 * themselves live in the main process (electron/login-item.ts — it cannot be
 * imported from here, see the electron rootDir rule); this file only holds
 * what the toggles DISPLAY, so it can be tested without React.
 */

export type HostPlatform = 'windows' | 'mac' | 'linux' | string | undefined;

export interface LoginItemView {
    supported: boolean;
    enabled: boolean;
    needsApproval: boolean;
}

/** Mirrors DEFAULT_* in electron/login-item.ts: the value a toggle shows
 *  before main answers, so a default-ON setting doesn't flash off→on. */
export const INITIAL_START_MINIMIZED = true;
export const INITIAL_MINIMIZE_TO_TRAY = true;

export function loginToggleLabel(platform: HostPlatform): string {
    if (platform === 'windows') return 'Start with Windows';
    if (platform === 'mac') return 'Open at login';
    return 'Start on login';
}

export function loginToggleDesc(platform: HostPlatform, state: LoginItemView | null): string {
    if (state && !state.supported) {
        return 'Only available in the installed app — a development build would register the bare Electron binary.';
    }
    if (state?.needsApproval) {
        return 'Waiting for your OK: allow Cipherline in System Settings → General → Login Items.';
    }
    if (platform === 'windows') return 'Launch Cipherline automatically when you sign in to Windows.';
    if (platform === 'mac') return 'Launch Cipherline automatically when you log in to your Mac.';
    return 'Launch Cipherline automatically when you log in.';
}

export function startMinimizedDesc(platform: HostPlatform): string {
    const when = platform === 'windows' ? 'starts with Windows' : 'starts at login';
    const where = platform === 'mac' ? 'the Dock' : 'the taskbar';
    return `When Cipherline ${when}, open to ${where} instead of the window. Opening it yourself always shows the window.`;
}

export function minimizeToTrayDesc(platform: HostPlatform): string {
    if (platform === 'mac') return 'Closing the window keeps Cipherline running in the menu bar. Click its icon (or the Dock icon) to reopen.';
    return 'Closing the window keeps Cipherline running in the system tray. Click the tray icon to reopen.';
}

/**
 * Normalise what `setStartWithWindows` resolved with. Current builds return
 * the state re-read from the OS; an older main process returns nothing, in
 * which case the requested value is all we have.
 */
export function loginStateAfterSet(requested: boolean, result: unknown, prev: LoginItemView | null): LoginItemView {
    if (result && typeof result === 'object'
        && typeof (result as LoginItemView).enabled === 'boolean'
        && typeof (result as LoginItemView).supported === 'boolean') {
        const r = result as LoginItemView;
        return { supported: r.supported, enabled: r.enabled, needsApproval: r.needsApproval === true };
    }
    return { supported: prev?.supported ?? true, enabled: requested, needsApproval: false };
}
