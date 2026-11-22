/**
 * App themes as plain data — THE single source of every theme colour.
 *
 * Plan: docs/plans/accessibility-and-themes.md (branch claude/a11y-themes-plan),
 * slice T1 "theme engine, Dark only, no visible change".
 *
 * Who reads this file:
 *   - src/theme/engine.ts       writes it as CSS variables on <html> at boot
 *                               (applyTheme) and answers themeColor(token).
 *   - tailwind.config.js        maps every Tailwind colour name to
 *                               `rgb(var(--cl-x-rgb) / <alpha-value>)` and emits
 *                               the `--cl-x-rgb` channel variables from here.
 *   - vite.config.ts            fills the index.html boot backdrop from `boot`.
 *   - electron/theme-boot.ts    a MIRROR of the few values the main process
 *                               paints before the renderer exists (window
 *                               background, title-bar overlay, update popup).
 *                               electron/ cannot import src/ (rootDir trap), so
 *                               electron/theme-boot.test.ts pins it to this file.
 *   - src/index.css `:root` and src/styles/cl-kit.css `:root` keep their static
 *     blocks (pre-script paint, harness pages, the website's copy of cl-kit);
 *     src/theme/themeTokens.test.ts fails if either drifts from this data.
 *
 * Rules for this file:
 *   - Pure data + pure functions. No DOM, no imports (Tailwind's config loader,
 *     the Vite config, the Tauri host and mobile ports all read it as-is).
 *   - Never rename or remove a token: `--cl-*` names are the consumer API and
 *     the website re-declares some of them. Add new ones only.
 *   - `palette` is opaque 6-digit hex only (the `-rgb` channels are derived).
 *     Colours with alpha go in `alpha`, composite values in `effects`.
 */

export const THEME_SCHEMA_VERSION = 1 as const;

/** Every built-in theme id. */
export const THEME_IDS = ['dark', 'light', 'midnight', 'hc-dark', 'hc-light'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME_ID: ThemeId = 'dark';

/**
 * What the user picks (Settings → Appearance → Theme): a theme, or `system`,
 * which follows the OS live (Electron `nativeTheme` in main, media queries in
 * the renderer). Order = the picker's order.
 *
 * The `system` rule (themeIdForPreference):
 *   OS asks for more contrast  -> High contrast dark / High contrast light,
 *                                 by the OS light/dark setting;
 *   otherwise                  -> Dark / Light.
 * "Asks for more contrast" = Windows High Contrast (forced colours) or macOS
 * Increase contrast: nativeTheme.shouldUseHighContrastColors /
 * inForcedColorsMode in main, `(prefers-contrast: more)` / `(forced-colors:
 * active)` in the renderer. Midnight is never picked by the system.
 */
export const THEME_PREFERENCES = ['dark', 'light', 'midnight', 'hc-dark', 'hc-light', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

/** The picker's label for each preference (also the backup-restore toast: "Theme restored: <label>"). */
export const THEME_PREFERENCE_LABELS: Readonly<Record<ThemePreference, string>> = {
    dark: 'Dark', light: 'Light', midnight: 'Midnight',
    'hc-dark': 'High contrast dark', 'hc-light': 'High contrast light', system: 'Sync with system',
};

export function isThemePreference(v: unknown): v is ThemePreference {
    return typeof v === 'string' && (THEME_PREFERENCES as readonly string[]).includes(v);
}

/**
 * A preference -> the theme id it shows now. `system` follows `systemDark`,
 * and picks a high-contrast theme when the OS asks for more contrast.
 */
export function themeIdForPreference(pref: unknown, systemDark: boolean, systemMoreContrast = false): ThemeId {
    if (pref === 'system') {
        if (systemMoreContrast) return systemDark ? 'hc-dark' : 'hc-light';
        return systemDark ? 'dark' : 'light';
    }
    return isThemeId(pref) ? pref : DEFAULT_THEME_ID;
}

/**
 * Surfaces that stay DARK in every theme (owner decision D4, the website's
 * "dark islands"): the engine re-declares the Dark tokens on them, so
 * everything inside paints exactly as it does in Dark. Add a root selector
 * here (or put `cl-island-dark` on the element) instead of branching a
 * component on the theme id.
 */
export const DARK_ISLAND_SELECTORS: readonly string[] = [
    '.cl-island-dark',
    // Profile card (popout .pcd, full profile .pfp): profile themes are designed on navy.
    '.pcd', '.pfp', '.ppo', '.ppo--panel',
    // Celebrations: Pro welcome, level up, the gift box unwrap, easter-egg moments.
    '.pcel', '.lvu', '.gb', '.mo-root',
    // The Firewall game.
    '.fw-root',
    // Fullscreen call console (the stage around video is dark context).
    '.cl-console',
    // Every video / participant tile (VideoTile's root): video is dark context.
    '.cl-tile-hover',
];

/** Opaque palette tokens — each becomes `--cl-<token>` and `--cl-<token>-rgb`. */
export const PALETTE_TOKENS = [
    // Surfaces (dark -> light)
    'abyss', 'deep', 'surface', 'raise', 'border', 'sink',
    // Lume — you & secure
    'lume', 'lume-hi', 'lume-press', 'lume-deep', 'on-lume',
    // Flash — others & careful
    'flash', 'flash-press', 'flash-deep', 'on-flash',
    // Status & warmth
    'glow', 'on-glow', 'ok', 'danger',
    // Text hierarchy
    'text', 'muted', 'faint',
    // ── Light-theme slice (T3). Each equals an existing Dark colour, so
    // swapping a literal for one of these never changes Dark.
    // Control boundaries (inputs, toggles, checkboxes): >= 3:1 where the
    // hairline `border` is decorative only.
    'border-strong',
    // "white" in Dark: the strongest foreground and the base of hover /
    // press lifts (`rgb(var(--cl-bright-rgb) / .06)`); ink in Light.
    'bright',
    // "black" in Dark: shadows and scrims; warm brown in Light.
    'shade',
    // The hole of the Do Not Disturb dot.
    'dot-hole',
    // Accent / status colours used as TEXT (links, mentions, warnings, errors).
    // Equal to the fill in Dark; darker in Light, where the fills are 1.5-3:1.
    'lume-text', 'flash-text', 'glow-text', 'ok-text', 'danger-text', 'info-text',
    // Lume as a standalone indicator (toggle on, progress, selected tab): 3:1.
    'lume-ui',
    // Presence dots (>= 3:1 on the panels in Light).
    'ok-dot', 'idle-dot', 'dnd-dot', 'offline-dot',
    // Colours that do NOT change with the theme (white text on a coloured
    // fill, a black video well): `text-pure-white`, `bg-pure-black`.
    'pure-white', 'pure-black',
    // Code blocks: the text and the syntax-highlight hues (styles/formatting.css .cl-hl-*).
    'code-text', 'code-kw', 'code-str', 'code-num', 'code-lit', 'code-type', 'code-add', 'code-del',
    // Keys, the mascot (components/mascot/Keys.tsx). His body is the brand
    // teal (`lume`) in every theme, his eyes the website's navy ink. The
    // 'alert' state (you were @mentioned) tints him amber in Dark; in Light
    // amber on cream read as "why is Keys yellow?" (owner, 2026-11-20), so
    // there he stays teal like the website's Keys and the alert is his
    // urgent leg cadence alone.
    'keys-alert', 'keys-ink',
] as const;
export type PaletteToken = (typeof PALETTE_TOKENS)[number];

/** Colours that carry alpha — each becomes `--cl-<token>` (no `-rgb`). */
export const ALPHA_TOKENS = ['lume-tint', 'flash-tint', 'scrim-egg', 'scrim-egg-core', 'overlay-hover', 'overlay-press', 'scrim'] as const;
export type AlphaToken = (typeof ALPHA_TOKENS)[number];

/** Shadows / glows — each becomes `--cl-<token>`. */
export const EFFECT_TOKENS = [
    'shadow-menu', 'shadow-press', 'glow-lume', 'glow-lume-hot', 'shadow-card', 'shadow-pop',
    // Light-theme polish (2026-11-20, owner: "I like the idea of having some
    // drop shadows here and there"). The `elev-*` ladder is a NO-OP layer in
    // Dark (a transparent zero shadow, so it can be appended to an existing
    // shadow list without changing a pixel) and the website's warm brown
    // elevation in Light (apps/website/src/styles/light.css):
    //   elev-1  small things that sit on a panel: the active channel row, the
    //           rail's active-server pill (the site's ghost-button cap)
    //   elev-2  cards and tracks: the rail decks (the site's --lt-shadow-pop)
    //   elev-3  the floating panels: channel list, chat, right panel, solo panes
    'elev-1', 'elev-2', 'elev-3',
    // The floating panels that ALREADY cast a shadow in Dark (right panel,
    // Home / Friends): Dark keeps today's value, Light takes elev-3.
    'shadow-panel',
    // The message composer's lift (was an inline black literal in ChatPane).
    'shadow-composer',
] as const;
export type EffectToken = (typeof EFFECT_TOKENS)[number];

/** Semantic aliases (unprefixed names, index.css lines "Semantic aliases"): name -> palette token. */
export const SEMANTIC_TOKENS = [
    'surface-page', 'surface-panel', 'surface-card', 'surface-input', 'surface-hover', 'border-hairline',
    'text-body', 'text-secondary', 'text-tertiary', 'accent', 'accent-on', 'careful', 'careful-on', 'warm', 'online',
] as const;
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number];

/** The brand-guide kit's own token set (styles/cl-kit.css `:root`, unprefixed). */
export const KIT_TOKENS = [
    'abyss', 'deep', 'surface', 'raise', 'border',
    'lume', 'lume-hi', 'lume-press', 'lume-deep', 'on-lume',
    'flash', 'flash-press', 'flash-deep', 'on-flash',
    'glow', 'ok', 'text', 'muted', 'faint',
] as const;
export type KitToken = (typeof KIT_TOKENS)[number];

export interface Theme {
    /** Schema version of this object (THEME_SCHEMA_VERSION). */
    v: typeof THEME_SCHEMA_VERSION;
    id: ThemeId;
    /** UI name (owner decision D2: plain names). */
    name: string;
    /** Written as `color-scheme` (native controls, scrollbars, form popups). */
    scheme: 'dark' | 'light';
    palette: Record<PaletteToken, string>;
    alpha: Record<AlphaToken, string>;
    effects: Record<EffectToken, string>;
    semantic: Record<SemanticToken, PaletteToken>;
    kit: Record<KitToken, PaletteToken>;
    /** What is painted before any stylesheet or script runs. */
    boot: {
        /** index.html's inline backdrop, top -> bottom (same as .lo-root in app-loading.css). */
        gradient: readonly [string, string, string];
        /** Windows/Linux caption-button overlay (electron main `titleBarOverlay`). */
        titleBar: { color: PaletteToken; symbolColor: PaletteToken };
        /** BrowserWindow `backgroundColor` of the main window. */
        windowBackground: PaletteToken;
        /** The "Applying update" card / opaque popup background. */
        card: PaletteToken;
    };
    /**
     * Role / username colours are user-picked. Below this contrast against
     * the panel (`deep`) they are moved toward readability, keeping the hue
     * (utils/roleColor.ts readableNameColor). 1 = shown exactly as picked
     * (Dark, unchanged since before themes).
     */
    nameMinContrast: number;
    /**
     * Set on a CUSTOM theme (src/theme/customTheme.ts deriveCustomTheme): its
     * library id. `id` is then the custom theme's BASE ('dark' | 'light') and
     * `scheme` the base's scheme, so the engine's `data-scheme` puts every
     * light-kind rule (`:root[data-scheme="light"]`) on a light-base custom
     * theme; the engine adds `data-custom-theme` and a more specific rule for
     * the colours. Theme-specific rules keyed on `data-theme="midnight"` and
     * `data-contrast="high"` never apply to a custom theme.
     */
    customId?: string;
    /** Extra CSS variables a custom theme derives (the light stylesheet's `--lt-*`). */
    extra?: Readonly<Record<string, string>>;
    /**
     * 'high' marks a high-contrast theme: the engine sets
     * `data-contrast="high"` on <html>, which turns on styles/theme-contrast.css
     * (2px control / panel edges, a strong focus ring, underlined links, no
     * glows). Absent = normal.
     */
    contrast?: 'high';
}

/** Today's look ("glow in the deep"). Values are byte-for-byte what index.css had. */
export const DARK_THEME: Theme = {
    v: THEME_SCHEMA_VERSION,
    id: 'dark',
    name: 'Dark',
    scheme: 'dark',
    palette: {
        abyss: '#0B0F1E',
        deep: '#131A30',
        surface: '#1C2542',
        raise: '#243056',
        border: '#2A3558',
        sink: '#0A1120',
        lume: '#25E0C8',
        'lume-hi': '#3BEAD6',
        'lume-press': '#12B79F',
        'lume-deep': '#0E8F7C',
        'on-lume': '#06251F',
        flash: '#FF6B5E',
        'flash-press': '#D14A3F',
        'flash-deep': '#B23A30',
        'on-flash': '#3A0E0A',
        glow: '#FFC94D',
        'on-glow': '#4A3406',
        ok: '#4ADE80',
        danger: '#FF5C7A',
        text: '#F4F7FF',
        muted: '#A7B3D4',
        // Owner decision D3 (plan default, 2026-11-20): was #5E6B8F, which failed
        // WCAG AA as text everywhere (2.4-3.6:1, ~630 uses: timestamps, hints).
        // #8591B5 passes on every surface but the hover fill (raise, 4.1:1).
        faint: '#8591B5',
        'border-strong': '#6B78A0',
        bright: '#FFFFFF',
        shade: '#000000',
        'dot-hole': '#000000',
        'lume-text': '#25E0C8',
        'flash-text': '#FF6B5E',
        'glow-text': '#FFC94D',
        'ok-text': '#4ADE80',
        'danger-text': '#FF5C7A',
        'info-text': '#5E8EE0',
        'lume-ui': '#25E0C8',
        'ok-dot': '#4ADE80',
        'idle-dot': '#FFC94D',
        'dnd-dot': '#FF6B5E',
        'offline-dot': '#5E6B8F',
        'pure-white': '#FFFFFF',
        'pure-black': '#000000',
        'code-text': '#DCE3F5',
        'code-kw': '#C7A6FF',
        'code-str': '#FFD47A',
        'code-num': '#FF9F85',
        'code-lit': '#FF8A7E',
        'code-type': '#7CC9FF',
        'code-add': '#6EE79A',
        'code-del': '#FF8A9E',
        'keys-alert': '#FFC94D',   // = glow
        'keys-ink': '#0B0F1E',     // = abyss
    },
    alpha: {
        'lume-tint': 'rgba(37,224,200,.12)',
        'flash-tint': 'rgba(255,107,94,.12)',
        'scrim-egg': 'rgba(5, 8, 20, .78)',
        'scrim-egg-core': 'rgba(5, 8, 20, .5)',
        'overlay-hover': 'rgba(255,255,255,.06)',
        'overlay-press': 'rgba(255,255,255,.1)',
        scrim: 'rgba(5,8,20,.72)',
    },
    effects: {
        'shadow-menu': '0 14px 34px rgba(0,0,0,.5)',
        'shadow-press': 'inset 0 3px 7px rgba(0,0,0,.45)',
        'glow-lume': '0 0 14px rgba(37,224,200,.22)',
        'glow-lume-hot': '0 0 14px rgba(37,224,200,.6)',
        'shadow-card': '0 10px 30px rgba(0,0,0,.35)',
        'shadow-pop': '0 18px 40px rgba(0,0,0,.5)',
        // No elevation ladder in Dark: the deep has glows, not drop shadows.
        'elev-1': '0 0 0 0 transparent',
        'elev-2': '0 0 0 0 transparent',
        'elev-3': '0 0 0 0 transparent',
        'shadow-panel': '0 14px 34px rgba(0,0,0,.35)',
        'shadow-composer': '0 2px 12px rgba(0,0,0,.22)',
    },
    semantic: {
        'surface-page': 'abyss',
        'surface-panel': 'deep',
        'surface-card': 'deep',
        'surface-input': 'surface',
        'surface-hover': 'raise',
        'border-hairline': 'border',
        'text-body': 'text',
        'text-secondary': 'muted',
        'text-tertiary': 'faint',
        accent: 'lume',
        'accent-on': 'on-lume',
        careful: 'flash',
        'careful-on': 'on-flash',
        warm: 'glow',
        online: 'ok',
    },
    kit: {
        abyss: 'abyss', deep: 'deep', surface: 'surface', raise: 'raise', border: 'border',
        lume: 'lume', 'lume-hi': 'lume-hi', 'lume-press': 'lume-press', 'lume-deep': 'lume-deep', 'on-lume': 'on-lume',
        flash: 'flash', 'flash-press': 'flash-press', 'flash-deep': 'flash-deep', 'on-flash': 'on-flash',
        glow: 'glow', ok: 'ok', text: 'text', muted: 'muted', faint: 'faint',
    },
    boot: {
        gradient: ['#131A30', '#0F1526', '#0B0F1E'],
        titleBar: { color: 'abyss', symbolColor: 'text' },
        windowBackground: 'abyss',
        card: 'deep',
    },
    nameMinContrast: 1,
};

/**
 * Light (owner, 2026-11-20: "for the light mode lets match the look to the
 * website style"). Source: apps/website/src/styles/light.css (`.lt`) and
 * portal-light.css (`.pl`); contrast pinned in themeContrast.test.ts.
 * Cream ground, white panels, ink text, the brand teal kept as a FILL with a
 * darker teal for text, warm brown shadows instead of glows.
 */
export const LIGHT_THEME: Theme = {
    v: THEME_SCHEMA_VERSION,
    id: 'light',
    name: 'Light',
    scheme: 'light',
    palette: {
        abyss: '#FFF8EE',     // website cream (.lt --cl-abyss)
        deep: '#FFFFFF',      // panels / cards
        surface: '#F6EEE1',   // insets, inputs: between the site's #F4EBDC and #FBF4E8 so faint text passes
        raise: '#EEE1CB',     // hover (.lt --cl-raise)
        border: '#E6D6BD',    // decorative hairline only (1.4:1)
        sink: '#FBF4E8',      // the site's sand
        lume: '#25E0C8',      // brand teal: a FILL only (1.6:1 on white)
        'lume-hi': '#3BEAD6',
        'lume-press': '#12B79F',
        'lume-deep': '#0A6B60',
        'on-lume': '#06251F',
        flash: '#FF6B5E',
        'flash-press': '#D14A3F',
        'flash-deep': '#B23A30',
        'on-flash': '#3A0E0A',
        glow: '#FFC94D',
        'on-glow': '#4A3406',
        ok: '#4ADE80',
        danger: '#FF5C7A',
        text: '#1C2240',      // website ink
        muted: '#4E5573',
        faint: '#5A6383',     // the site's #646B88 is 4.07:1 on raise; darkened to pass
        'border-strong': '#8C7D66',
        bright: '#1C2240',
        shade: '#3C2C14',     // the website's warm shadow colour rgba(60,44,20,…)
        'dot-hole': '#FFFFFF',
        'lume-text': '#0A6B60',
        'flash-text': '#B42318', // portal error text
        'glow-text': '#8A4B05',
        'ok-text': '#166534',
        'danger-text': '#B4234A',
        'info-text': '#1D4ED8',
        'lume-ui': '#0E8F7C',
        'ok-dot': '#1F9D55',
        'idle-dot': '#B7791F',
        'dnd-dot': '#D63B57',
        'offline-dot': '#7C8398',
        'pure-white': '#FFFFFF',
        'pure-black': '#000000',
        // GitHub-light-like hues, each >= 4.5:1 on the sand code well (sink).
        'code-text': '#1C2240',
        'code-kw': '#7B30C9',
        'code-str': '#0A6B3D',
        'code-num': '#A3480A',
        'code-lit': '#B42318',
        'code-type': '#0B5CAD',
        'code-add': '#166534',
        'code-del': '#B4234A',
        'keys-alert': '#25E0C8',   // teal, as the website's Keys (see PALETTE_TOKENS)
        'keys-ink': '#0B0F1E',     // the website Keys' eyes (40-keys.js), not the cream abyss
    },
    alpha: {
        'lume-tint': 'rgba(37,224,200,.18)',
        'flash-tint': '#FFEDEA',
        // Easter-egg moments stay a dark stage (D4).
        'scrim-egg': 'rgba(5, 8, 20, .78)',
        'scrim-egg-core': 'rgba(5, 8, 20, .5)',
        'overlay-hover': 'rgba(28,34,64,.05)',
        'overlay-press': 'rgba(28,34,64,.09)',
        scrim: 'rgba(28,34,64,.34)',   // the portal's modal backdrop
    },
    effects: {
        'shadow-menu': '0 18px 40px -12px rgba(60,44,20,.25), 0 2px 8px rgba(60,44,20,.08)',
        'shadow-press': 'inset 0 3px 7px rgba(60,44,20,.16)',
        'glow-lume': '0 10px 30px -8px rgba(10,116,102,.25)',
        'glow-lume-hot': '0 10px 26px -6px rgba(10,116,102,.45)',
        'shadow-card': '0 1px 0 rgba(255,255,255,.9) inset, 0 22px 44px -28px rgba(92,64,24,.28), 0 2px 6px -2px rgba(92,64,24,.08)',
        'shadow-pop': '0 18px 40px -18px rgba(60,44,20,.32), 0 3px 8px -3px rgba(60,44,20,.12)',
        'elev-1': '0 1px 2px rgba(60,44,20,.06), 0 6px 16px -10px rgba(60,44,20,.30)',
        'elev-2': '0 18px 40px -18px rgba(60,44,20,.32), 0 3px 8px -3px rgba(60,44,20,.12)',
        'elev-3': '0 24px 48px -24px rgba(60,44,20,.30), 0 3px 10px -4px rgba(60,44,20,.10)',
        'shadow-panel': '0 24px 48px -24px rgba(60,44,20,.30), 0 3px 10px -4px rgba(60,44,20,.10)',
        'shadow-composer': '0 1px 2px rgba(60,44,20,.06), 0 6px 16px -8px rgba(60,44,20,.28)',
    },
    semantic: DARK_THEME.semantic,
    kit: {
        // As the website's portal (.pl): white fields, a 3:1 control edge.
        abyss: 'sink', deep: 'deep', surface: 'deep', raise: 'surface', border: 'border-strong',
        lume: 'lume', 'lume-hi': 'lume-hi', 'lume-press': 'lume-press', 'lume-deep': 'lume-deep', 'on-lume': 'on-lume',
        flash: 'flash', 'flash-press': 'flash-press', 'flash-deep': 'flash-deep', 'on-flash': 'on-flash',
        glow: 'glow', ok: 'ok', text: 'text', muted: 'muted', faint: 'faint',
    },
    boot: {
        gradient: ['#FFFDF8', '#FFF8EE', '#FBF4E8'],
        titleBar: { color: 'abyss', symbolColor: 'text' },
        windowBackground: 'abyss',
        card: 'deep',
    },
    nameMinContrast: 4.5,
};

const NO_SHADOW = '0 0 0 0 transparent';

/**
 * Midnight (owner, 2026-11-20: "do we have a full dark one?"): a true black
 * ground for OLED screens. The page is #000000; panels sit a hair above it
 * with the faintest navy cast (so it still reads as Cipherline's deep, not a
 * generic grey-black), and the hairline borders do the separating that the
 * navy steps do in Dark. The brand teal stays the accent; glows are cut to a
 * whisper (a glow on pure black reads cheap). Contrast: every text colour
 * >= 4.5:1 on every surface including the hover fill, control edges >= 3:1
 * (themeContrast.test.ts). Dark islands (profile cards, celebrations, the
 * Firewall, the call stage) keep Dark's navy, as in Light.
 */
export const MIDNIGHT_THEME: Theme = {
    v: THEME_SCHEMA_VERSION,
    id: 'midnight',
    name: 'Midnight',
    scheme: 'dark',
    palette: {
        ...DARK_THEME.palette,
        abyss: '#000000',     // the page: true black
        deep: '#0A0C12',      // panels: a hair above black, a trace of navy
        surface: '#131722',   // inputs, cards
        raise: '#1C2130',     // hover
        border: '#2C3346',    // the hairline that separates panels from the black (1.67:1 on black)
        sink: '#05060A',      // code wells
        text: '#F2F5FC',
        muted: '#A8B1C6',
        faint: '#8A93A9',     // 5.2:1 even on the hover fill (Dark's faint is 4.1 there)
        'border-strong': '#687290',
        'offline-dot': '#6B7591',
    },
    alpha: {
        ...DARK_THEME.alpha,
        scrim: 'rgba(0,0,0,.8)',
    },
    effects: {
        'shadow-menu': '0 14px 34px rgba(0,0,0,.8)',
        'shadow-press': 'inset 0 3px 7px rgba(0,0,0,.6)',
        'glow-lume': '0 0 8px rgba(37,224,200,.1)',
        'glow-lume-hot': '0 0 10px rgba(37,224,200,.3)',
        'shadow-card': '0 10px 30px rgba(0,0,0,.6)',
        'shadow-pop': '0 18px 40px rgba(0,0,0,.75)',
        'elev-1': NO_SHADOW,
        'elev-2': NO_SHADOW,
        'elev-3': NO_SHADOW,
        'shadow-panel': NO_SHADOW,
        'shadow-composer': '0 2px 12px rgba(0,0,0,.5)',
    },
    semantic: DARK_THEME.semantic,
    kit: DARK_THEME.kit,
    boot: {
        gradient: ['#05070C', '#020306', '#000000'],
        titleBar: { color: 'abyss', symbolColor: 'text' },
        windowBackground: 'abyss',
        card: 'deep',
    },
    nameMinContrast: 4.5,
};

/**
 * High contrast dark: black ground, white text, every text colour >= 7:1
 * (WCAG AAA) on every surface, control and panel edges >= 3:1 (the hairline
 * itself is a strong grey here, 8:1). styles/theme-contrast.css adds what
 * colour alone cannot: 2px edges on controls and panels, a strong focus ring,
 * underlined links, no glows. The status colours are lifted so they stay
 * >= 7:1 as text; presence keeps its shapes (utils/userStatusModel.ts).
 */
export const HC_DARK_THEME: Theme = {
    v: THEME_SCHEMA_VERSION,
    id: 'hc-dark',
    name: 'High contrast dark',
    scheme: 'dark',
    contrast: 'high',
    palette: {
        abyss: '#000000',
        deep: '#000000',
        surface: '#0E1015',
        raise: '#1E232C',
        border: '#9AA3B5',
        sink: '#000000',
        lume: '#25E0C8',
        'lume-hi': '#5FF5E2',
        'lume-press': '#12B79F',
        'lume-deep': '#0E8F7C',
        'on-lume': '#000000',
        flash: '#FF7A6E',
        'flash-press': '#D14A3F',
        'flash-deep': '#B23A30',
        'on-flash': '#000000',
        glow: '#FFC94D',
        'on-glow': '#000000',
        ok: '#4ADE80',
        danger: '#FF7D95',
        text: '#FFFFFF',
        muted: '#E2E7F0',
        faint: '#C8CFDB',
        'border-strong': '#D2D8E3',
        bright: '#FFFFFF',
        shade: '#000000',
        'dot-hole': '#000000',
        'lume-text': '#3DF0D9',
        'flash-text': '#FF9A90',
        'glow-text': '#FFD873',
        'ok-text': '#7CF0A6',
        'danger-text': '#FF9AAD',
        'info-text': '#9EC1FF',
        'lume-ui': '#25E0C8',
        'ok-dot': '#4ADE80',
        'idle-dot': '#FFC94D',
        'dnd-dot': '#FF6B5E',
        'offline-dot': '#A0A8B8',
        'pure-white': '#FFFFFF',
        'pure-black': '#000000',
        'code-text': '#F2F5FF',
        'code-kw': '#D9C2FF',
        'code-str': '#FFE09A',
        'code-num': '#FFB8A3',
        'code-lit': '#FFA79E',
        'code-type': '#A6DBFF',
        'code-add': '#8EF0B2',
        'code-del': '#FFA8B8',
        'keys-alert': '#FFC94D',
        'keys-ink': '#0B0F1E',
    },
    alpha: {
        'lume-tint': 'rgba(37,224,200,.2)',
        'flash-tint': 'rgba(255,122,110,.2)',
        'scrim-egg': DARK_THEME.alpha['scrim-egg'],
        'scrim-egg-core': DARK_THEME.alpha['scrim-egg-core'],
        'overlay-hover': 'rgba(255,255,255,.14)',
        'overlay-press': 'rgba(255,255,255,.22)',
        scrim: 'rgba(0,0,0,.85)',
    },
    effects: {
        'shadow-menu': '0 14px 34px rgba(0,0,0,.7)',
        'shadow-press': 'inset 0 3px 7px rgba(0,0,0,.6)',
        'glow-lume': NO_SHADOW,
        'glow-lume-hot': NO_SHADOW,
        'shadow-card': NO_SHADOW,
        'shadow-pop': '0 18px 40px rgba(0,0,0,.7)',
        'elev-1': NO_SHADOW,
        'elev-2': NO_SHADOW,
        'elev-3': NO_SHADOW,
        'shadow-panel': NO_SHADOW,
        'shadow-composer': NO_SHADOW,
    },
    semantic: DARK_THEME.semantic,
    kit: DARK_THEME.kit,
    boot: {
        gradient: ['#000000', '#000000', '#000000'],
        titleBar: { color: 'abyss', symbolColor: 'text' },
        windowBackground: 'abyss',
        card: 'deep',
    },
    // 8, not 7: names sit on the member-group tint / a hover fill too, and clear 7:1 there.
    nameMinContrast: 8,
};

/**
 * High contrast light: white ground, near-black ink, every text colour >=
 * 7:1 on every surface. Built on Light's kind of rules (styles/theme-light*.css
 * apply to every light-scheme theme through `data-scheme="light"`), so the
 * brand teal stays a FILL with black labels (12.6:1) and a dark teal for
 * text; theme-contrast.css adds the 2px edges, focus ring, underlined links
 * and drops the warm shadows.
 */
export const HC_LIGHT_THEME: Theme = {
    v: THEME_SCHEMA_VERSION,
    id: 'hc-light',
    name: 'High contrast light',
    scheme: 'light',
    contrast: 'high',
    palette: {
        abyss: '#FFFFFF',
        deep: '#FFFFFF',
        surface: '#FFFFFF',
        raise: '#E4E8EF',
        border: '#5C6478',
        sink: '#F2F4F8',
        lume: '#25E0C8',
        'lume-hi': '#3BEAD6',
        'lume-press': '#12B79F',
        'lume-deep': '#0A6B60',
        'on-lume': '#000000',
        flash: '#FF6B5E',
        'flash-press': '#D14A3F',
        'flash-deep': '#B23A30',
        'on-flash': '#000000',
        glow: '#FFC94D',
        'on-glow': '#000000',
        ok: '#4ADE80',
        danger: '#FF5C7A',
        text: '#0A0E1F',
        muted: '#262C40',
        faint: '#373E54',
        'border-strong': '#1C2240',
        bright: '#0A0E1F',
        shade: '#000000',
        'dot-hole': '#FFFFFF',
        'lume-text': '#005248',
        'flash-text': '#8A140D',
        'glow-text': '#5E3300',
        'ok-text': '#0B5228',
        'danger-text': '#931236',
        'info-text': '#1036A0',
        'lume-ui': '#00594F',
        'ok-dot': '#13703A',
        'idle-dot': '#8A5A00',
        'dnd-dot': '#C4261A',
        'offline-dot': '#5C6478',
        'pure-white': '#FFFFFF',
        'pure-black': '#000000',
        'code-text': '#0A0E1F',
        'code-kw': '#5B1FA6',
        'code-str': '#0B5A2A',
        'code-num': '#7A3300',
        'code-lit': '#8A140D',
        'code-type': '#0A4A8C',
        'code-add': '#0B5228',
        'code-del': '#931236',
        'keys-alert': '#25E0C8',
        'keys-ink': '#0B0F1E',
    },
    alpha: {
        'lume-tint': 'rgba(0,89,79,.12)',
        'flash-tint': '#FFE3E0',
        'scrim-egg': DARK_THEME.alpha['scrim-egg'],
        'scrim-egg-core': DARK_THEME.alpha['scrim-egg-core'],
        'overlay-hover': 'rgba(10,14,31,.08)',
        'overlay-press': 'rgba(10,14,31,.14)',
        scrim: 'rgba(10,14,31,.6)',
    },
    effects: {
        'shadow-menu': '0 8px 24px rgba(0,0,0,.22)',
        'shadow-press': 'inset 0 2px 5px rgba(0,0,0,.2)',
        'glow-lume': NO_SHADOW,
        'glow-lume-hot': NO_SHADOW,
        'shadow-card': NO_SHADOW,
        'shadow-pop': '0 12px 28px rgba(0,0,0,.22)',
        'elev-1': NO_SHADOW,
        'elev-2': NO_SHADOW,
        'elev-3': NO_SHADOW,
        'shadow-panel': NO_SHADOW,
        'shadow-composer': NO_SHADOW,
    },
    semantic: DARK_THEME.semantic,
    kit: {
        // As Light's (the portal's white fields), with a dark control edge.
        abyss: 'sink', deep: 'deep', surface: 'deep', raise: 'raise', border: 'border-strong',
        lume: 'lume', 'lume-hi': 'lume-hi', 'lume-press': 'lume-press', 'lume-deep': 'lume-deep', 'on-lume': 'on-lume',
        flash: 'flash', 'flash-press': 'flash-press', 'flash-deep': 'flash-deep', 'on-flash': 'on-flash',
        glow: 'glow', ok: 'ok', text: 'text', muted: 'muted', faint: 'faint',
    },
    boot: {
        gradient: ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
        titleBar: { color: 'abyss', symbolColor: 'text' },
        windowBackground: 'abyss',
        card: 'deep',
    },
    // 8, not 7: names sit on the member-group tint / a hover fill too, and clear 7:1 there.
    nameMinContrast: 8,
};

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
    dark: DARK_THEME, light: LIGHT_THEME, midnight: MIDNIGHT_THEME, 'hc-dark': HC_DARK_THEME, 'hc-light': HC_LIGHT_THEME,
};

export function isThemeId(v: unknown): v is ThemeId {
    return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}

/** Any stored/passed value -> a built-in theme (unknown, tampered or missing = default). */
export function resolveTheme(id: unknown): Theme {
    return THEMES[isThemeId(id) ? id : DEFAULT_THEME_ID];
}

/**
 * Tailwind colour names -> palette token. The class names are the long-standing
 * ones (tailwind.config.js before T1), legacy aliases included; each now
 * compiles to `rgb(var(--cl-<token>-rgb) / <alpha-value>)`.
 */
export const TAILWIND_COLORS: Readonly<Record<string, PaletteToken>> = {
    'cl-abyss': 'abyss', 'cl-deep': 'deep', 'cl-surface': 'surface', 'cl-raise': 'raise', 'cl-border': 'border', 'cl-sink': 'sink',
    primary: 'lume', 'cl-lume': 'lume', 'cl-lume-hi': 'lume-hi', 'cl-lume-press': 'lume-press', 'cl-lume-deep': 'lume-deep', 'cl-on-lume': 'on-lume',
    'cl-flash': 'flash', 'cl-flash-press': 'flash-press', 'cl-flash-deep': 'flash-deep', 'cl-on-flash': 'on-flash',
    'cl-glow': 'glow', 'cl-ok': 'ok', 'cl-danger': 'danger',
    'cl-text': 'text', 'cl-muted': 'muted', 'cl-faint': 'faint',
    // Legacy aliases (classes still referencing old names)
    'page-bg': 'abyss', 'panel-bg': 'deep', 'surface-raised': 'surface', 'surface-elevated': 'raise',
    'bubble-recv': 'surface', 'bubble-send': 'lume',
    // Short reachable aliases (PORTING-PLAN handoff)
    flash: 'flash', glow: 'glow', online: 'ok', 'text-body': 'text',
    // Light-theme slice: text / indicator / boundary tokens.
    'cl-border-strong': 'border-strong', 'cl-bright': 'bright', 'cl-shade': 'shade',
    'cl-lume-text': 'lume-text', 'cl-flash-text': 'flash-text', 'cl-glow-text': 'glow-text', 'cl-ok-text': 'ok-text',
    'cl-danger-text': 'danger-text', 'cl-info-text': 'info-text', 'cl-lume-ui': 'lume-ui',
    'pure-white': 'pure-white', 'pure-black': 'pure-black',
    // Tailwind's own white / black follow the theme: `bg-white/5` is a hover
    // lift in Dark and an ink lift in Light, `text-white` the strongest text,
    // `bg-black/50` a scrim. Identical to Tailwind's #fff / #000 in Dark. Use
    // pure-white / pure-black where the colour must not change.
    white: 'bright', black: 'shade',
};

/** '#25E0C8' -> '37 224 200' (the space-separated channels Tailwind's `<alpha-value>` pattern needs). */
export function hexToRgbChannels(hex: string): string {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`theme palette colours must be #RRGGBB, got ${hex}`);
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** The `-rgb` channel variables alone (Tailwind's base layer emits these for the default theme). */
export function themeRgbVariables(theme: Theme): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of PALETTE_TOKENS) out[`--cl-${t}-rgb`] = hexToRgbChannels(theme.palette[t]);
    return out;
}

/** Every CSS custom property a theme sets, in a stable order. */
export function themeCssVariables(theme: Theme): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of PALETTE_TOKENS) out[`--cl-${t}`] = theme.palette[t];
    Object.assign(out, themeRgbVariables(theme));
    for (const t of ALPHA_TOKENS) out[`--cl-${t}`] = theme.alpha[t];
    for (const t of EFFECT_TOKENS) out[`--cl-${t}`] = theme.effects[t];
    for (const t of SEMANTIC_TOKENS) out[`--${t}`] = `var(--cl-${theme.semantic[t]})`;
    for (const t of KIT_TOKENS) out[`--${t}`] = theme.palette[theme.kit[t]];
    // Custom themes only: derived values, never user text (customTheme.ts); re-checked here anyway.
    for (const [k, v] of Object.entries(theme.extra ?? {})) {
        if (/^--[a-z0-9-]{1,40}$/.test(k) && /^[#0-9a-zA-Z(),. -]{1,120}$/.test(v)) out[k] = v;
    }
    return out;
}

/** The root selector a theme's rule uses: built-ins by id, custom themes by base + `data-custom-theme`. */
export function themeRootSelector(theme: Theme): string {
    return theme.customId ? `:root[data-theme="${theme.id}"][data-custom-theme]` : `:root[data-theme="${theme.id}"]`;
}

/** The CSS rule the engine injects: `:root[data-theme="dark"]{...;color-scheme:dark}`. */
export function themeCssText(theme: Theme): string {
    const decls = Object.entries(themeCssVariables(theme)).map(([k, v]) => `${k}:${v}`);
    decls.push(`color-scheme:${theme.scheme}`);
    const root = themeRootSelector(theme);
    const rule = `${root}{${decls.join(';')}}`;
    if (theme.id === DARK_THEME.id && !theme.customId) return rule;
    // Dark islands (D4): the Dark tokens re-declared on each island root.
    const dark = Object.entries(themeCssVariables(DARK_THEME)).map(([k, v]) => `${k}:${v}`);
    dark.push('color-scheme:dark');
    const sel = DARK_ISLAND_SELECTORS.map((s) => `${root} ${s}`).join(',');
    return `${rule}\n${sel}{${dark.join(';')}}`;
}

/** Every `--cl-*` name a theme defines (for the token-coverage test). */
export function themeClVariableNames(theme: Theme = DARK_THEME): string[] {
    return Object.keys(themeCssVariables(theme)).filter((k) => k.startsWith('--cl-'));
}
