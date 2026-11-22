/**
 * Theme colours the MAIN process paints before (or without) the renderer:
 * the main window's `backgroundColor` and the Windows/Linux `titleBarOverlay`, the
 * "Applying update" popup, the Linux wallet notice window, the installer /
 * update splash tokens and the tray's slash outline. One helper,
 * `bootPalette(id)`, so none of them carries its own hex.
 *
 * Source of truth: src/theme/themes.ts. electron/ cannot import src/ (the
 * rootDir trap: tsconfig.electron.json's rootDir is ./electron, and an import
 * from ../src changes the dist-electron layout), so this file MIRRORS the few
 * values main needs, and electron/theme-boot.test.ts fails if any of them
 * drifts from the theme data.
 *
 * Device-level storage, the same mechanism as the other window-creation
 * preferences (startMinimized, and the interface-scale slice's `uiScale`):
 * one SecureStore key, read by main before `new BrowserWindow`, never
 * account-scoped (the sign-in screen is themed too).
 *
 * Host contract (also for the Tauri host):
 *   invoke 'theme:get'        -> ThemeState { id, pref }
 *   invoke 'theme:set' pref   -> ThemeState (a built-in theme id, or 'system')
 *   event  'theme:changed'    -> ThemeState (also when the OS flips while on `system`)
 *
 * `system` (src/theme/themes.ts THEME_PREFERENCES has the rule): the OS asks
 * for more contrast (nativeTheme.shouldUseHighContrastColors, or Windows
 * forced colours: inForcedColorsMode) -> High contrast dark / light by the OS
 * light/dark setting; otherwise Dark / Light.
 *   sendSync 'theme:get-sync' -> ThemeState (the preload, before the page loads: no flash)
 *
 * No `electron` import and no import from ../src: unit-testable under vitest.
 */

/** SecureStore key holding the device's theme id. */
export const THEME_STORE_KEY = 'theme';

/** Built-in theme ids (mirror of src/theme/themes.ts THEME_IDS). */
export const BOOT_THEME_IDS = ['dark', 'light', 'midnight', 'hc-dark', 'hc-light'] as const;
export type BootThemeId = (typeof BOOT_THEME_IDS)[number];
export const DEFAULT_BOOT_THEME_ID: BootThemeId = 'dark';

export interface BootPalette {
    abyss: string;
    deep: string;
    surface: string;
    border: string;
    sink: string;
    lume: string;
    lumeHi: string;
    lumeDeep: string;
    glow: string;
    ok: string;
    text: string;
    muted: string;
    faint: string;
    /** BrowserWindow backgroundColor of the main window. */
    windowBackground: string;
    /** Windows caption-button overlay. */
    titleBar: { color: string; symbolColor: string };
    /** "Applying update" opaque card / window. */
    card: string;
}

/** Mirror of the theme data (electron/theme-boot.test.ts pins every value). */
export const BOOT_PALETTES: Readonly<Record<BootThemeId, BootPalette>> = {
    dark: {
        abyss: '#0B0F1E',
        deep: '#131A30',
        surface: '#1C2542',
        border: '#2A3558',
        sink: '#0A1120',
        lume: '#25E0C8',
        lumeHi: '#3BEAD6',
        lumeDeep: '#0E8F7C',
        glow: '#FFC94D',
        ok: '#4ADE80',
        text: '#F4F7FF',
        muted: '#A7B3D4',
        faint: '#8591B5',
        windowBackground: '#0B0F1E',
        titleBar: { color: '#0B0F1E', symbolColor: '#F4F7FF' },
        card: '#131A30',
    },
    light: {
        abyss: '#FFF8EE',
        deep: '#FFFFFF',
        surface: '#F6EEE1',
        border: '#E6D6BD',
        sink: '#FBF4E8',
        lume: '#25E0C8',
        lumeHi: '#3BEAD6',
        lumeDeep: '#0A6B60',
        glow: '#FFC94D',
        ok: '#4ADE80',
        text: '#1C2240',
        muted: '#4E5573',
        faint: '#5A6383',
        windowBackground: '#FFF8EE',
        titleBar: { color: '#FFF8EE', symbolColor: '#1C2240' },
        card: '#FFFFFF',
    },
    midnight: {
        abyss: '#000000',
        deep: '#0A0C12',
        surface: '#131722',
        border: '#2C3346',
        sink: '#05060A',
        lume: '#25E0C8',
        lumeHi: '#3BEAD6',
        lumeDeep: '#0E8F7C',
        glow: '#FFC94D',
        ok: '#4ADE80',
        text: '#F2F5FC',
        muted: '#A8B1C6',
        faint: '#8A93A9',
        windowBackground: '#000000',
        titleBar: { color: '#000000', symbolColor: '#F2F5FC' },
        card: '#0A0C12',
    },
    'hc-dark': {
        abyss: '#000000',
        deep: '#000000',
        surface: '#0E1015',
        border: '#9AA3B5',
        sink: '#000000',
        lume: '#25E0C8',
        lumeHi: '#5FF5E2',
        lumeDeep: '#0E8F7C',
        glow: '#FFC94D',
        ok: '#4ADE80',
        text: '#FFFFFF',
        muted: '#E2E7F0',
        faint: '#C8CFDB',
        windowBackground: '#000000',
        titleBar: { color: '#000000', symbolColor: '#FFFFFF' },
        card: '#000000',
    },
    'hc-light': {
        abyss: '#FFFFFF',
        deep: '#FFFFFF',
        surface: '#FFFFFF',
        border: '#5C6478',
        sink: '#F2F4F8',
        lume: '#25E0C8',
        lumeHi: '#3BEAD6',
        lumeDeep: '#0A6B60',
        glow: '#FFC94D',
        ok: '#4ADE80',
        text: '#0A0E1F',
        muted: '#262C40',
        faint: '#373E54',
        windowBackground: '#FFFFFF',
        titleBar: { color: '#FFFFFF', symbolColor: '#0A0E1F' },
        card: '#FFFFFF',
    },
};

/** What the user picked (mirror of src/theme/themes.ts THEME_PREFERENCES). */
export const BOOT_THEME_PREFERENCES = ['dark', 'light', 'midnight', 'hc-dark', 'hc-light', 'system'] as const;
export type BootThemePreference = (typeof BOOT_THEME_PREFERENCES)[number];

export function isBootThemeId(v: unknown): v is BootThemeId {
    return typeof v === 'string' && (BOOT_THEME_IDS as readonly string[]).includes(v);
}

export function isBootThemePreference(v: unknown): v is BootThemePreference {
    return typeof v === 'string' && (BOOT_THEME_PREFERENCES as readonly string[]).includes(v);
}

/** The stored string -> a preference; anything else (missing, tampered, a removed theme) is the default. */
export function parseStoredThemePreference(raw: string | null | undefined): BootThemePreference {
    return isBootThemePreference(raw) ? raw : DEFAULT_BOOT_THEME_ID;
}

/**
 * A preference -> the theme shown; `system` follows the OS (main:
 * nativeTheme.shouldUseDarkColors, and shouldUseHighContrastColors /
 * inForcedColorsMode for `systemMoreContrast`).
 */
export function themeIdForBootPreference(pref: BootThemePreference, systemDark: boolean, systemMoreContrast = false): BootThemeId {
    if (pref !== 'system') return pref;
    if (systemMoreContrast) return systemDark ? 'hc-dark' : 'hc-light';
    return systemDark ? 'dark' : 'light';
}

/** The stored string -> a theme id (a stored `system` resolves with `systemDark`, default dark). */
export function parseStoredThemeId(raw: string | null | undefined, systemDark = true, systemMoreContrast = false): BootThemeId {
    return themeIdForBootPreference(parseStoredThemePreference(raw), systemDark, systemMoreContrast);
}

/** The colours main paints for a theme id (unknown -> default). */
export function bootPalette(id?: string | null): BootPalette {
    return BOOT_PALETTES[isBootThemeId(id) ? id : DEFAULT_BOOT_THEME_ID];
}

export interface ThemeState {
    /** The theme shown now. */
    id: BootThemeId;
    /** What the user picked (`system` follows the OS). */
    pref: BootThemePreference;
}

/** The device's state through a store getter that may throw (store locked / not ready). */
export function readDeviceThemeState(get: () => string | null | undefined, systemDark: boolean, systemMoreContrast = false): ThemeState {
    let pref: BootThemePreference = DEFAULT_BOOT_THEME_ID;
    try { pref = parseStoredThemePreference(get()); } catch { /* locked: default */ }
    return { id: themeIdForBootPreference(pref, systemDark, systemMoreContrast), pref };
}

/** Read the device's theme id through a store getter that may throw (store locked / not ready). */
export function readDeviceThemeId(get: () => string | null | undefined, systemDark = true): BootThemeId {
    return readDeviceThemeState(get, systemDark).id;
}
