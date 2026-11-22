/**
 * The device's ACTIVE custom theme, as main stores and paints it
 * (src/theme/customTheme.ts builds the payload; plan T5).
 *
 * A custom theme's full definition lives in the account's encrypted
 * secureLocalStore library, which is cold until the account is bound — too
 * late for the first frame. So when the user picks a custom theme the renderer
 * also hands main a small device-level copy:
 *
 *   { id, theme: { v: 1, base, colors: { nine #rrggbb }, glow }, boot: { BootPalette + gradient } }
 *
 * never the theme's name (not needed to paint). Main stores it in SecureStore
 * under THEME_CUSTOM_STORE_KEY next to the `theme` preference ('custom'),
 * paints the window background / Windows caption overlay from `boot` before
 * `new BrowserWindow`, and hands the whole payload to the preload's
 * synchronous boot ask so the renderer derives the full theme before React's
 * first render. Data only: every colour must be `#rrggbb`, every key known,
 * the JSON small; anything else is refused (the renderer re-validates the
 * `theme` part again with the same rules the editor uses).
 *
 * No `electron` import and no import from ../src (rootDir trap): unit-testable.
 */
import {
    DEFAULT_BOOT_THEME_ID, parseStoredThemePreference, themeIdForBootPreference,
    type BootPalette, type BootThemeId, type BootThemePreference,
} from './theme-boot';

/** SecureStore key holding the active custom theme's device copy (JSON). */
export const THEME_CUSTOM_STORE_KEY = 'themeCustom';
/** The `theme` preference value that means "the stored custom theme". */
export const CUSTOM_THEME_PREF = 'custom';
/** The stored JSON is ~1 KB; refuse anything far above. */
export const CUSTOM_BOOT_JSON_MAX = 4096;

/** Mirror of src/theme/customTheme.ts CUSTOM_THEME_KNOBS (theme-custom-boot.test.ts pins it). */
export const CUSTOM_BOOT_KNOBS = ['bg', 'panel', 'surface', 'text', 'muted', 'accent', 'onAccent', 'danger', 'border'] as const;
const BOOT_KEYS = ['abyss', 'deep', 'surface', 'border', 'sink', 'lume', 'lumeHi', 'lumeDeep', 'glow', 'ok', 'text', 'muted', 'faint', 'windowBackground', 'card'] as const;

export interface CustomBootPayload {
    id: string;
    theme: { v: 1; base: 'dark' | 'light'; colors: Record<(typeof CUSTOM_BOOT_KNOBS)[number], string>; glow: boolean };
    boot: BootPalette & { gradient: [string, string, string] };
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate an untrusted payload (IPC argument or stored JSON). Returns a clean copy or null. */
export function parseCustomBootPayload(raw: unknown): CustomBootPayload | null {
    let v: unknown = raw;
    if (typeof raw === 'string') {
        if (raw.length > CUSTOM_BOOT_JSON_MAX) return null;
        try { v = JSON.parse(raw); } catch { return null; }
    } else {
        try { if (JSON.stringify(raw).length > CUSTOM_BOOT_JSON_MAX) return null; } catch { return null; }
    }
    if (!isObj(v)) return null;
    const { id, theme, boot } = v;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    if (!isObj(theme) || theme.v !== 1 || (theme.base !== 'dark' && theme.base !== 'light') || typeof theme.glow !== 'boolean') return null;
    if (!isObj(theme.colors)) return null;
    const colors = {} as CustomBootPayload['theme']['colors'];
    for (const k of CUSTOM_BOOT_KNOBS) {
        const c = theme.colors[k];
        if (!isHex(c)) return null;
        colors[k] = c.toLowerCase();
    }
    if (Object.keys(theme.colors).length !== CUSTOM_BOOT_KNOBS.length) return null;
    if (!isObj(boot)) return null;
    const out = {} as Record<(typeof BOOT_KEYS)[number], string>;
    for (const k of BOOT_KEYS) {
        if (!isHex(boot[k])) return null;
        out[k] = (boot[k] as string).toUpperCase();
    }
    const tb = boot.titleBar;
    if (!isObj(tb) || !isHex(tb.color) || !isHex(tb.symbolColor)) return null;
    const g = boot.gradient;
    if (!Array.isArray(g) || g.length !== 3 || !g.every(isHex)) return null;
    return {
        id,
        theme: { v: 1, base: theme.base, colors, glow: theme.glow },
        boot: {
            ...out,
            titleBar: { color: tb.color.toUpperCase(), symbolColor: tb.symbolColor.toUpperCase() },
            gradient: [g[0].toUpperCase(), g[1].toUpperCase(), g[2].toUpperCase()],
        },
    };
}

/** ThemeState plus the custom payload when the preference is `custom`. */
export interface CustomAwareThemeState {
    /** The theme shown now: a built-in id, or the custom theme's BASE id. */
    id: BootThemeId;
    /** What the user picked. */
    pref: BootThemePreference | typeof CUSTOM_THEME_PREF;
    /** The active custom theme (pref === 'custom' only). */
    custom?: CustomBootPayload;
}

/**
 * The device's theme state through store getters that may throw (locked
 * store). A stored `custom` preference with a missing or invalid payload
 * falls back to the default built-in — never a half-painted window. A stored
 * `system` resolves exactly as theme-boot.ts readDeviceThemeState does
 * (High contrast dark / light when the OS asks for more contrast).
 */
export function readDeviceThemeStateWithCustom(
    getPref: () => string | null | undefined,
    getCustom: () => string | null | undefined,
    systemDark: boolean,
    systemMoreContrast = false,
): CustomAwareThemeState {
    let raw: string | null | undefined = null;
    try { raw = getPref(); } catch { /* locked */ }
    if (raw === CUSTOM_THEME_PREF) {
        let custom: CustomBootPayload | null = null;
        try { custom = parseCustomBootPayload(getCustom()); } catch { /* locked */ }
        if (custom) return { id: custom.theme.base, pref: CUSTOM_THEME_PREF, custom };
        return { id: DEFAULT_BOOT_THEME_ID, pref: DEFAULT_BOOT_THEME_ID };
    }
    const pref = parseStoredThemePreference(raw);
    return { id: themeIdForBootPreference(pref, systemDark, systemMoreContrast), pref };
}

/**
 * A live theme PREVIEW's window colours (theme:preview / theme:preview-end,
 * renderer: src/theme/engine.ts startThemePreview). Memory only: nothing here
 * touches a store. `paint` repaints the window; `realColors` answers the
 * device's stored theme's colours (what end() puts back).
 */
export interface WindowThemePreview {
    /** Paint a validated custom theme payload; false (and nothing painted) when it is invalid. */
    start(payload: unknown): boolean;
    /** Drop the preview and repaint the real theme; false when none was up. */
    end(): boolean;
    /** Is a preview up? (main then leaves the window colours alone on a real theme change). */
    active(): boolean;
}

export function createWindowThemePreview(paint: (colors: BootPalette) => void, realColors: () => BootPalette): WindowThemePreview {
    let up = false;
    return {
        start(payload) {
            const custom = parseCustomBootPayload(payload);
            if (!custom) return false;
            up = true;
            paint(custom.boot);
            return true;
        },
        end() {
            if (!up) return false;
            up = false;
            paint(realColors());
            return true;
        },
        active: () => up,
    };
}

/** The colours main paints for a state: the custom boot palette, else the built-in one. */
export function paletteForState(state: CustomAwareThemeState, builtIn: (id: string) => BootPalette): BootPalette {
    return state.custom ? state.custom.boot : builtIn(state.id);
}
