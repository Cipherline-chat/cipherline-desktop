/**
 * Device approval — the renderer's side of the server gate
 * (`DEVICE_APPROVAL_REQUIRED=enforce`; see apps/api/src/devices/device-approval.util.ts
 * and docs/device-approval-mobile-spec.md).
 *
 * A device that signs in to an account which already has an approved device is
 * PENDING until one of: an approved device approves it (signature + the six
 * digits both screens show), a QR link signed by an approved device, or the
 * user proves a recovery key. This module is the plain-TypeScript half — wire
 * shapes, event parsers, list reducers, error mapping and the four signed
 * requests — so it is unit-testable without a DOM (apps/desktop's vitest has
 * none). The screens are `DeviceApprovalPending.tsx` (the new device) and
 * `DeviceApprovalModal.tsx` (an approver).
 *
 * Nothing secret is handled here. Signatures are made in the main process
 * (electron/device-approval-keys.ts) with the device identity key; a typed
 * recovery key crosses the bridge once, inward, and is never stored.
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from './apiPath';
import { deriveDeviceApprovalCode } from './deviceApprovalCode';

export * from './deviceApprovalEvents';
import { parseApprovalPendingEvent, type PendingDeviceRequest, type ApprovalStatusResponse } from './deviceApprovalEvents';

// ── the code ────────────────────────────────────────────────────────────────

/** The six digits THIS client computes for a request. The approver compares
 *  them with what the human typed from the new device's screen. */
export function codeForRequest(userId: string, req: Pick<PendingDeviceRequest, 'identity_key_pub_b64' | 'nonce_b64'>): Promise<string> {
    return deriveDeviceApprovalCode(userId, req.identity_key_pub_b64, req.nonce_b64);
}

// ── errors ──────────────────────────────────────────────────────────────────

export type ApprovalErrorKind =
    | 'code_mismatch' | 'locked' | 'expired' | 'bad_signature' | 'recovery_invalid'
    | 'rate_limited' | 'enforce_required' | 'no_signer' | 'network' | 'unknown';

export interface DescribedApprovalError { kind: ApprovalErrorKind; message: string; attemptsLeft?: number }

/** Map a failed approval call to something a person can act on. The server's
 *  machine-readable `error` is authoritative; the status code is the fallback. */
export function describeApprovalError(err: unknown): DescribedApprovalError {
    if (err instanceof NoSignerError) return { kind: 'no_signer', message: err.message };
    const e = err as { response?: { status?: number; data?: { error?: string; message?: string; attempts_left?: number } }; request?: unknown; message?: string };
    const data = e?.response?.data;
    const status = e?.response?.status;
    switch (data?.error) {
        case 'device_approval_code_mismatch':
            return { kind: 'code_mismatch', message: 'That code does not match the one on the new device.', attemptsLeft: data.attempts_left };
        case 'device_approval_locked':
            return { kind: 'locked', message: 'Too many wrong attempts — this request was denied. The device can sign in again to make a new one.' };
        case 'device_approval_expired':
            return { kind: 'expired', message: 'This request has expired. The device can sign in again to make a new one.' };
        case 'device_approval_bad_signature':
            return { kind: 'bad_signature', message: 'This device could not vouch for the request. Open Cipherline on a device you have already signed in with and try again.' };
        case 'device_recovery_key_invalid':
            return { kind: 'recovery_invalid', message: 'That recovery key does not belong to any of your devices.' };
        case 'device_approval_required':
            return { kind: 'enforce_required', message: 'This device has to be approved from another device, with a recovery key, or by updating Cipherline.' };
    }
    if (status === 429) return { kind: 'rate_limited', message: 'Too many attempts — wait a few seconds and try again.' };
    if (status === 404) return { kind: 'expired', message: 'This request is no longer pending.' };
    if (!e?.response && e?.request) return { kind: 'network', message: "Can't reach Cipherline — check your connection." };
    return { kind: 'unknown', message: data?.message || e?.message || 'Something went wrong.' };
}

export class NoSignerError extends Error {
    constructor(what = 'This device cannot sign approvals (desktop app required).') { super(what); this.name = 'NoSignerError'; }
}

// ── requests ────────────────────────────────────────────────────────────────

const auth = (token: string, deviceId?: string) => ({
    headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'x-device-id': deviceId } : {}) },
});
const nowSeconds = () => Math.floor(Date.now() / 1000);

export interface DecisionCtx { token: string; userId: string; deviceId: string }

async function signDecision(ctx: DecisionCtx, req: PendingDeviceRequest, decision: 'approve' | 'deny') {
    const sign = window.electronAPI?.signDeviceApproval;
    if (!sign) throw new NoSignerError();
    const ts = nowSeconds();
    // `display` is what the main-process confirmation says ("Approve <name>
    // (<platform>)?"); it is not part of what is signed.
    const signed = decision === 'approve'
        ? await sign(ctx.userId, ctx.deviceId, req.device_id, req.identity_key_pub_b64, decision, ts, { deviceName: req.device_name, platform: req.platform })
        : await sign(ctx.userId, ctx.deviceId, req.device_id, req.identity_key_pub_b64, decision, ts);
    if (!signed) throw new NoSignerError('This device did not sign the decision (it was cancelled, or the keystore is locked).');
    return { approver_sig_b64: signed.sig, approver_ts: ts };
}

/** Approve with the six digits the approver's own derivation produced (the
 *  caller has already checked them against what the human typed). */
export async function approvePendingDevice(ctx: DecisionCtx, req: PendingDeviceRequest, code: string): Promise<void> {
    const sig = await signDecision(ctx, req, 'approve');
    await axios.post(apiUrl`/devices/${req.device_id}/approve`, { code, ...sig }, auth(ctx.token, ctx.deviceId));
}

export async function denyPendingDevice(ctx: DecisionCtx, req: PendingDeviceRequest): Promise<void> {
    const sig = await signDecision(ctx, req, 'deny');
    await axios.post(apiUrl`/devices/${req.device_id}/deny`, sig, auth(ctx.token, ctx.deviceId));
}

/**
 * Cancel a cooling-off device reset ("A device reset was requested — Cancel
 * reset"). Cancelling IS denying the device that asked for it, so the request
 * is signed with the same `deny` decision and the server revokes that device,
 * clears the reset and emails the owner. The signature is what makes this
 * callable only from an approved device: `x-device-id` alone proves nothing.
 */
export async function cancelDeviceReset(ctx: DecisionCtx, req: PendingDeviceRequest): Promise<void> {
    const sig = await signDecision(ctx, req, 'deny');
    await axios.post(apiUrl`/devices/${req.device_id}/cancel-reset`, sig, auth(ctx.token, ctx.deviceId));
}

export async function fetchPendingRequests(token: string): Promise<PendingDeviceRequest[]> {
    const res = await axios.get<unknown>(`${API_BASE}/devices/pending`, auth(token));
    if (!Array.isArray(res.data)) return [];
    return res.data.map(parseApprovalPendingEvent).filter((r): r is PendingDeviceRequest => r !== null);
}

/** The waiting device polls its own request. */
export async function fetchApprovalStatus(token: string, deviceId: string): Promise<ApprovalStatusResponse> {
    const res = await axios.get<ApprovalStatusResponse>(apiUrl`/devices/${deviceId}/approval`, auth(token));
    return res.data;
}

/** The new device proves it was typed an approved device's recovery key. */
export async function submitRecoveryKeyProof(
    token: string, userId: string, deviceId: string, identityPub: string, typedKeyB64: string,
): Promise<void> {
    const prove = window.electronAPI?.proveRecoveryKey;
    if (!prove) throw new NoSignerError();
    const ts = nowSeconds();
    const proof = await prove(typedKeyB64.trim(), userId, deviceId, identityPub, ts);
    // null = not a 32-byte key (mistyped / truncated): same message as a key
    // the server does not know, so nothing is learned from the difference.
    if (!proof) throw Object.assign(new Error('Not a recovery key'), { response: { status: 403, data: { error: 'device_recovery_key_invalid' } } });
    await axios.post(apiUrl`/devices/${deviceId}/recovery-proof`,
        { recovery_pub_b64: proof.recoveryPub, sig_b64: proof.sig, ts }, auth(token));
}

/** "All my other devices are lost" — schedule the cooling-off reset. */
export async function requestDeviceReset(token: string, deviceId: string): Promise<{ resetDueAt: string | null }> {
    const res = await axios.post<{ ok: boolean; reset_due_at?: string }>(apiUrl`/devices/${deviceId}/reset-request`, {}, auth(token));
    return { resetDueAt: res.data.reset_due_at ?? null };
}

/**
 * Publish this device's recovery commitment — the PUBLIC half of a keypair
 * derived from its recovery key, signed by its identity key — so a future new
 * device that is typed the recovery key can prove it. Idempotent and cheap;
 * called once per sign-in. Failure is silent by design: recovery-key approval
 * is a fallback and must never block the app.
 */
export async function publishRecoveryCommitment(token: string, userId: string, deviceId: string): Promise<boolean> {
    try {
        const get = window.electronAPI?.getRecoveryCommitment;
        if (!get) return false;
        const ts = nowSeconds();
        const c = await get(userId, deviceId, ts);
        if (!c) return false;
        await axios.put(apiUrl`/devices/${deviceId}/recovery-commitment`,
            { recovery_pub_b64: c.recoveryPub, identity_sig_b64: c.sig, ts }, auth(token, deviceId));
        return true;
    } catch {
        return false;
    }
}
