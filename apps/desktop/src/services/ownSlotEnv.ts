/**
 * The real OwnSlotEnv — binds an own-device slot to IPC (the E2EE engine in
 * main), WebCrypto (the content key) and the `/v1/history` slot endpoints.
 * Shared by the `personal_saves` sync and the `gif_library` sync, so both
 * verify senders, find devices and move bytes the same way.
 *
 * Kept apart from the services so their logic stays unit-testable against a
 * fake env.
 */

import axios from 'axios';
import { API_BASE } from '../constants';
import {
    generateAesGcmKey,
    exportKeyToBase64,
    importKeyFromBase64,
    encryptWithKey,
    decryptWithKey,
} from '../utils/crypto';
import { isOwnSender, type OwnDeviceIdentity } from '../utils/ownSlotSync';
import type { OwnSlotEnv, UnwrappedKey } from './personalSavesSyncService';

export interface OwnSlotAuth {
    userId: string;
    deviceId: string;
    token: string;
}

/** Thrown when a snapshot decrypts but was not written by one of our devices. */
export class ForeignSnapshotError extends Error {
    constructor() {
        super('Snapshot was not written by one of this account\'s devices');
        this.name = 'ForeignSnapshotError';
    }
}

export function createOwnSlotEnv(auth: OwnSlotAuth, slot: string): OwnSlotEnv {
    const { userId, deviceId, token } = auth;
    const headers = { Authorization: `Bearer ${token}`, 'x-device-id': deviceId };
    const api = () => window.electronAPI!;

    /** This account's devices and identity keys. `identity_keys` claims no
     *  one-time prekeys, so it is safe to call on every sync. */
    async function ownIdentities(): Promise<OwnDeviceIdentity[] | null> {
        try {
            const res = await axios.get(`${API_BASE}/keys/identity_keys`, { params: { user_id: userId }, headers });
            if (!Array.isArray(res.data)) return null;
            return (res.data as OwnDeviceIdentity[]).filter(d =>
                typeof d?.device_id === 'string' && typeof d?.identity_key_pub_b64 === 'string');
        } catch {
            return null;
        }
    }

    interface PrekeyBundleRow {
        device_id?: string;
        identity_key_pub_b64?: string;
        signed_prekey?: { pub_b64?: string; sig_b64?: string };
        one_time_prekey?: { prekey_id?: number; prekey_pub_b64?: string } | null;
    }

    return {
        async getSlotMeta() {
            try {
                const res = await axios.get(`${API_BASE}/history/slot/${slot}/meta`, { headers });
                const d = res.data;
                return d?.backup_id ? { backup_id: d.backup_id, updated_at: String(d.updated_at) } : null;
            } catch { return null; }
        },

        async downloadSlot() {
            const res = await axios.get(`${API_BASE}/history/backup`, { params: { slot }, headers });
            const b64 = res.data?.data_b64;
            if (typeof b64 !== 'string' || !b64) return null;
            const bin = atob(b64);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        },

        async uploadSlot(bytes) {
            const { data } = await axios.post(
                `${API_BASE}/history/backup`,
                { size_bytes: bytes.byteLength, slot },
                { headers },
            );
            if (!data?.backup_id) throw new Error('history/backup did not return a backup_id');
            await axios.post(`${API_BASE}/history/upload/${data.backup_id}`, bytes, {
                headers: { ...headers, 'Content-Type': 'application/octet-stream' },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
        },

        async listOwnDeviceIds() {
            const ids = await ownIdentities();
            return ids ? ids.map(d => d.device_id) : null;
        },

        async fetchOwnDevices() {
            // prekey_bundle claims a one-time prekey per device per call, which
            // is why the services call this only once a publish is going ahead.
            // The claimed prekey is then USED (mixed into the wrap) rather than
            // thrown away: a snapshot is decrypted exactly once per device (the
            // engine's persistent replay set refuses a second pass anyway), so
            // one-time-prekey forward secrecy costs nothing here.
            const res = await axios.get(`${API_BASE}/keys/prekey_bundle`, { params: { user_id: userId }, headers });
            if (!Array.isArray(res.data)) return [];
            return (res.data as PrekeyBundleRow[])
                .filter(d => !!d?.device_id && d.device_id !== deviceId && !!d.signed_prekey?.pub_b64)
                .map(d => ({
                    device_id: d.device_id!,
                    spk_pub_b64: d.signed_prekey!.pub_b64!,
                    sig_b64: d.signed_prekey!.sig_b64,
                    identity_pub_b64: d.identity_key_pub_b64,
                    otp_pub_b64: d.one_time_prekey?.prekey_pub_b64 ?? null,
                    otp_id: typeof d.one_time_prekey?.prekey_id === 'number' ? d.one_time_prekey.prekey_id : null,
                }));
        },

        async wrapToDevices(plaintext, devices) {
            const { envelope_b64 } = await api().encryptMessageV2(plaintext, userId, devices, deviceId);
            return envelope_b64;
        },

        async unwrapFromEnvelope(envelopeB64): Promise<UnwrappedKey> {
            // Identities FIRST. The engine records every envelope it decrypts
            // in a persistent replay set, so a snapshot can be decrypted once
            // per device, ever. If the lookup failed after decrypting, this
            // device could never read that snapshot again; failing before it
            // leaves the envelope untouched for the next attempt.
            const identities = await ownIdentities();
            if (!identities) throw new Error('could not list this account\'s devices; not reading the snapshot now');
            const res = await api().decryptMessage(envelopeB64, deviceId);
            // Fail closed: not one of our devices → not our snapshot.
            if (!isOwnSender(res, userId, identities)) throw new ForeignSnapshotError();
            return { contentJson: res.contentJson, senderDeviceId: res.senderDeviceId };
        },

        async generateContentKeyB64() {
            return exportKeyToBase64(await generateAesGcmKey());
        },
        async encryptWithKey(plaintext, keyB64) {
            return encryptWithKey(plaintext, await importKeyFromBase64(keyB64));
        },
        async decryptWithKey(bytes, keyB64) {
            return decryptWithKey(bytes, await importKeyFromBase64(keyB64));
        },

        now: () => Date.now(),
    };
}
