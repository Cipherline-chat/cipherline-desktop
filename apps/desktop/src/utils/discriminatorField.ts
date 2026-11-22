/**
 * What the "#0000" field in a settings screen should say and allow, as a pure
 * function. Shared by Settings -> Profile (desktop) and the website account
 * portal (which imports this file from desktop source, like usernameField.ts).
 *
 * MIRROR ONLY. POST /v1/auth/discriminator enforces everything here (the Pro
 * gate with a 403, exactly 4 digits and the 1..9999 range with a 400, uniqueness with a 409) and is
 * the only thing that matters for safety. This exists so a person sees "not
 * allowed" before they submit and a server rejection lands next to the field.
 *
 * Valid user-chosen numbers are 0001-9999 (#0000 is not choosable).
 */
import { formatDateTime } from './a11y/timeFormat';

export const DISCRIMINATOR_ZERO_MESSAGE = '#0000 is not available. Choose a number from 0001 to 9999.';
export const DISCRIMINATOR_FORMAT_MESSAGE = 'Use all 4 digits, e.g. 0042 (0001-9999).';
/** The crown popover on the locked segment (owner 2026-11-16: "a little hover
 *  box that says its a pro feature. with the yellow crown"). */
export const DISCRIMINATOR_PRO_MESSAGE = 'Custom #numbers are a Pro feature.';
export const DISCRIMINATOR_TRIAL_MESSAGE = 'Changing your #number unlocks once you are on paid Pro. It is not included in the free trial.';

/** How Pro's feature lists name it (owner: "Add custom #0001 Tags to the list
 *  of features on pro"). Desktop billing UI, checkout, the website portal. */
export const PRO_TAG_FEATURE_TITLE = 'Custom #0001 tags';
export const PRO_TAG_FEATURE_DETAIL = 'Pick the number after your name';

// ── 24 h change cooldown (mirror of POST /auth/discriminator's 429) ─────────

/** `error` of the API's 429 body for a change inside the cooldown. The
 *  throttler's own 429 carries no such code. */
export const DISCRIMINATOR_COOLDOWN_ERROR = 'discriminator_change_cooldown';

/** Milliseconds until a change is allowed again (0 = now), from
 *  `next_discriminator_change_at` (/auth/me) or a 429's `next_change_at`. */
export function discriminatorCooldownRemainingMs(nextChangeAt: string | Date | null | undefined, now: number = Date.now()): number {
    if (!nextChangeAt) return 0;
    const t = nextChangeAt instanceof Date ? nextChangeAt.getTime() : Date.parse(nextChangeAt);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, t - now);
}

/** `7 h`, `45 min` - rounded UP so it never promises a change earlier than the
 *  server will take it (same rule as the username's). */
export function formatDiscriminatorCooldown(ms: number): string {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    if (minutes < 60) return `${minutes} min`;
    return `${Math.ceil(ms / 3_600_000)} h`;
}

/**
 * The cooldown line under the field: relative AND absolute, e.g.
 * "You can change your #number again in 7 h (Tue 3:04 PM)." The absolute part is the
 * viewer's local time; `opts` pins locale / zone for tests.
 */
export function discriminatorCooldownFieldMessage(
    nextChangeAt: string | Date,
    now: number = Date.now(),
    opts: { locale?: string; timeZone?: string } = {},
): string {
    const ms = discriminatorCooldownRemainingMs(nextChangeAt, now);
    const at = nextChangeAt instanceof Date ? nextChangeAt : new Date(nextChangeAt);
    let when = '';
    try {
        when = formatDateTime(at, opts.locale, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: opts.timeZone });
    } catch { /* bad locale/zone: relative only */ }
    return `You can change your #number again in ${formatDiscriminatorCooldown(ms)}${when ? ` (${when})` : ''}.`;
}

// ── Cancel confirmation ──────────────────────────────────────────────────────

/**
 * The line every cancel confirmation shows (desktop BillingTab, website
 * SubscriptionCard): what happens to the #number when Pro ENDS (not when they
 * click cancel). Names their number only when it is one they chose
 * (`discriminator_custom` on /auth/me); otherwise the generic line. The API's
 * DiscriminatorLapseService is what actually does it.
 */
export function discriminatorCancelNotice(i: { discriminator?: number | null; custom?: boolean | null }): string {
    if (i.custom === true && typeof i.discriminator === 'number') {
        return `Your custom #number (#${String(i.discriminator).padStart(4, '0')}) will be replaced with a random one when Pro ends.`;
    }
    // No example digits here: next to a founder's cancel modal "#0001" would read
    // like a founder spot number (which that modal must never show).
    return 'Custom #number tags are Pro: you keep the #number you have now, but you can only choose a new one with Pro.';
}

/** Keep digits only, at most 4 (a pasted "#0042" becomes "0042"). */
/**
 * What POST /auth/discriminator is sent: always all 4 digits. The API takes a
 * STRING matching /^#?\d{4}$/ (it refuses coerced numbers), so 1 must go as
 * "0001" — sending String(1) = "1" was refused, which is why every number below
 * 1000 failed while 1111 worked (owner, 2026-11-16).
 */
export function discriminatorWireValue(n: number): string {
    return String(Math.trunc(n)).padStart(4, '0');
}

export function cleanDiscriminatorDraft(raw: string): string {
    return raw.replace(/\D/g, '').slice(0, 4);
}

/** The slice of GET /billing/status the gate reads. A live comp arrives as
 *  subscription_status 'active' (the server normalises it), so it passes. */
export interface DiscriminatorGateStatus {
    subscription_status?: string | null;
    effective_status?: string | null;
}

/** Mirror of the server's BillingService.canChangeDiscriminator: paying (or
 *  comped) and currently entitled; a trial is NOT enough. */
export function canChangeDiscriminatorMirror(s: DiscriminatorGateStatus | null | undefined): boolean {
    if (!s || s.effective_status !== 'active') return false;
    return s.subscription_status === 'active'
        || s.subscription_status === 'canceled_pending'
        || s.subscription_status === 'past_due';
}

export type DiscriminatorFieldState =
    /** Free or trial account: read-only. `trial` picks the copy. */
    | { kind: 'locked'; trial: boolean; message: string }
    /** Pro, but changed in the last 24 h: read-only until `remainingMs` passes. */
    | { kind: 'cooldown'; message: string; remainingMs: number }
    | { kind: 'unchanged' }
    | { kind: 'invalid'; message: string }
    | { kind: 'ok'; value: number }

export interface DiscriminatorFieldInput {
    /** What is in the input (digits only after cleanDiscriminatorDraft). */
    draft: string;
    /** The account's current discriminator. */
    current: number | null | undefined;
    canChange: boolean;
    /** subscription_status === 'trial', for the locked copy. */
    isTrial?: boolean;
    /** `next_discriminator_change_at` (/auth/me) or a 429's `next_change_at`. */
    nextChangeAt?: string | null;
    now?: number;
    /** Locale / zone for the absolute time in the cooldown copy (tests). */
    format?: { locale?: string; timeZone?: string };
}

export function discriminatorFieldState(i: DiscriminatorFieldInput): DiscriminatorFieldState {
    // The Pro gate first, like the server (403 before anything else).
    if (!i.canChange) {
        const trial = !!i.isTrial;
        return { kind: 'locked', trial, message: trial ? DISCRIMINATOR_TRIAL_MESSAGE : DISCRIMINATOR_PRO_MESSAGE };
    }
    const now = i.now ?? Date.now();
    const remainingMs = discriminatorCooldownRemainingMs(i.nextChangeAt, now);
    if (remainingMs > 0 && i.nextChangeAt) {
        return { kind: 'cooldown', remainingMs, message: discriminatorCooldownFieldMessage(i.nextChangeAt, now, i.format) };
    }
    const v = i.draft.trim();
    if (v === '') return { kind: 'unchanged' };
    if (!/^\d{4}$/.test(v)) return { kind: 'invalid', message: DISCRIMINATOR_FORMAT_MESSAGE };
    const n = parseInt(v, 10);
    if (n === 0) return { kind: 'invalid', message: DISCRIMINATOR_ZERO_MESSAGE };
    if (n === i.current) return { kind: 'unchanged' };
    return { kind: 'ok', value: n };
}

/**
 * The inline "#0000" segment of the username field: what Enter or leaving the
 * segment does with the current draft. `draft === null` means "not edited"
 * (the segment shows the saved number). `rejectedDraft` is the draft the
 * server last refused, so blurring again does not re-send a taken number.
 *  - 'save'   POST it.
 *  - 'revert' drop the draft (empty, or the same number as now).
 *  - 'none'   leave it as is (locked, nothing typed, invalid, already refused);
 *             an invalid draft stays so its message stays next to it.
 */
export function discriminatorCommitAction(
    state: DiscriminatorFieldState,
    draft: string | null,
    rejectedDraft?: string | null,
): 'save' | 'revert' | 'none' {
    if (state.kind === 'locked' || state.kind === 'cooldown' || draft === null) return 'none';
    if (state.kind === 'unchanged') return 'revert';
    if (state.kind === 'invalid') return 'none';
    return rejectedDraft != null && rejectedDraft === draft ? 'none' : 'save';
}

/** The tag as it will read, e.g. "shinobi#0042". */
export function discriminatorPreview(username: string, n: number): string {
    return `${username}#${String(n).padStart(4, '0')}`;
}

/**
 * Turn a failed POST /auth/discriminator into field copy. 403 (not Pro), 409
 * (taken), 400 (format / #0000), 429 cooldown (with `nextChangeAt`, so the
 * field locks at once) and 429 throttle all have specific text; anything else
 * -> null so the caller keeps its generic error.
 */
export function discriminatorSaveError(err: unknown): {
    kind: 'pro' | 'taken' | 'invalid' | 'throttled' | 'cooldown';
    message: string;
    nextChangeAt?: string | null;
} | null {
    const res = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
    if (!res || typeof res.status !== 'number') return null;
    const d = (res.data ?? {}) as { message?: unknown; error?: unknown; next_change_at?: unknown };
    if (res.status === 429 && d.error === DISCRIMINATOR_COOLDOWN_ERROR) {
        const next = typeof d.next_change_at === 'string' ? d.next_change_at : null;
        const text = typeof d.message === 'string' ? d.message : '';
        return { kind: 'cooldown', message: text || 'You changed your #number recently. Try again later.', nextChangeAt: next };
    }
    const text = Array.isArray(d.message)
        ? d.message.filter((m): m is string => typeof m === 'string').join(' ')
        : typeof d.message === 'string' ? d.message : '';
    switch (res.status) {
        case 403: return { kind: 'pro', message: text || DISCRIMINATOR_PRO_MESSAGE };
        case 409: return { kind: 'taken', message: text || 'That number is taken. Try another.' };
        case 400: return { kind: 'invalid', message: text || DISCRIMINATOR_FORMAT_MESSAGE };
        case 429: return { kind: 'throttled', message: 'Too many tries. You can change your #number again in a little while.' };
        default: return null;
    }
}
