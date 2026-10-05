/**
 * QR sign-in — the session/poll/countdown state machine, factored out of
 * `components/link/QrSignInPanel.tsx` so it is testable without mounting
 * React. `apps/desktop`'s vitest config runs a plain Node environment with no
 * DOM and no `@testing-library` (see `vitest.config.ts`'s header comment) —
 * every existing suite in this app tests logic modules directly rather than
 * rendering components, and this follows the same convention rather than
 * introducing a new one. The component is a thin view wired to this via
 * `subscribe`/`getSnapshot`; `QrSignInPanel.test.ts` exercises it directly
 * (deliberately `.ts`, not `.tsx` — that file's header explains why).
 *
 * Full design + threat model: docs/QR-LINKING.md §2, §7. The 2026-09-28
 * hardening this file implements on the NEW-device side:
 *
 *   A1 — this device generates a six-digit VERIFICATION CODE per session and
 *        sends its hash with the session; it is shown on screen ONLY once the
 *        server reports `scanned` (a signed-in device pointed a camera at the
 *        QR). The approver must type it. A photograph of the QR predates the
 *        scan and never contains it, so a stranger who scans the photo cannot
 *        approve this desktop into THEIR account. Five wrong guesses burn the
 *        session (`denied`, `reason: 'locked'`) — this device asks for a new
 *        code.
 *   A4 — the grant this device opens carries a CLAIM SECRET, not tokens. The
 *        token pair is minted by `POST /v1/link/sessions/:id/claim`, called
 *        from `openGrant` with the secret. A grant nobody opens never becomes
 *        a session. (A v1 grant — tokens inside — is still opened, for a
 *        legacy approver.)
 *   QR-1 confirm screen now names the account with avatar + handle + which
 *        device approved, all resolved from the NEW token via `/auth/me`.
 */

import type { ClaimLinkSessionResponse, LinkGrantPayload, LinkPollResponse } from '../types/link';

export type QrSignInPhase =
    | 'idle'        // "Show a code" prompt
    | 'starting'    // minting the key + POSTing the session
    | 'active'      // QR shown, polling, counting down (server: pending)
    | 'scanned'     // server: scanned — a signed-in device read the QR; the verification code is on screen
    | 'approving'   // server: approving — phone said yes, sealing in progress
    | 'opening'     // server: granted — decrypting/claiming, or (post-confirm) registering this device
    // QR-1 (adversarial review) — this phase sits between 'opening' (decrypt +
    // claim done, nothing persisted yet) and 'success': it shows the
    // AUTHORITATIVE identity the new access token resolves to — fetched from
    // the server, never taken from the grant, which the approving device
    // writes and could put anything in — and waits for the user to confirm
    // before anything is persisted.
    | 'confirm'
    | 'success'     // logged in; the panel is about to be unmounted by the parent
    | 'expired'
    | 'denied'
    | 'error';

export interface QrSignInSnapshot {
    phase: QrSignInPhase;
    fingerprint: string | null;
    qrDataUrl: string | null;
    remainingS: number;
    error: string | null;
    /** The six digits the approver must type. Generated at `begin`, kept
     *  private (never on screen, never in the QR) until `phase === 'scanned'`;
     *  the view must render it only then. */
    verificationCode: string | null;
    /** With `phase === 'denied'`: `'locked'` when the server burned the
     *  session after five wrong codes (as opposed to the approver saying
     *  "Not me"). */
    deniedReason: 'locked' | null;
    /** Populated only during 'confirm' — the identity to show the user
     *  ("You are about to sign in as @name#1234") before anything is
     *  persisted. Everything but `approvedByDeviceName` comes from `whoAmI`,
     *  resolved server-side from the NEW access token — never from the grant. */
    confirmIdentity: {
        userId: string;
        username: string;
        discriminator: number | null;
        /** Encrypted-avatar attachment id (or null) from `/auth/me`. */
        avatarUrl: string | null;
        /** Display-only context — which of the approving account's devices
         *  said yes. NOT part of the QR-1 trust decision. */
        approvedByDeviceName: string;
    } | null;
}

/** Mirrors `electron/link-grant.ts`'s `LinkGrantPayload` — see
 *  `src/types/link.ts` for why this is a hand-kept mirror, not an import. */
export type LinkGrantResult = LinkGrantPayload;

export interface CreateSessionResult {
    link_id: string;
    expires_at: string;
    ttl_s: number;
}

export type PollResult = LinkPollResponse;

/**
 * Everything the controller needs from the outside world, injected rather
 * than imported directly — this is the whole reason it is testable without
 * Electron, a network, or React. `realDeps()` in `QrSignInPanel.tsx` wires
 * these to the real IPC bridge, `axios`, and `AuthContext`; tests wire them
 * to mocks.
 */
export interface QrSignInDeps {
    linkBegin: (linkId: string) => Promise<{ ekPubB64: string; fingerprint: string }>;
    linkBind: (linkId: string) => Promise<void>;
    linkOpen: (envelopeB64: string, linkId: string) => Promise<LinkGrantResult>;
    linkEnd: () => Promise<void>;
    getDeviceName: () => Promise<string>;
    /** 'windows' | 'mac' | 'linux' — display-only, self-asserted to the approver. */
    getPlatform: () => string;
    /** Six random decimal digits from a CSPRNG. Injected so tests can pin it. */
    generateCode: () => string;
    createSession: (ekPubB64: string, deviceLabel: string, code: string, platform: string) => Promise<CreateSessionResult>;
    pollSession: (linkId: string) => Promise<PollResult>;
    /** v2 — `POST /v1/link/sessions/:id/claim` with the secret found inside the
     *  opened grant. THIS is where the token pair is minted. */
    claimSession: (linkId: string, claimSecret: string) => Promise<ClaimLinkSessionResponse>;
    /** Authenticated with the NEW token, per docs/QR-LINKING.md step 7. */
    destroySession: (linkId: string, accessToken: string) => Promise<void>;
    /** Same device-registration path a password login uses. */
    registerDevice: (userId: string, accessToken: string) => Promise<{ deviceId: string; requiresPairing: boolean }>;
    /** AuthContext's `login()` — persists the session via `secureLocalStore`,
     *  never raw `localStorage`. */
    // AuthContext's own `login` is typed `void | Promise<void>` even though
    // the real implementation is always async — matching that here (rather
    // than narrowing to `Promise<void>`) is what lets `realDeps` pass it
    // straight through. `await`ing a `void` value is harmless in JS.
    login: (token: string, userId: string, deviceId: string, requiresPairing: boolean, refreshToken?: string) => void | Promise<void>;
    /**
     * QR-1 — the AUTHORITATIVE "whose account does this new token belong to"
     * check. Resolves the identity the server itself attaches to
     * `accessToken` (the same "who am I" call `AuthContext` makes after a
     * password login) — this is the only source `openGrant` may trust for
     * the confirmation screen. The grant's `user_id` is not enough on its
     * own (a raw UUID means nothing to a human deciding "is this me") and
     * the grant carries no display name at all — by design: a display name
     * would be written by the approving device, which could be a hostile
     * account putting any string it likes into the field this dialog shows
     * the victim.
     */
    whoAmI: (accessToken: string) => Promise<{ user_id: string; username: string; discriminator: number | null; avatar_url: string | null }>;
    /** Renders a QR data URL LOCALLY from a string this module already built —
     *  see `buildQrText` below for why the string itself must never come from
     *  the server. */
    renderQr: (text: string) => Promise<string>;
    /** Builds the QR payload string from the link id and the EK PUB KEY THIS
     *  MODULE GOT FROM `linkBegin` — never from a server response field.
     *  docs/QR-LINKING.md §2.5: a server-rendered/sourced QR would let a
     *  hostile API pod substitute a key it holds the private half of. */
    buildQrText: (linkId: string, ekPubB64: string) => string;
    pollIntervalMs: number;
    countdownTickMs: number;
}

const emptySnapshot: QrSignInSnapshot = {
    phase: 'idle', fingerprint: null, qrDataUrl: null, remainingS: 0, error: null,
    verificationCode: null, deniedReason: null, confirmIdentity: null,
};

/** QR-1's hazard-naming copy — shown when the user rejects the confirmation
 *  screen, or when `whoAmI` cannot be resolved at all (fail closed: no
 *  identity to show means no basis to let the user confirm). Names what is
 *  actually happening rather than a generic failure, per the review: a
 *  generic "sign-in failed" reads like a bug, not like "someone else's
 *  account approved this code." */
const ACCOUNT_MISMATCH_MESSAGE =
    "That code was approved by someone else's account. Do not sign in — show a new code.";

/** Server-issued link ids are 22-char base64url (the same shape mobile's
 *  `ID_PATTERN` requires). QR-4 (adversarial review): `created.link_id` is
 *  interpolated into the QR string this device renders, and a hostile or
 *  compromised API pod that returns something shaped like
 *  `"<22 chars>&k=<attacker key>"` would let a duplicate `&k=` parameter
 *  smuggle an attacker-controlled ephemeral key past the mobile scanner's
 *  first-wins rule — see `linkQr.ts`'s `buildLinkQr` doc for the full
 *  mechanics. Rejecting outright here (before the id is bound to the
 *  in-flight session or built into a QR at all) is defence in depth on top
 *  of `buildLinkQr`'s `encodeURIComponent` and `link-grant.ts`'s
 *  `bindLinkSession` doing the same check main-process-side. */
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CODE_PATTERN = /^\d{6}$/;

/** Six decimal digits from `crypto.getRandomValues`, rejection-sampled so
 *  every code is equally likely. The default `generateCode` dep. */
export function generateVerificationCode(): string {
    const buf = new Uint32Array(1);
    // 4_294_000_000 = the largest multiple of 1_000_000 that fits in 32 bits.
    for (;;) {
        crypto.getRandomValues(buf);
        if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, '0');
    }
}

/** Same message-extraction convention `AuthScreen.tsx` uses everywhere else,
 *  minus the axios-specific bits (the deps functions may throw plain Errors —
 *  their own callers are responsible for translating HTTP failures). */
function describeError(err: unknown): string {
    if (err && typeof err === 'object' && 'isAxiosError' in err) {
        const axErr = err as { response?: { data?: { message?: unknown } } };
        if (!axErr.response) return "Can't reach Cipherline — check your connection and try again.";
        const msg = axErr.response?.data?.message;
        if (typeof msg === 'string' && msg) return msg;
    }
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong. Please try again.';
}

/** What `openGrant` holds between the confirm screen and `confirmAccount`:
 *  a REAL token pair (claimed for v2, unsealed for v1) that nothing has
 *  persisted yet. */
interface PendingSession {
    link_id: string;
    user_id: string;
    access_token: string;
    refresh_token: string;
    approved_by_device_name: string;
}

export class QrSignInController {
    private snapshot: QrSignInSnapshot = emptySnapshot;
    private listeners = new Set<(s: QrSignInSnapshot) => void>();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private countdownTimer: ReturnType<typeof setInterval> | null = null;
    private expiresAtMs = 0;
    /** True only while a session is live and should still react to poll
     *  results / countdown ticks — guards a stale async callback (a poll in
     *  flight when the countdown hits zero, or `dispose()` mid-request) from
     *  acting after the flow already moved on. */
    private active = false;
    private disposed = false;
    /** QR-1 — the opened-but-not-yet-persisted session, held only while
     *  `phase === 'confirm'`. Nothing in this class may call `deps.login`
     *  with anything other than the session sitting here, and only from
     *  `confirmAccount()`. */
    private pending: PendingSession | null = null;
    /** The verification code for the CURRENT session, generated in `begin`.
     *  Mirrored into the snapshot as `verificationCode` (the view shows it
     *  only from `scanned` on). */
    private code: string | null = null;
    // Not a constructor parameter property: this app's tsconfig sets
    // `erasableSyntaxOnly`, which forbids that shorthand (it is not purely
    // type-level — it generates an assignment), so the field is declared
    // above and assigned explicitly instead.
    private readonly deps: QrSignInDeps;

    constructor(deps: QrSignInDeps) {
        this.deps = deps;
    }

    getSnapshot(): QrSignInSnapshot {
        return this.snapshot;
    }

    subscribe(listener: (s: QrSignInSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private set(patch: Partial<QrSignInSnapshot>): void {
        if (this.disposed) return;
        this.snapshot = { ...this.snapshot, ...patch };
        for (const l of this.listeners) l(this.snapshot);
    }

    private clearTimers(): void {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    }

    /** Stop everything and discard the main-process session. Does not itself
     *  change `phase` — callers set whatever phase fits why they stopped. */
    private async stopSession(): Promise<void> {
        this.clearTimers();
        this.active = false;
        this.code = null;
        try { await this.deps.linkEnd(); } catch { /* best-effort */ }
    }

    /** Never call the outside world (main process, network) after dispose. */
    private guard(): boolean {
        return !this.disposed;
    }

    private fail(err: unknown, message = describeError(err)): void {
        if (this.guard()) {
            this.set({
                phase: 'error', error: message, qrDataUrl: null, fingerprint: null,
                verificationCode: null, confirmIdentity: null,
            });
        }
    }

    /**
     * Step 6/7 of docs/QR-LINKING.md §2.3 — server said `granted`. Decrypt,
     * turn the grant into a token pair (v2: redeem the claim secret — this is
     * the moment the server mints; v1: the tokens were inside), then STOP:
     * resolve which account that token actually belongs to and let the user
     * confirm before anything is registered or persisted.
     *
     * QR-1 (adversarial review): this used to go straight from a successful
     * decrypt to `login()` with nobody ever having been told which account
     * they were about to join. This method now only gets as far as showing
     * that account; `confirmAccount()` is the one that persists, and only on
     * explicit confirmation.
     */
    private async openGrant(envelopeB64: string, linkId: string): Promise<void> {
        this.set({ phase: 'opening', verificationCode: null });
        try {
            const grant = await this.deps.linkOpen(envelopeB64, linkId);
            if (!this.guard()) return;

            let tokens: { access_token: string; refresh_token: string; user_id: string };
            if (grant.v === 2) {
                // A4: nothing exists yet. Redeem the secret — exactly once —
                // and the server mints the pair for THIS device's request.
                tokens = await this.deps.claimSession(linkId, grant.claim_secret);
                if (!this.guard()) return;
            } else {
                tokens = { access_token: grant.access_token, refresh_token: grant.refresh_token, user_id: grant.user_id };
            }

            // QR-1: resolve the AUTHORITATIVE identity for the NEW token —
            // never the grant's own fields, which the approving device wrote
            // and a hostile approver fully controls. See `whoAmI`'s doc on
            // `QrSignInDeps` above.
            let identity: Awaited<ReturnType<QrSignInDeps['whoAmI']>>;
            try {
                identity = await this.deps.whoAmI(tokens.access_token);
            } catch {
                // No authoritative identity to show means no basis to let
                // the user confirm anything — fail exactly like an explicit
                // rejection, not like a retryable network blip.
                await this.rejectGrant();
                return;
            }
            if (!this.guard()) return;

            this.pending = {
                link_id: linkId,
                user_id: identity.user_id || tokens.user_id,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                approved_by_device_name: grant.approved_by_device_name,
            };
            this.set({
                phase: 'confirm',
                confirmIdentity: {
                    userId: identity.user_id || tokens.user_id,
                    username: identity.username,
                    discriminator: identity.discriminator,
                    avatarUrl: identity.avatar_url ?? null,
                    approvedByDeviceName: grant.approved_by_device_name,
                },
            });
        } catch (err) {
            await this.stopSession();
            this.fail(err);
        }
    }

    /**
     * QR-1 — "Continue": the user looked at the resolved account and
     * confirmed it is theirs. This is the ONLY path in this class that ends
     * in `deps.login(...)`, and it may only run against `this.pending` —
     * the exact session the confirmation screen was built from, never a
     * fresher or different one. Register the device, persist via
     * AuthContext's login(), best-effort purge the server-side session.
     */
    async confirmAccount(): Promise<void> {
        const session = this.pending;
        if (!session || !this.guard()) return;
        this.pending = null;
        this.set({ phase: 'opening', confirmIdentity: null });
        try {
            const { deviceId, requiresPairing } = await this.deps.registerDevice(session.user_id, session.access_token);
            if (requiresPairing) {
                // Should not happen — device auto-registration has no
                // human-approval gate (CLAUDE.md) — but never sign in
                // half-approved if the server ever disagrees.
                throw new Error('This device still needs approval. Please sign in with your password instead.');
            }
            if (!this.guard()) return;

            // QR-1: this is the persist call site — the ONLY place in this
            // file `deps.login` is ever called. It sits downstream of an
            // explicit user confirmation because a link session is
            // account-agnostic BY CONSTRUCTION (docs/QR-LINKING.md §2.8);
            // the verification code makes substitution structurally hard,
            // the confirmation makes whatever remains visible.
            await this.deps.login(session.access_token, session.user_id, deviceId, false, session.refresh_token);
            this.active = false;

            // Best-effort purge, authenticated with the NEW token — itself
            // proof the grant was opened. A failure here is harmless (the
            // session expires on its own) and must never block the sign-in
            // that already succeeded.
            try {
                await this.deps.destroySession(session.link_id, session.access_token);
            } catch { /* harmless — session expires on its own */ }

            if (this.guard()) this.set({ phase: 'success' });
        } catch (err) {
            await this.stopSession();
            this.fail(err);
        }
    }

    /**
     * QR-1 — "This isn't my account": the user looked at the resolved
     * identity and it was not theirs. Discards everything: no token is ever
     * persisted, the main-process session is torn down, and the user is
     * shown copy that names the hazard rather than a generic failure.
     */
    async rejectAccount(): Promise<void> {
        this.pending = null;
        await this.rejectGrant();
    }

    /** Shared by an explicit rejection and a `whoAmI` failure — both mean
     *  "no confirmed identity to proceed on," so both discard the same way. */
    private async rejectGrant(): Promise<void> {
        this.active = false;
        await this.stopSession();
        this.fail(null, ACCOUNT_MISMATCH_MESSAGE);
    }

    private async poll(linkId: string): Promise<void> {
        if (!this.active || !this.guard()) return;
        let data: PollResult;
        try {
            data = await this.deps.pollSession(linkId);
        } catch {
            // Transient network hiccup: skip this tick, try again on the next
            // one. The countdown — not a poll-failure count — is the
            // authoritative "give up" signal, matching the design's
            // no-auto-refresh stance.
            return;
        }
        if (!this.active || !this.guard()) return; // may have expired while this was in flight

        switch (data.state) {
            case 'pending':
                return;
            case 'scanned':
                // A1: a signed-in device has read the QR. NOW the verification
                // code goes on screen — and only now. Until this tick it has
                // existed solely in this controller's memory.
                if (this.snapshot.phase === 'active') this.set({ phase: 'scanned', verificationCode: this.code });
                return;
            case 'approving':
                this.set({ phase: 'approving', verificationCode: null });
                return;
            case 'denied':
                await this.stopSession();
                if (this.guard()) this.set({ phase: 'denied', deniedReason: data.reason === 'locked' ? 'locked' : null, verificationCode: null });
                return;
            case 'expired':
                await this.stopSession();
                if (this.guard()) this.set({ phase: 'expired', verificationCode: null });
                return;
            case 'claimed':
                // Only reachable if somebody else redeemed OUR secret — which
                // requires our private key. Treat as a contract violation.
                await this.stopSession();
                this.fail(null, 'This sign-in was completed elsewhere. Please show a new code.');
                return;
            case 'granted':
                this.clearTimers(); // stop polling/counting down; openGrant drives from here
                if (!data.envelope_b64) {
                    // Contract violation, not a user-facing state — granted
                    // always carries the envelope. Never proceed without one.
                    this.active = false;
                    await this.stopSession();
                    this.fail(null, 'Sign-in response was incomplete. Please try again.');
                    return;
                }
                await this.openGrant(data.envelope_b64, linkId);
                return;
        }
    }

    /** "Show a code" / "Show a new code" — always starts a FRESH session,
     *  never reuses a key (or a verification code) from a previous attempt
     *  (mirrors `beginLinkSession`'s own "discard, don't pool" stance on the
     *  main-process side). */
    async begin(): Promise<void> {
        this.set({ ...emptySnapshot, phase: 'starting' });
        try {
            // 1. Mint the ephemeral keypair BEFORE the server-issued link_id
            //    exists — the POST body needs the public key, but the POST is
            //    what mints the id. `linkBind` below attaches the real id
            //    once we have it (main.ts's 'link:begin' handler doc has the
            //    fuller rationale for this ordering).
            const { ekPubB64, fingerprint } = await this.deps.linkBegin('');
            if (!this.guard()) return;

            // A1: the verification code is minted here, alongside the key,
            // and its hash rides in the create call. It goes nowhere else
            // until the server says `scanned`.
            const code = this.deps.generateCode();
            if (!CODE_PATTERN.test(code)) throw new Error('Could not generate a verification code. Please try again.');
            this.code = code;

            const deviceLabel = (await this.deps.getDeviceName())?.trim() || 'Cipherline Desktop';
            const created = await this.deps.createSession(ekPubB64, deviceLabel, code, this.deps.getPlatform());
            if (!this.guard()) return;

            // QR-4: validate the server-issued id BEFORE it is bound to the
            // session or built into anything the QR renders — see
            // LINK_ID_PATTERN's doc above.
            if (!LINK_ID_PATTERN.test(created.link_id)) {
                throw new Error('Sign-in code was malformed. Please try again.');
            }

            // 2. Attach the real id to the session already in flight.
            await this.deps.linkBind(created.link_id);
            if (!this.guard()) return;

            // 3. Build the QR text LOCALLY from linkId + the IPC-returned
            //    key — `created` (the POST response) contributes ONLY the
            //    link id, never the key. See `buildQrText`'s doc above.
            const qrText = this.deps.buildQrText(created.link_id, ekPubB64);
            const qrDataUrl = await this.deps.renderQr(qrText);
            if (!this.guard()) return;

            this.expiresAtMs = Date.parse(created.expires_at);
            this.active = true;
            this.set({
                phase: 'active',
                fingerprint,
                qrDataUrl,
                remainingS: Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000)),
                error: null,
            });

            const linkId = created.link_id;
            this.pollTimer = setInterval(() => { void this.poll(linkId); }, this.deps.pollIntervalMs);
            this.countdownTimer = setInterval(() => {
                const remaining = Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000));
                this.set({ remainingS: remaining });
                if (remaining <= 0) {
                    // Local countdown is the primary expiry signal —
                    // deliberately NOT auto-refreshed (an indefinitely
                    // refreshing QR on an unattended screen is a standing
                    // invitation to a shoulder-surfer, and hides expiry from
                    // the user).
                    this.clearTimers();
                    this.active = false;
                    this.code = null;
                    void this.deps.linkEnd().catch(() => { /* best-effort */ });
                    if (this.guard()) this.set({ phase: 'expired', verificationCode: null });
                }
            }, this.deps.countdownTickMs);
        } catch (err) {
            await this.stopSession();
            this.fail(err);
        }
    }

    /** "Cancel" — back to the idle prompt without generating a new code. */
    async cancel(): Promise<void> {
        this.pending = null;
        await this.stopSession();
        if (this.guard()) this.set({ ...emptySnapshot, phase: 'idle' });
    }

    /** Unmount cleanup: never leave the main process holding an ephemeral
     *  private key for a session nothing is looking at any more. Safe to call
     *  more than once and safe to call with no session in flight. */
    dispose(): void {
        if (this.disposed) return;
        this.clearTimers();
        this.active = false;
        this.pending = null;
        this.code = null;
        this.disposed = true;
        void this.deps.linkEnd().catch(() => { /* best-effort */ });
    }
}
