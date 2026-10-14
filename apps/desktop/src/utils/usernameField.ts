/**
 * What the username field in a settings screen should say and allow, as a
 * pure function — shared by Settings → Profile (desktop) and the website
 * account portal's ProfileCard (which imports this file from desktop source,
 * like utils/imageCrop), so both show the same states for the same facts.
 *
 * MIRROR ONLY. The API enforces both rules (the profanity filter and the 24 h
 * change cooldown) and is the only thing that matters for safety; this exists
 * so a person sees "not allowed" or "available in 5 h" BEFORE they submit,
 * and so a server rejection is shown next to the field instead of as a
 * generic failure.
 */
import {
    USERNAME_REGEX,
    USERNAME_NOT_ALLOWED_MESSAGE,
    USERNAME_COOLDOWN_ERROR,
    isNameAllowed,
    usernameCooldownRemainingMs,
    usernameCooldownMessage,
} from '@cipherline/shared';

export const USERNAME_FORMAT_MESSAGE = '3–32 characters: letters, digits, underscore.';

export interface UsernameFieldInput {
    /** What is in the input. */
    draft: string;
    /** The account's current (saved) username. */
    current: string;
    /** `next_username_change_at` from /auth/me (or a 429's `next_change_at`). */
    nextChangeAt?: string | null;
    /** `username_pending` from /auth/me: the first choice is never locked. */
    pending?: boolean;
    now: number;
}

export type UsernameFieldState =
    /** In cooldown: the input is disabled and `message` says until when. */
    | { kind: 'locked'; message: string; remainingMs: number }
    /** Nothing to save for the username. */
    | { kind: 'unchanged' }
    /** Fails the format rule. */
    | { kind: 'invalid'; message: string }
    /** Fails the profanity filter. */
    | { kind: 'not_allowed'; message: string }
    /** A valid new name. */
    | { kind: 'ok' };

export function usernameFieldState(i: UsernameFieldInput): UsernameFieldState {
    const remainingMs = i.pending ? 0 : usernameCooldownRemainingMs(i.nextChangeAt, i.now);
    if (remainingMs > 0) return { kind: 'locked', message: usernameCooldownMessage(remainingMs), remainingMs };
    const v = i.draft.trim();
    if (v === '' || v === i.current) return { kind: 'unchanged' };
    if (!USERNAME_REGEX.test(v)) return { kind: 'invalid', message: USERNAME_FORMAT_MESSAGE };
    if (!isNameAllowed(v)) return { kind: 'not_allowed', message: USERNAME_NOT_ALLOWED_MESSAGE };
    return { kind: 'ok' };
}

/** True when the field blocks saving (bad name). A locked field does not —
 *  its draft is pinned to the current name, and the rest of the profile can
 *  still be saved. */
export function usernameBlocksSave(s: UsernameFieldState): boolean {
    return s.kind === 'invalid' || s.kind === 'not_allowed';
}

/**
 * Turn a failed PATCH /auth/profile into a message for the username field,
 * when the failure is about the username: a 429 cooldown (with the time it
 * lifts, so the field can lock without waiting for /auth/me), a 400 from the
 * filter or the format rule, or a 409 name clash. Anything else -> null (the
 * caller keeps its generic error).
 */
export function usernameSaveError(err: unknown): { message: string; nextChangeAt: string | null } | null {
    const res = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
    if (!res || typeof res.status !== 'number') return null;
    const d = (res.data ?? {}) as { error?: unknown; message?: unknown; next_change_at?: unknown; retry_after?: unknown };
    const text = Array.isArray(d.message)
        ? d.message.filter((m): m is string => typeof m === 'string').join(' ')
        : typeof d.message === 'string' ? d.message : '';
    if (res.status === 429 && d.error === USERNAME_COOLDOWN_ERROR) {
        const next = typeof d.next_change_at === 'string' ? d.next_change_at : null;
        const fallback = typeof d.retry_after === 'number' ? usernameCooldownMessage(d.retry_after * 1000) : 'You changed your username recently. Try again later.';
        return { message: text || fallback, nextChangeAt: next };
    }
    if (res.status === 400 && /username/i.test(text)) return { message: text, nextChangeAt: null };
    if (res.status === 409 && text) return { message: text, nextChangeAt: null };
    return null;
}
