/**
 * Theme engine — applies a theme (src/theme/themes.ts) to the document and
 * lets every non-CSS consumer follow it.
 *
 * What applyTheme(theme) does:
 *   1. writes ONE <style id="cl-theme"> holding
 *        :root[data-theme="<id>"]{--cl-*:...;--cl-*-rgb:...;--<semantic>:...;--<kit>:...;color-scheme:...}
 *      (specificity 0,2,0, so it outranks the static `:root` blocks in
 *      index.css / cl-kit.css whatever the stylesheet order is, while scoped
 *      re-declarations on descendants — night-dive's `.app-rail`, dark islands —
 *      keep working because they sit on other elements);
 *   2. sets `data-theme="<id>"` on <html>, plus `data-scheme="dark|light"`
 *      (what KIND of theme: styles/theme-light*.css key on it, so every
 *      light-scheme theme — Light, High contrast light — gets the light kind
 *      of rules) and `data-contrast="high"` on a high-contrast theme
 *      (styles/theme-contrast.css);
 *   3. fires `themechange` on window (CustomEvent<{ theme: Theme }>) and wakes
 *      useTheme() subscribers.
 *
 * Canvas / SVG / inline-style consumers that cannot use a CSS variable call
 * themeColor(token) (the resolved hex of the active theme) and re-read on
 * `themechange` (or render from useTheme()).
 *
 * The device's theme id lives in the main process (SecureStore key `theme`,
 * electron/theme-boot.ts) so the window's own background is right before any
 * page loads; bootTheme() asks for it before the first React render.
 */
import { useSyncExternalStore } from 'react';
import {
    DARK_THEME, DEFAULT_THEME_PREFERENCE, PALETTE_TOKENS, THEME_PREFERENCE_LABELS, isThemeId, isThemePreference, resolveTheme, themeCssText,
    themeIdForPreference,
    type PaletteToken, type Theme, type ThemeId, type ThemePreference,
} from './themes';
import {
    customBootPayload, customThemeFromTheme, defFromBootPayload, deriveCustomTheme, type CustomThemeBootPayload, type CustomThemeDef,
} from './customTheme';

export const THEME_STYLE_ID = 'cl-theme';
export const THEME_CHANGE_EVENT = 'themechange';
export type ThemeChangeEvent = CustomEvent<{ theme: Theme }>;

let current: Theme = DARK_THEME;
const listeners = new Set<() => void>();

function hasDom(): boolean {
    return typeof document !== 'undefined' && !!document.documentElement && typeof document.createElement === 'function';
}

/** Apply `theme` to the document (idempotent) and notify subscribers when it changed. */
export function applyTheme(theme: Theme): void {
    const changed = theme !== current;
    current = theme;
    if (hasDom()) {
        const css = themeCssText(theme);
        let el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
        if (!el) {
            el = document.createElement('style');
            el.id = THEME_STYLE_ID;
            (document.head ?? document.documentElement).appendChild(el);
        }
        if (el.textContent !== css) el.textContent = css;
        const root = document.documentElement as HTMLElement & { removeAttribute?: (k: string) => void };
        root.setAttribute('data-theme', theme.id);
        // The KIND of theme (light-kind rules key on it); a custom theme carries its base's scheme.
        root.setAttribute('data-scheme', theme.scheme);
        if (theme.contrast === 'high') root.setAttribute('data-contrast', 'high');
        else root.removeAttribute?.('data-contrast');
        // Custom themes (customTheme.ts): base id in data-theme, plus this marker for the colour rule.
        if (theme.customId) root.setAttribute('data-custom-theme', theme.customId);
        else root.removeAttribute?.('data-custom-theme');
    }
    if (!changed) return;
    for (const l of listeners) { try { l(); } catch { /* a broken subscriber must not stop the rest */ } }
    try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
        }
    } catch { /* no event support (tests) */ }
}

/** The active theme. */
export function getTheme(): Theme {
    return current;
}

/**
 * The resolved colour of a palette token in the active theme ('#25E0C8'), for
 * canvas fillStyle, SVG attributes and anything else that cannot take
 * a CSS variable. Pass `alpha` (0-1) for an `rgba()` string.
 */
export function themeColor(token: PaletteToken, alpha?: number): string {
    const hex = current.palette[token];
    if (alpha === undefined || alpha >= 1) return hex;
    return rgbaOf(hex, Math.max(0, Math.round(alpha * 1000) / 1000));
}

/**
 * The rgba string of a resolved palette hex at `alpha`, with the alpha
 * written exactly as given (themeColor rounds it to 3 places). For per-frame
 * canvas consumers that already hold a resolved theme colour and must draw the
 * same fillStyle string every frame (the ambient motes, utils/ambientPalette.ts).
 */
export function rgbaOf(hex: string, alpha: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Subscribe to theme changes; returns the unsubscribe. */
export function subscribeTheme(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** React: the active theme, re-rendering on change. */
export function useTheme(): Theme {
    return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}

/** Every palette token's resolved colour (for consumers that need the full set, e.g. a canvas engine). */
export function getThemeColors(): Record<PaletteToken, string> {
    const out = {} as Record<PaletteToken, string>;
    for (const t of PALETTE_TOKENS) out[t] = current.palette[t];
    return out;
}

/** The host bridge slice the engine needs (electron preload / Tauri host). */
export interface ThemeHost {
    getTheme?: () => Promise<unknown>;
    /** Store a preference (a theme id or 'system'); main repaints the window and answers `{ id, pref }`. */
    setTheme?: (pref: string) => Promise<unknown>;
    /** Main's push when the theme changes (another window, or the OS while on `system`). */
    onThemeChanged?: (cb: (state: { id: string; pref?: string }) => void) => () => void;
    /** The device's theme id, read synchronously by the preload before the page loaded (no flash). */
    bootThemeId?: string;
    /** The device's ACTIVE custom theme (CustomThemeBootPayload), read synchronously by the preload with bootThemeId. */
    bootCustomTheme?: unknown;
    /** Store the active custom theme device-level; main repaints the window from `payload.boot`. */
    setCustomTheme?: (payload: CustomThemeBootPayload) => Promise<unknown>;
    /** Live preview: main paints the window background / caption buttons from `payload.boot`, STORING NOTHING. */
    previewTheme?: (payload: CustomThemeBootPayload) => Promise<unknown>;
    /** Live preview ended: main repaints from the device's stored theme. */
    endThemePreview?: () => Promise<unknown>;
}

// ── Custom theme (customTheme.ts) ───────────────────────────────────────────

/** The preference picked: a built-in (or system), or `custom` (the active custom theme below). */
export type ActiveThemePreference = ThemePreference | 'custom';

let activeCustom: { id: string; def: CustomThemeDef; theme: Theme } | null = null;

/** The active custom theme's library id, or null on a built-in. */
export function getActiveCustomThemeId(): string | null {
    return preference === 'custom' && activeCustom ? activeCustom.id : null;
}

function rememberCustom(id: string, def: CustomThemeDef): Theme {
    if (activeCustom && activeCustom.id === id && JSON.stringify(activeCustom.def) === JSON.stringify(def)) return activeCustom.theme;
    const theme = deriveCustomTheme(def, id);
    activeCustom = { id, def, theme };
    return theme;
}

/** A host state (theme:get / theme:changed / the preload's sync answer) -> the custom theme it names, if any. */
function customFromState(state: unknown): { id: string; def: CustomThemeDef } | null {
    if (!state || typeof state !== 'object' || (state as { pref?: unknown }).pref !== 'custom') return null;
    return defFromBootPayload((state as { custom?: unknown }).custom);
}

/**
 * Apply a custom theme now and store it device-level through the host (main
 * keeps `{ id, theme colours, boot palette }`, never the name, and repaints
 * the window background / caption buttons). Never rejects.
 */
export async function setCustomTheme(id: string, def: CustomThemeDef, host: ThemeHost | undefined = hostFromWindow()): Promise<void> {
    setPreferenceState('custom');
    applyReal(rememberCustom(id, def));
    followSystemInRenderer(false);
    try { await host?.setCustomTheme?.(customBootPayload(id, def)); } catch { /* old main / store locked: this session keeps it */ }
}

// ── Live preview ────────────────────────────────────────────────────────────
//
// Every way of putting a theme on the app from Settings (a built-in tile, a
// custom tile, Save in the editor, Save and use on an import) and Preview / Use
// on a shared theme card shows the theme on the WHOLE app as a PREVIEW first
// (components/themeShare/ThemePreviewBar.tsx is the "Previewing <name>" bar with
// Keep / Revert and a countdown). A preview is renderer memory ONLY: nothing
// goes to theme:set / theme:set-custom, the active-theme mirror, the library or
// sync, so a reload or a restart always comes back in the device's real theme.
// Main only repaints the window background / Windows caption buttons
// (theme:preview, which stores nothing).
//
// It REVERTS BY ITSELF after PREVIEW_REVERT_MS unless the user presses Keep
// (owner, 2026-11-26: custom colours are never contrast-corrected, so a theme
// can make text or buttons unfindable; a picked theme must never strand
// anyone). The timer lives HERE, not in the bar, so the revert happens even if
// the bar could not render. Picking another theme restarts it.
//
// While a preview is up, every REAL theme change that is not a user's choice
// (main's push when the OS flips on Sync with system, a synced edit of the
// active custom theme, a backup restore) lands on `previewBase` instead of the
// screen, so Revert restores exactly what the device would show now. A user's
// choice (activeThemeMirror chooseBuiltinTheme / chooseCustomTheme: Keep on the
// bar) ends the preview first.

/** How long a preview stays up without Keep before the real theme comes back. */
export const PREVIEW_REVERT_MS = 15_000;

/** Where a preview was started: Settings (leaving Settings reverts it) or a shared theme (card / link / import). */
export type ThemePreviewSource = 'settings' | 'share';

export interface ThemePreviewState {
    /** The theme on screen. */
    theme: Theme;
    /** What the bar calls it ("Midnight", "Ocean"). */
    name: string;
    /** A custom theme's data (Keep saves / uses this), or null for a built-in. */
    def: CustomThemeDef | null;
    /** A built-in preference (or Sync with system) being previewed, else null. */
    builtin: ThemePreference | null;
    /** Its library id when it is one of "Your themes", else null. */
    libraryId: string | null;
    /** An edit of a library theme that is NOT written yet: Keep writes it, Revert drops it (the opener gets onRevert). */
    pendingEdit: boolean;
    source: ThemePreviewSource;
    /** Bumped on every start (a new preview replacing one re-announces and re-focuses the bar). */
    seq: number;
    /** Date.now() at which it reverts by itself. Moves on restartThemePreviewCountdown(). */
    revertAt: number;
}

export interface ThemePreviewOptions {
    libraryId?: string | null;
    source?: ThemePreviewSource;
    pendingEdit?: boolean;
    /** Called once when THIS preview ends without Keep (Revert, Escape, the timer, leaving Settings). Not on replace. */
    onRevert?: () => void;
}

/** The custom id an unsaved previewed theme carries (data-custom-theme). */
export const PREVIEW_THEME_ID = 'preview';

let preview: ThemePreviewState | null = null;
/** The device's REAL theme while a preview is up (what Revert puts back). */
let previewBase: Theme | null = null;
let previewSeq = 0;
let revertTimer: ReturnType<typeof setTimeout> | null = null;
let onRevert: (() => void) | null = null;
const previewListeners = new Set<() => void>();

function notifyPreview(): void {
    for (const l of previewListeners) { try { l(); } catch { /* keep going */ } }
}

/** A real (non-preview) theme change: on screen, or held behind the preview. */
function applyReal(theme: Theme): void {
    if (preview) previewBase = theme;
    else applyTheme(theme);
}

/** The device's real theme (what shows when no preview is up). */
export function realTheme(): Theme {
    return preview && previewBase ? previewBase : current;
}

export function getThemePreview(): ThemePreviewState | null {
    return preview;
}

export function subscribeThemePreview(cb: () => void): () => void {
    previewListeners.add(cb);
    return () => { previewListeners.delete(cb); };
}

/** React: the running preview, or null. */
export function useThemePreview(): ThemePreviewState | null {
    return useSyncExternalStore(subscribeThemePreview, getThemePreview, getThemePreview);
}

function armRevertTimer(): number {
    if (revertTimer) clearTimeout(revertTimer);
    revertTimer = setTimeout(() => { revertTimer = null; stopThemePreview(); }, PREVIEW_REVERT_MS);
    return Date.now() + PREVIEW_REVERT_MS;
}

function beginPreview(
    theme: Theme,
    fields: Pick<ThemePreviewState, 'name' | 'def' | 'builtin' | 'libraryId'>,
    opts: ThemePreviewOptions,
    paint: CustomThemeBootPayload,
    host: ThemeHost | undefined,
): void {
    if (!preview) previewBase = current;
    // A replaced preview's opener is not told (the user moved on to another theme, nothing reverted).
    onRevert = opts.onRevert ?? null;
    preview = {
        theme, ...fields,
        pendingEdit: !!opts.pendingEdit,
        source: opts.source ?? 'share',
        seq: ++previewSeq,
        revertAt: armRevertTimer(),
    };
    applyTheme(theme);
    notifyPreview();
    try { void host?.previewTheme?.(paint)?.catch?.(() => { /* old main */ }); } catch { /* old preload */ }
}

/**
 * Show the custom theme `def` on the whole app until Keep, Revert or the timer.
 * Starting while one is up replaces it (and restarts the countdown; Revert
 * still goes back to the real theme). Persists nothing.
 */
export function startThemePreview(def: CustomThemeDef, opts: ThemePreviewOptions = {}, host: ThemeHost | undefined = hostFromWindow()): void {
    const libraryId = opts.libraryId ?? null;
    const id = libraryId ?? PREVIEW_THEME_ID;
    beginPreview(deriveCustomTheme(def, id), { name: def.name, def, builtin: null, libraryId }, opts, customBootPayload(id, def), host);
}

/** Show a built-in theme (or what Sync with system resolves to now) as a preview. Persists nothing. */
export function startBuiltinThemePreview(pref: ThemePreference, opts: Omit<ThemePreviewOptions, 'libraryId' | 'pendingEdit'> = {}, host: ThemeHost | undefined = hostFromWindow()): void {
    if (!isThemePreference(pref)) return;
    const theme = resolveThemePreference(pref);
    const name = THEME_PREFERENCE_LABELS[pref];
    // Main's preview paint takes a custom payload: the built-in's own colours.
    const paint = customBootPayload(PREVIEW_THEME_ID, customThemeFromTheme(theme, name));
    beginPreview(theme, { name, def: null, builtin: pref, libraryId: null }, opts, paint, host);
}

/** The user is still choosing (picked another theme, saved it to the library): full countdown again. */
export function restartThemePreviewCountdown(): void {
    if (!preview) return;
    preview = { ...preview, revertAt: armRevertTimer() };
    notifyPreview();
}

/** Keep is committing this preview: it ends as KEPT, so the opener's onRevert must not run. */
export function markThemePreviewKept(): void {
    onRevert = null;
}

/** End the preview and put the device's real theme back (the same Theme object: no re-derive, no flash). */
export function stopThemePreview(host: ThemeHost | undefined = hostFromWindow()): void {
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    if (!preview) return;
    const back = previewBase ?? current;
    const reverted = onRevert;
    onRevert = null;
    preview = null;
    previewBase = null;
    applyTheme(back);
    notifyPreview();
    try { void host?.endThemePreview?.()?.catch?.(() => { /* old main */ }); } catch { /* old preload */ }
    if (reverted) { try { reverted(); } catch { /* the opener is gone */ } }
}

/** Settings closed: a preview started there reverts (Keep already ended it if it was pressed). */
export function endSettingsThemePreview(): void {
    if (preview?.source === 'settings') stopThemePreview();
}

// ── Preference (Dark / Light / Sync with system) ────────────────────────────

let preference: ActiveThemePreference = DEFAULT_THEME_PREFERENCE;
const prefListeners = new Set<() => void>();
let mediaCleanup: (() => void) | null = null;

/** Does the OS ask for dark? (renderer side; main uses nativeTheme). No matchMedia = dark. */
export function systemPrefersDark(): boolean {
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
        return !window.matchMedia('(prefers-color-scheme: light)').matches;
    } catch { return true; }
}

/** The media queries that mean "the OS asks for more contrast" (themes.ts THEME_PREFERENCES, the `system` rule). */
export const MORE_CONTRAST_QUERIES = ['(prefers-contrast: more)', '(forced-colors: active)'] as const;

/** Does the OS ask for more contrast (Windows High Contrast, macOS Increase contrast)? Renderer side; main uses nativeTheme. */
export function systemPrefersMoreContrast(): boolean {
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return MORE_CONTRAST_QUERIES.some((q) => window.matchMedia(q).matches);
    } catch { return false; }
}

/** A preference (or a stored id) -> the theme it shows right now. */
export function resolveThemePreference(pref: unknown): Theme {
    return resolveTheme(themeIdForPreference(pref, systemPrefersDark(), systemPrefersMoreContrast()));
}

export function getThemePreference(): ActiveThemePreference {
    return preference;
}

function setPreferenceState(pref: ActiveThemePreference): void {
    if (pref === preference) return;
    preference = pref;
    for (const l of prefListeners) { try { l(); } catch { /* keep going */ } }
}

/** While on `system` with no host push (harness, website, a host without onThemeChanged), follow the media query live. */
function followSystemInRenderer(on: boolean): void {
    mediaCleanup?.();
    mediaCleanup = null;
    if (!on) return;
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mqs = ['(prefers-color-scheme: light)', ...MORE_CONTRAST_QUERIES].map((q) => window.matchMedia(q));
        const onChange = () => { if (preference === 'system') applyReal(resolveThemePreference('system')); };
        for (const mq of mqs) mq.addEventListener('change', onChange);
        mediaCleanup = () => { for (const mq of mqs) mq.removeEventListener('change', onChange); };
    } catch { /* no media queries */ }
}

/**
 * The picker's action: apply at once (no waiting on the main process), then
 * store it through the host, which repaints the window background / title-bar
 * overlay and tells the other listeners. Never rejects.
 */
export async function setThemePreference(pref: ThemePreference, host: ThemeHost | undefined = hostFromWindow()): Promise<void> {
    if (!isThemePreference(pref)) return;
    setPreferenceState(pref);
    applyReal(resolveThemePreference(pref));
    followSystemInRenderer(pref === 'system' && !host?.onThemeChanged);
    try {
        const r = await host?.setTheme?.(pref);
        const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined;
        // Main resolved `system` with nativeTheme: trust it over matchMedia.
        if (isThemeId(id) && preference === pref) applyReal(resolveTheme(id));
    } catch { /* host refused / old preload: this session keeps the choice */ }
}

/** React: the stored preference (a built-in theme id, 'system', or 'custom'). */
export function useThemePreference(): ActiveThemePreference {
    return useSyncExternalStore(
        (cb) => { prefListeners.add(cb); return () => { prefListeners.delete(cb); }; },
        getThemePreference, getThemePreference,
    );
}

function hostFromWindow(): ThemeHost | undefined {
    try { return (typeof window !== 'undefined' ? (window as unknown as { electronAPI?: ThemeHost }).electronAPI : undefined); } catch { return undefined; }
}

/**
 * Boot: apply the default theme synchronously (so the first frame already has
 * the engine's variables and data-theme), then ask the host for the device's
 * stored theme id and apply that. Never rejects; gives up on the host after
 * `timeoutMs` so a missing or wedged handler cannot hold the first render.
 */
export function bootTheme(host: ThemeHost | undefined = hostFromWindow(), timeoutMs = 400): Promise<ThemeId> {
    // The preload's synchronous answer (electron/preload.ts bootThemeId): the
    // first frame is already in the stored theme, so Light never flashes Dark.
    const bootCustom = defFromBootPayload(host?.bootCustomTheme);
    if (bootCustom) {
        setPreferenceState('custom');
        applyTheme(rememberCustom(bootCustom.id, bootCustom.def));
    } else {
        applyTheme(isThemeId(host?.bootThemeId) ? resolveTheme(host!.bootThemeId) : current);
    }
    try {
        host?.onThemeChanged?.((state) => {
            const custom = customFromState(state);
            if (custom) { setPreferenceState('custom'); applyReal(rememberCustom(custom.id, custom.def)); return; }
            if (isThemePreference(state?.pref)) setPreferenceState(state.pref);
            if (isThemeId(state?.id)) applyReal(resolveTheme(state.id));
        });
    } catch { /* old preload */ }
    if (!host?.getTheme) return Promise.resolve(current.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((res) => { timer = setTimeout(() => res(undefined), timeoutMs); });
    const asked = Promise.resolve().then(() => host.getTheme!()).catch(() => undefined);
    return Promise.race([asked, timeout]).then((r) => {
        if (timer) clearTimeout(timer);
        const custom = customFromState(r);
        if (custom) {
            setPreferenceState('custom');
            applyReal(rememberCustom(custom.id, custom.def));
            return realTheme().id;
        }
        const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : r;
        const pref = r && typeof r === 'object' ? (r as { pref?: unknown }).pref : undefined;
        if (isThemePreference(pref)) setPreferenceState(pref);
        else if (isThemeId(id)) setPreferenceState(id);
        applyReal(resolveTheme(id));
        return realTheme().id;
    });
}

/** Test-only: forget the active theme. */
export function __resetThemeForTests(): void {
    current = DARK_THEME;
    preview = null;
    previewBase = null;
    previewSeq = 0;
    if (revertTimer) clearTimeout(revertTimer);
    revertTimer = null;
    onRevert = null;
    previewListeners.clear();
    listeners.clear();
    preference = DEFAULT_THEME_PREFERENCE;
    activeCustom = null;
    prefListeners.clear();
    mediaCleanup?.();
    mediaCleanup = null;
}
