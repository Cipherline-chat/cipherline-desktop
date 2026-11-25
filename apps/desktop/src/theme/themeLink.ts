/**
 * Theme LINKS: a custom theme shared as a URL.
 *
 *   https://cipherline.chat/theme#clth1.<base64url JSON>
 *   cipherline://theme#clth1.<base64url JSON>          (opens the desktop app)
 *
 * The theme lives in the URL FRAGMENT. Browsers never send a fragment to a
 * server (not in the request line, not in Referer), so opening the link in a
 * browser asks cipherline.chat for a static `/theme` page and nothing else;
 * the page reads the fragment on the device (apps/website ThemeLinkPage). In
 * Cipherline the link travels inside an ordinary E2EE text message, and the
 * chat renders a card for it (components/themeShare/ThemeLinkEmbed) — no
 * fetch of any kind, ever.
 *
 * What is inside is exactly a `clth1.` share code (customTheme.ts), so a link
 * is decoded with the SAME validator and readability guard as a pasted code:
 * colours only (literal hex / rgb / hsl, alpha dropped), a cleaned and capped
 * name, a size cap, the readability nudge. A link carries data, never CSS.
 *
 * Pure: no DOM, no React, no storage. Imported by the desktop app AND by the
 * website (apps/website/vite.config.ts `@app-theme` alias), so keep it free of
 * Electron- or app-only imports.
 *
 * Typical length: 336-351 characters for the presets, ~380 with a 40-letter
 * name, ~545 at the worst case (a 40-emoji name). Every valid code is far
 * below THEME_LINK_CODE_MAX.
 */
import { CUSTOM_THEME_KNOBS, CUSTOM_THEME_SHARE_PREFIX, decodeShareCode, encodeShareCode, type CustomThemeDef, type NormalizeResult } from './customTheme';

export const THEME_LINK_ORIGIN = 'https://cipherline.chat';
export const THEME_LINK_PATH = '/theme';
/** `https://cipherline.chat/theme#` — a link is this + a share code. */
export const THEME_LINK_BASE = `${THEME_LINK_ORIGIN}${THEME_LINK_PATH}#`;
export const THEME_DEEP_LINK_BASE = 'cipherline://theme#';
/**
 * The longest share code a LINK may carry. A normalised theme encodes to at
 * most ~520 characters (40 four-byte code points in the name); anything far
 * above that is not one of ours and is refused before it is decoded.
 */
export const THEME_LINK_CODE_MAX = 1024;

/** `clth1.` + base64url: the only fragment a theme link can carry. */
const CODE_RE = /^clth1\.[A-Za-z0-9_-]+$/;
/** A theme URL, fragment and all (host case-insensitive, apex only like invite links, optional trailing slash before `#`). */
const THEME_URL_RE = /^https?:\/\/cipherline\.chat\/theme\/?#(.*)$/i;
/** Same host + path + a fragment, readable or not (the bare page `…/theme` is just a link to the website). */
const THEME_URL_ANY_RE = /^https?:\/\/cipherline\.chat\/theme\/?#/i;

/** The share link for a theme. */
export function buildThemeLink(def: CustomThemeDef): string {
    return THEME_LINK_BASE + encodeShareCode(def);
}

/** The app deep link for a share code (the website's "Open in Cipherline"). Null for anything that is not a code. */
export function buildThemeDeepLink(code: string): string | null {
    return isThemeCodeShape(code) ? THEME_DEEP_LINK_BASE + code : null;
}

/** Shape only (prefix, base64url, length cap) — NOT validation; decode for that. */
export function isThemeCodeShape(code: unknown): code is string {
    return typeof code === 'string' && code.length <= THEME_LINK_CODE_MAX && CODE_RE.test(code);
}

/** A URL fragment (`#clth1.…`, with or without the `#`) -> the share code, or null. */
export function themeCodeFromFragment(hash: unknown): string | null {
    if (typeof hash !== 'string') return null;
    let s = hash.startsWith('#') ? hash.slice(1) : hash;
    // Some apps percent-encode the fragment when they hand a link on; base64url never needs it.
    if (s.includes('%')) {
        try { s = decodeURIComponent(s); } catch { return null; }
    }
    s = s.trim();
    return isThemeCodeShape(s) ? s : null;
}

/** Is `url` a theme link (`https://cipherline.chat/theme#…`) at all, readable or not? */
export function isThemeLinkUrl(url: unknown): boolean {
    // Recognised at any length (an oversized one is the "can't be read" card); the prefix test is anchored and cheap.
    return typeof url === 'string' && THEME_URL_ANY_RE.test(url);
}

/** A theme link -> its share code (shape-checked), or null. */
export function themeCodeFromLink(url: unknown): string | null {
    if (typeof url !== 'string' || url.length > THEME_LINK_CODE_MAX + 64) return null;
    const m = THEME_URL_RE.exec(url);
    return m ? themeCodeFromFragment(m[1]) : null;
}

export type ThemeLinkParse =
    | { kind: 'none' }
    | { kind: 'invalid' }
    | { kind: 'ok'; code: string; result: Extract<NormalizeResult, { ok: true }> };

/**
 * What a URL in a message is, for the chat card: not a theme link at all; a
 * theme link that can't be read (bad fragment, refused by the validator); or
 * a valid theme, already validated (colours exactly as shared).
 */
export function parseThemeLink(url: unknown): ThemeLinkParse {
    if (!isThemeLinkUrl(url)) return { kind: 'none' };
    const code = themeCodeFromLink(url);
    if (!code) return { kind: 'invalid' };
    const result = decodeShareCode(code);
    return result.ok ? { kind: 'ok', code, result } : { kind: 'invalid' };
}

/** `cipherline://theme#clth1.…` -> the share code (shape-checked), or null. */
export function themeCodeFromDeepLink(url: unknown): string | null {
    if (typeof url !== 'string' || url.length > THEME_DEEP_LINK_BASE.length + THEME_LINK_CODE_MAX) return null;
    const m = /^cipherline:\/\/theme\/?#(.*)$/i.exec(url);
    return m ? themeCodeFromFragment(m[1]) : null;
}

/** The message text a "Send to a friend" sends: the optional note, then the link on its own line. */
export function themeShareMessage(def: CustomThemeDef, note?: string): string {
    const link = buildThemeLink(def);
    const n = (note ?? '').trim();
    return n ? `${n}\n${link}` : link;
}

const LABEL_MEMO = new Map<string, string>();
const LABEL_MEMO_MAX = 100;
/** Every bare theme link in a run of text (previews). */
const THEME_LINK_IN_TEXT = /https?:\/\/cipherline\.chat\/theme\/?#clth1\.[A-Za-z0-9_-]+/gi;

/** "Theme: Ocean" for a valid theme link, "Theme link" for one that can't be read. Memoised. */
export function themeLinkLabel(url: string): string {
    const hit = LABEL_MEMO.get(url);
    if (hit !== undefined) return hit;
    const p = parseThemeLink(url);
    const label = p.kind === 'ok' ? `Theme: ${p.result.def.name}` : 'Theme link';
    LABEL_MEMO.set(url, label);
    if (LABEL_MEMO.size > LABEL_MEMO_MAX) LABEL_MEMO.delete(LABEL_MEMO.keys().next().value as string);
    return label;
}

/**
 * Plain-text previews (notifications, the conversation list, reply quotes):
 * a ~350-character theme link reads as "Theme: Ocean" instead.
 */
export function labelThemeLinks(text: string): string {
    if (!/cipherline\.chat\/theme/i.test(text)) return text;
    return text.replace(THEME_LINK_IN_TEXT, (m) => themeLinkLabel(m));
}

/** Same look (base, glow, every colour; the name is ignored): "already in your themes". */
export function sameThemeLook(a: CustomThemeDef, b: CustomThemeDef): boolean {
    return a.base === b.base && a.glow === b.glow && CUSTOM_THEME_KNOBS.every((k) => a.colors[k].toLowerCase() === b.colors[k].toLowerCase());
}

/** The swatches a theme card shows, in order. */
export const THEME_CARD_SWATCHES = ['bg', 'panel', 'surface', 'text', 'accent', 'danger'] as const;

/** Prefix re-exported for callers that only need to recognise a pasted code. */
export { CUSTOM_THEME_SHARE_PREFIX };
