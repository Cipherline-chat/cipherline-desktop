/**
 * QR sign-in (link) types shared between the renderer's `QrSignInPanel` /
 * `PhoneLinkPanel` and their tests, and referenced by `env.d.ts` for the
 * `electronAPI.linkOpen` / `linkSeal` signatures.
 *
 * Deliberately NOT imported from `electron/link-grant.ts`: an import from
 * `electron/` into `src/` (even `import type`) nests the emitted
 * `dist-electron` output under `dist-electron/electron/` instead of
 * `dist-electron/`, which breaks packaging with "main.js not found in
 * archive" — a failure that only a STAGING build catches, not `--noEmit`
 * (CLAUDE.md's "Electron rootDir trap"). This is a byte-compatible MIRROR of
 * `link-grant.ts`'s `LinkGrantPayload` and the API's `LinkPollResult` /
 * `LinkInvitePollResult`, kept in sync by hand — the same discipline
 * `main.ts` already applies to the history-request-proof message template for
 * the same reason.
 *
 * Full design: `docs/QR-LINKING.md` (mobile repo) §2; the 2026-09-28
 * hardening (verification code, second factor, claim-then-mint, invites) is
 * described in `apps/api/src/link/link.service.ts`'s header.
 */

/** v1 — tokens inside the envelope (legacy approver). */
export interface LinkGrantPayloadV1 {
    type: 'link_grant';
    v: 1;
    link_id: string;
    user_id: string;
    access_token: string;
    refresh_token: string;
    approved_by_device_id: string;
    approved_by_device_name: string;
    issued_at: string;
}

/** v2 — a claim secret; the token pair is minted by `POST sessions/:id/claim`. */
export interface LinkGrantPayloadV2 {
    type: 'link_grant';
    v: 2;
    link_id: string;
    user_id: string;
    claim_secret: string;
    approved_by_device_id: string;
    approved_by_device_name: string;
    issued_at: string;
}

/** The decrypted grant, exactly as `link-grant.ts`'s `openLinkGrant` returns
 *  it — see that file for the envelope format and why every field is
 *  required (a grant missing any of them is rejected before it ever reaches
 *  the renderer). */
export type LinkGrantPayload = LinkGrantPayloadV1 | LinkGrantPayloadV2;

/** Mirrors `apps/api/src/link/link.constants.ts`'s `LinkState`. */
export type LinkSessionState = 'pending' | 'scanned' | 'approving' | 'granted' | 'claimed' | 'denied' | 'expired';

/** Mirrors `apps/api/src/link/link.service.ts`'s `LinkPollResult` — the shape
 *  of `GET /v1/link/sessions/:id`. */
export interface LinkPollResponse {
    state: LinkSessionState;
    envelope_b64?: string;
    expires_in_s?: number;
    /** With `denied` only, when the SERVER burned the session (five wrong codes). */
    reason?: 'locked';
}

/** The shape of `POST /v1/link/sessions`. */
export interface CreateLinkSessionResponse {
    link_id: string;
    ttl_s: number;
    expires_at: string;
}

/** The shape of `POST /v1/link/sessions/:id/claim`. */
export interface ClaimLinkSessionResponse {
    access_token: string;
    refresh_token: string;
    user_id: string;
}

// ── invites (this desktop is the signed-in device showing the QR) ───────────

/** Mirrors the API's `LinkInviteState`. */
export type LinkInviteState = 'open' | 'joined' | 'approving' | 'granted' | 'claimed' | 'denied' | 'expired';

/** The shape of `POST /v1/link/invites`. */
export interface CreateLinkInviteResponse {
    invite_id: string;
    ttl_s: number;
    expires_at: string;
}

/** The shape of `GET /v1/link/invites/:id` — mirrors `LinkInvitePollResult`. */
export interface LinkInvitePollResponse {
    state: LinkInviteState;
    expires_in_s?: number;
    device_label?: string;
    platform?: string;
    ek_pub_b64?: string;
    requires_2fa?: 'totp' | null;
    reason?: 'locked';
}

/** Body of `POST /v1/link/sessions/:id/approve` (v2). */
export interface ApproveLinkSessionBody {
    code: string;
    totp_code?: string;
    backup_code?: string;
}

/** The v2 shape of `POST /v1/link/sessions/:id/approve`. */
export interface ApproveLinkSessionResponse {
    v: 2;
    claim_secret: string;
    user_id: string;
    approved_by_device_id: string;
    approved_by_device_name: string;
}

/** Machine-readable `error` values on the approve/claim 4xx bodies — mirrors
 *  `LINK_ERR` in `apps/api/src/link/link.constants.ts`. */
export const LINK_ERR = {
    CODE_REQUIRED: 'link_code_required',
    CODE_MISMATCH: 'link_code_mismatch',
    LOCKED: 'link_locked',
    TWO_FACTOR_REQUIRED: 'link_2fa_required',
    TWO_FACTOR_INVALID: 'link_2fa_invalid',
    WRONG_ACCOUNT: 'link_wrong_account',
    CLIENT_TOO_OLD: 'link_client_too_old',
} as const;
