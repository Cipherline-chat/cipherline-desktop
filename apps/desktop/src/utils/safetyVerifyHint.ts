/**
 * The one-time "make sure it's really them" hint: a small callout on the chat
 * header's safety shield, shown once per account to someone who has a real
 * conversation going with a contact they have never verified and has never
 * verified anyone. Identity here is trust-on-first-use; almost nobody compares
 * safety numbers, and this is the single nudge that says why it is worth doing.
 *
 * This file is the DOM-free half: the eligibility rule (pure) and the
 * per-account "done" record. The component is components/SafetyVerifyHint.tsx.
 *
 * Done means done forever, for any of: pressing either button, Escape, the card
 * having been on screen long enough to be read (HINT_SEEN_MS: a chat switch or a
 * crash can never make it come back), or verifying ANYONE by ANY route
 * (utils/firstVerification.ts calls markHintDone from the one place a
 * verification is committed, keyVerification.markVerified).
 *
 * Storage: a per-account record in secureLocalStore (never raw localStorage),
 * named for the account so the store files it under that account's subkey.
 * Excluded from backups (services/backupRegistry.ts): a one-time UI marker. The
 * pins it is about are never restored from a vault either, so a restored device
 * is a device where nobody is verified yet and the hint may say its piece once.
 * Reads and writes wait for the account's records to be loaded (isAccountReady):
 * a cold namespace reads null and would otherwise show the hint again.
 */
import { secureLocalStore } from './secureLocalStore';
import type { TrustLevel } from './contactTrust';

export const SAFETY_HINT_DONE_PREFIX = 'cipherline_safety_hint_done_';
/** Same-window change event, so the card closes the moment anything marks the hint done. */
export const SAFETY_HINT_EVENT = 'cipherline:safety-hint-changed';

/** Real history: at least this many messages from EACH side. */
export const HINT_MIN_PER_SIDE = 5;
/** Not on top of the boot UI: nothing in the first minute after the app starts. */
export const HINT_QUIET_START_MS = 60_000;
/** On screen this long counts as seen: the hint is then done even if the card is just left there. */
export const HINT_SEEN_MS = 4_000;

export const SAFETY_HINT_TITLE = 'Make sure it’s really them';
export const safetyHintBody = (name: string) =>
    `Compare safety numbers with ${name} once, in person or on a call. If they match, nobody is sitting in the middle.`;
export const SAFETY_HINT_PRIMARY = 'Compare now';
export const SAFETY_HINT_SECONDARY = 'Not now';

export interface HintFacts {
    /** A real 1:1 DM: not a group, not a server channel. */
    isOneToOneDm: boolean;
    /** The "conversation" is your own notes chat. */
    isSelfChat: boolean;
    /** The contact's overall trust level (utils/contactTrust.ts); only 'unverified' is a candidate. */
    trustLevel: TrustLevel;
    /** A key-change / forgery warning is up for this contact: that banner owns the topic. */
    warningActive: boolean;
    /** Any contact, on this device, has ever been verified (any device of anyone, legacy counts). */
    verifiedAnyone: boolean;
    /** Text-like messages in the loaded thread, per side. */
    messagesFromMe: number;
    messagesFromThem: number;
    /** A call is live in THIS conversation. */
    callActiveHere: boolean;
    /** ms since the app (this window) started. */
    sinceAppStartMs: number;
    /** Already finished with, for good. */
    alreadyDone: boolean;
    /** The user switched all tips off (first-week nudges' master switch). */
    tipsOff: boolean;
}

/** Why a hint may not show, or null when it may. Pure; the first failing rule wins. */
export function safetyHintBlocker(f: HintFacts): string | null {
    if (f.alreadyDone) return 'done';
    if (f.tipsOff) return 'tips-off';
    if (f.isSelfChat) return 'self-chat';
    if (!f.isOneToOneDm) return 'not-a-dm';
    if (f.trustLevel !== 'unverified') return 'trust-level';
    if (f.warningActive) return 'warning';
    if (f.verifiedAnyone) return 'verified-someone';
    if (f.messagesFromMe < HINT_MIN_PER_SIDE || f.messagesFromThem < HINT_MIN_PER_SIDE) return 'thin-history';
    if (f.callActiveHere) return 'in-call';
    if (f.sinceAppStartMs < HINT_QUIET_START_MS) return 'just-started';
    return null;
}

export const safetyHintEligible = (f: HintFacts): boolean => safetyHintBlocker(f) === null;

/** ms left of the quiet start (0 = already past it). */
export const quietStartLeftMs = (sinceAppStartMs: number): number => Math.max(0, HINT_QUIET_START_MS - sinceAppStartMs);

/**
 * Text-like messages from each side of the loaded thread (utils/messageMenuGating
 * isTextLikeMessageType's set: text, invites, GIFs). Structural only: it looks at
 * the kind and the sender, never the content.
 */
export function countThreadSides<M extends { content?: { type?: string | null } | null }>(
    messages: readonly M[] | null | undefined,
    isMine: (m: M) => boolean,
    isTextLike: (type: string | null | undefined) => boolean,
): { mine: number; theirs: number } {
    let mine = 0;
    let theirs = 0;
    for (const m of messages ?? []) {
        if (!isTextLike(m?.content?.type)) continue;
        if (isMine(m)) mine++; else theirs++;
        if (mine >= HINT_MIN_PER_SIDE && theirs >= HINT_MIN_PER_SIDE) break;
    }
    return { mine, theirs };
}

// ── the per-account "done" record ───────────────────────────────────────────

const doneKey = (userId: string) => SAFETY_HINT_DONE_PREFIX + userId;

/** The account's records are loaded, so reading and writing its flags means something. */
export const hintStoreReady = (userId: string | null | undefined): boolean => {
    try { return !!userId && secureLocalStore.isAccountReady(userId); } catch { return false; }
};

/** Done for good? An unreadable or not-yet-loaded store reads as DONE: better a missed nudge than a repeated one. */
export function isHintDone(userId: string | null | undefined): boolean {
    if (!userId || !hintStoreReady(userId)) return true;
    try { return secureLocalStore.getItem(doneKey(userId)) === '1'; } catch { return true; }
}

/** Why the hint finished: 'seen' (on screen long enough), 'closed' (a button / Escape), 'verified' (someone was verified). */
export type HintDoneReason = 'seen' | 'closed' | 'verified';

/** Finish with the hint, forever, and tell any open card why. Idempotent. */
export function markHintDone(userId: string | null | undefined, reason: HintDoneReason = 'closed'): void {
    if (!userId || !hintStoreReady(userId)) return;
    try {
        if (secureLocalStore.getItem(doneKey(userId)) !== '1') secureLocalStore.setItem(doneKey(userId), '1');
    } catch { return; }
    // Told even when it was already done: a card that is open must still hear that the user
    // acted ('seen' alone leaves a card on screen; the other two take it down).
    try { window.dispatchEvent(new CustomEvent<{ userId: string; reason: HintDoneReason }>(SAFETY_HINT_EVENT, { detail: { userId, reason } })); } catch { /* no window (tests) */ }
}

export function subscribeHintDone(cb: (reason: HintDoneReason) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const on = (e: Event) => cb((e as CustomEvent<{ reason?: HintDoneReason }>).detail?.reason ?? 'closed');
    window.addEventListener(SAFETY_HINT_EVENT, on);
    return () => window.removeEventListener(SAFETY_HINT_EVENT, on);
}
