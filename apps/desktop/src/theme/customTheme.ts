/**
 * Custom themes — DATA ONLY (owner decision D7: never raw user CSS).
 *
 * Plan: docs/plans/accessibility-and-themes.md (branch claude/a11y-themes-plan),
 * slice T5 / phase 7. A custom theme is a small versioned JSON object:
 *
 *   { v: 1, name, base: 'dark' | 'light', colors: { bg, panel, surface, text,
 *     muted, accent, onAccent, danger, border }, glow: boolean }
 *
 * The user picks those nine meaningful colours (+ glow on/off). Everything
 * else — hover / press / tints / alpha / rgb channels / shadows / text tiers /
 * status and code colours / the boot palette — is DERIVED here from the base
 * built-in theme plus the knobs, so a custom theme is always a complete Theme
 * (every PALETTE/ALPHA/EFFECT token) and the engine applies it exactly like a
 * built-in one.
 *
 * Three layers, all pure (no DOM, no storage, no React):
 *   1. parse + validate  (normalizeCustomTheme): a colour is accepted only if
 *      packages/shared/card-style.ts `parseCardColor` reads it as a LITERAL
 *      colour (hex / rgb() / hsl()), so url(), var(), theme(), expressions and
 *      anything else is refused; alpha is dropped (themes are opaque); the
 *      name is cleaned and capped; the whole object is size-capped.
 *   2. readability guard (makeReadable): grounds are clamped into the base's
 *      band, then text >= 4.5:1 on every ground, secondary text >= 4.5:1 on
 *      the panels, text-on-accent >= 4.5:1 on the accent. A pick that fails is
 *      NUDGED (same hue and chroma in OKLCH, nearest passing lightness — the
 *      card-style / role-colour approach), and the editor shows
 *      "adjusted for readability (X:1)". What is stored is the nudged value.
 *   3. derive (deriveCustomTheme): the full Theme. Accent-as-text, danger as
 *      text, control edges and indicators are themselves nudged to 4.5:1 / 3:1.
 *      auditTheme() measures every pair; a theme with any failure is never
 *      saved (the editor disables Save; tests fuzz it).
 *
 * Security indicators stay recognisable: the colours trust UI is drawn in
 * (TrustBadge: ok-text = verified, glow-text = unverified, flash-text =
 * compromised; presence dots; the dark islands — profile cards, celebrations,
 * call stage) are NOT user knobs. They keep the base theme's hue and are only
 * moved in lightness for contrast against the custom panels, and the islands
 * keep the Dark tokens exactly.
 */
import { cardColorRgba, parseCardColor } from '@cipherline/shared';
import { hexToOklch, oklchToHex } from '../utils/palette';
import { AA_TEXT, AA_UI, contrastRatio, relativeLuminance } from './contrast';
import {
    DARK_THEME, LIGHT_THEME, THEME_SCHEMA_VERSION, type PaletteToken, type Theme,
} from './themes';

export const CUSTOM_THEME_VERSION = 1 as const;
export const CUSTOM_THEME_BASES = ['dark', 'light'] as const;
export type CustomThemeBase = (typeof CUSTOM_THEME_BASES)[number];

/** The knobs a user edits, in editor order. */
export const CUSTOM_THEME_KNOBS = ['bg', 'panel', 'surface', 'text', 'muted', 'accent', 'onAccent', 'danger', 'border'] as const;
export type CustomThemeKnob = (typeof CUSTOM_THEME_KNOBS)[number];
export type CustomThemeColors = Record<CustomThemeKnob, string>;

export interface CustomThemeDef {
    v: typeof CUSTOM_THEME_VERSION;
    name: string;
    base: CustomThemeBase;
    colors: CustomThemeColors;
    /** Accent glows (Dark's "glow in the deep") instead of plain shadows. */
    glow: boolean;
}

/** A saved custom theme (the library entry): the def plus a stable id. */
export interface StoredCustomTheme extends CustomThemeDef {
    id: string;
}

export const CUSTOM_THEME_NAME_MAX = 40;
/** A normalised def serialises to ~330 bytes; anything far above is not a theme. */
export const CUSTOM_THEME_JSON_MAX = 2048;
export const CUSTOM_THEME_SHARE_PREFIX = 'clth1.';
export const CUSTOM_THEME_SHARE_MAX = 4096;
export const CUSTOM_THEME_FILE_KIND = 'cipherline-theme';
export const DEFAULT_CUSTOM_THEME_NAME = 'My theme';

/** Editor copy for each knob. */
export const KNOB_LABELS: Readonly<Record<CustomThemeKnob, { label: string; hint: string }>> = {
    bg: { label: 'Background', hint: 'The ground behind the panels' },
    panel: { label: 'Panels', hint: 'Channel list, chat, member list' },
    surface: { label: 'Inputs & cards', hint: 'Message box, fields, insets' },
    text: { label: 'Text', hint: 'Messages and names' },
    muted: { label: 'Secondary text', hint: 'Hints, timestamps, labels' },
    accent: { label: 'Accent', hint: 'Buttons, selection, links' },
    onAccent: { label: 'Text on accent', hint: 'Labels on accent buttons' },
    danger: { label: 'Danger', hint: 'Delete and leave actions' },
    border: { label: 'Lines', hint: 'Dividers and outlines' },
};

// ── Colour helpers ──────────────────────────────────────────────────────────

const HEX6 = /^#[0-9a-f]{6}$/;

/** '#aabbcc' -> [r, g, b]. */
function rgbOf(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
function hexOf([r, g, b]: readonly number[]): string {
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}
/** sRGB mix: t = 0 -> a, t = 1 -> b. */
export function mixHex(a: string, b: string, t: number): string {
    const x = rgbOf(a), y = rgbOf(b);
    return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t));
}
/** 'rgba(r,g,b,a)' from a hex. */
export function rgbaOf(hex: string, a: number): string {
    const [r, g, b] = rgbOf(hex);
    return `rgba(${r},${g},${b},${a})`;
}
const channelsOf = (hex: string) => rgbOf(hex).join(',');
const minContrast = (fg: string, bgs: readonly string[]) => Math.min(...bgs.map((b) => contrastRatio(fg, b)));
const BLACK = hexOf([0, 0, 0]);
const WHITE = hexOf([255, 255, 255]);

/** Round a ratio down to one decimal for display ("4.5:1" never overstates). */
export function formatRatio(r: number): string {
    return `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;
}

/**
 * The nearest colour to `hex` (same OKLCH hue and chroma, lightness moved as
 * little as possible) whose contrast against EVERY background in `bgs` is at
 * least `min`. Tries lighter and darker and keeps the smaller move; when
 * neither direction can pass (impossible pairs), black or white, whichever
 * reads better. Returns `hex` unchanged when it already passes.
 */
export function nudgeToContrast(hex: string, bgs: readonly string[], min: number): string {
    if (bgs.length === 0 || minContrast(hex, bgs) >= min) return hex;
    const { L, C, h } = hexToOklch(hex);
    const at = (l: number) => oklchToHex(l, C, h);
    const search = (towards: 0 | 1): { hex: string; dist: number } | null => {
        if (minContrast(at(towards), bgs) < min) return null;
        // Binary search the boundary; `pass` always holds a passing lightness.
        let pass: number = towards, fail = L;
        for (let i = 0; i < 28; i++) {
            const mid = (pass + fail) / 2;
            if (minContrast(at(mid), bgs) >= min) pass = mid; else fail = mid;
        }
        return { hex: at(pass), dist: Math.abs(pass - L) };
    };
    const up = search(1), down = search(0);
    const best = up && down ? (up.dist <= down.dist ? up : down) : up ?? down;
    if (best && minContrast(best.hex, bgs) >= min) return best.hex;
    return minContrast(WHITE, bgs) >= minContrast(BLACK, bgs) ? WHITE : BLACK;
}

/** Move a ground into the base's band: dark bases at most `max` luminance, light bases at least `min`. */
function clampGround(hex: string, base: CustomThemeBase): string {
    const lum = relativeLuminance(hex);
    if (base === 'dark' ? lum <= DARK_GROUND_MAX : lum >= LIGHT_GROUND_MIN) return hex;
    const { L, C, h } = hexToOklch(hex);
    const ok = (l: number) => {
        const y = relativeLuminance(oklchToHex(l, C, h));
        return base === 'dark' ? y <= DARK_GROUND_MAX : y >= LIGHT_GROUND_MIN;
    };
    let pass: number = base === 'dark' ? 0 : 1, fail = L;
    for (let i = 0; i < 28; i++) {
        const mid = (pass + fail) / 2;
        if (ok(mid)) pass = mid; else fail = mid;
    }
    return oklchToHex(pass, C, h);
}

/**
 * Ground bands. Every dark ground stays at or below 0.12 relative luminance
 * (about #616161) and every light one at or above 0.45 (about #B4B4B4), so a
 * text colour >= 4.5:1 on all of them always exists — the guard can always
 * fix a pick instead of refusing it.
 */
export const DARK_GROUND_MAX = 0.12;
export const LIGHT_GROUND_MIN = 0.45;

// ── Bases and presets ───────────────────────────────────────────────────────

const baseTheme = (b: CustomThemeBase): Theme => (b === 'light' ? LIGHT_THEME : DARK_THEME);
const lower = (hex: string) => hex.toLowerCase();

/** The knobs that reproduce a built-in theme (the "Start from Dark / Light" seeds). */
export function knobsFromTheme(t: Theme): CustomThemeColors {
    const p = t.palette;
    return {
        bg: lower(p.abyss), panel: lower(p.deep), surface: lower(p.surface), text: lower(p.text), muted: lower(p.muted),
        accent: lower(p.lume), onAccent: lower(p['on-lume']), danger: lower(p.danger), border: lower(p.border),
    };
}

/** A fresh def seeded from a built-in base. */
export function customThemeFromBase(base: CustomThemeBase, name = DEFAULT_CUSTOM_THEME_NAME): CustomThemeDef {
    return { v: CUSTOM_THEME_VERSION, name, base, colors: knobsFromTheme(baseTheme(base)), glow: base === 'dark' };
}

/**
 * A fresh def seeded from ANY built-in theme (Create theme while Midnight or
 * High contrast is on starts from those colours): the base is the theme's
 * scheme (a custom theme's base is always dark or light), the knobs its
 * colours, glow only for Dark. For Dark / Light this equals customThemeFromBase.
 */
export function customThemeFromTheme(t: Theme, name = DEFAULT_CUSTOM_THEME_NAME): CustomThemeDef {
    return { v: CUSTOM_THEME_VERSION, name, base: t.scheme, colors: knobsFromTheme(t), glow: t.id === DARK_THEME.id };
}

// ── Validation / normalisation ──────────────────────────────────────────────

export type CustomThemeError =
    | 'not-an-object' | 'too-large' | 'bad-version' | 'bad-base' | 'bad-colour' | 'bad-name' | 'bad-code' | 'unreadable';

export const CUSTOM_THEME_ERROR_TEXT: Readonly<Record<CustomThemeError, string>> = {
    'not-an-object': 'That is not a Cipherline theme.',
    'too-large': 'That theme is too large.',
    'bad-version': 'That theme was made by a newer Cipherline. Update to use it.',
    'bad-base': 'That theme has no valid base (dark or light).',
    'bad-colour': 'That theme contains something that is not a colour.',
    'bad-name': 'That theme has an invalid name.',
    'bad-code': 'That is not a theme code. Codes start with clth1.',
    'unreadable': 'That theme cannot be made readable.',
};

/** One colour pick the guard changed. */
export interface ReadabilityAdjustment {
    knob: CustomThemeKnob;
    from: string;
    to: string;
    /** The contrast the adjusted colour reaches against the backgrounds it was checked on. */
    ratio: number;
    /** What it was measured against, for the editor ("on panels"). */
    against: string;
}

export type NormalizeResult =
    | { ok: true; def: CustomThemeDef; adjustments: ReadabilityAdjustment[] }
    | { ok: false; error: CustomThemeError; detail?: string };

/** One user-supplied colour -> opaque '#rrggbb', or null for anything that is not a literal colour. */
export function parseThemeColor(input: unknown): string | null {
    const c = parseCardColor(input);
    if (!c) return null;
    const rgba = cardColorRgba(c); // null for theme(...) tokens: only literal colours
    if (!rgba) return null;
    return hexOf([rgba[0], rgba[1], rgba[2]]);
}

// Control characters, bidi overrides / isolates and zero-width marks.
// eslint-disable-next-line no-control-regex -- stripping them IS the point
const NAME_STRIP = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

/** A display name: cleaned, single-spaced, capped. Empty -> null. */
export function cleanThemeName(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const s = input.normalize('NFC').replace(NAME_STRIP, '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    // Cap by code points, never splitting a surrogate pair.
    return Array.from(s).slice(0, CUSTOM_THEME_NAME_MAX).join('').trim();
}

/**
 * Parse an untrusted theme object (an import, a share code, a synced item, a
 * backup restore, a stored record): validate, fill missing knobs from the
 * base, then run the readability guard. Never throws.
 */
export function normalizeCustomTheme(input: unknown): NormalizeResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'not-an-object' };
    let size = 0;
    try { size = JSON.stringify(input).length; } catch { return { ok: false, error: 'not-an-object' }; }
    if (size > CUSTOM_THEME_JSON_MAX) return { ok: false, error: 'too-large' };
    const o = input as { v?: unknown; kind?: unknown; name?: unknown; base?: unknown; colors?: unknown; glow?: unknown };
    if (o.kind !== undefined && o.kind !== CUSTOM_THEME_FILE_KIND) return { ok: false, error: 'not-an-object' };
    if (o.v !== CUSTOM_THEME_VERSION) return { ok: false, error: 'bad-version' };
    if (o.base !== 'dark' && o.base !== 'light') return { ok: false, error: 'bad-base' };
    const base = o.base;
    let name = DEFAULT_CUSTOM_THEME_NAME;
    if (o.name !== undefined) {
        const n = cleanThemeName(o.name);
        if (n === null && typeof o.name !== 'string') return { ok: false, error: 'bad-name' };
        name = n ?? DEFAULT_CUSTOM_THEME_NAME;
    }
    if (o.colors !== undefined && (!o.colors || typeof o.colors !== 'object' || Array.isArray(o.colors))) {
        return { ok: false, error: 'bad-colour' };
    }
    const given = (o.colors ?? {}) as Record<string, unknown>;
    const colors = knobsFromTheme(baseTheme(base));
    for (const k of CUSTOM_THEME_KNOBS) {
        if (!Object.prototype.hasOwnProperty.call(given, k)) continue;
        const c = parseThemeColor(given[k]);
        if (!c) return { ok: false, error: 'bad-colour', detail: k };
        colors[k] = c;
    }
    const glow = typeof o.glow === 'boolean' ? o.glow : base === 'dark';
    const { colors: readable, adjustments } = makeReadable(base, colors);
    const def: CustomThemeDef = { v: CUSTOM_THEME_VERSION, name, base, colors: readable, glow };
    if (auditTheme(deriveCustomTheme(def)).length > 0) return { ok: false, error: 'unreadable' };
    return { ok: true, def, adjustments };
}

/** The hover fill: the inset colour lifted a step toward the text. */
export function raiseOf(surface: string, text: string, base: CustomThemeBase): string {
    return mixHex(surface, text, base === 'dark' ? 0.09 : 0.07);
}

/**
 * The readability guard over the knobs. Returns the colours to USE (and
 * store) plus what it changed. Idempotent: running it on its own output
 * changes nothing.
 */
export function makeReadable(base: CustomThemeBase, input: CustomThemeColors): { colors: CustomThemeColors; adjustments: ReadabilityAdjustment[] } {
    const c: CustomThemeColors = { ...input };
    const adjustments: ReadabilityAdjustment[] = [];
    const note = (knob: CustomThemeKnob, from: string, against: string, bgs: readonly string[]) => {
        if (c[knob] !== from) adjustments.push({ knob, from, to: c[knob], ratio: minContrast(c[knob], bgs), against });
    };
    // 1. Grounds into the base's band (so step 2 can always succeed).
    for (const k of ['bg', 'panel', 'surface'] as const) {
        const from = c[k];
        c[k] = clampGround(from, base);
        if (c[k] !== from) {
            const y = relativeLuminance(c[k]);
            adjustments.push({ knob: k, from, to: c[k], ratio: y, against: base === 'dark' ? 'kept dark for a dark theme' : 'kept light for a light theme' });
        }
    }
    const grounds = [c.bg, c.panel, c.surface];
    // 2. Text on every ground and on the hover fill (which moves toward the text: iterate).
    {
        const from = c.text;
        for (let i = 0; i < 6; i++) {
            const next = nudgeToContrast(c.text, [...grounds, raiseOf(c.surface, c.text, base)], AA_TEXT);
            if (next === c.text) break;
            c.text = next;
        }
        note('text', from, 'on every background', [...grounds, raiseOf(c.surface, c.text, base)]);
    }
    // 3. Secondary text on the page, the panels and the insets.
    { const from = c.muted; c.muted = nudgeToContrast(c.muted, grounds, AA_TEXT); note('muted', from, 'on panels', grounds); }
    // 4. Labels on the accent.
    { const from = c.onAccent; c.onAccent = nudgeToContrast(c.onAccent, [c.accent], AA_TEXT); note('onAccent', from, 'on the accent', [c.accent]); }
    return { colors: c, adjustments };
}

// ── Derivation ──────────────────────────────────────────────────────────────

/** OKLCH lightness step of a colour (positive = lighter), hue and chroma kept. */
function stepL(hex: string, dL: number): string {
    const { L, C, h } = hexToOklch(hex);
    return oklchToHex(Math.min(1, Math.max(0, L + dL)), C, h);
}

/** Replace every `rgba(r,g,b,` in `s` whose channels are `from` with `to`'s channels. */
function recolor(s: string, from: string, to: string): string {
    return s.split(`rgba(${channelsOf(from)},`).join(`rgba(${channelsOf(to)},`);
}

/** Variables the light-only stylesheet (styles/theme-light.css) reads, derived for a light custom theme. */
export const CUSTOM_LIGHT_EXTRA_VARS = ['--lt-line', '--lt-line-soft', '--lt-step', '--lt-mint', '--lt-mint-edge', '--lt-mint-ink'] as const;

/**
 * A (normalised) def -> a complete Theme. `id` is the BASE id and `scheme`
 * the base's (so the engine's `data-scheme` puts every light-kind
 * `:root[data-scheme="light"]` rule on a light custom theme, and no
 * `contrast`: High contrast styling never applies to a custom theme);
 * `customId` marks it as custom (the engine adds `data-custom-theme` and a
 * more specific rule). Pure and deterministic.
 */
export function deriveCustomTheme(def: CustomThemeDef, customId = 'preview'): Theme {
    const base = baseTheme(def.base);
    const dark = def.base === 'dark';
    const k = def.colors;
    const p: Record<PaletteToken, string> = { ...base.palette };
    const grounds = [k.bg, k.panel, k.surface];

    p.abyss = k.bg;
    p.deep = k.panel;
    p.surface = k.surface;
    p.raise = raiseOf(k.surface, k.text, def.base);
    p.border = k.border;
    p.sink = dark ? mixHex(k.bg, BLACK, 0.12) : mixHex(k.bg, k.text, 0.025);
    p.text = k.text;
    p.muted = k.muted;
    // The faintest text (timestamps, hints, code comments, "(you)") also sits on
    // inset cards and code wells: readable on every ground and the sink, not
    // just the page and panels (theme coverage audit, 2026-11-20).
    p.faint = nudgeToContrast(mixHex(k.muted, k.panel, 0.22), [...grounds, p.sink], AA_TEXT);
    p.bright = k.text;
    p.shade = dark ? base.palette.shade : (() => { const { C, h } = hexToOklch(k.bg); return oklchToHex(0.28, Math.min(0.06, C * 2 + 0.02), h); })();
    p['dot-hole'] = dark ? base.palette['dot-hole'] : k.panel;
    p['border-strong'] = nudgeToContrast(k.border, grounds, AA_UI);

    // Accent family.
    p.lume = k.accent;
    p['lume-hi'] = stepL(k.accent, 0.06);
    p['lume-press'] = stepL(k.accent, -0.08);
    p['on-lume'] = k.onAccent;
    // Accent text also sits on accent-TINTED fills (the active settings item,
    // "In call" pills, selected rows: up to ~20% accent over a ground), so it
    // must clear 4.5:1 there too (theme coverage audit, 2026-11-20).
    const tinted = grounds.map((g) => mixHex(g, k.accent, 0.2));
    p['lume-text'] = nudgeToContrast(k.accent, [...grounds, ...tinted], AA_TEXT);
    p['lume-deep'] = dark ? stepL(k.accent, -0.25) : p['lume-text'];
    p['lume-ui'] = nudgeToContrast(k.accent, [k.panel, k.surface], AA_UI);
    p['keys-alert'] = dark ? base.palette['keys-alert'] : k.accent;

    // Danger (destructive actions) — a knob; trust colours below are NOT.
    p.danger = k.danger;
    p['danger-text'] = nudgeToContrast(k.danger, grounds, AA_TEXT);

    // Security / status colours: base hue, lightness nudged for the custom grounds.
    for (const t of ['flash-text', 'glow-text', 'ok-text', 'info-text'] as const) p[t] = nudgeToContrast(base.palette[t], grounds, AA_TEXT);
    for (const t of ['ok-dot', 'idle-dot', 'dnd-dot', 'offline-dot'] as const) p[t] = nudgeToContrast(base.palette[t], [k.bg, k.panel], AA_UI);

    // Code: the well is the page colour (styles/formatting.css .cl-fmt-pre).
    p['code-text'] = k.text;
    for (const t of ['code-kw', 'code-str', 'code-num', 'code-lit', 'code-type', 'code-add', 'code-del'] as const) {
        p[t] = nudgeToContrast(base.palette[t], [k.bg, p.sink, k.panel], AA_TEXT);
    }

    const alpha = { ...base.alpha };
    alpha['lume-tint'] = rgbaOf(k.accent, dark ? 0.12 : 0.18);
    alpha['flash-tint'] = rgbaOf(p.flash, 0.12);
    alpha['overlay-hover'] = rgbaOf(k.text, dark ? 0.06 : 0.05);
    alpha['overlay-press'] = rgbaOf(k.text, dark ? 0.1 : 0.09);
    alpha.scrim = dark ? rgbaOf(mixHex(k.bg, BLACK, 0.55), 0.72) : rgbaOf(k.text, 0.34);

    const effects = { ...base.effects };
    if (!dark) {
        // Light's warm-brown shadows, re-tinted from the custom ground.
        // Light's two shadow browns: its `shade` (60,44,20) and the card's warmer 92,64,24.
        const shadeA = LIGHT_THEME.palette.shade;
        const shadeB = hexOf([92, 64, 24]);
        const shadeB2 = mixHex(p.shade, WHITE, 0.15);
        for (const key of Object.keys(effects) as (keyof typeof effects)[]) {
            effects[key] = recolor(recolor(effects[key], shadeA, p.shade), shadeB, shadeB2);
        }
    }
    if (def.glow) {
        effects['glow-lume'] = `0 0 14px ${rgbaOf(k.accent, dark ? 0.22 : 0.3)}`;
        effects['glow-lume-hot'] = `0 0 14px ${rgbaOf(k.accent, dark ? 0.6 : 0.55)}`;
    } else if (dark) {
        effects['glow-lume'] = `0 6px 18px -8px ${rgbaOf(BLACK, 0.55)}`;
        effects['glow-lume-hot'] = `0 8px 22px -8px ${rgbaOf(BLACK, 0.7)}`;
    } else {
        effects['glow-lume'] = `0 10px 30px -8px ${rgbaOf(p['lume-deep'], 0.25)}`;
        effects['glow-lume-hot'] = `0 10px 26px -6px ${rgbaOf(p['lume-deep'], 0.45)}`;
    }

    const extra: Record<string, string> = {};
    if (!dark) {
        extra['--lt-line'] = mixHex(k.border, k.panel, 0.35);
        extra['--lt-line-soft'] = mixHex(k.border, k.panel, 0.6);
        extra['--lt-step'] = mixHex(k.border, k.text, 0.12);
        extra['--lt-mint'] = mixHex(k.accent, k.panel, 0.88);
        extra['--lt-mint-edge'] = mixHex(k.accent, k.panel, 0.65);
        extra['--lt-mint-ink'] = nudgeToContrast(k.accent, [extra['--lt-mint']], AA_TEXT);
    }

    return {
        v: THEME_SCHEMA_VERSION,
        id: base.id,
        customId,
        name: def.name,
        scheme: base.scheme,
        palette: p,
        alpha,
        effects,
        extra,
        semantic: base.semantic,
        kit: base.kit,
        boot: {
            gradient: dark
                ? [k.panel, mixHex(k.panel, k.bg, 0.5), k.bg]
                : [mixHex(k.bg, k.panel, 0.7), k.bg, p.sink],
            titleBar: base.boot.titleBar,
            windowBackground: base.boot.windowBackground,
            card: base.boot.card,
        },
        nameMinContrast: dark ? 3 : AA_TEXT,
    };
}

// ── Audit (the "never save an unreadable theme" check) ──────────────────────

export interface AuditFailure { fg: PaletteToken; bg: PaletteToken; ratio: number; min: number }

/** Every text / control pair a theme must pass. */
export const AUDIT_PAIRS: ReadonlyArray<{ fg: PaletteToken; bgs: readonly PaletteToken[]; min: number }> = [
    { fg: 'text', bgs: ['abyss', 'deep', 'surface', 'raise'], min: AA_TEXT },
    { fg: 'muted', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'faint', bgs: ['abyss', 'deep'], min: AA_TEXT },
    { fg: 'lume-text', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'on-lume', bgs: ['lume'], min: AA_TEXT },
    { fg: 'danger-text', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'flash-text', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'glow-text', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'ok-text', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'info-text', bgs: ['abyss', 'deep', 'surface'], min: AA_TEXT },
    { fg: 'code-kw', bgs: ['abyss', 'deep'], min: AA_TEXT },
    { fg: 'code-str', bgs: ['abyss', 'deep'], min: AA_TEXT },
    { fg: 'border-strong', bgs: ['abyss', 'deep', 'surface'], min: AA_UI },
    { fg: 'lume-ui', bgs: ['deep', 'surface'], min: AA_UI },
    { fg: 'ok-dot', bgs: ['abyss', 'deep'], min: AA_UI },
    { fg: 'idle-dot', bgs: ['abyss', 'deep'], min: AA_UI },
    { fg: 'dnd-dot', bgs: ['abyss', 'deep'], min: AA_UI },
];

/** Every failing pair (empty = readable). */
export function auditTheme(t: Theme): AuditFailure[] {
    const out: AuditFailure[] = [];
    for (const pair of AUDIT_PAIRS) {
        for (const bg of pair.bgs) {
            const ratio = contrastRatio(t.palette[pair.fg], t.palette[bg]);
            if (ratio < pair.min) out.push({ fg: pair.fg, bg, ratio, min: pair.min });
        }
    }
    return out;
}

// ── Sharing: codes and files ────────────────────────────────────────────────

/** The portable form (no id: an import always gets a fresh one). */
export function portableTheme(def: CustomThemeDef): CustomThemeDef {
    return { v: def.v, name: def.name, base: def.base, colors: { ...def.colors }, glow: def.glow };
}

function b64urlEncode(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string | null {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
        const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { return null; }
}

/** A share code: `clth1.` + base64url(JSON of the normalised theme). */
export function encodeShareCode(def: CustomThemeDef): string {
    return CUSTOM_THEME_SHARE_PREFIX + b64urlEncode(JSON.stringify(portableTheme(def)));
}

/** A share code -> a normalised theme (validated + readability-guarded). */
export function decodeShareCode(code: unknown): NormalizeResult {
    if (typeof code !== 'string') return { ok: false, error: 'bad-code' };
    const s = code.trim();
    if (s.length > CUSTOM_THEME_SHARE_MAX) return { ok: false, error: 'too-large' };
    if (!s.startsWith(CUSTOM_THEME_SHARE_PREFIX)) return { ok: false, error: 'bad-code' };
    const json = b64urlDecode(s.slice(CUSTOM_THEME_SHARE_PREFIX.length));
    if (json === null) return { ok: false, error: 'bad-code' };
    let o: unknown;
    try { o = JSON.parse(json); } catch { return { ok: false, error: 'bad-code' }; }
    return normalizeCustomTheme(o);
}

/** The `.json` file contents. */
export function themeFileJson(def: CustomThemeDef): string {
    return JSON.stringify({ kind: CUSTOM_THEME_FILE_KIND, ...portableTheme(def) }, null, 2) + '\n';
}

/** Pasted text or a file's contents: a share code or the JSON. */
export function parseThemeImport(text: unknown): NormalizeResult {
    if (typeof text !== 'string') return { ok: false, error: 'not-an-object' };
    const s = text.trim();
    if (s.startsWith(CUSTOM_THEME_SHARE_PREFIX)) return decodeShareCode(s);
    if (s.length > CUSTOM_THEME_JSON_MAX * 2) return { ok: false, error: 'too-large' };
    if (!s.startsWith('{')) return { ok: false, error: 'bad-code' };
    let o: unknown;
    try { o = JSON.parse(s); } catch { return { ok: false, error: 'not-an-object' }; }
    return normalizeCustomTheme(o);
}

// ── Device boot copy (electron/theme-custom-boot.ts validates it in main) ──

/** What main stores device-level for the ACTIVE custom theme: no name (never needed to paint). */
export interface CustomThemeBootPayload {
    id: string;
    theme: { v: 1; base: CustomThemeBase; colors: CustomThemeColors; glow: boolean };
    boot: {
        abyss: string; deep: string; surface: string; border: string; sink: string;
        lume: string; lumeHi: string; lumeDeep: string; glow: string; ok: string;
        text: string; muted: string; faint: string;
        windowBackground: string; titleBar: { color: string; symbolColor: string }; card: string;
        gradient: [string, string, string];
    };
}

export function customBootPayload(id: string, def: CustomThemeDef): CustomThemeBootPayload {
    const t = deriveCustomTheme(def, id);
    const p = t.palette;
    const u = (h: string) => h.toUpperCase();
    return {
        id,
        theme: { v: CUSTOM_THEME_VERSION, base: def.base, colors: { ...def.colors }, glow: def.glow },
        boot: {
            abyss: u(p.abyss), deep: u(p.deep), surface: u(p.surface), border: u(p.border), sink: u(p.sink),
            lume: u(p.lume), lumeHi: u(p['lume-hi']), lumeDeep: u(p['lume-deep']), glow: u(p.glow), ok: u(p.ok),
            text: u(p.text), muted: u(p.muted), faint: u(p.faint),
            windowBackground: u(p[t.boot.windowBackground]),
            titleBar: { color: u(p[t.boot.titleBar.color]), symbolColor: u(p[t.boot.titleBar.symbolColor]) },
            card: u(p[t.boot.card]),
            gradient: [u(t.boot.gradient[0]), u(t.boot.gradient[1]), u(t.boot.gradient[2])],
        },
    };
}

/** The stored device copy -> a def (re-validated; the name is not stored). */
export function defFromBootPayload(raw: unknown): { id: string; def: CustomThemeDef } | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as { id?: unknown; theme?: unknown };
    if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return null;
    const r = normalizeCustomTheme(o.theme);
    return r.ok ? { id: o.id, def: r.def } : null;
}

export const isHex6 = (s: unknown): s is string => typeof s === 'string' && HEX6.test(s.toLowerCase());
