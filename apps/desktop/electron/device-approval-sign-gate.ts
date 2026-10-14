/**
 * device-approval-sign-gate — the decision half of the two channels that let
 * THIS device vouch for another one: `crypto:device-approval-sign` (approve /
 * deny a pending device) and `crypto:link-approval-sign` (approve a QR-linked
 * session).
 *
 * WHAT THIS PROTECTS
 * An approval is an Ed25519 signature by this device's identity key, and the
 * server treats it as "an approved device of this account vouched for that
 * key". The signed device then receives every message, channel key and call
 * key from that moment on. The signer used to run for whoever invoked the IPC
 * channel, so attacker code inside our own renderer could mint an approval
 * for a device of its choosing without a human ever seeing it. The sender
 * guard (ipc-guard.ts) answers "is this really our renderer", not "did a
 * person ask for this".
 *
 * THE CONTROL
 * Same shape and same reasoning as recovery-key-gate.ts: a main-process
 * native dialog, because a human choosing the non-default button is the one
 * signal renderer code cannot manufacture. MAIN shows it, BEFORE it signs;
 * "Approve" is the only way to a signature, Cancel is the default, and a
 * failure to show the dialog is a refusal. Only `approve` (and the link
 * approval, which is an approval) is confirmed. `deny` is the safe direction
 * (it removes a device) and is also what "Cancel reset" signs, so it is never
 * made to wait on a dialog.
 *
 * WHERE THE NAME COMES FROM — AN HONEST LIMIT
 * Main holds no API token and no API base (the renderer owns the session), so
 * it cannot fetch the pending request itself; the device name and platform in
 * the dialog arrive in the IPC payload. They are validated strictly (type,
 * length, control/bidi characters stripped, platform pinned to the server's
 * enum) and are display-only. A compromised renderer can therefore choose
 * what the dialog SAYS, but not whether the dialog is shown, and not what is
 * signed: everything that is signed (ids, identity key, timestamp) is
 * validated to a fixed shape here and is independent of the display text. The
 * dialog is a human-presence gate, not an authenticated description of the
 * device — and it says so by never claiming more than "Approve <name>".
 *
 * DIALOG FATIGUE, as in recovery-key-gate.ts: one dialog in flight (further
 * requests are dropped, not queued) and a decline silences prompts for a
 * short cooldown.
 *
 * Imports nothing from `electron`, so it is covered by vitest (see
 * vitest.config.ts's note on electron/** scope). main.ts injects the real
 * dialog and the real signer.
 */

export interface SignedApproval { identityPub: string; sig: string }

export type ApprovalSignResult =
    | ({ ok: true } & SignedApproval)
    /** The payload failed validation — nothing was shown, nothing was signed. */
    | { ok: false; reason: 'invalid' }
    /** The human said no, a request arrived in the cooldown, or the dialog could not be shown. */
    | { ok: false; reason: 'declined' }
    /** A confirmation is already on screen; this request was dropped, not queued. */
    | { ok: false; reason: 'busy' }
    /** The user confirmed but the identity key could not sign (locked keystore). */
    | { ok: false; reason: 'unavailable' };

/** What the confirmation dialog is told. Already sanitized. */
export interface ApprovalConfirmInfo {
    kind: 'device' | 'link';
    /** Sanitized display name; null for a link approval (the phone has not registered yet). */
    deviceName: string | null;
    /** Display label, e.g. "Windows". Null for a link approval. */
    platform: string | null;
}

export interface ApprovalSignGateDeps {
    /** Shows the main-process confirmation. Resolves true only on "Approve". */
    confirm: (info: ApprovalConfirmInfo) => Promise<boolean>;
    /** Signs the canonical message with the device identity key. Called ONLY after approval (or for a deny). */
    signDecision: (a: { userId: string; approverDeviceId: string; pendingDeviceId: string; pendingIdentityKeyB64: string; decision: 'approve' | 'deny'; ts: number }) => Promise<SignedApproval | null>;
    signLink: (a: { userId: string; approverDeviceId: string; linkId: string; newIdentityKeyB64: string | null; ts: number }) => Promise<SignedApproval | null>;
    now?: () => number;
}

/** How long a "Cancel" silences further approval prompts. Shorter than the
 *  recovery-key gate's 30 s: a user who mis-clicked Cancel on a sign-in they
 *  just started should not be stuck, while a scripted retry loop still gets
 *  one prompt per window. */
export const APPROVAL_DECLINE_COOLDOWN_MS = 15_000;

// ── validation ──────────────────────────────────────────────────────────────

/** Ids that go into the colon-joined signed message. No `:` is allowed in any
 *  of them — a smuggled colon would let a field spill into its neighbour. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A raw 32-byte Ed25519 public key as standard base64 with padding. */
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const isKey = (v: unknown): v is string => typeof v === 'string' && KEY_RE.test(v);
const isTs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

// C0/C1 controls, zero-width and bidi formatting characters: anything that
// lets a name break the dialog's line structure or visually reorder its text.
// eslint-disable-next-line no-control-regex
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** A name that is safe to put in a native dialog, or null when it is unusable. */
export function sanitizeDisplayName(raw: unknown, max = 64): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const PLATFORM_LABELS: Record<string, string> = {
    windows: 'Windows', mac: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android', web: 'Web',
};

/** Pinned to the server's platform enum; anything else is not a platform. */
export function platformDisplay(raw: unknown): string | null {
    return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, raw) ? PLATFORM_LABELS[raw] : null;
}

/** The dialog's headline. Exported so the wording is pinned by a test. */
export function approvalQuestion(info: ApprovalConfirmInfo): string {
    return info.kind === 'link' || !info.deviceName
        ? 'Approve a new device to access your encrypted messages?'
        : `Approve ${info.deviceName} (${info.platform ?? 'unknown platform'}) to access your encrypted messages?`;
}

// ── the gate ────────────────────────────────────────────────────────────────

export interface ApprovalSignGate {
    /** `crypto:device-approval-sign`. `display` is only read for `approve`. */
    signDecision(args: {
        userId: unknown; approverDeviceId: unknown; pendingDeviceId: unknown; pendingIdentityKeyB64: unknown;
        decision: unknown; ts: unknown; display?: unknown;
    }): Promise<ApprovalSignResult>;
    /** `crypto:link-approval-sign`. */
    signLink(args: {
        userId: unknown; approverDeviceId: unknown; linkId: unknown; newIdentityKeyB64: unknown; ts: unknown;
    }): Promise<ApprovalSignResult>;
}

export function createApprovalSignGate(deps: ApprovalSignGateDeps): ApprovalSignGate {
    const now = deps.now ?? Date.now;
    let inFlight = false;
    let declinedUntil = 0;

    /** One dialog at a time, one cooldown for both channels; `sign` runs only on approval. */
    async function confirmThen(info: ApprovalConfirmInfo, sign: () => Promise<SignedApproval | null>): Promise<ApprovalSignResult> {
        if (inFlight) return { ok: false, reason: 'busy' };
        if (now() < declinedUntil) return { ok: false, reason: 'declined' };
        inFlight = true;
        let approved = false;
        try {
            approved = await deps.confirm(info);
        } catch {
            // A dialog that failed to open is not consent. Fail closed.
            approved = false;
        } finally {
            inFlight = false;
        }
        if (!approved) {
            declinedUntil = now() + APPROVAL_DECLINE_COOLDOWN_MS;
            return { ok: false, reason: 'declined' };
        }
        const signed = await sign();
        return signed ? { ok: true, ...signed } : { ok: false, reason: 'unavailable' };
    }

    return {
        async signDecision(a) {
            const decision: 'approve' | 'deny' | null = a.decision === 'approve' ? 'approve' : a.decision === 'deny' ? 'deny' : null;
            if (!isId(a.userId) || !isId(a.approverDeviceId) || !isId(a.pendingDeviceId)
                || !isKey(a.pendingIdentityKeyB64) || !isTs(a.ts) || !decision) {
                return { ok: false, reason: 'invalid' };
            }
            const args = {
                userId: a.userId, approverDeviceId: a.approverDeviceId, pendingDeviceId: a.pendingDeviceId,
                pendingIdentityKeyB64: a.pendingIdentityKeyB64, decision, ts: a.ts,
            };
            if (decision === 'deny') {
                // The safe direction (and what "Cancel reset" signs): never behind a dialog.
                const signed = await deps.signDecision(args);
                return signed ? { ok: true, ...signed } : { ok: false, reason: 'unavailable' };
            }
            const d = a.display as { deviceName?: unknown; platform?: unknown } | null | undefined;
            const deviceName = sanitizeDisplayName(d?.deviceName);
            const platform = platformDisplay(d?.platform);
            // An approval with nothing to show the human is refused outright:
            // a dialog that cannot say what is being approved is not a gate.
            if (!deviceName || !platform) return { ok: false, reason: 'invalid' };
            return confirmThen({ kind: 'device', deviceName, platform }, () => deps.signDecision(args));
        },

        async signLink(a) {
            if (!isId(a.userId) || !isId(a.approverDeviceId) || !isId(a.linkId) || !isTs(a.ts)
                || !(a.newIdentityKeyB64 === null || isKey(a.newIdentityKeyB64))) {
                return { ok: false, reason: 'invalid' };
            }
            const args = {
                userId: a.userId, approverDeviceId: a.approverDeviceId, linkId: a.linkId,
                newIdentityKeyB64: a.newIdentityKeyB64, ts: a.ts,
            };
            return confirmThen({ kind: 'link', deviceName: null, platform: null }, () => deps.signLink(args));
        },
    };
}
