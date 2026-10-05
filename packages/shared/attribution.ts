/**
 * Signup attribution — the cross-app contract for "how did this person arrive".
 *
 * Referral links (`https://cipherline.chat/ref/<code>`) and server-invite links
 * (`https://cipherline.chat/invite/<code>`) are carried through signup so the
 * code is applied automatically and the user SEES it applied. These are the
 * shapes both ends agree on. Nothing here is secret: a referral code or invite
 * code is the thing a person deliberately shares.
 */

/** Public web origin the landing pages live on. */
export const CIPHERLINE_WEB_ORIGIN = 'https://cipherline.chat';

/**
 * The official Cipherline community server's invite code.
 *
 * Default only — the API's `GET /v1/config` returns `official_server` from the
 * `OFFICIAL_SERVER_INVITE_CODE` env var when it is set, so ops can re-point it
 * (e.g. after the server is rebuilt) without shipping a client. Clients use
 * this constant as the instant, offline default and may refresh from /v1/config.
 * Joining is always a PROMPT the user accepts, never automatic.
 */
export const OFFICIAL_SERVER_INVITE_CODE = 'zKKaUldlWXo';

/** Referral codes are 8 uppercase hex characters (see AuthService.finalize). */
export const REFERRAL_CODE_RE = /^[A-F0-9]{8}$/;

/** Server-invite codes: URL-safe base64-ish, as minted by InvitesService. */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

export const referralLinkFor = (code: string): string => `${CIPHERLINE_WEB_ORIGIN}/ref/${code}`;
export const inviteLinkFor = (code: string): string => `${CIPHERLINE_WEB_ORIGIN}/invite/${code}`;

/** `GET /v1/auth/resolve-referral?code=` — who a referral code belongs to. */
export interface ReferralResolveResponse {
    valid: boolean;
    /** Present only when `valid`. Public identity, exactly what a friend request shows. */
    referrer?: { username: string; discriminator: number | null };
}

/** `GET /v1/config` -> `official_server`. */
export interface OfficialServerConfig {
    invite_code: string;
    invite_url: string;
}

/**
 * WebSocket event `referral:redeemed`, sent to the REFERRER when someone
 * finishes signup with their code. Carries only the new user's public tag.
 */
export interface ReferralRedeemedEventData {
    username: string;
    discriminator: number | null;
    /** ISO-8601 timestamp of the signup. */
    redeemed_at: string;
}

/** One entry of `GET /v1/billing/referral` -> `recent_referrals` (catch-up for an offline referrer). */
export interface RecentReferral {
    username: string;
    discriminator: number | null;
    joined_at: string;
}
