/**
 * Centralised helpers for translating server role data into UI-ready forms.
 *
 * Three concerns colocated here so every consumer agrees on the answers:
 *   - "What hex string corresponds to this packed-int role.color?"
 *   - "Which role determines this member's name colour?" (highest-position
 *     role with a real colour they're assigned to)
 *   - "Which role determines where this member groups in the member list?"
 *     (highest-position role they're assigned to that has hoisted: true)
 *
 * Before this module the answers were spread across four files and three
 * different (one buggy) hex formatters. The bug: omitting `>>> 0` on a
 * negative role.color (i.e. -1, our "no colour" sentinel) coerced it into
 * `#ffffff…ff` instead of being treated as nullish.
 */

export interface RoleLite {
    role_id: string;
    name: string;
    color: number;        // 24-bit packed RGB; -1 = no colour
    position: number;     // higher = higher priority (Discord semantics)
    is_everyone: boolean;
    hoisted: boolean;     // whether this role creates a separate member-list section
}

/**
 * Convert the packed 32-bit role.color int into `#rrggbb`.
 * Returns `null` for the -1 "no colour assigned" sentinel.
 *
 * `>>> 0` reinterprets the signed int as unsigned (otherwise toString(16) on
 * a negative number returns a `-` prefixed hex). `& 0xffffff` then masks off
 * the alpha byte if the source ever leaked one (defence in depth).
 */
export function roleColorHexFromInt(c: number): string | null {
    if (c === -1) return null;
    return `#${((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The role that drives a member's name colour: highest-position role they
 * hold that has a real colour (i.e. not `-1`). `@everyone` is excluded
 * because its colour is by convention untracked.
 *
 * Returns the role record (caller can read .color, .name, etc.) or null.
 */
export function getTopColoredRole<R extends RoleLite>(
    roleIds: string[],
    roles: R[],
): R | null {
    let best: R | null = null;
    for (const r of roles) {
        if (r.is_everyone) continue;
        if (r.color === -1) continue;
        if (!roleIds.includes(r.role_id)) continue;
        if (!best || r.position > best.position) best = r;
    }
    return best;
}

/** Convenience: hex of {@link getTopColoredRole}, or null. */
export function getHighestRoleColor<R extends RoleLite>(
    roleIds: string[],
    roles: R[],
): string | null {
    const top = getTopColoredRole(roleIds, roles);
    return top ? roleColorHexFromInt(top.color) : null;
}

/**
 * The role that drives member ordering in the panel: highest-position role
 * they hold (regardless of colour or hoisting). Useful for priority checks.
 *
 * Returns the role or null if the member only has `@everyone`.
 */
export function getTopRole<R extends RoleLite>(
    roleIds: string[],
    roles: R[],
): R | null {
    let best: R | null = null;
    for (const r of roles) {
        if (r.is_everyone) continue;
        if (!roleIds.includes(r.role_id)) continue;
        if (!best || r.position > best.position) best = r;
    }
    return best;
}

/**
 * The role that determines which section a member appears in on the right
 * panel: highest-position role they hold that has `hoisted: true`.
 *
 * If the member's top role is not hoisted, we walk down until we find one
 * that is. Members with no hoisted role go in the generic "Members" bucket.
 */
export function getTopHoistedRole<R extends RoleLite>(
    roleIds: string[],
    roles: R[],
): R | null {
    let best: R | null = null;
    for (const r of roles) {
        if (r.is_everyone) continue;
        if (!r.hoisted) continue;
        if (!roleIds.includes(r.role_id)) continue;
        if (!best || r.position > best.position) best = r;
    }
    return best;
}

/** Convenience numeric form of {@link getTopRole}. -Infinity if no role. */
export function getHighestRolePosition<R extends RoleLite>(
    roleIds: string[],
    roles: R[],
): number {
    const top = getTopRole(roleIds, roles);
    return top ? top.position : -Infinity;
}

/* ---------------------------------------------------------------------- *
 * Contrast helpers — role colours are user-chosen and unconstrained, so a
 * dark/near-black pick is unreadable rendered as text on a dark background
 * (e.g. the roles dropdown). These give a WCAG-ish floor without touching
 * colours that already read fine.
 * ---------------------------------------------------------------------- */

function hexToRgb01(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function srgbToLinear(c: number): number {
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a `#rrggbb` colour: 0 (black) .. 1 (white). */
export function relativeLuminance(hex: string): number {
    const [r, g, b] = hexToRgb01(hex);
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours: 1 (none) .. 21 (max). */
export function contrastRatio(hexA: string, hexB: string): number {
    const la = relativeLuminance(hexA);
    const lb = relativeLuminance(hexB);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hNorm = h / 360;
    return [
        hueToRgb(p, q, hNorm + 1 / 3),
        hueToRgb(p, q, hNorm),
        hueToRgb(p, q, hNorm - 1 / 3),
    ];
}

function rgb01ToHex(r: number, g: number, b: number): string {
    const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * The dropdown menu's background (cl-kit's `--deep`, #131A30). Hardcoded
 * rather than read from a CSS custom property because this is a pure,
 * unit-testable function that runs outside component render — keep in sync
 * if `--deep` ever changes.
 */
export const CL_KIT_DEEP_BG_HEX = '#131A30';

/**
 * Lightens a role colour just enough to clear a minimum WCAG contrast ratio
 * against a dark background, preserving hue and saturation so it still
 * reads as "that role's colour" rather than snapping to a generic light
 * grey. Colours that already clear `minRatio` pass through unchanged.
 *
 * `minRatio` defaults to 4.5:1 (WCAG AA for normal-size text) and `bgHex`
 * defaults to the roles dropdown's background.
 *
 * Returns `null` unchanged for "no colour assigned" — callers should fall
 * back to the normal UI text colour, not render a null colour as black.
 */
export function readableRoleColorHex(
    hex: string | null,
    minRatio = 4.5,
    bgHex: string = CL_KIT_DEEP_BG_HEX,
): string | null {
    if (!hex) return null;
    if (contrastRatio(hex, bgHex) >= minRatio) return hex;

    const [r, g, b] = hexToRgb01(hex);
    const [h, s] = rgbToHsl(r, g, b);

    // HSL lightness -> relative luminance is monotonic for a fixed hue/sat
    // (raising L walks steadily toward white), so binary search converges
    // on the minimum lightness that clears the ratio.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const [nr, ng, nb] = hslToRgb(h, s, mid);
        if (contrastRatio(rgb01ToHex(nr, ng, nb), bgHex) < minRatio) lo = mid; else hi = mid;
    }
    const [fr, fg, fb] = hslToRgb(h, s, hi);
    return rgb01ToHex(fr, fg, fb);
}
