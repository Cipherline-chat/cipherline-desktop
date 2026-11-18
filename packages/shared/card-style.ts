/**
 * Message card style — "Style your own message card" (2026-11-17).
 *
 * A small, typed, versioned description of how ONE message's card looks:
 * background (solid, gradient or a simple repeating pattern, with an overall
 * opacity), border (uniform, per side, or a gradient), corner radius, padding
 * preset, up to two outer shadows, text colour / alignment / letter-spacing /
 * glow, an accent stripe and one app-defined animation. The full contract
 * (every field, bound, default, the byte cap, versioning, the readability
 * rule, the reserved looks and where it renders) is
 * docs/message-card-style.md.
 *
 * THE OBJECT IS THE CONTRACT. It travels as `card_style` inside the encrypted
 * message content (packages/shared/content.ts), never as CSS. CSS text is only
 * one way to PRODUCE it: `parseCardStyleCss` is a strict allowlist parser that
 * turns a few declarations into this object and says, per declaration, what it
 * accepted, adjusted or ignored and why. A bot, the mobile app or the desktop
 * editor can equally build the JSON by hand.
 *
 * Every reader re-validates with `normalizeCardStyle`, because the sender is
 * untrusted: unknown versions and oversize payloads are dropped whole, unknown
 * fields are dropped, out-of-range numbers are clamped, anything malformed is
 * dropped, reserved looks are neutralised, and nothing is ever guessed. A
 * renderer only ever consumes `resolveCardStyle`'s output — concrete colours
 * and numbers — never raw CSS, never a class name, never a URL, never var().
 *
 * Pure: no DOM, no React, no Node APIs, no globals beyond the language. A
 * test asserts it (cardStyle.purity.test.ts in apps/desktop).
 */

// ── Bounds ──────────────────────────────────────────────────────────────────

export const CARD_STYLE_VERSION = 1 as const;

/**
 * Hard cap on the UTF-8 byte length of `JSON.stringify(card_style)` as
 * received or sent. 2048: the largest legal style (two 6-stop gradients, two
 * shadows, every other field) normalises to well under 1.5 KB.
 */
export const CARD_STYLE_MAX_BYTES = 2048;

/** Hard cap on the CSS text the editor's "Edit as CSS" box will parse at all. */
export const CARD_STYLE_CSS_MAX_CHARS = 3000;

/** At most this many declarations are read from CSS text; the rest are ignored. */
export const CARD_STYLE_CSS_MAX_DECLARATIONS = 32;

export const CARD_BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const;
export type CardBorderStyle = typeof CARD_BORDER_STYLES[number];

export const CARD_PADDINGS = ['tight', 'cozy', 'roomy'] as const;
export type CardPadding = typeof CARD_PADDINGS[number];

/** Padding presets as [vertical, horizontal] px. */
export const CARD_PADDING_PX: Readonly<Record<CardPadding, readonly [number, number]>> = {
    tight: [4, 8],
    cozy: [8, 12],
    roomy: [12, 16],
};

export const CARD_ALIGNS = ['left', 'center', 'right'] as const;
export type CardAlign = typeof CARD_ALIGNS[number];

/**
 * App-defined animations. The sender only picks a name and a speed; the
 * keyframes (and so the intensity) belong to the app.
 *  - drift:   the gradient slowly shifts across the card (needs a gradient background)
 *  - pulse:   the shadows breathe between full and dimmer (needs a shadow)
 *  - shimmer: a faint light sweeps across the card (works on any card)
 */
export const CARD_ANIMATIONS = ['drift', 'pulse', 'shimmer'] as const;
export type CardAnimationName = typeof CARD_ANIMATIONS[number];

export const CARD_LIMITS = {
    borderWidth: { min: 0, max: 4 },
    radius: { min: 0, max: 24 },
    shadowOffset: { min: -8, max: 8 },
    shadowBlur: { min: 0, max: 16 },
    shadowSpread: { min: 0, max: 4 },
    shadows: { max: 2 },
    stops: { min: 2, max: 6 },
    stopAt: { min: 0, max: 100 },
    /** A repeating gradient's period (its last stop) can't be finer than this, in %. */
    repeatPeriodMin: 4,
    backgroundOpacity: { min: 0, max: 100 },
    textGlowBlur: { min: 1, max: 8 },
    letterSpacing: { min: -0.5, max: 2 },
    animationSeconds: { min: 4, max: 20 },
} as const;

export const CARD_DEFAULTS = {
    /** Linear gradient direction when none is given (CSS's own default: to bottom). */
    angle: 180,
    radialShape: 'ellipse' as const,
    borderWidth: 1,
    borderStyle: 'solid' as CardBorderStyle,
    shadowBlur: 8,
    textGlowBlur: 4,
    animationSeconds: 8,
    /** Rendering defaults when the field is absent. */
    radius: 10,
    padding: 'cozy' as CardPadding,
};

/** WCAG 2.x AA for normal text: the app's own default text must reach it. */
export const CARD_MIN_CONTRAST = 4.5;

/**
 * The readability FLOOR for a sender's own text colour. At or above it the
 * colour is used as chosen; below it the app nudges it toward legibility
 * (lighter on dark cards, darker on light ones) until it clears the floor,
 * and the editor says "adjusted for readability".
 */
export const CARD_TEXT_FLOOR = 3;

/**
 * Theme colours: anywhere a colour is accepted, a style may name one of these
 * instead of a literal colour. The VIEWER's app resolves it from its own
 * design tokens for its current theme, so a sender that cannot know the
 * viewer's theme (a bot) still gets readable, on-brand cards. Spelled
 * `theme(success)` or `theme(success / 20%)` (CSS and JSON alike; JSON may
 * also use the bare name `"success"`). Never reaches the DOM as `var()`: the
 * renderer only ever receives the resolved concrete colour.
 */
export const CARD_THEME_TOKENS = ['accent', 'success', 'warning', 'danger', 'info', 'muted'] as const;
export type CardThemeToken = typeof CARD_THEME_TOKENS[number];

/** Accent stripe (the coloured bar down the card's left edge) bounds. */
export const CARD_STRIPE_LIMITS = { min: 2, max: 6, default: 3 } as const;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A normalised colour: lower-case `#rrggbb`, `#rrggbbaa` when not fully
 * opaque, or a theme colour `theme(<token>)` / `theme(<token> / <n>%)`.
 */
export type CardColor = string;

export interface CardGradientStop {
    color: CardColor;
    /** Position along the gradient, integer percent 0..100, non-decreasing. */
    at: number;
}

export type CardLinearType = 'linear' | 'repeating-linear';
export type CardRadialType = 'radial' | 'repeating-radial';

export type CardBackground =
    | { type: 'solid'; color: CardColor }
    | { type: CardLinearType; angle: number; stops: CardGradientStop[] }
    | { type: CardRadialType; shape: 'circle' | 'ellipse'; stops: CardGradientStop[] };

/** Four values in CSS order: top, right, bottom, left. */
export type CardSides<T> = [T, T, T, T];

export type CardBorder =
    /** A coloured border: one width / colour, or one per side. */
    | { width: number | CardSides<number>; style: CardBorderStyle; color: CardColor | CardSides<CardColor> }
    /** A gradient border: uniform width, always solid. */
    | { width: number; style: 'solid'; gradient: { angle: number; stops: CardGradientStop[] } };

/** One radius for every corner, or [top-left, top-right, bottom-right, bottom-left]. */
export type CardRadius = number | [number, number, number, number];

/** An OUTER shadow (never inset). */
export interface CardShadow {
    x: number;
    y: number;
    blur: number;
    spread: number;
    color: CardColor;
}

export interface CardTextGlow {
    color: CardColor;
    blur: number;
}

export interface CardAnimation {
    name: CardAnimationName;
    seconds: number;
}

/** A coloured bar down the left edge, inside the card (like an embed's colour bar). */
export interface CardStripe {
    color: CardColor;
    /** px, CARD_STRIPE_LIMITS.min..max. */
    width: number;
}

export interface CardStyleV1 {
    v: 1;
    background?: CardBackground;
    /** Opacity of the whole background, integer percent (absent = 100). */
    backgroundOpacity?: number;
    border?: CardBorder;
    radius?: CardRadius;
    padding?: CardPadding;
    /** One or two outer shadows. */
    shadows?: CardShadow[];
    /** Text colour (kept above CARD_TEXT_FLOOR by the renderer). */
    text?: CardColor;
    /** A soft glow around the text (one centred text-shadow). */
    textGlow?: CardTextGlow;
    align?: CardAlign;
    /** Alignment of the message's HEADINGS only (a centred title over a left-aligned list). */
    headingAlign?: CardAlign;
    /** px, one decimal. */
    letterSpacing?: number;
    stripe?: CardStripe;
    animation?: CardAnimation;
}

/** The current card style version. A union once there is a v2. */
export type CardStyle = CardStyleV1;

// ── Small pure helpers ──────────────────────────────────────────────────────

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v: unknown): v is Record<string, unknown> {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    // A plain object from any realm (JSON.parse, structured clone, another
    // context): its prototype is null or a prototype whose own prototype is
    // null. A class instance has one more link and is refused.
    const proto = Object.getPrototypeOf(v);
    return proto === null || (Object.getPrototypeOf(proto) === null && Object.prototype.toString.call(v) === '[object Object]');
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A finite number, or null (NaN, ±Infinity, strings, everything else). */
function finite(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** UTF-8 byte length of a JS string, without TextEncoder (pure, every runtime). */
export function utf8ByteLength(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
        } else n += 3;
    }
    return n;
}

/** Byte size of a value as it travels (JSON), or Infinity when it can't be serialised. */
export function cardStyleByteSize(v: unknown): number {
    try {
        const s = JSON.stringify(v);
        return typeof s === 'string' ? utf8ByteLength(s) : Infinity;
    } catch {
        return Infinity;
    }
}

// ── Colour ──────────────────────────────────────────────────────────────────

/** Characters that may appear in a colour or a CSS value at all. Anything else: refused. */
const VALUE_CHARS = /^[a-z0-9#%().,+\-/ \t\r\n]*$/;
const NUM = /^\d{1,3}(?:\.\d{1,4})?$|^\.\d{1,4}$/;

function num(word: string): number | null {
    return NUM.test(word) ? Number(word) : null;
}

/** A 0..255 channel from `128` or `50%` (clamped like CSS). */
function channel(word: string): number | null {
    if (word.endsWith('%')) {
        const p = num(word.slice(0, -1));
        return p === null ? null : clamp(Math.round((p / 100) * 255), 0, 255);
    }
    const n = num(word);
    return n === null ? null : clamp(Math.round(n), 0, 255);
}

/** An alpha 0..1 from `0.5`, `.5`, `1` or `50%`. */
function alphaOf(word: string): number | null {
    if (word.endsWith('%')) {
        const p = num(word.slice(0, -1));
        return p === null ? null : clamp(p / 100, 0, 1);
    }
    const n = num(word);
    return n === null ? null : clamp(n, 0, 1);
}

function percentOf(word: string): number | null {
    if (!word.endsWith('%')) return null;
    const p = num(word.slice(0, -1));
    return p === null ? null : clamp(p, 0, 100);
}

const hex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

function toHex(r: number, g: number, b: number, a: number): CardColor {
    const aa = Math.round(clamp(a, 0, 1) * 255);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${aa === 255 ? '' : hex2(aa)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const hh = ((h % 360) + 360) % 360 / 360;
    const ss = clamp(s, 0, 100) / 100;
    const ll = clamp(l, 0, 100) / 100;
    if (ss === 0) return [ll * 255, ll * 255, ll * 255];
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    const f = (t: number): number => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/** The words of a colour function's arguments: comma syntax or space syntax with `/ alpha`. */
function colourArgs(args: Tok[][]): { parts: string[]; alpha: string | null } | null {
    const words = (seq: Tok[]): string[] | null => {
        const out: string[] = [];
        for (const t of seq) {
            if (t.kind !== 'word') return null;
            out.push(t.text);
        }
        return out;
    };
    if (args.length === 3 || args.length === 4) {
        const flat: string[] = [];
        for (const a of args) {
            const w = words(a);
            if (!w || w.length !== 1) return null;
            flat.push(w[0]);
        }
        return { parts: flat.slice(0, 3), alpha: flat[3] ?? null };
    }
    if (args.length !== 1) return null;
    const seq = args[0];
    const slash = seq.findIndex(t => t.kind === 'slash');
    const head = words(slash < 0 ? seq : seq.slice(0, slash));
    if (!head || head.length !== 3) return null;
    if (slash < 0) return { parts: head, alpha: null };
    const tail = words(seq.slice(slash + 1));
    if (!tail || tail.length !== 1) return null;
    return { parts: head, alpha: tail[0] };
}

/** A colour from one value token, with the reason when it isn't one. */
function colourFromTok(t: Tok): { color: CardColor } | { error: string } {
    if (t.kind === 'word') {
        const w = t.text;
        if (w.startsWith('#')) {
            const h = w.slice(1);
            if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return { error: `"${w}" is not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa)` };
            const full = h.length <= 4 ? h.split('').map(c => c + c).join('') : h;
            const r = parseInt(full.slice(0, 2), 16);
            const g = parseInt(full.slice(2, 4), 16);
            const b = parseInt(full.slice(4, 6), 16);
            const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
            return { color: toHex(r, g, b, a) };
        }
        if ((CARD_THEME_TOKENS as readonly string[]).includes(w)) return { color: `theme(${w})` };
        return { error: `"${w}" is not an allowed colour: use hex, rgb()/rgba(), hsl()/hsla() or theme(${CARD_THEME_TOKENS.join('|')}) (named colours are not supported)` };
    }
    if (t.kind !== 'fn') return { error: 'expected a colour' };
    if (t.name === 'theme') return themeColour(t.args);
    const args = colourArgs(t.args);
    if (t.name === 'rgb' || t.name === 'rgba') {
        if (!args) return { error: `${t.name}() needs three channels and an optional alpha` };
        const [r, g, b] = args.parts.map(channel);
        const a = args.alpha === null ? 1 : alphaOf(args.alpha);
        if (r === null || g === null || b === null || a === null) return { error: `${t.name}() has a value that is not a plain number or percentage` };
        return { color: toHex(r, g, b, a) };
    }
    if (t.name === 'hsl' || t.name === 'hsla') {
        if (!args) return { error: `${t.name}() needs hue, saturation, lightness and an optional alpha` };
        const hw = args.parts[0].endsWith('deg') ? args.parts[0].slice(0, -3) : args.parts[0];
        const h = num(hw);
        const s = percentOf(args.parts[1]);
        const l = percentOf(args.parts[2]);
        const a = args.alpha === null ? 1 : alphaOf(args.alpha);
        if (h === null || s === null || l === null || a === null) return { error: `${t.name}() has a value that is not a plain number or percentage` };
        const [r, g, b] = hslToRgb(h, s, l);
        return { color: toHex(r, g, b, a) };
    }
    return { error: `${t.name}() is not a colour function` };
}

/** `theme(token)` / `theme(token / alpha)` / `theme(token, alpha)` → canonical. */
function themeColour(args: Tok[][]): { color: CardColor } | { error: string } {
    const flat: Tok[] = args.length === 2 ? [...args[0], { kind: 'slash' }, ...args[1]] : args.length === 1 ? args[0] : [];
    const tokenTok = flat[0];
    const usage = `theme() takes one of ${CARD_THEME_TOKENS.join(', ')} and an optional alpha: theme(success) or theme(success / 20%)`;
    if (!tokenTok || tokenTok.kind !== 'word' || !(CARD_THEME_TOKENS as readonly string[]).includes(tokenTok.text)) return { error: usage };
    if (flat.length === 1) return { color: `theme(${tokenTok.text})` };
    if (flat.length !== 3 || flat[1].kind !== 'slash' || flat[2].kind !== 'word') return { error: usage };
    const a = alphaOf(flat[2].text);
    if (a === null) return { error: usage };
    const pct = Math.round(a * 100);
    return { color: pct >= 100 ? `theme(${tokenTok.text})` : `theme(${tokenTok.text} / ${pct}%)` };
}

/** The token and alpha (0..1) of a normalised theme colour, or null for a literal colour. */
export function cardThemeColorParts(c: CardColor): { token: CardThemeToken; alpha: number } | null {
    const m = /^theme\(([a-z]+)(?: \/ (\d{1,2})%)?\)$/.exec(c);
    if (!m || !(CARD_THEME_TOKENS as readonly string[]).includes(m[1])) return null;
    return { token: m[1] as CardThemeToken, alpha: m[2] === undefined ? 1 : Number(m[2]) / 100 };
}

/**
 * Parse ONE colour string (hex, rgb()/rgba(), hsl()/hsla()) into the
 * normalised form, or null. Used for the JSON fields and by the CSS parser,
 * so both paths accept exactly the same colours.
 */
export function parseCardColor(input: unknown): CardColor | null {
    if (typeof input !== 'string' || input.length === 0 || input.length > 64) return null;
    // ASCII check BEFORE lower-casing: some non-ASCII letters lower-case to
    // ASCII (the Kelvin sign K -> k), which would let a lookalike through.
    if (!/^[\x20-\x7e]*$/.test(input)) return null;
    const s = input.toLowerCase().trim();
    if (!VALUE_CHARS.test(s)) return null;
    const toks = tokenize(s);
    if ('error' in toks || toks.tokens.length !== 1) return null;
    const c = colourFromTok(toks.tokens[0]);
    return 'color' in c ? c.color : null;
}

/**
 * [r, g, b, a] for a NORMALISED colour in a theme (theme colours resolve
 * through `theme.tokens`), or null.
 */
export function resolveCardColor(c: CardColor, theme: Pick<CardTheme, 'tokens'>): [number, number, number, number] | null {
    const t = cardThemeColorParts(c);
    if (!t) return cardColorRgba(c);
    const base = cardColorRgba(parseCardColor(theme.tokens[t.token]) ?? '');
    return base ? [base[0], base[1], base[2], base[3] * t.alpha] : null;
}

/** [r, g, b, a] with r/g/b 0..255 and a 0..1, from a NORMALISED literal (hex) colour. */
export function cardColorRgba(c: CardColor): [number, number, number, number] | null {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
    if (!m) return null;
    const v = m[1];
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
}

// ── Value tokenizer (shared by colours and the CSS parser) ──────────────────

type Tok =
    | { kind: 'word'; text: string }
    | { kind: 'fn'; name: string; args: Tok[][] }
    | { kind: 'comma' }
    | { kind: 'slash' };

/** Functions the grammar knows. A colour function may sit inside a gradient; nothing else nests. */
const GRADIENT_FNS = new Set(['linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient']);
const COLOUR_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'theme']);

/**
 * Split a lower-cased, charset-checked value into tokens. Functions may nest
 * at most one level (a colour inside a gradient). Unknown function names are
 * refused here, with the reason.
 */
function tokenize(s: string, depth = 0): { tokens: Tok[] } | { error: string } {
    const tokens: Tok[] = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if (ch === ',') { tokens.push({ kind: 'comma' }); i++; continue; }
        if (ch === '/') { tokens.push({ kind: 'slash' }); i++; continue; }
        if (ch === ')') return { error: 'unbalanced ")"' };
        if (ch === '(') return { error: 'unexpected "("' };
        let j = i;
        while (j < s.length && /[a-z0-9#%.+\-]/.test(s[j])) j++;
        const word = s.slice(i, j);
        if (j < s.length && s[j] === '(') {
            const name = word;
            if (!GRADIENT_FNS.has(name) && !COLOUR_FNS.has(name)) {
                return { error: functionRefusal(name) };
            }
            if (depth >= 1 && !COLOUR_FNS.has(name)) return { error: 'nested functions are not allowed (only a colour inside a gradient)' };
            if (depth >= 2) return { error: 'nested functions are not allowed (only a colour inside a gradient)' };
            // Find the matching ")".
            let level = 0;
            let k = j;
            for (; k < s.length; k++) {
                if (s[k] === '(') level++;
                else if (s[k] === ')') { level--; if (level === 0) break; }
            }
            if (k >= s.length) return { error: 'unbalanced "("' };
            const inner = s.slice(j + 1, k);
            const innerToks = tokenize(inner, depth + 1);
            if ('error' in innerToks) return innerToks;
            if (COLOUR_FNS.has(name) && innerToks.tokens.some(t => t.kind === 'fn')) {
                return { error: 'nested functions are not allowed (only a colour inside a gradient)' };
            }
            const args: Tok[][] = [[]];
            for (const t of innerToks.tokens) {
                if (t.kind === 'comma') args.push([]);
                else args[args.length - 1].push(t);
            }
            tokens.push({ kind: 'fn', name, args });
            i = k + 1;
            continue;
        }
        if (word.length === 0) return { error: `unexpected "${ch}"` };
        tokens.push({ kind: 'word', text: word });
        i = j;
    }
    return { tokens };
}

function functionRefusal(name: string): string {
    if (name === 'url') return 'url() is never allowed: no remote fetches, images must be real attachments';
    if (name === 'var') return 'var() is not allowed: a card cannot read the app\'s own design tokens';
    if (name === 'expression') return 'expression() is not allowed';
    if (name === 'attr') return 'attr() is not allowed';
    if (name === 'image-set' || name === '-webkit-image-set') return 'image-set() is not allowed: no remote images';
    if (name === 'element' || name === '-moz-element') return 'element() is not allowed: a card cannot paint other parts of the app';
    if (name === 'conic-gradient') return 'conic-gradient() is not supported: use linear-gradient() or radial-gradient()';
    if (name === '') return 'unexpected "("';
    return `${name}() is not allowed: only rgb(), rgba(), hsl(), hsla(), theme() and the linear / radial (and repeating) gradients`;
}

// ── Normaliser (the receiver's validator) ───────────────────────────────────

function normStops(v: unknown, repeating = false): CardGradientStop[] | null {
    if (!Array.isArray(v)) return null;
    if (v.length < CARD_LIMITS.stops.min || v.length > CARD_LIMITS.stops.max) return null;
    const colours: CardColor[] = [];
    const ats: (number | null)[] = [];
    for (const s of v) {
        if (!isPlainObject(s)) return null;
        const c = parseCardColor(s.color);
        if (!c) return null;
        colours.push(c);
        if (own(s, 'at') && s.at !== undefined) {
            const a = finite(s.at);
            if (a === null) return null;
            ats.push(clamp(Math.round(a), 0, 100));
        } else ats.push(null);
    }
    // Missing positions: the first is 0, the last 100, the rest evenly
    // between their known neighbours (CSS's own rule).
    const n = ats.length;
    if (ats[0] === null) ats[0] = 0;
    if (ats[n - 1] === null) ats[n - 1] = 100;
    for (let i = 1; i < n; i++) {
        const a = ats[i];
        // Non-decreasing (a stop before an earlier one sits on it, as in CSS).
        if (a !== null && a < (ats[i - 1] as number)) ats[i] = ats[i - 1];
        if (ats[i] === null) {
            let j = i + 1;
            while (ats[j] === null) j++;
            const lo = ats[i - 1] as number;
            const hi = Math.max(lo, ats[j] as number);
            const steps = j - (i - 1);
            for (let k = i; k < j; k++) ats[k] = Math.round(lo + ((hi - lo) * (k - (i - 1))) / steps);
        }
    }
    // A repeating pattern finer than the floor is noise (and paint cost).
    if (repeating && (ats[n - 1] as number) < CARD_LIMITS.repeatPeriodMin) return null;
    return colours.map((color, i) => ({ color, at: ats[i] as number }));
}

function normAngle(v: unknown): number | null {
    const a = finite(v);
    return a === null ? null : ((Math.round(a) % 360) + 360) % 360;
}

function normBackground(v: unknown): CardBackground | undefined {
    if (!isPlainObject(v)) return undefined;
    if (v.type === 'solid') {
        const c = parseCardColor(v.color);
        return c ? { type: 'solid', color: c } : undefined;
    }
    if (v.type === 'linear' || v.type === 'repeating-linear') {
        const stops = normStops(v.stops, v.type === 'repeating-linear');
        if (!stops) return undefined;
        let angle: number = CARD_DEFAULTS.angle;
        if (own(v, 'angle') && v.angle !== undefined) {
            const a = normAngle(v.angle);
            if (a === null) return undefined;
            angle = a;
        }
        return { type: v.type, angle, stops };
    }
    if (v.type === 'radial' || v.type === 'repeating-radial') {
        const stops = normStops(v.stops, v.type === 'repeating-radial');
        if (!stops) return undefined;
        let shape: 'circle' | 'ellipse' = CARD_DEFAULTS.radialShape;
        if (own(v, 'shape') && v.shape !== undefined) {
            if (v.shape !== 'circle' && v.shape !== 'ellipse') return undefined;
            shape = v.shape;
        }
        return { type: v.type, shape, stops };
    }
    return undefined;
}

const bw = (x: unknown): number | null => {
    const n = finite(x);
    return n === null ? null : clamp(Math.round(n), CARD_LIMITS.borderWidth.min, CARD_LIMITS.borderWidth.max);
};

/** One value, or four (all equal collapses to one); null when malformed. */
function sides<T>(v: unknown, one: (x: unknown) => T | null, eq: (a: T, b: T) => boolean): T | CardSides<T> | null {
    if (Array.isArray(v)) {
        if (v.length !== 4) return null;
        const out = v.map(one);
        if (out.some(x => x === null)) return null;
        const four = out as CardSides<T>;
        return four.every(x => eq(x, four[0])) ? four[0] : four;
    }
    return one(v);
}

function normBorder(v: unknown): CardBorder | undefined {
    if (!isPlainObject(v)) return undefined;
    if (own(v, 'gradient') && v.gradient !== undefined) {
        // A gradient border: uniform width, solid.
        const g = v.gradient;
        if (!isPlainObject(g)) return undefined;
        const stops = normStops(g.stops);
        if (!stops) return undefined;
        let angle: number = CARD_DEFAULTS.angle;
        if (own(g, 'angle') && g.angle !== undefined) {
            const a = normAngle(g.angle);
            if (a === null) return undefined;
            angle = a;
        }
        let width: number = CARD_DEFAULTS.borderWidth;
        if (own(v, 'width') && v.width !== undefined) {
            const w = bw(v.width);
            if (w === null) return undefined;
            width = w;
        }
        if (own(v, 'style') && v.style !== undefined && v.style !== 'solid') return undefined;
        if (width === 0) return undefined;
        return { width, style: 'solid', gradient: { angle, stops } };
    }
    const color = sides<CardColor>(v.color, parseCardColor, (a, b) => a === b);
    if (color === null) return undefined;
    let width: number | CardSides<number> = CARD_DEFAULTS.borderWidth;
    if (own(v, 'width') && v.width !== undefined) {
        const w = sides<number>(v.width, bw, (a, b) => a === b);
        if (w === null) return undefined;
        width = w;
    }
    let style: CardBorderStyle = CARD_DEFAULTS.borderStyle;
    if (own(v, 'style') && v.style !== undefined) {
        if (typeof v.style !== 'string' || !(CARD_BORDER_STYLES as readonly string[]).includes(v.style)) return undefined;
        style = v.style as CardBorderStyle;
    }
    if ([width].flat().every(x => x === 0)) return undefined; // nothing to draw
    return { width, style, color };
}

function normRadius(v: unknown): CardRadius | undefined {
    const r = (x: unknown): number | null => {
        const n = finite(x);
        return n === null ? null : clamp(Math.round(n), CARD_LIMITS.radius.min, CARD_LIMITS.radius.max);
    };
    const out = sides<number>(v, r, (a, b) => a === b);
    return out === null ? undefined : out;
}

function normShadow(v: unknown): CardShadow | null {
    if (!isPlainObject(v)) return null;
    const color = parseCardColor(v.color);
    if (!color) return null;
    const num0 = (k: string, lo: number, hi: number, dflt: number): number | null => {
        if (!own(v, k) || v[k] === undefined) return dflt;
        const n = finite(v[k]);
        return n === null ? null : clamp(Math.round(n), lo, hi);
    };
    const x = num0('x', CARD_LIMITS.shadowOffset.min, CARD_LIMITS.shadowOffset.max, 0);
    const y = num0('y', CARD_LIMITS.shadowOffset.min, CARD_LIMITS.shadowOffset.max, 0);
    const blur = num0('blur', CARD_LIMITS.shadowBlur.min, CARD_LIMITS.shadowBlur.max, CARD_DEFAULTS.shadowBlur);
    const spread = num0('spread', CARD_LIMITS.shadowSpread.min, CARD_LIMITS.shadowSpread.max, 0);
    if (x === null || y === null || blur === null || spread === null) return null;
    if (blur === 0 && spread === 0 && x === 0 && y === 0) return null; // draws nothing
    return { x, y, blur, spread, color };
}

function normShadows(v: unknown): CardShadow[] | undefined {
    if (!Array.isArray(v) || v.length === 0 || v.length > CARD_LIMITS.shadows.max) return undefined;
    const out: CardShadow[] = [];
    for (const s of v) {
        const n = normShadow(s);
        if (!n) return undefined;
        out.push(n);
    }
    return out;
}

function normTextGlow(v: unknown): CardTextGlow | undefined {
    if (!isPlainObject(v)) return undefined;
    const color = parseCardColor(v.color);
    if (!color) return undefined;
    let blur: number = CARD_DEFAULTS.textGlowBlur;
    if (own(v, 'blur') && v.blur !== undefined) {
        const b = finite(v.blur);
        if (b === null) return undefined;
        blur = clamp(Math.round(b), CARD_LIMITS.textGlowBlur.min, CARD_LIMITS.textGlowBlur.max);
    }
    return { color, blur };
}

function normStripe(v: unknown): CardStripe | undefined {
    if (!isPlainObject(v)) return undefined;
    const color = parseCardColor(v.color);
    if (!color) return undefined;
    let width: number = CARD_STRIPE_LIMITS.default;
    if (own(v, 'width') && v.width !== undefined) {
        const w = finite(v.width);
        if (w === null) return undefined;
        width = clamp(Math.round(w), CARD_STRIPE_LIMITS.min, CARD_STRIPE_LIMITS.max);
    }
    return { color, width };
}

function normAnimation(v: unknown): CardAnimation | undefined {
    if (!isPlainObject(v)) return undefined;
    if (typeof v.name !== 'string' || !(CARD_ANIMATIONS as readonly string[]).includes(v.name)) return undefined;
    let seconds: number = CARD_DEFAULTS.animationSeconds;
    if (own(v, 'seconds') && v.seconds !== undefined) {
        const s = finite(v.seconds);
        if (s === null) return undefined;
        seconds = clamp(Math.round(s * 10) / 10, CARD_LIMITS.animationSeconds.min, CARD_LIMITS.animationSeconds.max);
    }
    return { name: v.name as CardAnimationName, seconds };
}

// ── Reserved looks ("can't fake the app") ───────────────────────────────────

/**
 * Looks the app keeps for its OWN chrome. A card style (from a person or a
 * bot) can never take them; the normaliser neutralises them, so every reader
 * enforces it and the editor says what happened:
 *
 *  - `private_reply`: a dashed or dotted border in the accent or muted colour
 *    (the token, or a literal colour close to it in any built-in theme) on
 *    any side is the reserved "Only you can see this" treatment. Such a
 *    border is drawn solid.
 *  - `notice_pill`: a fully rounded card (every corner >= 16px) with tight
 *    padding is the shape of system rows (member joined / left), the
 *    "waiting for this channel's key" placeholder and the app's notice pills.
 *    Its corners are capped at 12px.
 *
 * The rest of "can't fake the app" is structural, in the renderer (see
 * docs/message-card-style.md, Render rules): the card wraps only the message
 * BODY, so the sender's name, avatar, APP tag and timestamp are always drawn
 * by the app outside it; the card is always left-aligned in the message
 * column under that header (system rows are centred between rules, which a
 * card cannot do: `align` moves the TEXT inside the card, never the card);
 * every styled card keeps a visible app-drawn edge
 * (`ResolvedCardStyle.edge`); a card carries no icons or images.
 */
export const CARD_RESERVED_LOOKS = ['private_reply', 'notice_pill'] as const;
export type CardReservedLook = typeof CARD_RESERVED_LOOKS[number];

export const CARD_RESERVED_REASONS: Readonly<Record<CardReservedLook, string>> = {
    private_reply: 'a dashed or dotted accent or muted border is reserved for the app\'s "Only you can see this" replies, so it is drawn solid',
    notice_pill: 'a fully rounded card with tight padding looks like the app\'s system and notice pills, so its corners are capped at 12px',
};

/** Reserved-look colours are compared against every built-in theme. */
function nearToken(c: CardColor, tokens: readonly CardThemeToken[]): boolean {
    const t = cardThemeColorParts(c);
    if (t) return tokens.includes(t.token);
    const rgba = cardColorRgba(c);
    if (!rgba) return false;
    for (const theme of Object.values(CARD_THEMES)) {
        for (const tok of tokens) {
            const ref = cardColorRgba(parseCardColor(theme.tokens[tok]) ?? '');
            if (!ref) continue;
            const d = Math.hypot(rgba[0] - ref[0], rgba[1] - ref[1], rgba[2] - ref[2]);
            if (d < 64) return true;
        }
    }
    return false;
}

function applyReservedLooks(out: CardStyle): CardReservedLook[] {
    const hit: CardReservedLook[] = [];
    const b = out.border;
    if (b && 'color' in b && (b.style === 'dashed' || b.style === 'dotted') && [b.color].flat().some(c => nearToken(c, ['accent', 'muted']))) {
        out.border = { ...b, style: 'solid' };
        hit.push('private_reply');
    }
    const r = out.radius === undefined ? null : Array.isArray(out.radius) ? out.radius : [out.radius, out.radius, out.radius, out.radius];
    if (r && out.padding === 'tight' && r.every(x => x >= 16)) {
        const capped = r.map(x => Math.min(x, 12)) as [number, number, number, number];
        out.radius = capped.every(x => x === capped[0]) ? capped[0] : capped;
        hit.push('notice_pill');
    }
    return hit;
}

/**
 * Validate and normalise an untrusted `card_style` value.
 *
 * Returns the canonical object, or null when there is nothing usable: not a
 * plain object, `v` other than 1, larger than CARD_STYLE_MAX_BYTES, or no
 * valid field left. Idempotent: normalising its own output returns an equal
 * object. Field order in the output is fixed, so equal styles serialise to
 * identical JSON.
 */
export function normalizeCardStyle(input: unknown): CardStyle | null {
    return normalizeWithNotes(input).style;
}

function normalizeWithNotes(input: unknown): { style: CardStyle | null; reserved: CardReservedLook[] } {
    const style = normalizeInner(input);
    if (!style) return { style: null, reserved: [] };
    const reserved = applyReservedLooks(style);
    return { style, reserved };
}

function normalizeInner(input: unknown): CardStyle | null {
    if (!isPlainObject(input)) return null;
    if (input.v !== CARD_STYLE_VERSION) return null;
    if (cardStyleByteSize(input) > CARD_STYLE_MAX_BYTES) return null;
    const out: CardStyle = { v: 1 };
    const background = own(input, 'background') ? normBackground(input.background) : undefined;
    if (background) out.background = background;
    if (background && own(input, 'backgroundOpacity')) {
        const o = finite(input.backgroundOpacity);
        if (o !== null) {
            const c = clamp(Math.round(o), CARD_LIMITS.backgroundOpacity.min, CARD_LIMITS.backgroundOpacity.max);
            if (c < 100) out.backgroundOpacity = c;
        }
    }
    const border = own(input, 'border') ? normBorder(input.border) : undefined;
    if (border) out.border = border;
    const radius = own(input, 'radius') ? normRadius(input.radius) : undefined;
    if (radius !== undefined) out.radius = radius;
    if (own(input, 'padding') && typeof input.padding === 'string' && (CARD_PADDINGS as readonly string[]).includes(input.padding)) {
        out.padding = input.padding as CardPadding;
    }
    const shadows = own(input, 'shadows') ? normShadows(input.shadows) : undefined;
    if (shadows) out.shadows = shadows;
    const text = own(input, 'text') ? parseCardColor(input.text) : null;
    if (text) out.text = text;
    const textGlow = own(input, 'textGlow') ? normTextGlow(input.textGlow) : undefined;
    if (textGlow) out.textGlow = textGlow;
    if (own(input, 'align') && typeof input.align === 'string' && (CARD_ALIGNS as readonly string[]).includes(input.align) && input.align !== 'left') {
        out.align = input.align as CardAlign;
    }
    if (own(input, 'headingAlign') && typeof input.headingAlign === 'string' && (CARD_ALIGNS as readonly string[]).includes(input.headingAlign)
        && input.headingAlign !== (out.align ?? 'left')) {
        out.headingAlign = input.headingAlign as CardAlign;
    }
    if (own(input, 'letterSpacing')) {
        const l = finite(input.letterSpacing);
        if (l !== null) {
            const c = clamp(Math.round(l * 10) / 10, CARD_LIMITS.letterSpacing.min, CARD_LIMITS.letterSpacing.max);
            if (c !== 0) out.letterSpacing = c;
        }
    }
    const stripe = own(input, 'stripe') ? normStripe(input.stripe) : undefined;
    if (stripe) out.stripe = stripe;
    const animation = own(input, 'animation') ? normAnimation(input.animation) : undefined;
    // An animation only exists with what it animates: drift moves a gradient,
    // pulse breathes the shadows. Shimmer works on any card.
    if (animation) {
        const ok = animation.name === 'shimmer'
            || (animation.name === 'drift' && !!out.background && out.background.type !== 'solid')
            || (animation.name === 'pulse' && !!out.shadows);
        if (ok) out.animation = animation;
    }
    return Object.keys(out).length > 1 ? out : null;
}

/** Two styles are the same look (compares canonical JSON). */
export function sameCardStyle(a: CardStyle | null | undefined, b: CardStyle | null | undefined): boolean {
    const na = a ? normalizeCardStyle(a) : null;
    const nb = b ? normalizeCardStyle(b) : null;
    return JSON.stringify(na) === JSON.stringify(nb);
}

/** The validated card style of a message's content (any sender kind), or null. */
export function cardStyleOfContent(content: unknown): CardStyle | null {
    if (!isPlainObject(content)) return null;
    return own(content, 'card_style') ? normalizeCardStyle(content.card_style) : null;
}

/**
 * Apply an `edit`'s card style to the edited message's content.
 *  - edit has no `card_style` key → the original's style is KEPT (an older
 *    client editing a styled message doesn't strip it);
 *  - `card_style: null` → the style is removed (the sender chose plain);
 *  - a value that normalises to a style → it REPLACES the original's;
 *  - a value that doesn't (unknown version, oversize, malformed) → the
 *    original is kept: a reader never guesses what a future style meant.
 */
export function withEditCardStyle<T extends object>(content: T, edit: unknown): T {
    if (!isPlainObject(edit) || !own(edit, 'card_style')) return content;
    const next = { ...content } as Record<string, unknown>;
    if (edit.card_style === null) {
        delete next.card_style;
        return next as T;
    }
    const s = normalizeCardStyle(edit.card_style);
    if (!s) return content;
    next.card_style = s;
    return next as T;
}

/**
 * Server channels: a style counts only on a row the SERVER checked (the
 * row's plaintext `styled` flag, set by the API only when the sender holds
 * STYLE_MESSAGES in that channel). Content from a row without the flag has
 * its `card_style` OBJECT removed before it is stored or rendered, so a
 * modified client that slips a style in unflagged shows plain to everyone.
 * `card_style: null` (an edit removing a style) needs no permission and is
 * kept. DMs and groups have no flag and pass `styledFlag: undefined` with
 * `isServerChannel: false`.
 */
export function gateCardStyleByFlag<T>(content: T, opts: { isServerChannel: boolean; styledFlag: unknown }): T {
    if (!opts.isServerChannel || opts.styledFlag === true) return content;
    if (!isPlainObject(content) || !own(content, 'card_style') || content.card_style === null) return content;
    const { card_style: _dropped, ...rest } = content as Record<string, unknown>;
    return rest as T;
}

/** The plaintext `styled` flag a channel POST carries: true only for a message / edit that sets a style. */
export function cardStyledFlag(content: unknown): boolean {
    if (!isPlainObject(content)) return false;
    return own(content, 'card_style') && content.card_style !== null && normalizeCardStyle(content.card_style) !== null;
}

// ── CSS text → style (the "Edit as CSS" box) ────────────────────────────────

export type CardCssStatus = 'accepted' | 'adjusted' | 'ignored' | 'overridden';
export type CardStyleField = keyof Omit<CardStyle, 'v'>;

export interface CardCssDeclarationReport {
    /** The declaration as written (trimmed, at most 120 chars). */
    text: string;
    /** Lower-cased property name, or '' when none could be read. */
    property: string;
    status: CardCssStatus;
    /** Why it was adjusted, ignored or overridden. */
    reason?: string;
    /** The style field this declaration writes, when accepted. */
    field?: CardStyleField;
}

export interface CardCssResult {
    style: CardStyle | null;
    declarations: CardCssDeclarationReport[];
    /** Set when the whole input was refused before reading any declaration. */
    error?: string;
}

interface DraftBorder {
    width?: number | number[];
    style?: string;
    color?: string | string[];
    gradient?: unknown;
}

/** Draft: what the CSS writes before the normaliser has the last word. */
type Draft = Partial<Record<CardStyleField, unknown>> & { border?: DraftBorder | null };

const KNOWN_PROPS = new Set([
    'background', 'background-color', 'background-image', 'background-opacity',
    'border', 'border-width', 'border-style', 'border-color', 'border-image',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'padding', 'box-shadow', 'color', 'text-shadow', 'text-align', 'heading-align', 'letter-spacing',
    'stripe', 'animation',
]);

const LAYOUT_ESCAPE = new Set([
    'position', 'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline', 'inset-block-start', 'inset-block-end',
    'inset-inline-start', 'inset-inline-end', 'z-index', 'transform', 'translate', 'rotate', 'scale', 'transform-origin',
    'perspective', 'float', 'clear', 'display', 'contain', 'isolation', 'will-change', 'zoom', 'offset', 'offset-path',
    'anchor-name', 'position-anchor', 'container',
]);
const SIZING = new Set([
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'inline-size', 'block-size',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-inline',
    'overflow', 'overflow-x', 'overflow-y', 'box-sizing', 'aspect-ratio', 'flex', 'grid', 'order', 'columns',
]);
const EFFECTS = new Set([
    'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
    'clip-path', 'clip', 'mix-blend-mode', 'opacity', 'visibility', 'outline', 'outline-offset',
    'background-blend-mode', 'pointer-events', 'cursor', 'user-select', 'appearance',
]);
const TYPOGRAPHY = new Set([
    'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'word-spacing',
    'text-transform', 'text-decoration', 'white-space', 'direction', 'writing-mode', 'text-indent',
]);
const ANIM_LONGHANDS = new Set([
    'animation-name', 'animation-duration', 'animation-timing-function', 'animation-iteration-count', 'animation-delay',
    'animation-direction', 'animation-fill-mode', 'animation-play-state', 'transition', 'transition-property',
    'transition-duration', 'transition-timing-function', 'transition-delay',
]);

function propertyRefusal(p: string): string {
    if (LAYOUT_ESCAPE.has(p)) return 'not allowed: it could move the card or let it cover the app. Styling stays inside the card';
    if (SIZING.has(p) || p.startsWith('margin-') || p.startsWith('padding-')) {
        return p.startsWith('padding-') ? 'use the padding shorthand; it snaps to a preset' : 'not allowed: it could change the card\'s size or the row layout';
    }
    if (EFFECTS.has(p)) return 'not allowed: effects like this can reach outside the card or hide things';
    if (TYPOGRAPHY.has(p)) return 'fonts, sizes and text styles come from the formatting bar, not card CSS';
    if (p === 'content' || p === 'quotes' || p === 'counter-reset' || p === 'counter-increment') return 'generated content is not allowed';
    if (ANIM_LONGHANDS.has(p)) return 'use the animation shorthand: animation: drift | pulse | shimmer <seconds>';
    if (p.startsWith('background-')) return 'only background, background-color, background-image and background-opacity are allowed';
    if (p.startsWith('border-') && p.endsWith('-radius')) return 'use border-radius with one to four values';
    if (p.startsWith('border-')) return 'use border, border-width, border-style, border-color, border-image or border-top / -right / -bottom / -left';
    if (p.startsWith('--')) return 'custom properties are not allowed';
    return 'not in the allowed set (background, border, border-radius, padding, box-shadow, color, text-shadow, text-align, heading-align, letter-spacing, stripe, animation)';
}

function charRefusal(text: string): string {
    if (/[^\x20-\x7e\t\r\n]/.test(text)) return 'only plain ASCII is allowed (lookalike and invisible characters are refused)';
    if (text.includes('\\')) return 'escapes (\\) are not allowed';
    if (text.includes('*')) return 'comments are not allowed';
    if (text.includes('!')) return '!important is not allowed';
    if (text.includes('@')) return 'at-rules such as @import are not allowed';
    if (/[{}]/.test(text)) return 'write declarations only: no selectors or { } blocks';
    if (/["'`]/.test(text)) return 'quoted strings are not allowed';
    if (text.includes('<') || text.includes('>')) return 'markup is not allowed';
    if (text.includes('&')) return '"&" is not allowed';
    const bad = /[^a-zA-Z0-9#%().,+\-/:; \t\r\n]/.exec(text);
    return `the character "${bad ? bad[0] : '?'}" is not allowed`;
}

type Len = { px: number } | { error: string };

function lengthOf(t: Tok | undefined, signed = false): Len {
    if (!t || t.kind !== 'word') return { error: 'expected a length in px' };
    const w = t.text;
    if (w === '0' || w === '-0') return { px: 0 };
    if (w.startsWith('-') && !signed) return { error: 'negative lengths are not allowed' };
    const m = /^(-?)(\d{1,6}(?:\.\d{1,2})?)px$/.exec(w);
    if (!m) return { error: /^-?\d/.test(w) ? `"${w}": only px lengths are allowed` : `"${w}" is not a length` };
    return { px: (m[1] ? -1 : 1) * Number(m[2]) };
}

const isLengthWord = (t: Tok): boolean => t.kind === 'word' && !t.text.startsWith('#') && (t.text === '0' || /px$/.test(t.text) || /^-?\d/.test(t.text));

const SIDES_TO: Record<string, number> = {
    'to top': 0, 'to top right': 45, 'to right top': 45, 'to right': 90, 'to bottom right': 135, 'to right bottom': 135,
    'to bottom': 180, 'to bottom left': 225, 'to left bottom': 225, 'to left': 270, 'to top left': 315, 'to left top': 315,
};

interface StepOut { draft: Draft; field: CardStyleField; adjusted?: string }

function gradientFromFn(fn: Extract<Tok, { kind: 'fn' }>): { background: Record<string, unknown>; adjusted?: string } | { error: string } {
    const args = fn.args.filter(a => a.length > 0);
    if (args.length !== fn.args.length) return { error: 'empty gradient argument' };
    const linear = fn.name === 'linear-gradient' || fn.name === 'repeating-linear-gradient';
    const repeating = fn.name.startsWith('repeating-');
    let rest = args;
    let angle: number | undefined;
    let shape: 'circle' | 'ellipse' | undefined;
    const first = args[0];
    if (linear && first && first.every(t => t.kind === 'word')) {
        const words = first.map(t => (t as { text: string }).text);
        const joined = words.join(' ');
        if (words.length === 1 && /^-?\d{1,4}(?:\.\d{1,2})?deg$/.test(words[0])) {
            angle = Number(words[0].slice(0, -3));
            rest = args.slice(1);
        } else if (words[0] === 'to') {
            if (!(joined in SIDES_TO)) return { error: `"${joined}" is not a gradient direction` };
            angle = SIDES_TO[joined];
            rest = args.slice(1);
        } else if (/^-?\d/.test(words[0]) && words.length === 1 && !words[0].endsWith('%')) {
            return { error: `"${words[0]}": a gradient angle must be in deg` };
        }
    }
    if (!linear && first && first.every(t => t.kind === 'word')) {
        const words = first.map(t => (t as { text: string }).text);
        if (words.length === 1 && (words[0] === 'circle' || words[0] === 'ellipse')) {
            shape = words[0];
            rest = args.slice(1);
        } else if (words.includes('at') || words.some(w => /^(closest|farthest)-/.test(w)) || words.includes('circle') || words.includes('ellipse')) {
            return { error: 'radial gradients support only "circle" or "ellipse", centred: no sizes or positions' };
        }
    }
    if (rest.length < CARD_LIMITS.stops.min) return { error: `a gradient needs at least ${CARD_LIMITS.stops.min} colour stops` };
    if (rest.length > CARD_LIMITS.stops.max) return { error: `at most ${CARD_LIMITS.stops.max} colour stops (this has ${rest.length})` };
    const stops: { color: string; at?: number }[] = [];
    let adjusted: string | undefined;
    for (const seq of rest) {
        if (seq.length < 1 || seq.length > 2) return { error: 'each colour stop is a colour and at most one percentage' };
        const c = colourFromTok(seq[0]);
        if ('error' in c) return c;
        if (seq.length === 2) {
            const p = seq[1];
            if (p.kind !== 'word' || !/^-?\d{1,4}(?:\.\d{1,2})?%$/.test(p.text)) return { error: 'a colour stop position must be a percentage' };
            const raw = Number(p.text.slice(0, -1));
            const v = clamp(raw, 0, 100);
            if (v !== raw) adjusted = 'stop positions are kept between 0% and 100%';
            stops.push({ color: c.color, at: v });
        } else stops.push({ color: c.color });
    }
    if (repeating) {
        const last = stops[stops.length - 1].at;
        if (last === undefined) return { error: 'a repeating gradient needs a % position on its last stop (its pattern size)' };
        if (last < CARD_LIMITS.repeatPeriodMin) return { error: `a repeating pattern can't be finer than ${CARD_LIMITS.repeatPeriodMin}% (its last stop)` };
    }
    const type = (linear ? 'linear' : 'radial');
    const t = repeating ? `repeating-${type}` : type;
    return linear
        ? { background: { type: t, ...(angle !== undefined ? { angle } : {}), stops }, adjusted }
        : { background: { type: t, ...(shape ? { shape } : {}), stops }, adjusted };
}

const four = <T,>(v: T | T[] | undefined, fill: T): T[] => (Array.isArray(v) ? [...v] : [v ?? fill, v ?? fill, v ?? fill, v ?? fill]);
const SIDE_INDEX: Record<string, number> = { 'border-top': 0, 'border-right': 1, 'border-bottom': 2, 'border-left': 3 };

function parseShadow(seq: Tok[], allowOffsets: boolean): { shadow: { x: number; y: number; blur: number; spread: number; color: string }; notes: string[] } | { error: string } {
    if (seq.some(t => t.kind === 'word' && t.text === 'inset')) return { error: 'inset shadows are not allowed: shadows sit around the card' };
    let colour: string | undefined;
    const lens: number[] = [];
    for (const t of seq) {
        if (isLengthWord(t)) {
            const l = lengthOf(t, true);
            if ('error' in l) return l;
            lens.push(l.px);
            continue;
        }
        const c = colourFromTok(t);
        if ('error' in c) return c;
        if (colour) return { error: 'a shadow has one colour' };
        colour = c.color;
    }
    if (!colour) return { error: 'a shadow needs a colour (for example: 0 0 12px #25e0c866)' };
    if (lens.length < 2 || lens.length > 4) return { error: 'write a shadow as: <x> <y> [<blur> [<spread>]] <colour>' };
    const [x, y, blur = 0, spread = 0] = lens;
    if (blur < 0) return { error: 'a negative blur is not allowed' };
    if (spread < 0) return { error: 'negative spread is not allowed (it would shrink the shadow under the card)' };
    if (!allowOffsets && (x !== 0 || y !== 0)) return { error: 'a text glow is centred: both offsets must be 0' };
    const notes: string[] = [];
    const cl = (v: number, lo: number, hi: number, name: string) => {
        const c = clamp(Math.round(v), lo, hi);
        if (c !== v) notes.push(`${name} ${v}px became ${c}px`);
    };
    cl(x, CARD_LIMITS.shadowOffset.min, CARD_LIMITS.shadowOffset.max, 'x');
    cl(y, CARD_LIMITS.shadowOffset.min, CARD_LIMITS.shadowOffset.max, 'y');
    cl(blur, allowOffsets ? CARD_LIMITS.shadowBlur.min : CARD_LIMITS.textGlowBlur.min, allowOffsets ? CARD_LIMITS.shadowBlur.max : CARD_LIMITS.textGlowBlur.max, 'blur');
    if (allowOffsets) cl(spread, CARD_LIMITS.shadowSpread.min, CARD_LIMITS.shadowSpread.max, 'spread');
    return { shadow: { x, y, blur, spread, color: colour }, notes };
}

function stepDeclaration(prop: string, toks: Tok[], current: Draft): StepOut | { error: string } {
    const words = (): string[] | null => (toks.every(t => t.kind === 'word') ? toks.map(t => (t as { text: string }).text) : null);
    const w1 = words();
    const isNone = !!w1 && w1.length === 1 && w1[0] === 'none';
    if (toks.some(t => t.kind === 'comma') && prop !== 'box-shadow') {
        if (prop === 'text-shadow') return { error: 'one text shadow only' };
        if (prop === 'animation') return { error: 'only one animation' };
        if (prop.startsWith('background')) return { error: 'only one background layer' };
        return { error: 'lists are not allowed here' };
    }
    if (toks.some(t => t.kind === 'slash')) return { error: '"/" is only allowed inside rgb(), hsl() or theme()' };
    const curB: DraftBorder = { ...(current.border ?? {}) };
    switch (prop) {
        case 'background':
        case 'background-color':
        case 'background-image': {
            if (isNone) return { draft: { background: null }, field: 'background' };
            if (toks.length !== 1) return { error: 'background takes exactly one colour or one gradient (no images, positions or sizes)' };
            const t = toks[0];
            if (t.kind === 'fn' && GRADIENT_FNS.has(t.name)) {
                if (prop === 'background-color') return { error: 'background-color takes a colour; put gradients in background or background-image' };
                const g = gradientFromFn(t);
                if ('error' in g) return g;
                return { draft: { background: g.background }, field: 'background', adjusted: g.adjusted };
            }
            if (prop === 'background-image') return { error: 'background-image takes a gradient' };
            const c = colourFromTok(t);
            if ('error' in c) return c;
            return { draft: { background: { type: 'solid', color: c.color } }, field: 'background' };
        }
        case 'background-opacity': {
            if (!w1 || w1.length !== 1) return { error: 'background-opacity takes one value: 0 to 1, or 0% to 100%' };
            const a = alphaOf(w1[0]);
            if (a === null) return { error: 'background-opacity takes one value: 0 to 1, or 0% to 100%' };
            return { draft: { backgroundOpacity: Math.round(a * 100) }, field: 'backgroundOpacity' };
        }
        case 'border': {
            if (w1 && w1.length === 1 && (w1[0] === 'none' || w1[0] === '0')) return { draft: { border: null }, field: 'border' };
            let width: number | undefined;
            let style: string | undefined;
            let color: string | undefined;
            const notes: string[] = [];
            for (const t of toks) {
                if (t.kind === 'word' && (CARD_BORDER_STYLES as readonly string[]).includes(t.text)) {
                    if (style) return { error: 'border has two styles' };
                    style = t.text;
                    continue;
                }
                if (isLengthWord(t)) {
                    const l = lengthOf(t);
                    if ('error' in l) return l;
                    if (width !== undefined) return { error: 'border has two widths' };
                    width = l.px;
                    continue;
                }
                if (t.kind === 'word' && ['none', 'hidden', 'groove', 'ridge', 'inset', 'outset'].includes(t.text)) {
                    return { error: `border style "${t.text}" is not allowed: use solid, dashed, dotted or double` };
                }
                const c = colourFromTok(t);
                if ('error' in c) return c;
                if (color) return { error: 'border has two colours' };
                color = c.color;
            }
            if (!color) return { error: 'border needs a colour (for example: border: 1px solid #25e0c8)' };
            if (width !== undefined && (width > CARD_LIMITS.borderWidth.max || width !== Math.round(width))) {
                notes.push(`width ${width}px became ${clamp(Math.round(width), 0, CARD_LIMITS.borderWidth.max)}px (whole px, ${CARD_LIMITS.borderWidth.max}px at most)`);
            }
            if (!style) notes.push('no style given, so solid');
            if (width === undefined) notes.push('no width given, so 1px');
            return { draft: { border: { width: width ?? CARD_DEFAULTS.borderWidth, style: style ?? 'solid', color } }, field: 'border', adjusted: notes.length ? notes.join('; ') : undefined };
        }
        case 'border-top':
        case 'border-right':
        case 'border-bottom':
        case 'border-left': {
            const i = SIDE_INDEX[prop];
            let width: number | undefined;
            let style: string | undefined;
            let color: string | undefined;
            if (w1 && w1.length === 1 && (w1[0] === 'none' || w1[0] === '0')) width = 0;
            else {
                for (const t of toks) {
                    if (t.kind === 'word' && (CARD_BORDER_STYLES as readonly string[]).includes(t.text)) { style = t.text; continue; }
                    if (isLengthWord(t)) {
                        const l = lengthOf(t);
                        if ('error' in l) return l;
                        width = l.px;
                        continue;
                    }
                    const c = colourFromTok(t);
                    if ('error' in c) return c;
                    color = c.color;
                }
            }
            if (curB.gradient !== undefined) return { error: 'per-side borders can\'t combine with a gradient border' };
            const shared = curB.style ?? 'solid';
            if (style && style !== shared && curB.style !== undefined) return { error: `one border style for all sides (the border is ${shared})` };
            const widths = four<number>(curB.width as number | number[] | undefined, curB.width === undefined ? 0 : CARD_DEFAULTS.borderWidth);
            const sideColour = color ?? (Array.isArray(curB.color) ? curB.color[i] : curB.color);
            if (!sideColour && width !== 0) return { error: `${prop} needs a colour` };
            const colours = four<string>(curB.color as string | string[] | undefined, sideColour ?? '#000000');
            widths[i] = width ?? CARD_DEFAULTS.borderWidth;
            if (sideColour) colours[i] = sideColour;
            const adj = widths[i] > CARD_LIMITS.borderWidth.max ? `width became ${CARD_LIMITS.borderWidth.max}px (the most)` : undefined;
            return { draft: { border: { width: widths, style: style ?? curB.style ?? 'solid', color: colours } }, field: 'border', adjusted: adj };
        }
        case 'border-width': {
            if (toks.length < 1 || toks.length > 4) return { error: 'border-width takes one to four px values' };
            const vals: number[] = [];
            for (const t of toks) {
                const l = lengthOf(t);
                if ('error' in l) return l;
                vals.push(l.px);
            }
            const [a, b = a, c = a, d = b] = vals;
            const w = vals.length === 1 ? a : [a, b, c, d];
            const adj = [w].flat().some(x => x > CARD_LIMITS.borderWidth.max || x !== Math.round(x)) ? `kept to whole px, ${CARD_LIMITS.borderWidth.max}px at most` : undefined;
            if (Array.isArray(w) && curB.gradient !== undefined) return { error: 'a gradient border has one width for all sides' };
            return { draft: { border: { ...curB, width: w } }, field: 'border', adjusted: adj };
        }
        case 'border-style': {
            if (!w1 || w1.length !== 1) return { error: 'one style for all sides' };
            if (!(CARD_BORDER_STYLES as readonly string[]).includes(w1[0])) return { error: `"${w1[0]}" is not allowed: use solid, dashed, dotted or double` };
            if (curB.gradient !== undefined && w1[0] !== 'solid') return { error: 'a gradient border is always solid' };
            return { draft: { border: { ...curB, style: w1[0] } }, field: 'border' };
        }
        case 'border-color': {
            if (toks.length < 1 || toks.length > 4) return { error: 'border-color takes one to four colours' };
            const cs: string[] = [];
            for (const t of toks) {
                const c = colourFromTok(t);
                if ('error' in c) return c;
                cs.push(c.color);
            }
            const [a, b = a, c = a, d = b] = cs;
            const { gradient: _g, ...withoutGradient } = curB;
            return { draft: { border: { ...withoutGradient, color: cs.length === 1 ? a : [a, b, c, d] } }, field: 'border' };
        }
        case 'border-image': {
            if (isNone) {
                const { gradient: _g, ...rest } = curB;
                return { draft: { border: rest }, field: 'border' };
            }
            const fn = toks[0];
            const trailing = toks.slice(1);
            if (!fn || fn.kind !== 'fn' || fn.name !== 'linear-gradient') return { error: 'border-image takes one linear-gradient() (a gradient border)' };
            if (trailing.length > 1 || (trailing.length === 1 && !(trailing[0].kind === 'word' && trailing[0].text === '1'))) {
                return { error: 'write a gradient border as: border-image: linear-gradient(...) 1 (no slices, widths or outsets)' };
            }
            const g = gradientFromFn(fn);
            if ('error' in g) return g;
            if (Array.isArray(curB.width)) return { error: 'a gradient border has one width for all sides' };
            const { color: _c, ...rest } = curB;
            const gr = g.background as { angle?: number; stops: unknown };
            return {
                draft: { border: { ...rest, style: 'solid', width: curB.width ?? CARD_DEFAULTS.borderWidth, gradient: { ...(gr.angle !== undefined ? { angle: gr.angle } : {}), stops: gr.stops } } },
                field: 'border',
                adjusted: curB.width === undefined ? 'no border-width given, so 1px' : g.adjusted,
            };
        }
        case 'border-radius': {
            if (toks.length < 1 || toks.length > 4) return { error: 'border-radius takes one to four px values' };
            const vals: number[] = [];
            for (const t of toks) {
                const l = lengthOf(t);
                if ('error' in l) return l;
                vals.push(l.px);
            }
            // CSS shorthand order: TL, TR, BR, BL.
            const [a, b = a, c = a, d = b] = vals;
            const fourR = [a, b, c, d];
            const capped = fourR.map(x => clamp(Math.round(x), 0, CARD_LIMITS.radius.max));
            const adj = capped.some((x, i) => x !== fourR[i]) ? `kept to whole px between 0 and ${CARD_LIMITS.radius.max}px` : undefined;
            return { draft: { radius: fourR }, field: 'radius', adjusted: adj };
        }
        case 'padding': {
            if (toks.length < 1 || toks.length > 4) return { error: 'padding takes one to four px values' };
            const vals: number[] = [];
            for (const t of toks) {
                const l = lengthOf(t);
                if ('error' in l) return l;
                vals.push(l.px);
            }
            const [top, right = top, bottom = top, left = right] = vals;
            const v = (top + bottom) / 2;
            const h = (left + right) / 2;
            let best: CardPadding = 'cozy';
            let bestD = Infinity;
            for (const p of CARD_PADDINGS) {
                const [pv, ph] = CARD_PADDING_PX[p];
                const d = Math.abs(pv - v) + Math.abs(ph - h);
                if (d < bestD) { best = p; bestD = d; }
            }
            const [pv, ph] = CARD_PADDING_PX[best];
            const exact = vals.length <= 2 && top === pv && right === ph && bottom === pv && left === ph;
            return {
                draft: { padding: best },
                field: 'padding',
                adjusted: exact ? undefined : `snapped to the ${best} preset (${pv}px ${ph}px): padding is preset-only, so a card never shifts the layout`,
            };
        }
        case 'box-shadow': {
            if (isNone) return { draft: { shadows: null }, field: 'shadows' };
            const list: Tok[][] = [[]];
            for (const t of toks) {
                if (t.kind === 'comma') list.push([]);
                else list[list.length - 1].push(t);
            }
            if (list.length > CARD_LIMITS.shadows.max) return { error: `at most ${CARD_LIMITS.shadows.max} shadows` };
            const shadows: unknown[] = [];
            const notes: string[] = [];
            for (const seq of list) {
                const s = parseShadow(seq, true);
                if ('error' in s) return s;
                shadows.push(s.shadow);
                notes.push(...s.notes);
            }
            return { draft: { shadows }, field: 'shadows', adjusted: notes.length ? notes.join('; ') : undefined };
        }
        case 'text-shadow': {
            if (isNone) return { draft: { textGlow: null }, field: 'textGlow' };
            const s = parseShadow(toks, false);
            if ('error' in s) return s;
            if (s.shadow.spread !== 0) return { error: 'a text glow has no spread: write 0 0 <blur> <colour>' };
            return { draft: { textGlow: { color: s.shadow.color, blur: s.shadow.blur } }, field: 'textGlow', adjusted: s.notes.length ? s.notes.join('; ') : undefined };
        }
        case 'color': {
            if (toks.length !== 1) return { error: 'color takes one colour' };
            const c = colourFromTok(toks[0]);
            if ('error' in c) return c;
            return { draft: { text: c.color }, field: 'text' };
        }
        case 'heading-align': {
            // Cipherline's own property: aligns the message's headings only.
            if (!w1 || w1.length !== 1) return { error: 'heading-align takes left, center or right' };
            const hmap: Record<string, CardAlign> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right' };
            const ha = hmap[w1[0]];
            if (!ha) return { error: `"${w1[0]}" is not allowed: heading-align takes left, center or right` };
            return { draft: { headingAlign: ha }, field: 'headingAlign' };
        }
        case 'text-align': {
            if (!w1 || w1.length !== 1) return { error: 'text-align takes left, center or right' };
            const map: Record<string, CardAlign> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right' };
            const a = map[w1[0]];
            if (!a) return { error: `"${w1[0]}" is not allowed: text-align takes left, center or right` };
            return { draft: { align: a }, field: 'align' };
        }
        case 'letter-spacing': {
            if (!w1 || w1.length !== 1) return { error: 'letter-spacing takes one px value' };
            if (w1[0] === 'normal') return { draft: { letterSpacing: null }, field: 'letterSpacing' };
            const l = lengthOf(toks[0], true);
            if ('error' in l) return l;
            const c = clamp(Math.round(l.px * 10) / 10, CARD_LIMITS.letterSpacing.min, CARD_LIMITS.letterSpacing.max);
            return { draft: { letterSpacing: l.px }, field: 'letterSpacing', adjusted: c !== l.px ? `${l.px}px became ${c}px (${CARD_LIMITS.letterSpacing.min} to ${CARD_LIMITS.letterSpacing.max}px)` : undefined };
        }
        case 'stripe': {
            // The accent stripe (Cipherline's own property): a coloured bar inside the card's left edge.
            if (w1 && w1.length === 1 && (w1[0] === 'none' || w1[0] === '0')) return { draft: { stripe: null }, field: 'stripe' };
            let width: number | undefined;
            let color: string | undefined;
            for (const t of toks) {
                if (t.kind === 'word' && t.text === 'solid') continue;
                if (t.kind === 'word' && (CARD_BORDER_STYLES as readonly string[]).includes(t.text)) return { error: 'the accent stripe is always solid' };
                if (isLengthWord(t)) {
                    const l = lengthOf(t);
                    if ('error' in l) return l;
                    if (width !== undefined) return { error: 'the stripe has two widths' };
                    width = l.px;
                    continue;
                }
                const c = colourFromTok(t);
                if ('error' in c) return c;
                if (color) return { error: 'the stripe has two colours' };
                color = c.color;
            }
            if (!color) return { error: 'the accent stripe needs a colour (for example: stripe: 4px theme(danger))' };
            const notes: string[] = [];
            if (width === undefined) notes.push(`no width given, so ${CARD_STRIPE_LIMITS.default}px`);
            else {
                const cw = clamp(Math.round(width), CARD_STRIPE_LIMITS.min, CARD_STRIPE_LIMITS.max);
                if (cw !== width) notes.push(`width ${width}px became ${cw}px (${CARD_STRIPE_LIMITS.min} to ${CARD_STRIPE_LIMITS.max}px)`);
            }
            return { draft: { stripe: { color, ...(width !== undefined ? { width } : {}) } }, field: 'stripe', adjusted: notes.length ? notes.join('; ') : undefined };
        }
        case 'animation': {
            if (!w1) return { error: 'animation takes a name and a duration only' };
            if (isNone) return { draft: { animation: null }, field: 'animation' };
            let name: string | undefined;
            let seconds: number | undefined;
            for (const x of w1) {
                if ((CARD_ANIMATIONS as readonly string[]).includes(x)) {
                    if (name) return { error: 'only one animation' };
                    name = x;
                } else if (/^\d{1,5}(?:\.\d{1,3})?(ms|s)$/.test(x)) {
                    if (seconds !== undefined) return { error: 'one duration only (no delay)' };
                    seconds = x.endsWith('ms') ? Number(x.slice(0, -2)) / 1000 : Number(x.slice(0, -1));
                } else if (x === 'infinite') {
                    // Card animations always loop: accepted, changes nothing.
                } else {
                    return { error: `"${x}" is not allowed: animation is one of ${CARD_ANIMATIONS.join(', ')} plus a duration; timing curves are app-defined` };
                }
            }
            if (!name) return { error: `animation must be one of the app's: ${CARD_ANIMATIONS.join(', ')}` };
            const s = seconds ?? CARD_DEFAULTS.animationSeconds;
            const cs = clamp(Math.round(s * 10) / 10, CARD_LIMITS.animationSeconds.min, CARD_LIMITS.animationSeconds.max);
            const notes: string[] = [];
            if (seconds === undefined) notes.push(`no duration given, so ${CARD_DEFAULTS.animationSeconds}s`);
            else if (cs !== s) notes.push(`${s}s became ${cs}s (between ${CARD_LIMITS.animationSeconds.min}s and ${CARD_LIMITS.animationSeconds.max}s)`);
            return { draft: { animation: { name, seconds: s } }, field: 'animation', adjusted: notes.length ? notes.join('; ') : undefined };
        }
        default:
            return { error: propertyRefusal(prop) };
    }
}

/** Why an accepted declaration's field didn't survive normalisation. */
function droppedReason(field: CardStyleField, style: CardStyle | null): string {
    switch (field) {
        case 'border': return 'no border is drawn: it needs a colour (or a gradient) and a width above 0';
        case 'animation':
            return style?.background && style.background.type !== 'solid'
                ? 'pulse needs a shadow (box-shadow)'
                : 'drift needs a gradient background; pulse needs a shadow (box-shadow)';
        case 'shadows': return 'a shadow with no offset, blur or spread draws nothing';
        case 'backgroundOpacity': return 'background opacity needs a background; 100% is the default';
        case 'align': return 'left is the default';
        case 'headingAlign': return 'headings already follow text-align';
        case 'letterSpacing': return '0 is the default';
        default: return 'it has no effect';
    }
}

/**
 * Parse CSS declarations into a card style through a strict allowlist.
 *
 * Only declarations (`property: value;`), never selectors, blocks, at-rules,
 * comments, escapes, quotes, `!important` or non-ASCII. Each declaration is
 * reported as accepted, adjusted (clamped, snapped or neutralised, with the
 * reason), ignored (with the reason) or overridden (a later declaration
 * replaced it). The result's `style` is exactly `normalizeCardStyle` of what
 * was accepted, so CSS and the equivalent JSON produce the identical object.
 */
export function parseCardStyleCss(css: unknown): CardCssResult {
    if (typeof css !== 'string') return { style: null, declarations: [], error: 'not text' };
    if (css.length > CARD_STYLE_CSS_MAX_CHARS) {
        return { style: null, declarations: [], error: `too long: at most ${CARD_STYLE_CSS_MAX_CHARS} characters` };
    }
    const reports: CardCssDeclarationReport[] = [];
    const draft: Draft = {};
    const lastFor = new Map<string, number>();
    let count = 0;
    for (const raw of css.split(';')) {
        const text = raw.trim();
        if (!text) continue;
        const shown = text.length > 120 ? `${text.slice(0, 117)}...` : text;
        count++;
        if (count > CARD_STYLE_CSS_MAX_DECLARATIONS) {
            reports.push({ text: shown, property: '', status: 'ignored', reason: `at most ${CARD_STYLE_CSS_MAX_DECLARATIONS} declarations are read` });
            continue;
        }
        // Charset first, on the raw text, before any case folding.
        if (!/^[a-zA-Z0-9#%().,+\-/: \t\r\n]*$/.test(text)) {
            reports.push({ text: shown, property: '', status: 'ignored', reason: charRefusal(text) });
            continue;
        }
        const lower = text.toLowerCase();
        // A dangerous function anywhere in the declaration is named as such,
        // before anything else could describe it less clearly.
        const dangerous = /(^|[^a-z-])(url|expression|var|attr|image-set|-webkit-image-set|element|-moz-element|env|calc)\s*\(/.exec(lower);
        if (dangerous) {
            reports.push({ text: shown, property: '', status: 'ignored', reason: functionRefusal(dangerous[2]) });
            continue;
        }
        const colon = lower.indexOf(':');
        if (colon < 0 || lower.indexOf(':', colon + 1) >= 0) {
            reports.push({ text: shown, property: '', status: 'ignored', reason: colon < 0 ? 'not a declaration (expected property: value)' : 'one colon per declaration' });
            continue;
        }
        const prop = lower.slice(0, colon).trim();
        const value = lower.slice(colon + 1).trim();
        if (!/^-{0,2}[a-z][a-z-]{0,40}$/.test(prop)) {
            reports.push({ text: shown, property: '', status: 'ignored', reason: 'not a property name' });
            continue;
        }
        if (!value) {
            reports.push({ text: shown, property: prop, status: 'ignored', reason: 'no value' });
            continue;
        }
        if (!KNOWN_PROPS.has(prop)) {
            reports.push({ text: shown, property: prop, status: 'ignored', reason: propertyRefusal(prop) });
            continue;
        }
        const tok = tokenize(value);
        if ('error' in tok) {
            reports.push({ text: shown, property: prop, status: 'ignored', reason: tok.error });
            continue;
        }
        const step = stepDeclaration(prop, tok.tokens, draft);
        if ('error' in step) {
            reports.push({ text: shown, property: prop, status: 'ignored', reason: step.error });
            continue;
        }
        // A later declaration of the same field wins, except the border
        // longhands and sides, which merge into one border.
        const mergesBorder = step.field === 'border' && prop !== 'border';
        const key = mergesBorder ? prop : step.field;
        const prev = lastFor.get(key);
        if (prev !== undefined) reports[prev] = { ...reports[prev], status: 'overridden', reason: 'a later declaration replaced it' };
        if (prop === 'border') {
            for (const [k, idx] of [...lastFor.entries()]) {
                if (k.startsWith('border-') && k !== 'border-radius') {
                    reports[idx] = { ...reports[idx], status: 'overridden', reason: 'the later border shorthand replaced it' };
                    lastFor.delete(k);
                }
            }
        }
        Object.assign(draft, step.draft);
        lastFor.set(key, reports.length);
        reports.push({ text: shown, property: prop, status: step.adjusted ? 'adjusted' : 'accepted', reason: step.adjusted, field: step.field });
    }
    // The normaliser has the last word (the same function every reader runs).
    const json: Record<string, unknown> = { v: 1 };
    for (const [k, v] of Object.entries(draft)) if (v !== null && v !== undefined) json[k] = v;
    const { style, reserved } = normalizeWithNotes(json);
    // Reserved looks: say which declaration the app changed, and why.
    const reservedField: Record<CardReservedLook, CardStyleField> = { private_reply: 'border', notice_pill: 'radius' };
    for (const look of reserved) {
        const field = reservedField[look];
        for (let i = reports.length - 1; i >= 0; i--) {
            const r = reports[i];
            if ((r.status === 'accepted' || r.status === 'adjusted') && r.field === field) {
                r.status = 'adjusted';
                r.reason = r.reason ? `${r.reason}; ${CARD_RESERVED_REASONS[look]}` : CARD_RESERVED_REASONS[look];
                break;
            }
        }
    }
    for (const r of reports) {
        if ((r.status === 'accepted' || r.status === 'adjusted') && r.field && !(style && style[r.field] !== undefined)) {
            // `none` / `normal` / `0` declarations intentionally clear a field.
            if (/:\s*(none|normal|0)\s*$/i.test(r.text)) continue;
            // left / 100% / 0px are the defaults: accepted, and simply not stored.
            if (r.field === 'headingAlign' && /:\s*(left|start|center|right|end)\s*$/i.test(r.text)) continue;
            if ((r.field === 'align' && /:\s*(left|start)\s*$/i.test(r.text)) || (r.field === 'backgroundOpacity' && style?.background && /:\s*(1|100%|1\.0+)\s*$/.test(r.text))) continue;
            r.status = 'ignored';
            r.reason = droppedReason(r.field, style);
        }
    }
    return { style, declarations: reports };
}

// ── Style → CSS text (the editor shows the visual editor's result as CSS) ───

function stopsCss(stops: CardGradientStop[]): string {
    return stops.map(s => `${s.color} ${s.at}%`).join(', ');
}

function backgroundCss(bg: CardBackground): string {
    if (bg.type === 'solid') return bg.color;
    if ('angle' in bg) return `${bg.type}-gradient(${bg.angle}deg, ${stopsCss(bg.stops)})`;
    return `${bg.type}-gradient(${bg.shape}, ${stopsCss(bg.stops)})`;
}

const shadowCss = (s: CardShadow): string => `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`;

/**
 * The canonical CSS text for a style; `parseCardStyleCss` of it returns an
 * equal style (round-trip, tested). One declaration per line.
 */
export function cardStyleToCss(style: CardStyle | null): string {
    const s = style ? normalizeCardStyle(style) : null;
    if (!s) return '';
    const out: string[] = [];
    if (s.background) out.push(`background: ${backgroundCss(s.background)};`);
    if (s.backgroundOpacity !== undefined) out.push(`background-opacity: ${s.backgroundOpacity}%;`);
    const b = s.border;
    if (b) {
        if ('gradient' in b) {
            out.push(`border-width: ${b.width}px;`);
            out.push(`border-image: linear-gradient(${b.gradient.angle}deg, ${stopsCss(b.gradient.stops)}) 1;`);
        } else if (!Array.isArray(b.width) && !Array.isArray(b.color)) {
            out.push(`border: ${b.width}px ${b.style} ${b.color};`);
        } else {
            out.push(`border-style: ${b.style};`);
            out.push(`border-width: ${[b.width].flat().length === 1 ? `${b.width}px` : (b.width as number[]).map(x => `${x}px`).join(' ')};`);
            out.push(`border-color: ${Array.isArray(b.color) ? b.color.join(' ') : b.color};`);
        }
    }
    if (s.radius !== undefined) out.push(`border-radius: ${Array.isArray(s.radius) ? s.radius.map(r => `${r}px`).join(' ') : `${s.radius}px`};`);
    if (s.padding) {
        const [v, h] = CARD_PADDING_PX[s.padding];
        out.push(`padding: ${v}px ${h}px;`);
    }
    if (s.shadows) out.push(`box-shadow: ${s.shadows.map(shadowCss).join(', ')};`);
    if (s.text) out.push(`color: ${s.text};`);
    if (s.textGlow) out.push(`text-shadow: 0 0 ${s.textGlow.blur}px ${s.textGlow.color};`);
    if (s.align) out.push(`text-align: ${s.align};`);
    if (s.headingAlign) out.push(`heading-align: ${s.headingAlign};`);
    if (s.letterSpacing !== undefined) out.push(`letter-spacing: ${s.letterSpacing}px;`);
    if (s.stripe) out.push(`stripe: ${s.stripe.width}px ${s.stripe.color};`);
    if (s.animation) out.push(`animation: ${s.animation.name} ${s.animation.seconds}s;`);
    return out.join('\n');
}

// ── Display modes ───────────────────────────────────────────────────────────

/** A reader's own choice (Appearance → Message styles). */
export const USER_CARD_STYLE_MODES = ['all', 'static', 'plain'] as const;
export type UserCardStyleMode = typeof USER_CARD_STYLE_MODES[number];

/** A server's choice for its channels (Server Settings → Overview). Plain server metadata, not content. */
export const SERVER_MESSAGE_STYLES = ['on', 'no_animation', 'off'] as const;
export type ServerMessageStyles = typeof SERVER_MESSAGE_STYLES[number];

export function isServerMessageStyles(v: unknown): v is ServerMessageStyles {
    return typeof v === 'string' && (SERVER_MESSAGE_STYLES as readonly string[]).includes(v);
}

export function isUserCardStyleMode(v: unknown): v is UserCardStyleMode {
    return typeof v === 'string' && (USER_CARD_STYLE_MODES as readonly string[]).includes(v);
}

/** How one card renders: with animation, without, or not at all. */
export type CardRenderMode = 'full' | 'static' | 'plain';

/**
 * The strictest of every switch that applies, whoever sent the message (a
 * person or, later, a bot): the reader's own mode, the server's setting (null
 * in a DM: DMs are unaffected), the per-message "Show plain", and the OS
 * reduced-motion preference (never any animation).
 */
export function effectiveCardRenderMode(opts: {
    user: UserCardStyleMode | null | undefined;
    server: ServerMessageStyles | null | undefined;
    showPlain?: boolean;
    reducedMotion?: boolean;
}): CardRenderMode {
    const user = isUserCardStyleMode(opts.user) ? opts.user : 'all';
    const server = isServerMessageStyles(opts.server) ? opts.server : 'on';
    if (opts.showPlain || user === 'plain' || server === 'off') return 'plain';
    if (opts.reducedMotion || user === 'static' || server === 'no_animation') return 'static';
    return 'full';
}

// ── Contrast + render resolution ────────────────────────────────────────────

function lin(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(rgb: readonly [number, number, number]): number {
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG contrast ratio between two OPAQUE colours. */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

function over(fg: [number, number, number, number], bg: readonly [number, number, number]): [number, number, number] {
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}


export interface CardTheme {
    /** The row background the card sits on (any accepted literal colour; must be opaque). */
    background: string;
    /** The app's normal message text colour on that background. */
    text: string;
    /** What each theme colour means in this theme (literal colours). */
    tokens: Readonly<Record<CardThemeToken, string>>;
}

/**
 * The built-in themes, for any client that has no design tokens of its own
 * (a bot's preview, a test). `dark` is the desktop's "glow in the deep"
 * palette (index.css); `light` is the reference light palette. Each token is
 * readable as text on its theme's background. Reserved-look matching
 * (`nearToken`) checks a literal colour against every theme here.
 */
export const CARD_THEMES: Readonly<Record<'dark' | 'light', CardTheme>> = {
    dark: {
        background: '#0b0f1e',
        text: '#f4f7ff',
        tokens: { accent: '#25e0c8', success: '#4ade80', warning: '#ffc94d', danger: '#ff6b5e', info: '#5e8ee0', muted: '#a7b3d4' },
    },
    light: {
        background: '#f6f8fc',
        text: '#0b1430',
        tokens: { accent: '#0a6b60', success: '#166534', warning: '#8a4b05', danger: '#b42318', info: '#1d4ed8', muted: '#4b5568' },
    },
};

export interface ResolvedCardStyle {
    /** A concrete CSS colour for background-color (solid backgrounds). */
    backgroundColor?: string;
    /** Concrete CSS gradient layer(s) for background-image (comma-separated when layered). */
    backgroundImage?: string;
    /** background-clip / background-origin for layered images (the gradient border technique). */
    backgroundClip?: string;
    /** [top, right, bottom, left] px. */
    borderWidth?: CardSides<number>;
    borderStyle?: CardBorderStyle;
    /** [top, right, bottom, left]; 'transparent' everywhere for a gradient border. */
    borderColor?: CardSides<string>;
    /** [top-left, top-right, bottom-right, bottom-left] px. */
    radius: [number, number, number, number];
    /** [vertical, horizontal] px (the stripe's width is added on the left by the renderer). */
    padding: readonly [number, number];
    /** A CSS box-shadow list (outer only). */
    boxShadow?: string;
    /** A dimmer version, for the pulse keyframes. */
    boxShadowDim?: string;
    /**
     * How far the shadows paint outside the card, per side, in px, capped at
     * CARD_SHADOW_REACH_MAX. The renderer reserves exactly this much room
     * around the card inside the message row and clips paint there, so a
     * shadow can never bleed onto the next row (or the previous one).
     */
    shadowReach?: { top: number; right: number; bottom: number; left: number };
    /** The accent stripe with a concrete colour. */
    stripe?: { width: number; color: string };
    /**
     * The text colour to use inside the card, when it is not the app's normal
     * one: the sender's (kept above CARD_TEXT_FLOOR), or one the app picked
     * so the text stays readable on this background. When set, the renderer
     * also derives link / code / mention / quote / spoiler colours from it.
     */
    textColor?: string;
    /** text-shadow for the text glow. */
    textShadow?: string;
    align?: CardAlign;
    headingAlign?: CardAlign;
    letterSpacing?: number;
    /**
     * True when the app must draw its own hairline edge: the sender's border
     * is absent or too faint to see. Every styled card keeps a visible
     * boundary marking it as user content; the sender cannot remove it.
     */
    edge: boolean;
    animation?: CardAnimation;
    /** What the app changed and why (the editor explains these to the author). */
    notes: {
        /** The sender's text colour was below the floor and was nudged. */
        textAdjusted?: { ratio: number; to: string };
        /** No text colour can read on this background, so it was dropped. */
        backgroundDropped?: boolean;
        /** The app picked the text colour because its default would be unreadable here. */
        autoText?: boolean;
    };
}

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const cssColor = (c: Rgba): string => {
    const r = Math.round(c[0]);
    const g = Math.round(c[1]);
    const b = Math.round(c[2]);
    const a = Math.round(c[3] * 1000) / 1000;
    return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
};

function rc(c: CardColor, theme: CardTheme, alphaMul = 1): Rgba {
    const v = resolveCardColor(c, theme) ?? [0, 0, 0, 0];
    return [v[0], v[1], v[2], v[3] * alphaMul];
}

/** Every colour the text has to be readable on: the stops, plus sampled points between them. */
function backgroundSamples(bg: CardBackground | undefined, base: Rgb, theme: CardTheme, opacity: number): Rgb[] {
    if (!bg) return [base];
    if (bg.type === 'solid') return [over(rc(bg.color, theme, opacity), base)];
    const out: Rgb[] = [];
    const cs = bg.stops.map(s => rc(s.color, theme, opacity));
    for (let i = 0; i < cs.length; i++) {
        out.push(over(cs[i], base));
        if (i + 1 < cs.length) {
            // Luminance along a segment can dip below both ends: sample it.
            for (let k = 1; k < 8; k++) {
                const t = k / 8;
                const a = cs[i];
                const b = cs[i + 1];
                out.push(over([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t], base));
            }
        }
    }
    return out;
}

function worstContrast(text: Rgba, samples: Rgb[]): number {
    let worst = Infinity;
    for (const s of samples) worst = Math.min(worst, contrastRatio(over(text, s), s));
    return worst;
}

const AUTO_TEXT: readonly Rgba[] = [[244, 247, 255, 1], [11, 15, 30, 1]];

/** Nudge a colour toward white or black until it clears `floor` on every sample; null if neither direction can. */
function nudge(c: Rgba, samples: Rgb[], floor: number): Rgba | null {
    const opaque: Rgba = [c[0], c[1], c[2], 1];
    for (let step = 1; step <= 20; step++) {
        const t = step / 20;
        for (const target of [[255, 255, 255], [0, 0, 0]] as Rgb[]) {
            const m: Rgba = [opaque[0] + (target[0] - opaque[0]) * t, opaque[1] + (target[1] - opaque[1]) * t, opaque[2] + (target[2] - opaque[2]) * t, 1];
            if (worstContrast(m, samples) >= floor) return m;
        }
    }
    return null;
}

function gradientCss(type: CardBackground['type'], angleOrShape: number | string, stops: CardGradientStop[], theme: CardTheme, alphaMul: number): string {
    const s = stops.map(x => `${cssColor(rc(x.color, theme, alphaMul))} ${x.at}%`).join(', ');
    return typeof angleOrShape === 'number' ? `${type}-gradient(${angleOrShape}deg, ${s})` : `${type}-gradient(${angleOrShape}, ${s})`;
}

/** Paint reserved around a card for its shadows is capped here (px per side); beyond it the renderer clips. */
export const CARD_SHADOW_REACH_MAX = 28; // = the largest legal reach (8 offset + 16 blur + 4 spread): never visibly cut

/** How far the shadows paint beyond the card on each side (blur + spread, shifted by the offset), capped. */
export function shadowReach(list: CardShadow[]): { top: number; right: number; bottom: number; left: number } {
    let top = 0, right = 0, bottom = 0, left = 0;
    for (const sh of list) {
        const r = sh.blur + sh.spread;
        top = Math.max(top, r - sh.y);
        bottom = Math.max(bottom, r + sh.y);
        left = Math.max(left, r - sh.x);
        right = Math.max(right, r + sh.x);
    }
    const c = (n: number) => Math.min(CARD_SHADOW_REACH_MAX, Math.max(0, Math.ceil(n)));
    return { top: c(top), right: c(right), bottom: c(bottom), left: c(left) };
}

function shadowsCss(list: CardShadow[], theme: CardTheme, dim = false): string {
    return list.map(s => {
        const c = rc(s.color, theme, dim ? 0.45 : 1);
        const blur = dim ? Math.round(s.blur * 0.6) : s.blur;
        return `${s.x}px ${s.y}px ${blur}px ${s.spread}px ${cssColor(c)}`;
    }).join(', ');
}

/**
 * What to draw for a validated style, in a mode, on the VIEWER's theme: pure
 * data a thin renderer turns into inline styles. Every colour in the result
 * is concrete (theme colours already resolved); nothing in it is a `var()`.
 * Null when nothing should be drawn (no style, or plain mode).
 *
 * Readability, on the resolved colours of this theme:
 *  - the sender's text colour is used as chosen at or above CARD_TEXT_FLOOR
 *    against every part of the background (stops and points between them);
 *    below it, it is nudged toward white or black until it clears the floor
 *    (`notes.textAdjusted`);
 *  - with no sender colour, the app's text must reach CARD_MIN_CONTRAST, or
 *    the app picks a light or dark text that does (`notes.autoText`);
 *  - a background no text colour can read on (black-to-white) is dropped.
 */
export function resolveCardStyle(style: CardStyle | null | undefined, mode: CardRenderMode, theme: CardTheme = CARD_THEMES.dark): ResolvedCardStyle | null {
    const s = style ? normalizeCardStyle(style) : null;
    if (!s || mode === 'plain') return null;
    const baseC = cardColorRgba(parseCardColor(theme.background) ?? '#0b0f1e') ?? [11, 15, 30, 1];
    const base: Rgb = [baseC[0], baseC[1], baseC[2]];
    const themeText: Rgba = cardColorRgba(parseCardColor(theme.text) ?? '#f4f7ff') ?? [244, 247, 255, 1];
    const notes: ResolvedCardStyle['notes'] = {};
    const opacity = (s.backgroundOpacity ?? 100) / 100;

    let background = s.background;
    let samples = backgroundSamples(background, base, theme, opacity);
    const senderText = s.text ? rc(s.text, theme) : null;
    const pickText = (): Rgba | null | undefined => {
        // undefined = the app's own text is fine; null = nothing readable.
        if (senderText) {
            const r = worstContrast(senderText, samples);
            if (r >= CARD_TEXT_FLOOR) return senderText;
            const n = nudge(senderText, samples, CARD_TEXT_FLOOR);
            if (n) { notes.textAdjusted = { ratio: Math.round(r * 100) / 100, to: cssColor(n) }; return n; }
        }
        if (worstContrast(themeText, samples) >= CARD_MIN_CONTRAST) return undefined;
        const auto = AUTO_TEXT.find(c => worstContrast(c, samples) >= CARD_MIN_CONTRAST);
        if (auto) { notes.autoText = true; return auto; }
        return null;
    };
    let fg = pickText();
    if (fg === null) {
        background = undefined;
        notes.backgroundDropped = true;
        delete notes.textAdjusted;
        delete notes.autoText;
        samples = [base];
        fg = pickText() ?? undefined;
    }

    const radius: [number, number, number, number] = s.radius === undefined
        ? [CARD_DEFAULTS.radius, CARD_DEFAULTS.radius, CARD_DEFAULTS.radius, CARD_DEFAULTS.radius]
        : Array.isArray(s.radius) ? [...s.radius] as [number, number, number, number] : [s.radius, s.radius, s.radius, s.radius];
    const out: ResolvedCardStyle = {
        radius,
        padding: CARD_PADDING_PX[s.padding ?? CARD_DEFAULTS.padding],
        edge: true,
        notes,
    };
    // Background layer(s).
    let bgLayer: string | undefined;
    if (background?.type === 'solid') {
        const c = cssColor(rc(background.color, theme, opacity));
        out.backgroundColor = c;
        bgLayer = `linear-gradient(${c}, ${c})`;
    } else if (background) {
        bgLayer = gradientCss(background.type, 'angle' in background ? background.angle : background.shape, background.stops, theme, opacity);
        out.backgroundImage = bgLayer;
    }
    const b = s.border;
    if (b) {
        if ('gradient' in b) {
            // Gradient border: the border is transparent and a border-box
            // gradient shows through it; the padding box is painted over it
            // with the card's background on an opaque row-colour layer.
            const w = b.width;
            out.borderWidth = [w, w, w, w];
            out.borderStyle = 'solid';
            out.borderColor = ['transparent', 'transparent', 'transparent', 'transparent'];
            const rowLayer = `linear-gradient(${cssColor([base[0], base[1], base[2], 1])}, ${cssColor([base[0], base[1], base[2], 1])})`;
            const ring = gradientCss('linear', b.gradient.angle, b.gradient.stops, theme, 1);
            const layers = [...(bgLayer ? [bgLayer] : []), rowLayer, ring];
            out.backgroundImage = layers.join(', ');
            out.backgroundClip = [...(bgLayer ? ['padding-box'] : []), 'padding-box', 'border-box'].join(', ');
            delete out.backgroundColor;
            const avgA = b.gradient.stops.reduce((a, st) => a + rc(st.color, theme)[3], 0) / b.gradient.stops.length;
            out.edge = !(avgA >= 0.2);
        } else {
            const widths = (Array.isArray(b.width) ? b.width : [b.width, b.width, b.width, b.width]) as CardSides<number>;
            const colours = (Array.isArray(b.color) ? b.color : [b.color, b.color, b.color, b.color]).map(c => rc(c, theme));
            out.borderWidth = [...widths] as CardSides<number>;
            out.borderStyle = b.style;
            out.borderColor = colours.map(cssColor) as CardSides<string>;
            // A border the eye can find (opaque enough, and not the row
            // colour) on at least two sides is boundary enough; otherwise the
            // app draws its own hairline.
            const visible = colours.filter((c, i) => widths[i] > 0 && c[3] >= 0.2 && contrastRatio(over(c, base), base) >= 1.4).length;
            out.edge = visible < 2;
        }
    }
    if (s.shadows) {
        out.boxShadow = shadowsCss(s.shadows, theme);
        out.boxShadowDim = shadowsCss(s.shadows, theme, true);
        out.shadowReach = shadowReach(s.shadows);
    }
    if (s.stripe) out.stripe = { width: s.stripe.width, color: cssColor(rc(s.stripe.color, theme)) };
    if (fg) out.textColor = cssColor(fg);
    if (s.textGlow) out.textShadow = `0 0 ${s.textGlow.blur}px ${cssColor(rc(s.textGlow.color, theme))}`;
    if (s.align) out.align = s.align;
    if (s.headingAlign) out.headingAlign = s.headingAlign;
    if (s.letterSpacing !== undefined) out.letterSpacing = s.letterSpacing;
    if (mode === 'full' && s.animation) {
        const a = s.animation;
        const stillValid = a.name === 'shimmer' || (a.name === 'drift' && !!(background && background.type !== 'solid')) || (a.name === 'pulse' && !!out.boxShadow);
        if (stillValid) out.animation = { ...a };
    }
    return out;
}
