/**
 * Custom status — the pure half: the "Clear after" options and their expiry,
 * what a stored status currently is, the emoji slot, the dialog's draft rules,
 * and the one decision every surface shares: what a person's status line shows
 * when they have a custom status, a game, both or neither.
 *
 * The server enforces all of this independently (expiry is applied on every
 * read there); the client mirrors it for UX only and has no load-bearing check.
 */

import { isNameAllowed } from '@cipherline/shared';
import type { FriendStatusEntry } from './userStatusModel';

/** Mirrors the API's DTO limit (apps/api/src/gateway/custom-status.ts). */
export const CUSTOM_STATUS_TEXT_MAX = 100;

// ── Clear after ──────────────────────────────────────────────────────────────

export type ClearAfter = 'never' | '30m' | '1h' | '4h' | 'today';
/** `keep` only exists in the dialog, for a status that already has an expiry. */
export type ClearAfterChoice = ClearAfter | 'keep';

export const CLEAR_AFTER_OPTIONS: ReadonlyArray<{ id: ClearAfter; label: string }> = [
    { id: 'never', label: "Don't clear" },
    { id: '30m', label: '30 minutes' },
    { id: '1h', label: '1 hour' },
    { id: '4h', label: '4 hours' },
    { id: 'today', label: 'Today' },
];

const MINUTE = 60_000;

/**
 * The instant (ISO, UTC) the status should clear, or null for "don't clear".
 * "Today" is the end of the viewer's LOCAL day, so the server never needs the
 * time zone; it only sees an absolute instant and checks it is in the future.
 */
export function expiresAtFor(option: ClearAfter, now: Date = new Date()): string | null {
    switch (option) {
        case 'never': return null;
        case '30m': return new Date(now.getTime() + 30 * MINUTE).toISOString();
        case '1h': return new Date(now.getTime() + 60 * MINUTE).toISOString();
        case '4h': return new Date(now.getTime() + 240 * MINUTE).toISOString();
        case 'today': {
            const end = new Date(now);
            end.setHours(23, 59, 59, 999);
            return end.toISOString();
        }
    }
}

// ── What a stored status currently is ────────────────────────────────────────

export interface ActiveCustom {
    text: string | null;
    emoji: string | null;
    expiresAt: string | null;
}

/** The status while it has not expired; null when there is nothing to show. */
export function activeCustom(
    text: string | null | undefined,
    emoji: string | null | undefined,
    expiresAt: string | null | undefined,
    now: number = Date.now(),
): ActiveCustom | null {
    const t = text && text.length > 0 ? text : null;
    const e = emoji && emoji.length > 0 ? emoji : null;
    if (t === null && e === null) return null;
    if (expiresAt) {
        const ms = Date.parse(expiresAt);
        if (!Number.isNaN(ms) && ms <= now) return null;
    }
    return { text: t, emoji: e, expiresAt: expiresAt ?? null };
}

/** Earliest future expiry among the entries (ms), for one re-render timer. */
export function nextCustomExpiry(
    entries: Iterable<{ custom_status_expires_at?: string | null }>,
    now: number = Date.now(),
): number | null {
    let next: number | null = null;
    for (const e of entries) {
        if (!e.custom_status_expires_at) continue;
        const ms = Date.parse(e.custom_status_expires_at);
        if (Number.isNaN(ms) || ms <= now) continue;
        if (next === null || ms < next) next = ms;
    }
    return next;
}

// ── The emoji slot ───────────────────────────────────────────────────────────

/**
 * The status emoji is a STRING so it can grow: a unicode emoji, or a personal
 * custom emoji as a reference with the `cl:` prefix (`cl:p_<32 hex>`), rendered
 * through the `renderCustom` prop of `StatusEmoji`. Without a renderer such a
 * value renders as nothing rather than as raw text.
 */
export type StatusEmoji =
    | { kind: 'unicode'; value: string }
    | { kind: 'custom'; ref: string };

export const CUSTOM_EMOJI_PREFIX = 'cl:';

export function parseStatusEmoji(value: string | null | undefined): StatusEmoji | null {
    if (!value) return null;
    if (value.startsWith(CUSTOM_EMOJI_PREFIX) && value.length > CUSTOM_EMOJI_PREFIX.length) {
        return { kind: 'custom', ref: value.slice(CUSTOM_EMOJI_PREFIX.length) };
    }
    return { kind: 'unicode', value };
}

// ── The status line decision ─────────────────────────────────────────────────

export type StatusLineKind = 'custom+game' | 'custom' | 'game' | 'none';

export interface StatusLineModel {
    kind: StatusLineKind;
    emoji: string | null;
    text: string | null;
    /** The game the viewer may see (already empty while offline or on a phone). */
    game: string | null;
    /** Tooltip for the controller icon next to the custom status. */
    gameTooltip: string | null;
}

/**
 * What to show under a name:
 *   - custom status AND a game  -> the custom status, with a small game
 *     controller next to it whose tooltip says "Playing <game>";
 *   - custom status only        -> the custom status;
 *   - game only                 -> "Playing <game>" as before;
 *   - neither / offline         -> nothing.
 * Only what is already in the entry is used, so the game and the custom status
 * are shown to exactly the viewers the server already sent them to; an entry
 * for an offline person carries neither, and a person only on a phone has no
 * game.
 */
export function statusLineModel(
    entry: Pick<FriendStatusEntry, 'status' | 'custom_status_text' | 'custom_status_emoji' | 'custom_status_expires_at' | 'current_game' | 'on_mobile'> | null | undefined,
    now: number = Date.now(),
): StatusLineModel {
    const none: StatusLineModel = { kind: 'none', emoji: null, text: null, game: null, gameTooltip: null };
    if (!entry || entry.status === 'offline') return none;
    const onMobile = !!entry.on_mobile;
    const game = !onMobile && entry.current_game ? entry.current_game : null;
    const custom = activeCustom(entry.custom_status_text, entry.custom_status_emoji, entry.custom_status_expires_at, now);
    if (custom && game) return { kind: 'custom+game', emoji: custom.emoji, text: custom.text, game, gameTooltip: `Playing ${game}` };
    if (custom) return { kind: 'custom', emoji: custom.emoji, text: custom.text, game: null, gameTooltip: null };
    if (game) return { kind: 'game', emoji: null, text: null, game, gameTooltip: `Playing ${game}` };
    return none;
}

/** One-line plain text of the custom part ("🍕 lunch"), for tooltips. */
export function customStatusLabel(model: Pick<StatusLineModel, 'emoji' | 'text'>): string {
    // A custom-emoji reference is an image, never text.
    const emoji = parseStatusEmoji(model.emoji)?.kind === 'unicode' ? model.emoji : null;
    return [emoji, model.text].filter(Boolean).join(' ');
}

// ── The dialog's draft ───────────────────────────────────────────────────────

export interface CustomStatusDraft {
    text: string;
    emoji: string;
    clearAfter: ClearAfterChoice;
}

export interface CurrentCustomStatus {
    text: string;
    emoji: string;
    expiresAt: string | null;
}

/** Opening the dialog on an existing status keeps its expiry unless changed. */
export function initialDraft(current: CurrentCustomStatus | null, now: number = Date.now()): CustomStatusDraft {
    const active = current ? activeCustom(current.text, current.emoji, current.expiresAt, now) : null;
    if (!active) return { text: '', emoji: '', clearAfter: 'never' };
    return {
        text: active.text ?? '',
        emoji: active.emoji ?? '',
        clearAfter: active.expiresAt ? 'keep' : 'never',
    };
}

// Control, zero-width and bidi-override characters (built from escapes so no
// invisible character sits in this source file).
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const HIDDEN_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]');

export const CUSTOM_STATUS_NOT_ALLOWED = "That status isn't allowed. Please choose another.";

/** Why the draft cannot be saved, or null. An empty draft is valid (= clear). */
export function draftIssue(draft: CustomStatusDraft): string | null {
    if (draft.text.length > CUSTOM_STATUS_TEXT_MAX) return `Keep it to ${CUSTOM_STATUS_TEXT_MAX} characters.`;
    if (draft.text.length > 0 && draft.text.trim().length === 0) return 'A status cannot be only spaces.';
    if (HIDDEN_CHARS.test(draft.text)) {
        return 'That contains characters that cannot be used.';
    }
    if (draft.text.length > 0 && !isNameAllowed(draft.text)) return CUSTOM_STATUS_NOT_ALLOWED;
    return null;
}

export const draftIsEmpty = (d: CustomStatusDraft): boolean => d.text.length === 0 && d.emoji.length === 0;

export interface CustomStatusPayload {
    text: string;
    emoji: string;
    /** ISO instant, or null for "don't clear". Always null for an empty status. */
    expiresAt: string | null;
}

/** What to send. `keep` re-sends the existing expiry only while it is still ahead. */
export function draftPayload(
    draft: CustomStatusDraft,
    currentExpiresAt: string | null,
    now: Date = new Date(),
): CustomStatusPayload {
    if (draftIsEmpty(draft)) return { text: '', emoji: '', expiresAt: null };
    let expiresAt: string | null;
    if (draft.clearAfter === 'keep') {
        const ms = currentExpiresAt ? Date.parse(currentExpiresAt) : NaN;
        expiresAt = !Number.isNaN(ms) && ms > now.getTime() ? currentExpiresAt : null;
    } else {
        expiresAt = expiresAtFor(draft.clearAfter, now);
    }
    return { text: draft.text, emoji: draft.emoji, expiresAt };
}

/** "Clears at 3:45 PM" / "Clears tomorrow at …" — for the picker row and dialog. */
export function describeExpiry(expiresAt: string | null | undefined, now: Date = new Date()): string | null {
    if (!expiresAt) return null;
    const at = new Date(expiresAt);
    if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return at.toDateString() === now.toDateString() ? `Clears at ${time}` : `Clears ${at.toLocaleDateString([], { weekday: 'short' })} at ${time}`;
}
