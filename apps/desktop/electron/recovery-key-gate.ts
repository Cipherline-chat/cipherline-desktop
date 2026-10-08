/**
 * recovery-key-gate — the decision half of `secure:reveal-recovery-key`.
 *
 * UPDATE (2026-10-05) — THE SIGNUP CARVE-OUT IS GONE. From 2026-09-20 the
 * registration wizard revealed the key automatically, with no dialog, through
 * a separate ungated channel (`secure:reveal-recovery-key-signup`) — an owner
 * decision taken with the analysis below in hand, which accepted the residual
 * risk that main cannot tell a brand-new signup from a second device logging
 * into a non-empty vault. Onboarding round 6 removed the wizard's recovery-key
 * step altogether (the key is offered from Settings only), so that channel had
 * no caller left and was deleted rather than kept as an unused ungated path.
 * Today there is exactly ONE reveal channel, `secure:reveal-recovery-key`,
 * gated by this module, used by Settings (`RecoveryKeyCard.tsx`).
 * Everything below is the original rationale and applies in full again: do
 * not add an ungated reveal for onboarding without re-reading it and checking
 * with the owner. recovery-key-gate.test.ts pins that no ungated channel
 * exists.
 *
 * WHAT THIS PROTECTS
 * The device master key is the root of everything stored at rest on this
 * machine: it unwraps the Signal identity private key, every prekey, channel
 * keys, avatar keys and the Drive OAuth tokens in electron/storage.ts, AND
 * (via HKDF(master, userId)) every record in the renderer's encrypted
 * IndexedDB store. It also decrypts every backup container the device has
 * ever written. Unlike a session token it does not rotate and it does not
 * expire — a copy taken once is good against the whole vault, offline,
 * forever. That persistence is the reason this channel gets a control at all
 * when "a compromised renderer already sees rendered plaintext" is true.
 *
 * WHY A MAIN-PROCESS DIALOG AND NOT SOMETHING CHEAPER
 * The threat model here is a compromised renderer — attacker code running
 * inside our own window. The IPC sender guard (electron/ipc-guard.ts) does
 * not help: it answers "is this really our renderer?", and our renderer is
 * the compromised party. Nor does anything the renderer can assert about
 * itself. Electron exposes no trustworthy user-gesture bit on an invoke
 * event, and window focus is trivially satisfied by the same attacker code.
 * A main-process modal is the only signal in reach that attacker code cannot
 * manufacture: it requires a human at the keyboard choosing the non-default
 * button. Same reasoning, same shape as the `updater:set-channel` gate.
 *
 * WHY THERE IS NO ONBOARDING CARVE-OUT
 * The obvious refinement is to let the registration wizard reveal once,
 * ungated, on the theory that a seconds-old account has nothing worth
 * stealing. Implementing that safely requires MAIN to own the answer to "has
 * registration completed?", because a renderer-asserted "I'm still
 * onboarding" is not a gate. Main cannot own it:
 *
 *   • Device registration — and therefore `ensureSignalIdentity()`, the
 *     identity key, prekeys and `registration_id` — runs in AuthScreen's
 *     `registerOrReuseDevice()` BEFORE the wizard is mounted. Every keystore
 *     marker main writes is already present during the window the carve-out
 *     would cover, so none of them can discriminate it.
 *   • Arming the grace when main creates a brand-new keystore does not work
 *     either: a fresh keystore is also what a SECOND DEVICE gets when the
 *     user logs into an existing account, and that path never renders the
 *     wizard. The grace would sit armed and unconsumed on a device that
 *     immediately syncs a full history — precisely the loaded-vault case the
 *     control exists for.
 *   • Nothing else reaches main at login (`AuthContext.login` touches no IPC
 *     channel), so there is no main-observed latch to close the window with.
 *     Adding one the renderer must call back means the grace stays open for
 *     exactly the renderer that declines to call it.
 *
 * So the carve-out has no forgery-proof implementation, and an unconsumed
 * grace is strictly worse than no grace: it reads as protection while
 * handing over the key on demand. This is why, ORIGINALLY, both callers were
 * gated identically, and the wizard's step-1 auto-reveal was an explicit
 * button so the dialog was always the answer to a click the user just made —
 * which was the real objection to confirming during signup at the time. See
 * the UPDATE notice at the top of this file: that is no longer the state of
 * the code. The analysis directly above did not stop being true; the owner
 * decided to accept the residual risk it describes anyway.
 *
 * DIALOG FATIGUE
 * A confirm-on-reveal gate fails if attacker code can re-ask until the user
 * clicks through. Two bounds, both enforced here rather than in the dialog:
 * only one request may be in flight at a time, and a decline silences
 * further requests for a cooldown. Neither is sufficient alone against a
 * patient attacker; together they make "spam until yes" slow and visible
 * instead of instant.
 *
 * This module deliberately imports nothing from `electron` so it is covered
 * by the vitest suite (see vitest.config.ts's note on electron/** scope).
 * main.ts injects the real keystore and the real `dialog.showMessageBox`.
 */

export type RevealResult =
    | { ok: true; keyB64: string }
    /** The keystore is locked — there is no key to show (see StorageLockedScreen). */
    | { ok: false; reason: 'locked' }
    /** The human said no, or a request arrived during the post-decline cooldown. */
    | { ok: false; reason: 'declined' }
    /** A confirmation is already on screen; this request was dropped, not queued. */
    | { ok: false; reason: 'busy' };

export interface RecoveryKeyGateDeps {
    /** Keystore lock state. */
    isLocked: () => boolean;
    /** Reads the master key. Called ONLY after a human has approved. */
    getMasterKeyB64: () => string | null;
    /** Shows the main-process confirmation. Resolves true only on approval. */
    confirm: () => Promise<boolean>;
    /** Injectable clock so the cooldown is testable without real time. */
    now?: () => number;
}

/** How long a "no" suppresses further prompts. Long enough that a scripted
 *  retry loop cannot wear the user down in a single sitting; short enough
 *  that a user who mis-clicked Cancel just tries again. */
export const DECLINE_COOLDOWN_MS = 30_000;

/**
 * Builds the guarded reveal. The returned function is the entire body of the
 * `secure:reveal-recovery-key` handler: main.ts awaits keystore init, then
 * calls this.
 */
export function createRecoveryKeyGate(deps: RecoveryKeyGateDeps): () => Promise<RevealResult> {
    const now = deps.now ?? Date.now;
    let inFlight = false;
    let declinedUntil = 0;

    return async function revealRecoveryKey(): Promise<RevealResult> {
        // Check lock first: a locked store has no key, so prompting a human
        // about one would be a dialog that cannot lead anywhere.
        if (deps.isLocked()) return { ok: false, reason: 'locked' };

        if (inFlight) return { ok: false, reason: 'busy' };
        if (now() < declinedUntil) return { ok: false, reason: 'declined' };

        inFlight = true;
        let approved = false;
        try {
            approved = await deps.confirm();
        } catch {
            // A dialog that failed to open is not consent. Fail closed.
            approved = false;
        } finally {
            inFlight = false;
        }

        if (!approved) {
            declinedUntil = now() + DECLINE_COOLDOWN_MS;
            return { ok: false, reason: 'declined' };
        }

        // Only now does the key get read — a declined request never
        // materialises it, so there is nothing for a bug downstream to leak.
        const keyB64 = deps.getMasterKeyB64();
        if (!keyB64) return { ok: false, reason: 'locked' };
        return { ok: true, keyB64 };
    };
}
