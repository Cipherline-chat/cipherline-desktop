import axios from 'axios';
import secureLocalStore from './secureLocalStore';
import { API_BASE } from '../constants';
import {
    REFERRAL_CODE_RE,
    INVITE_CODE_RE,
    OFFICIAL_SERVER_INVITE_CODE,
    referralLinkFor,
    type ReferralResolveResponse,
    type OfficialServerConfig,
    type RecentReferral,
} from '@cipherline/shared';

/**
 * Signup attribution — carrying "how did this person arrive" through signup.
 *
 * A friend's referral link (`cipherline.chat/ref/<code>`) or a server invite
 * (`cipherline.chat/invite/<code>`) can reach the app in four ways:
 *
 *   1. App installed, running  -> OS deep link `cipherline://ref|invite/<code>`
 *   2. App installed, closed   -> same deep link on the cold-start command line
 *   3. App NOT installed       -> the landing page copies the link to the
 *                                 clipboard when the visitor clicks "Get
 *                                 Cipherline"; the first launch finds it and
 *                                 ASKS (see `peekClipboardOnce`)
 *   4. Anything else           -> the person pastes the link/code into the
 *                                 "Have a referral code?" field (`parseAttributionInput`)
 *
 * Whatever the route, the code is remembered here until it is USED: a referral
 * until signup finishes (or the person removes it), an invite until the person
 * joins or declines the prompt. It is stored with `secureLocalStore` (encrypted
 * at rest, master-tier — there is no account yet) and expires after
 * {@link PENDING_TTL_MS} so a link clicked months ago cannot resurface.
 *
 * Nothing here matches a person by IP or fingerprint, and nothing is sent to the
 * server except the code the person already holds (to look up who it belongs to).
 *
 * ── Hook points for the onboarding UI ───────────────────────────────────────
 *   getPendingReferral() / getPendingInvite()      read what is carried
 *   setPendingReferral(code) / setPendingInvite()  carry a code (any source)
 *   clearPendingReferral() / clearPendingInvite()  the code was used / declined
 *   resolveReferral(code)                          -> who owns the code
 *   rememberReferrer(uid, tag) / takeReferrer(uid) post-signup friend-request offer
 *   fetchOfficialServer()                          the "Join the official server" prompt
 */

/** A carried code older than this is ignored and dropped. */
export const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const PENDING_REF_SLOT = 'cl_attr_pending_ref_v1';
const PENDING_INVITE_SLOT = 'cl_attr_pending_invite_v1';
const CLIPBOARD_CHECKED_KEY = 'cl_attr_clipboard_checked_v1';
/** `cl_referrer_<uid>` — the referrer's public tag, kept for the post-signup friend-request offer. */
const REFERRER_KEY_PREFIX = 'cl_referrer_';

export type AttributionKind = 'ref' | 'invite';
export interface ParsedAttribution { kind: AttributionKind; code: string }

/** Canonical (upper-case) referral code, or null when it is not one. */
export function normalizeReferralCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const up = raw.trim().toUpperCase();
    return REFERRAL_CODE_RE.test(up) ? up : null;
}

/** Invite code as-is (they are case-sensitive), or null when malformed. */
export function normalizeInviteCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    return INVITE_CODE_RE.test(t) ? t : null;
}

/**
 * Make sense of whatever a person pasted: a deep link, a landing-page URL, or a
 * bare referral code. Returns null for anything else — in particular a bare
 * invite code is NOT guessed at (it is indistinguishable from other text); the
 * invite surfaces take URLs/deep links, and "Join a Server" takes bare codes.
 */
export function parseAttributionInput(text: unknown): ParsedAttribution | null {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t || t.length > 300) return null;

    const bare = normalizeReferralCode(t);
    if (bare) return { kind: 'ref', code: bare };

    const m = t.match(
        /^(?:cipherline:\/\/|https?:\/\/(?:www\.)?cipherline\.chat\/)(ref|invite)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i,
    );
    if (!m) return null;
    const kind = m[1].toLowerCase() as AttributionKind;
    const code = kind === 'ref' ? normalizeReferralCode(m[2]) : normalizeInviteCode(m[2]);
    return code ? { kind, code } : null;
}

// ── Pending code store ─────────────────────────────────────────────────────

interface Stored { code: string; at: number }

function readStored(key: string, normalize: (v: unknown) => string | null, now: number): string | null {
    let raw: string | null = null;
    try { raw = secureLocalStore.getItem(key); } catch { return null; }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<Stored>;
        const code = normalize(parsed?.code);
        const at = typeof parsed?.at === 'number' ? parsed.at : 0;
        if (code && now - at <= PENDING_TTL_MS && at <= now + 60_000) return code;
    } catch { /* corrupt — fall through and drop it */ }
    try { secureLocalStore.removeItem(key); } catch { /* ignore */ }
    return null;
}

function writeStored(key: string, code: string, now: number): void {
    try { secureLocalStore.setItem(key, JSON.stringify({ code, at: now } satisfies Stored)); } catch { /* locked store: carry in memory only */ }
}

function drop(key: string): void {
    try { secureLocalStore.removeItem(key); } catch { /* ignore */ }
}

export function getPendingReferral(now: number = Date.now()): string | null {
    return readStored(PENDING_REF_SLOT, normalizeReferralCode, now);
}
/** Returns false (and stores nothing) when `code` is not a well-formed referral code. */
export function setPendingReferral(code: string, now: number = Date.now()): boolean {
    const c = normalizeReferralCode(code);
    if (!c) return false;
    writeStored(PENDING_REF_SLOT, c, now);
    return true;
}
export function clearPendingReferral(): void { drop(PENDING_REF_SLOT); }

export function getPendingInvite(now: number = Date.now()): string | null {
    return readStored(PENDING_INVITE_SLOT, normalizeInviteCode, now);
}
export function setPendingInvite(code: string, now: number = Date.now()): boolean {
    const c = normalizeInviteCode(code);
    if (!c) return false;
    writeStored(PENDING_INVITE_SLOT, c, now);
    notifyInviteListeners();
    return true;
}
export function clearPendingInvite(): void {
    drop(PENDING_INVITE_SLOT);
    notifyInviteListeners();
}

// The pending invite is written from one place (a deep link, the clipboard
// offer) and shown from another (the join prompt after signup), so the second
// needs to hear about the first without polling.
const inviteListeners = new Set<() => void>();
function notifyInviteListeners(): void {
    for (const cb of [...inviteListeners]) { try { cb(); } catch { /* a listener must not break the writer */ } }
}
/** Subscribe to pending-invite changes. Returns the unsubscribe function. */
export function onPendingInviteChange(cb: () => void): () => void {
    inviteListeners.add(cb);
    return () => { inviteListeners.delete(cb); };
}

// ── Referrer (post-signup friend-request offer) ───────────────────────────

export interface ReferrerTag { username: string; discriminator: number | null }

const referrerKey = (uid: string) => `${REFERRER_KEY_PREFIX}${uid}`;

/** Remember who referred this (just-created) account, for the one-click friend request. */
export function rememberReferrer(userId: string, tag: ReferrerTag): void {
    if (!userId || !tag?.username) return;
    try { secureLocalStore.setItem(referrerKey(userId), JSON.stringify({ username: tag.username, discriminator: tag.discriminator ?? null })); } catch { /* ignore */ }
}
/** Read without consuming. */
export function peekReferrer(userId: string): ReferrerTag | null {
    if (!userId) return null;
    try {
        const raw = secureLocalStore.getItem(referrerKey(userId));
        if (!raw) return null;
        const p = JSON.parse(raw) as Partial<ReferrerTag>;
        if (typeof p?.username !== 'string' || !p.username) return null;
        return { username: p.username, discriminator: typeof p.discriminator === 'number' ? p.discriminator : null };
    } catch { return null; }
}
/** The offer was sent or declined — one-shot. */
export function clearReferrer(userId: string): void { if (userId) drop(referrerKey(userId)); }

// ── Resolve a code -> who owns it ─────────────────────────────────────────

/**
 * `GET /v1/auth/resolve-referral`. Never throws: a network/server failure is
 * reported as `{ valid: false, failed: true }` so the form can say "couldn't
 * check" rather than "invalid".
 *
 * Against an API that predates the endpoint (404) it falls back to the old
 * boolean `check-referral`, so a new client on an old server still accepts a
 * code — it just cannot name the referrer (`referrer` is absent).
 */
export async function resolveReferral(code: string): Promise<ReferralResolveResponse & { failed?: boolean }> {
    const c = normalizeReferralCode(code);
    if (!c) return { valid: false };
    try {
        const res = await axios.get(`${API_BASE}/auth/resolve-referral`, { params: { code: c } });
        const d = res.data as ReferralResolveResponse;
        if (d?.valid === true && typeof d.referrer?.username === 'string') {
            return { valid: true, referrer: { username: d.referrer.username, discriminator: d.referrer.discriminator ?? null } };
        }
        return { valid: false };
    } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status === 404) {
            try {
                const legacy = await axios.get(`${API_BASE}/auth/check-referral`, { params: { code: c } });
                return { valid: legacy.data?.valid === true };
            } catch { return { valid: false, failed: true }; }
        }
        // A 400 is an answer about THIS code; anything else means we could not ask.
        return status === 400 ? { valid: false } : { valid: false, failed: true };
    }
}

// ── First-launch clipboard hand-off ───────────────────────────────────────

/**
 * Look for the hand-off link the landing page copied, ONCE per install.
 *
 * Called when the sign-in screen first shows. The main process does the read
 * and answers only if the clipboard holds exactly one of our own links
 * (`electron/attribution-link.ts`) — anything else comes back as null, so the
 * renderer never sees clipboard text. The caller must show the result to the
 * person and let them accept or decline; it is never applied silently.
 *
 * "Once": the check is recorded so a later launch (or a person who just copied
 * something unrelated) is never read again. If the store is locked the write
 * is a no-op and the check simply stays eligible — it is read-only either way.
 */
export async function peekClipboardOnce(): Promise<ParsedAttribution | null> {
    try {
        if (secureLocalStore.getItem(CLIPBOARD_CHECKED_KEY)) return null;
    } catch { return null; }
    const api = (globalThis as { window?: { electronAPI?: { peekAttributionClipboard?: () => Promise<ParsedAttribution | null> } } }).window?.electronAPI;
    if (!api?.peekAttributionClipboard) return null;
    try { secureLocalStore.setItem(CLIPBOARD_CHECKED_KEY, '1'); } catch { /* ignore */ }
    try {
        const found = await api.peekAttributionClipboard();
        if (!found) return null;
        // Re-validate; never trust the bridge's shape blindly.
        if (found.kind === 'ref') {
            const code = normalizeReferralCode(found.code);
            return code ? { kind: 'ref', code } : null;
        }
        if (found.kind === 'invite') {
            const code = normalizeInviteCode(found.code);
            return code ? { kind: 'invite', code } : null;
        }
        return null;
    } catch { return null; }
}

// ── The official Cipherline server ────────────────────────────────────────

/** Synchronous default — correct offline and before any network call. */
export function officialServerDefault(): OfficialServerConfig {
    return { invite_code: OFFICIAL_SERVER_INVITE_CODE, invite_url: `https://cipherline.chat/invite/${OFFICIAL_SERVER_INVITE_CODE}` };
}

/**
 * The official server's invite, preferring `GET /v1/config` (so ops can
 * re-point it without a client release) and falling back to the shared
 * constant on any failure or malformed answer. Never throws.
 */
export async function fetchOfficialServer(): Promise<OfficialServerConfig> {
    try {
        const res = await axios.get(`${API_BASE}/config`, { timeout: 5000 });
        const code = normalizeInviteCode(res.data?.official_server?.invite_code);
        if (code) return { invite_code: code, invite_url: `https://cipherline.chat/invite/${code}` };
    } catch { /* fall through */ }
    return officialServerDefault();
}

// ── My referral link (the inviter's side) ─────────────────────────────────

export interface MyReferral {
    code: string;
    /** `https://cipherline.chat/ref/<code>` — the link to share. */
    url: string;
    /** How many people have signed up with it. */
    count: number;
    /** The latest few (public tag + date): catch-up for `referral:redeemed` events missed while offline. */
    recent: RecentReferral[];
}

/**
 * `GET /v1/billing/referral` — one cheap authenticated read that already exists.
 * Returns null when the account has no code yet or the call fails; callers treat
 * that as "nothing to show", never as an error to surface. The link is built from
 * the code locally, so this also works against an API that predates `referral_url`.
 */
export async function fetchMyReferral(token: string): Promise<MyReferral | null> {
    try {
        const res = await axios.get(`${API_BASE}/billing/referral`, { headers: { Authorization: `Bearer ${token}` } });
        const d = res.data as { referral_code?: string | null; referrals_count?: number; recent_referrals?: RecentReferral[] };
        const code = normalizeReferralCode(d?.referral_code);
        if (!code) return null;
        return {
            code,
            url: referralLinkFor(code),
            count: typeof d.referrals_count === 'number' ? d.referrals_count : 0,
            recent: Array.isArray(d.recent_referrals) ? d.recent_referrals.filter(r => typeof r?.username === 'string') : [],
        };
    } catch { return null; }
}
