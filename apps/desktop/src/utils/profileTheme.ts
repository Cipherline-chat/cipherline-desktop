/**
 * Profile theme: two colours (primary + accent) painted as a gradient behind
 * the profile card. The server only stores/validates the pair (lowercase
 * `#rrggbb`, apps/api/src/auth/profile-cosmetics.ts); everything about how it
 * LOOKS is decided here, on the viewer's device.
 *
 * Readability rule: the card keeps its light text (`cl-text` #F4F7FF,
 * `cl-muted` #A7B3D4 - Tailwind colours, not variables), so the tint is
 * mixed into the card's dark navy only as far as the muted text keeps a
 * WCAG contrast of at least 4.5:1 against the result, per gradient stop. A
 * near-white or neon theme therefore reads as a dimmer wash instead of
 * washing the text out; the pair's true colours are still shown undimmed on
 * the card's gradient frame and in the picker. The check is computed, not
 * assumed (profileTheme.test.ts pins it for every preset and for the
 * worst-case colours).
 */

export const THEME_HEX = /^#[0-9a-f]{6}$/;
export interface ProfileTheme { primary: string; accent: string }

export const isThemeHex = (v: unknown): v is string => typeof v === 'string' && THEME_HEX.test(v);

/** A server value -> a usable theme, or null (garbage renders the default card). */
export function readTheme(v: unknown): ProfileTheme | null {
    if (!v || typeof v !== 'object') return null;
    const t = v as Record<string, unknown>;
    return isThemeHex(t.primary) && isThemeHex(t.accent) ? { primary: t.primary, accent: t.accent } : null;
}

/** Normalise a colour-picker / typed value to the server's format, or null. */
export function normalizeHex(v: string): string | null {
    const s = v.trim().toLowerCase();
    const m = /^#?([0-9a-f]{6})$/.exec(s);
    return m ? `#${m[1]}` : null;
}

export const themeEquals = (a: ProfileTheme | null, b: ProfileTheme | null) =>
    (a === null && b === null) || (!!a && !!b && a.primary === b.primary && a.accent === b.accent);

// ── presets: the "glow in the deep" tokens (tailwind.config cl-*) ────────────

export const THEME_PRESETS: ReadonlyArray<{ id: string; label: string; theme: ProfileTheme }> = [
    { id: 'lume', label: 'Lume', theme: { primary: '#25e0c8', accent: '#0e8f7c' } },
    { id: 'glow', label: 'Glow', theme: { primary: '#ffc94d', accent: '#ff6b5e' } },
    { id: 'flash', label: 'Flash', theme: { primary: '#ff6b5e', accent: '#b23a30' } },
    { id: 'deep-sea', label: 'Deep sea', theme: { primary: '#5e8ee0', accent: '#25e0c8' } },
    { id: 'tide', label: 'Tide', theme: { primary: '#4ade80', accent: '#25e0c8' } },
    { id: 'abyss', label: 'Abyss', theme: { primary: '#243056', accent: '#0b0f1e' } },
    { id: 'coral', label: 'Coral', theme: { primary: '#ff8fb1', accent: '#ff6b5e' } },
    { id: 'sunken', label: 'Sunken', theme: { primary: '#ffc94d', accent: '#0e8f7c' } },
];

// ── contrast maths (WCAG 2.x relative luminance) ─────────────────────────────

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

export function luminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `t` of the way from `base` to `color` (0 = base). */
export function mix(base: string, color: string, t: number): string {
    const a = hexToRgb(base), b = hexToRgb(color), k = clamp01(t);
    return toHex(a.map((v, i) => v + (b[i] - v) * k));
}

/** The card's own navy (`bg-cl-deep`) and its text colours. */
export const CARD_BASE = '#131a30';
export const CARD_TEXT = '#f4f7ff';
export const CARD_TEXT_MUTED = '#a7b3d4';
export const MIN_TEXT_CONTRAST = 4.5;
/**
 * How far a theme colour may be mixed in at most (before the contrast cap).
 * Kept moderate on purpose: a strong wash fights a busy banner, the decoration
 * and the effect for attention. The true colours stay on the frame.
 */
export const MAX_TINT = 0.42;

/** The strongest tint (0..MAX_TINT) of `color` over the card base that keeps muted text >= 4.5:1. */
export function safeTint(color: string): number {
    if (contrast(CARD_TEXT_MUTED, mix(CARD_BASE, color, MAX_TINT)) >= MIN_TEXT_CONTRAST) return MAX_TINT;
    let lo = 0, hi = MAX_TINT;
    for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (contrast(CARD_TEXT_MUTED, mix(CARD_BASE, color, mid)) >= MIN_TEXT_CONTRAST) lo = mid; else hi = mid;
    }
    return lo;
}

export interface ThemeSurface {
    /** The two tinted gradient stops (top, bottom) behind the text. */
    from: string;
    to: string;
    /** The pair's own colours, for the gradient frame / swatches. */
    primary: string;
    accent: string;
    /** Background colour near the avatar, for the avatar / status-dot rings. */
    ring: string;
    /** Worst muted-text contrast across the two stops (always >= 4.5). */
    minContrast: number;
}

export function themeSurface(theme: ProfileTheme): ThemeSurface {
    const from = mix(CARD_BASE, theme.primary, safeTint(theme.primary));
    const to = mix(CARD_BASE, theme.accent, safeTint(theme.accent));
    return {
        from, to, primary: theme.primary, accent: theme.accent,
        ring: mix(from, to, 0.3),
        minContrast: Math.min(contrast(CARD_TEXT_MUTED, from), contrast(CARD_TEXT_MUTED, to)),
    };
}

/** Inline style for the card root: tinted gradient fill + the true-colour gradient frame. */
export function themeCardStyle(theme: ProfileTheme | null): Record<string, string> | undefined {
    if (!theme) return undefined;
    const s = themeSurface(theme);
    return {
        '--pc-ring': s.ring,
        border: '2px solid transparent',
        background: `linear-gradient(165deg, ${s.from} 0%, ${s.to} 100%) padding-box, linear-gradient(165deg, ${s.primary}, ${s.accent}) border-box`,
    };
}

/** A swatch background in the pair's true colours. */
export const themeSwatch = (t: ProfileTheme) => `linear-gradient(135deg, ${t.primary}, ${t.accent})`;

/**
 * The colour decorations and effects take by default ("Match theme"): the
 * lighter of the pair, lifted until it reads on the dark card (relative
 * luminance >= 0.2). null = no theme, so the art keeps its stock lume teal.
 */
export function matchTint(theme: ProfileTheme | null | undefined): string | null {
    if (!theme) return null;
    let c = luminance(theme.accent) >= luminance(theme.primary) ? theme.accent : theme.primary;
    for (let t = 0.1; luminance(c) < 0.2 && t <= 1; t += 0.1) c = mix(c, '#ffffff', t);
    return c;
}
