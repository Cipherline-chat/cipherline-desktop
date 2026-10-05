/**
 * "Sign in on your phone" — THIS desktop is the signed-in device, showing an
 * INVITE QR for a brand-new phone to scan (the mirror of `qrSignInController`,
 * where this desktop is the new device). Plain, dependency-injected state
 * machine that `components/link/PhoneLinkPanel.tsx` is a thin view over,
 * testable without React (see `qrSignInController.ts`'s header for why).
 *
 * The exchange, desktop side (server: `LinkService.createInvite` →
 * `joinInvite` → `pollInvite` → v2 `approve` / `postGrant` / `claim`):
 *
 *   1. `POST /v1/link/invites` → invite id; render `cipherline://invite/1?i=…`
 *      LOCALLY. The QR carries the id only — no key, no token.
 *   2. Poll `GET /v1/link/invites/:id` every 2 s. `open` → still waiting.
 *   3. `joined` — a phone scanned and announced itself: its SELF-ASSERTED
 *      label + platform, its ephemeral public key, and whether approving
 *      will need this account's TOTP. The phone is now showing six digits.
 *   4. The human types those six digits (and a TOTP, if asked) here and
 *      presses Approve → `POST sessions/:id/approve`. A wrong code is refused
 *      with `attempts_left`; five wrong burn the invite (`locked`).
 *   5. On success the server returns a CLAIM SECRET (no tokens — A4). Seal a
 *      v2 grant to the phone's key in the main process (`linkSeal`) and
 *      `POST sessions/:id/grant`.
 *   6. Keep polling: `granted` → the phone is collecting; `claimed` → the
 *      phone redeemed the secret and is signed in. Done.
 *
 * Why the verification code protects THIS direction: a photograph of this
 * desktop's QR lets a stranger's phone `join` first — but the six digits then
 * appear on THAT stranger's phone, not on the user's, and the user has
 * nothing valid to type. The wrong device is never approved; the user shows
 * a new code. Server-side that is `LinkService.joinInvite`'s single-use join
 * plus `approve`'s code check.
 *
 * Why sealing to a server-relayed key is acceptable HERE (and only here) —
 * docs/QR-LINKING.md §2.5 forbids it for the forward flow: this desktop never
 * sees the phone's screen, so there is no camera to take the key from; and
 * under v2 the sealed grant carries a claim secret the server itself minted,
 * not tokens. A server substituting its own key would learn a secret it
 * already holds the hash of, for an account it can mint tokens for anyway.
 * The seal still hides the envelope from every third party polling the
 * unauthenticated session route. `LinkService.pollInvite` says the same.
 */

import type {
    ApproveLinkSessionBody, ApproveLinkSessionResponse, CreateLinkInviteResponse,
    LinkGrantPayloadV2, LinkInvitePollResponse,
} from '../types/link';
import { LINK_ERR } from '../types/link';

export type PhoneLinkPhase =
    | 'idle'       // "Show a code" prompt
    | 'starting'   // creating the invite
    | 'active'     // QR shown, polling, counting down (server: open)
    | 'joined'     // a phone joined — code (+ TOTP) entry is on screen
    | 'approving'  // approve + seal + grant in flight
    | 'granted'    // envelope posted; waiting for the phone to claim
    | 'done'       // the phone claimed — it is signed in
    | 'denied'     // "Not this phone" pressed here, or locked after five wrong codes
    | 'expired'
    | 'error';

export interface PhoneLinkSnapshot {
    phase: PhoneLinkPhase;
    qrDataUrl: string | null;
    remainingS: number;
    error: string | null;
    /** From `joined` on — SELF-ASSERTED by the phone, shown as such. */
    joined: { deviceLabel: string; platform: string | null; requires2fa: 'totp' | null } | null;
    /** Inline message for the code/TOTP form (wrong code, attempts left…),
     *  distinct from `error`, which ends the flow. */
    formError: string | null;
    /** With `phase === 'denied'`: why. */
    deniedReason: 'locked' | 'not_me' | null;
}

export interface PhoneLinkDeps {
    /** `POST /v1/link/invites` with JWT + `x-device-id`. */
    createInvite: () => Promise<CreateLinkInviteResponse>;
    /** `GET /v1/link/invites/:id` (owner-only). */
    pollInvite: (inviteId: string) => Promise<LinkInvitePollResponse>;
    /** `POST /v1/link/sessions/:id/approve` with the typed code (+ TOTP). */
    approve: (inviteId: string, body: ApproveLinkSessionBody) => Promise<ApproveLinkSessionResponse>;
    /** `POST /v1/link/sessions/:id/deny`. */
    deny: (inviteId: string) => Promise<void>;
    /** `window.electronAPI.linkSeal` — seals in the main process. */
    seal: (payload: LinkGrantPayloadV2, ekPubB64: string, linkId: string) => Promise<string>;
    /** `POST /v1/link/sessions/:id/grant`. */
    postGrant: (inviteId: string, envelopeB64: string) => Promise<void>;
    renderQr: (text: string) => Promise<string>;
    buildQrText: (inviteId: string) => string;
    pollIntervalMs: number;
    countdownTickMs: number;
}

const emptySnapshot: PhoneLinkSnapshot = {
    phase: 'idle', qrDataUrl: null, remainingS: 0, error: null, joined: null, formError: null, deniedReason: null,
};

const INVITE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CODE_PATTERN = /^\d{6}$/;

interface AxiosLike { isAxiosError?: boolean; response?: { status?: number; data?: { message?: unknown; error?: unknown; attempts_left?: unknown } } }

function axiosData(err: unknown): AxiosLike['response'] | null {
    if (err && typeof err === 'object' && 'isAxiosError' in err) return (err as AxiosLike).response ?? null;
    return null;
}

function describeError(err: unknown): string {
    if (err && typeof err === 'object' && 'isAxiosError' in err) {
        const res = axiosData(err);
        if (!res) return "Can't reach Cipherline — check your connection and try again.";
        const msg = res.data?.message;
        if (typeof msg === 'string' && msg) return msg;
    }
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong. Please try again.';
}

export class PhoneLinkController {
    private snapshot: PhoneLinkSnapshot = emptySnapshot;
    private listeners = new Set<(s: PhoneLinkSnapshot) => void>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private countdownTimer: ReturnType<typeof setInterval> | null = null;
    private expiresAtMs = 0;
    private inviteId: string | null = null;
    /** The phone's ephemeral key, from the `joined` poll. The one thing the
     *  grant is sealed to. */
    private phoneEkPubB64: string | null = null;
    private active = false;
    private disposed = false;
    private readonly deps: PhoneLinkDeps;

    constructor(deps: PhoneLinkDeps) {
        this.deps = deps;
    }

    getSnapshot(): PhoneLinkSnapshot { return this.snapshot; }

    subscribe(listener: (s: PhoneLinkSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private set(patch: Partial<PhoneLinkSnapshot>): void {
        if (this.disposed) return;
        this.snapshot = { ...this.snapshot, ...patch };
        for (const l of this.listeners) l(this.snapshot);
    }

    private clearTimers(): void {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    }

    private stop(): void {
        this.clearTimers();
        this.active = false;
        this.phoneEkPubB64 = null;
    }

    private fail(err: unknown, message = describeError(err)): void {
        this.stop();
        if (!this.disposed) this.set({ phase: 'error', error: message, qrDataUrl: null, formError: null });
    }

    private async poll(inviteId: string): Promise<void> {
        if (!this.active || this.disposed) return;
        let data: LinkInvitePollResponse;
        try {
            data = await this.deps.pollInvite(inviteId);
        } catch {
            return; // transient — the countdown is the authoritative give-up
        }
        if (!this.active || this.disposed || this.inviteId !== inviteId) return;

        switch (data.state) {
            case 'open':
                return;
            case 'joined':
                // The phone announced itself. Hold its key for the seal and
                // put the code form on screen — once; re-polls while the user
                // is typing must not reset the form.
                if (typeof data.ek_pub_b64 === 'string') this.phoneEkPubB64 = data.ek_pub_b64;
                if (this.snapshot.phase === 'active') {
                    this.set({
                        phase: 'joined',
                        joined: {
                            deviceLabel: data.device_label || 'a phone',
                            platform: data.platform ?? null,
                            requires2fa: data.requires_2fa === 'totp' ? 'totp' : null,
                        },
                        formError: null,
                    });
                }
                return;
            case 'approving':
                // Our own approve is in flight (or landed) — nothing to do until
                // the grant is posted; `approve()` drives that.
                return;
            case 'granted':
                if (this.snapshot.phase === 'approving') this.set({ phase: 'granted' });
                return;
            case 'claimed':
                this.stop();
                if (!this.disposed) this.set({ phase: 'done', qrDataUrl: null, formError: null });
                return;
            case 'denied':
                this.stop();
                if (!this.disposed) {
                    this.set({ phase: 'denied', deniedReason: data.reason === 'locked' ? 'locked' : 'not_me', qrDataUrl: null, formError: null });
                }
                return;
            case 'expired':
                this.stop();
                if (!this.disposed) this.set({ phase: 'expired', qrDataUrl: null, formError: null });
                return;
        }
    }

    /** "Show a code" / "Show a new code". */
    async begin(): Promise<void> {
        this.stop();
        this.set({ ...emptySnapshot, phase: 'starting' });
        try {
            const created = await this.deps.createInvite();
            if (this.disposed) return;
            if (!INVITE_ID_PATTERN.test(created.invite_id)) {
                throw new Error('The sign-in code was malformed. Please try again.');
            }
            const qrDataUrl = await this.deps.renderQr(this.deps.buildQrText(created.invite_id));
            if (this.disposed) return;

            this.inviteId = created.invite_id;
            this.expiresAtMs = Date.parse(created.expires_at);
            this.active = true;
            this.set({
                phase: 'active', qrDataUrl,
                remainingS: Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000)),
            });

            const inviteId = created.invite_id;
            this.pollTimer = setInterval(() => { void this.poll(inviteId); }, this.deps.pollIntervalMs);
            this.countdownTimer = setInterval(() => {
                const remaining = Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000));
                this.set({ remainingS: remaining });
                if (remaining <= 0) {
                    // No auto-refresh (same reasoning as the sign-in QR).
                    this.stop();
                    if (!this.disposed) this.set({ phase: 'expired', qrDataUrl: null, formError: null });
                }
            }, this.deps.countdownTickMs);
        } catch (err) {
            this.fail(err);
        }
    }

    /**
     * The human typed the six digits off the phone's screen (and a TOTP, if
     * the account has one). Approve → seal → grant. Wrong code: stays on the
     * form with the server's message; locked: the flow ends.
     */
    async approve(code: string, second: { totp_code?: string; backup_code?: string } = {}): Promise<void> {
        const inviteId = this.inviteId;
        const ekPub = this.phoneEkPubB64;
        if (this.snapshot.phase !== 'joined' || !inviteId || !ekPub || this.disposed) return;
        const trimmed = code.replace(/\s+/g, '');
        if (!CODE_PATTERN.test(trimmed)) {
            this.set({ formError: 'Enter the six-digit code shown on your phone.' });
            return;
        }
        this.set({ phase: 'approving', formError: null });
        let approved: ApproveLinkSessionResponse;
        try {
            const body: ApproveLinkSessionBody = { code: trimmed };
            if (second.totp_code) body.totp_code = second.totp_code.replace(/\s+/g, '');
            else if (second.backup_code) body.backup_code = second.backup_code.trim();
            approved = await this.deps.approve(inviteId, body);
        } catch (err) {
            if (this.disposed) return;
            const res = axiosData(err);
            const errorCode = typeof res?.data?.error === 'string' ? res.data.error : null;
            if (errorCode === LINK_ERR.LOCKED) {
                this.stop();
                this.set({ phase: 'denied', deniedReason: 'locked', qrDataUrl: null, formError: null });
                return;
            }
            if (errorCode === LINK_ERR.CODE_MISMATCH || errorCode === LINK_ERR.TWO_FACTOR_INVALID
                || errorCode === LINK_ERR.TWO_FACTOR_REQUIRED || errorCode === LINK_ERR.CODE_REQUIRED) {
                // Recoverable: back to the form with the server's own words.
                const left = typeof res?.data?.attempts_left === 'number' ? res.data.attempts_left : null;
                const base = describeError(err);
                this.set({
                    phase: 'joined',
                    formError: left !== null ? `${base} ${left} ${left === 1 ? 'try' : 'tries'} left.` : base,
                    joined: this.snapshot.joined && errorCode === LINK_ERR.TWO_FACTOR_REQUIRED
                        ? { ...this.snapshot.joined, requires2fa: 'totp' }
                        : this.snapshot.joined,
                });
                return;
            }
            this.fail(err);
            return;
        }
        if (this.disposed) return;

        try {
            if (approved.v !== 2 || typeof approved.claim_secret !== 'string') {
                // The server minted tokens at approve — a contract this desktop
                // does not speak for another device. Never seal tokens here.
                throw new Error('The server answered in a form this app does not support. Please update Cipherline.');
            }
            const payload: LinkGrantPayloadV2 = {
                type: 'link_grant', v: 2, link_id: inviteId,
                user_id: approved.user_id,
                claim_secret: approved.claim_secret,
                approved_by_device_id: approved.approved_by_device_id,
                approved_by_device_name: approved.approved_by_device_name,
                issued_at: new Date().toISOString(),
            };
            const envelope = await this.deps.seal(payload, ekPub, inviteId);
            if (this.disposed) return;
            await this.deps.postGrant(inviteId, envelope);
            if (this.disposed) return;
            this.set({ phase: 'granted', qrDataUrl: null });
            // Polling continues: `claimed` flips us to `done`.
        } catch (err) {
            this.fail(err);
        }
    }

    /** "Not this phone" — burn the invite so the joined device can never be approved. */
    async denyJoined(): Promise<void> {
        const inviteId = this.inviteId;
        if (this.snapshot.phase !== 'joined' || !inviteId || this.disposed) return;
        this.stop();
        try { await this.deps.deny(inviteId); } catch { /* the TTL is the backstop */ }
        if (!this.disposed) this.set({ phase: 'denied', deniedReason: 'not_me', qrDataUrl: null, formError: null });
    }

    /** "Cancel" — back to idle. Nothing to purge server-side: an unjoined
     *  invite is worthless and expires on its own. */
    cancel(): void {
        this.stop();
        this.inviteId = null;
        if (!this.disposed) this.set({ ...emptySnapshot, phase: 'idle' });
    }

    dispose(): void {
        if (this.disposed) return;
        this.stop();
        this.disposed = true;
    }
}
