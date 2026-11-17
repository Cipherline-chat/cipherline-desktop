/**
 * Channel-list layout: sub-categories and decorative dividers.
 *
 * ONE set of rules, two consumers: the API validates every divider / sub-
 * category write against these (the only load-bearing check), and the desktop
 * runs the identical functions for inline feedback in its forms. A client that
 * skips the mirror just gets the server's 400.
 *
 * Sub-categories are ordinary `channel_categories` rows with a
 * `parent_category_id` (exactly ONE level: a sub-category's parent is always a
 * top-level category). Dividers are their own table; they carry no
 * permissions and no content, only how they look.
 */
import { displayNameError } from './display-name';

/**
 * How a divider draws. The LABEL styles (`label`, `header`, `pill`, `text`)
 * are the only ones that show text or a colour; the label renders exactly as
 * typed (no automatic decoration). `label` = centred between two fading rules,
 * `header` = left-aligned with one rule running to the right edge, `pill` =
 * label in a capsule on a centred rule, `text` = tinted text only, no rule.
 *
 * `header` / `pill` / `text` need channel_dividers_style_chk widened
 * (migrations/sql/20261116-channel-divider-styles-and-calls.sql) before the API accepts
 * them in production.
 */
export const DIVIDER_STYLES = ['label', 'header', 'pill', 'text', 'line', 'dots', 'space'] as const;
export type DividerStyle = typeof DIVIDER_STYLES[number];

export function isDividerStyle(v: unknown): v is DividerStyle {
    return typeof v === 'string' && (DIVIDER_STYLES as readonly string[]).includes(v);
}

/** Styles that carry a label and a colour. */
export const DIVIDER_LABEL_STYLES: readonly DividerStyle[] = ['label', 'header', 'pill', 'text'];

export function isLabelDividerStyle(v: unknown): boolean {
    return typeof v === 'string' && (DIVIDER_LABEL_STYLES as readonly string[]).includes(v);
}

/** The two channel lists a divider can sit in: the text list, or the Calls panel. */
export const DIVIDER_LIST_KINDS = ['text', 'calls'] as const;
export type DividerListKind = typeof DIVIDER_LIST_KINDS[number];

export function isDividerListKind(v: unknown): v is DividerListKind {
    return typeof v === 'string' && (DIVIDER_LIST_KINDS as readonly string[]).includes(v);
}

/** The list a category of this `kind` ('text' | 'huddle') belongs to. */
export function listKindOfCategoryKind(kind: string): DividerListKind {
    return kind === 'huddle' ? 'calls' : 'text';
}

/** Longest divider label, in characters (after trimming). */
export const DIVIDER_LABEL_MAX = 32;

/**
 * Divider labels follow the shared display-name rule (letters, digits,
 * punctuation, symbols and emoji sequences; no control, invisible or
 * blank-looking characters), capped at `DIVIDER_LABEL_MAX`. Clients render it
 * as a text node, never HTML. The database CHECK counts code
 * points (`char_length(label) <= 32`), so the cap is applied in code points
 * as well as grapheme clusters: a 32-grapheme run of ZWJ emoji would otherwise
 * pass the rule and then violate the CHECK.
 */
export function dividerLabelError(v: unknown): string | null {
    if (typeof v !== 'string') return 'label must be text';
    const t = v.trim();
    if (Array.from(t).length > DIVIDER_LABEL_MAX) return `label must be at most ${DIVIDER_LABEL_MAX} characters`;
    return displayNameError(t, { maxGraphemes: DIVIDER_LABEL_MAX });
}

export function isValidDividerLabel(v: unknown): v is string {
    return dividerLabelError(v) === null;
}

/**
 * The divider colour palette, drawn from the "glow in the deep" tokens. The
 * first entry (Glow gold) is the default a labelled divider uses when no
 * colour is stored. Any other `#rrggbb` is accepted too (the custom picker);
 * nothing that is not a 6-digit hex ever reaches the database, so a stored
 * colour can only ever be used as a colour.
 */
export const DIVIDER_COLOR_PRESETS: readonly string[] = [
    '#ffc94d', // Glow (default)
    '#25e0c8', // Lume
    '#ff6b5e', // Flash
    '#4ade80', // Ok
    '#5e8ee0',
    '#a78bfa',
    '#ff8fb1',
    '#9aa6c8', // muted
];
export const DIVIDER_DEFAULT_COLOR = '#ffc94d';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Strict `#rrggbb`. Returns the lower-cased colour, or null when invalid. */
export function normalizeDividerColor(v: unknown): string | null {
    if (typeof v !== 'string' || !HEX6.test(v)) return null;
    return v.toLowerCase();
}

/**
 * Emoji shown on a divider or before a sub-category's name: one emoji
 * (including ZWJ sequences, skin tones, keycaps and flags), at most 16 UTF-16
 * code units. Pictographs and the joiners/selectors they are built from only,
 * so it cannot smuggle text.
 */
export const LAYOUT_EMOJI_MAX = 16;
// Built on first use with `new RegExp` rather than as literals: this module is
// part of the package index every consumer evaluates, and a JS engine without
// Unicode property escapes would otherwise fail to PARSE the whole package.
let emojiRes: { all: RegExp; picto: RegExp } | null = null;
function emojiRegexes() {
    emojiRes ??= {
        all: new RegExp('^[\\p{Extended_Pictographic}\\p{Emoji_Component}\\p{Regional_Indicator}\\u200D\\uFE0F\\u20E3]+$', 'u'),
        picto: new RegExp('[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3]', 'u'),
    };
    return emojiRes;
}

export function isValidLayoutEmoji(v: unknown): v is string {
    if (typeof v !== 'string' || v.length < 1 || v.length > LAYOUT_EMOJI_MAX) return false;
    const re = emojiRegexes();
    return re.all.test(v) && re.picto.test(v);
}

/** Most dividers one server may hold (a sidebar decoration, not content). */
export const MAX_DIVIDERS_PER_SERVER = 100;

// ── Item order within one container ─────────────────────────────────────────
//
// A CONTAINER is the top of the list (`null`), a top-level category, or a
// sub-category. Its items - channels, dividers and (inside a top-level
// category only) sub-categories - share ONE `position` space and are drawn in
// `compareLayoutItems` order. Top-level categories keep their own ordering and
// always come after the top-of-list items, exactly as before sub-categories.

export type LayoutItemKind = 'channel' | 'subcategory' | 'divider';
export const LAYOUT_ITEM_KINDS: readonly LayoutItemKind[] = ['channel', 'subcategory', 'divider'];

const KIND_RANK: Record<LayoutItemKind, number> = { channel: 0, subcategory: 1, divider: 2 };

/**
 * Display order of two items in the same container: position, then kind
 * (ties only happen when an OLD client renumbered just the channels), then id
 * so the order is total and identical on every client and the server.
 */
export function compareLayoutItems(
    a: { kind: LayoutItemKind; id: string; position: number },
    b: { kind: LayoutItemKind; id: string; position: number },
): number {
    if (a.position !== b.position) return a.position - b.position;
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
