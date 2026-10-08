/**
 * Publishing this device's Signal key bundle — the ONE place that knows the
 * shape POST /v1/keys/upload_bundle accepts, and the launch/login publish flow
 * shared by useKeyBundleSync and deviceRegistration.
 *
 * THE SHAPE BUG THIS FIXES. The main process hands back an IdentityBundle with
 * the signed prekey NESTED (`signed_prekey: { id, pub_b64, sig_b64 }`). The
 * server's UploadBundleDto wants it FLAT (`signed_prekey_id`,
 * `signed_prekey_pub_b64`, `signed_prekey_sig_b64`), and its global
 * ValidationPipe runs with `forbidNonWhitelisted`. useKeyRotation posted
 * `{ ...bundle, device_id }` — nested — so EVERY top-up and signed-prekey
 * rotation since June 2026 was a 400 that its `catch {}` swallowed:
 *
 *   • the 100 one-time prekeys each top-up minted stayed on the device,
 *     never published, never claimable, never retirable — held forever, 100
 *     more every 15 minutes the pool stayed low (and it always did, because
 *     nothing replenished it);
 *   • rotated signed prekeys never reached the server, which kept handing
 *     senders an old one.
 *
 * That growth is what turned the vault into tens of thousands of entries and
 * every whole-vault operation into a main-thread stall. `toUploadBundleBody`
 * is now the only way a bundle becomes a request body, for every caller.
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { defaultShouldRetry } from './fetchWithRetry';

export interface KeyBundle {
    identity_key_pub_b64: string;
    registration_id: number;
    signed_prekey: { id: number; pub_b64: string; sig_b64: string };
    one_time_prekeys: { prekey_id: number; prekey_pub_b64: string }[];
}

/** Exactly the fields UploadBundleDto whitelists — nothing more, nothing nested. */
export interface UploadBundleBody {
    device_id: string;
    identity_key_pub_b64: string;
    registration_id: number;
    signed_prekey_id: number;
    signed_prekey_pub_b64: string;
    signed_prekey_sig_b64: string;
    one_time_prekeys: { prekey_id: number; prekey_pub_b64: string }[];
}

export function toUploadBundleBody(bundle: KeyBundle, deviceId: string): UploadBundleBody {
    return {
        device_id: deviceId,
        identity_key_pub_b64: bundle.identity_key_pub_b64,
        registration_id: bundle.registration_id,
        signed_prekey_id: bundle.signed_prekey.id,
        signed_prekey_pub_b64: bundle.signed_prekey.pub_b64,
        signed_prekey_sig_b64: bundle.signed_prekey.sig_b64,
        one_time_prekeys: bundle.one_time_prekeys.map((p) => ({ prekey_id: p.prekey_id, prekey_pub_b64: p.prekey_pub_b64 })),
    };
}

export interface KeyStatus {
    otp_remaining: number;
    spk_age_days: number;
    needs_rotation: boolean;
    // OPTIONAL on purpose: `undefined` must reach the main process as
    // "the server did not say", never as an empty set.
    unclaimed_prekey_ids?: number[];
    retired_prekey_ids?: number[];
}

/** GET /v1/keys/status, with the `held_from` paging cursor when available. */
export async function fetchKeyStatus(deviceId: string, token: string): Promise<KeyStatus> {
    let heldFrom: number | null = null;
    try {
        heldFrom = await window.electronAPI?.getLowestHeldOtpId?.() ?? null;
    } catch { /* cursor is an optimization, never a precondition */ }
    const { data } = await axios.get<KeyStatus>(`${API_BASE}/keys/status`, {
        params: { device_id: deviceId, ...(heldFrom != null ? { held_from: heldFrom } : {}) },
        headers: { Authorization: `Bearer ${token}` },
    });
    return data;
}

export async function postBundle(body: UploadBundleBody, token: string): Promise<void> {
    await axios.post(`${API_BASE}/keys/upload_bundle`, body, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * Launch / login publish: make sure the server holds this device's CURRENT
 * signed prekey and a usable one-time-prekey pool.
 *
 * Re-publishing the signed prekey at launch is load-bearing (a server left
 * advertising a key this device has since pruned makes every new DM
 * undecryptable), so this always uploads. What it re-offers is gated by the
 * server's own unclaimed list — the same carry gate useKeyRotation applies —
 * so a prekey that was claimed, or a legacy orphan the server has no row for,
 * is never served twice. If the status call fails the gate is skipped and the
 * main process falls back to its newest held prekeys (capped at the server's
 * 200), the pre-contract behaviour.
 *
 * When the gate leaves nothing to re-offer (the pool is empty, or the server
 * has no bundle for this device yet) a fresh batch is minted instead — an
 * upload needs at least one prekey.
 *
 * Returns 'skipped' only outside Electron.
 */
export async function publishIdentityBundle(deviceId: string, token: string): Promise<'uploaded' | 'skipped'> {
    const api = window.electronAPI;
    if (!api?.ensureIdentityBundle) return 'skipped';

    let status: KeyStatus | null = null;
    try {
        status = await fetchKeyStatus(deviceId, token);
    } catch {
        status = null;   // fail safe: no gate, delete nothing
    }
    const unclaimed = Array.isArray(status?.unclaimed_prekey_ids) ? status!.unclaimed_prekey_ids : undefined;

    const ensured = await api.ensureIdentityBundle(deviceId, unclaimed ? { unclaimedPrekeyIds: unclaimed } : undefined);
    let bundle: KeyBundle = ensured;
    if (!ensured.is_new && ensured.one_time_prekeys.length === 0) {
        const topped = await api.getRotationBundle?.({
            rotateSpk: false,
            unclaimedPrekeyIds: unclaimed,
            retiredPrekeyIds: Array.isArray(status?.retired_prekey_ids) ? status!.retired_prekey_ids : undefined,
            otpPoolLow: true,
        });
        if (!topped) return 'skipped';
        bundle = topped;
    }
    await postBundle(toUploadBundleBody(bundle, deviceId), token);
    return 'uploaded';
}

/**
 * Worth retrying? Network failures and 5xx/429 — yes. A 4xx is the server's
 * settled answer about THIS body: re-sending it can only fail the same way.
 * (useKeyBundleSync used to retry everything three times, and with a bundle
 * the server rejected outright that meant three full rebuilds on the main
 * process for nothing.)
 */
export function isRetryableUploadError(err: unknown): boolean {
    return defaultShouldRetry(err);
}
