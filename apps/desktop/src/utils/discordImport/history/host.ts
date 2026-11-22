/**
 * The Cipherline side of the history import: the import API routes, and the
 * same encryption a normal send uses. Built by the Create a Server modal and
 * handed to the wizard; the runner (./runner.ts) only sees these functions.
 *
 *   - sealRow: franking commitment (utils/franking.ts frankForSend), then the
 *     channel's sender key + this device's Ed25519 signature
 *     (electronAPI.encryptChannelMessage): byte for byte the normal send path;
 *   - encryptFile: AES-256-GCM with a fresh key (utils/crypto.ts), the key and
 *     nonce go INSIDE the message content, never to the server.
 */
import axios from 'axios';
import { apiUrl } from '../../apiPath';
import { encryptBlob, exportKeyToBase64, generateAesGcmKey } from '../../crypto';
import { frankForSend } from '../../franking';
import type { EncryptedFile, HistoryApi, SealedRow } from './runner';

export interface ImportStorage { used_bytes: number; limit_bytes: number }

/** POST /servers/:sid/imports/channel-map (apps/api ImportChannelMapView). */
export interface ImportChannelMap {
    channels: Array<{ channel_id: string; imported_rows: number; from: Array<{ source: number; rows: number }>; unknown_source_rows: number }>;
    imports: { used: number; limit: number; window_days: number };
    active: { idle_minutes: number; supersedable: boolean } | null;
}

export interface DiscordHistoryHost {
    api(serverId: string): HistoryApi;
    /** Mint the new server's channel keys on this device (the server was created moments ago). */
    prepareChannelKeys(serverId: string, channelIds: string[]): Promise<void>;
    /**
     * EXISTING channels ("Copy messages from Discord"): which of them this device cannot encrypt for (no
     * current key). Never mints over a live channel's key; mints only a channel nobody ever keyed.
     */
    existingChannelKeys?(serverId: string, channelIds: string[]): Promise<string[]>;
    /** Where messages from these Discord channels (source keys) already are in the server, and the import quota. */
    channelMap?(serverId: string, sourceKeys: string[]): Promise<ImportChannelMap>;
    /** End this account's active session in the server, keeping what it copied (after a crash). */
    endActive?(serverId: string): Promise<{ ended: boolean; rows_posted: number }>;
    sealRow(contentJson: string, channelId: string): Promise<SealedRow>;
    encryptFile(bytes: Uint8Array, mime: string): Promise<EncryptedFile>;
    upload(url: string, blob: Blob, mime: string, signal: AbortSignal): Promise<void>;
    storage(serverId: string): Promise<ImportStorage>;
    /** Lower-cased emoji name -> id, for the emojis the structure import just added. */
    emojiIds(serverId: string): Promise<Record<string, string>>;
    cancel(serverId: string, importId: string, deletePosted: boolean): Promise<{ deleted: number }>;
    /**
     * The page is going away (quit, reload) mid-import: end the session, KEEPING what was posted, with a request
     * that outlives the page (fetch keepalive). Otherwise the API keeps it "active" for 72 h idle and refuses the
     * account's next import (IMPORT_ALREADY_ACTIVE). Best effort; optional for older hosts / tests.
     */
    cancelOnUnload?(serverId: string, importId: string): void;
    deviceId: string;
    maxFileBytes: number;
}

const b64 = (bytes: ArrayBuffer): string => {
    const u = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
};

export function createDiscordHistoryHost(o: {
    token: string;
    userId: string;
    deviceId: string;
    maxFileBytes: number;
    prepareChannelKeys(serverId: string, channelIds: string[]): Promise<void>;
    existingChannelKeys?(serverId: string, channelIds: string[]): Promise<string[]>;
}): DiscordHistoryHost {
    const auth = { headers: { Authorization: `Bearer ${o.token}`, 'x-device-id': o.deviceId } };
    const base = (sid: string) => apiUrl`/servers/${sid}/imports`;
    return {
        api: (sid) => ({
            createSession: async (body) => (await axios.post(base(sid), body, auth)).data,
            registerAuthors: async (iid, authors) => (await axios.post(`${base(sid)}/${encodeURIComponent(iid)}/authors`, { authors }, auth)).data,
            postBatch: async (iid, body) => (await axios.post(`${base(sid)}/${encodeURIComponent(iid)}/messages`, body, { ...auth, timeout: 60_000 })).data,
            // The import's batch initiate (size + MIME per file; the file NAME stays
            // inside the encrypted content, as in utils/attachmentInitiate.ts).
            initiateFiles: async (iid, channelId, files) => {
                const body = { channel_id: channelId, files: files.map(f => ({ size_bytes: f.size_bytes, mime_type: f.mime_type })) };
                const url = `${base(sid)}/${encodeURIComponent(iid)}/attachments` + '/initiate';
                return (await axios.post(url, body, auth)).data.files;
            },
            save: async (iid, body) => (await axios.post(`${base(sid)}/${encodeURIComponent(iid)}/save`, body, auth)).data,
            complete: async (iid) => (await axios.post(`${base(sid)}/${encodeURIComponent(iid)}/complete`, {}, auth)).data,
        }),
        prepareChannelKeys: o.prepareChannelKeys,
        ...(o.existingChannelKeys ? { existingChannelKeys: o.existingChannelKeys } : {}),
        channelMap: async (sid, sourceKeys) => (await axios.post(`${base(sid)}/channel-map`, { source_keys: sourceKeys }, auth)).data,
        endActive: async (sid) => (await axios.post(`${base(sid)}/active/end`, {}, auth)).data,
        sealRow: async (contentJson, channelId) => {
            const franked = await frankForSend(contentJson, { contextKind: 'channel', contextId: channelId, senderUserId: o.userId, senderDeviceId: o.deviceId });
            const enc = await window.electronAPI!.encryptChannelMessage(franked.contentJson, channelId, { user_id: o.userId, device_id: o.deviceId });
            return { ...enc, ...(franked.commitment_b64 ? { commitment_b64: franked.commitment_b64 } : {}) };
        },
        encryptFile: async (bytes, mime) => {
            const key = await generateAesGcmKey();
            const plain = new Blob([bytes as BlobPart], { type: mime });
            const { encryptedBlob, ivB64 } = await encryptBlob(plain, key);
            let sha: string | null = null;
            try { sha = b64(await crypto.subtle.digest('SHA-256', bytes as BufferSource)); } catch { /* reportable as unverified only */ }
            return { blob: encryptedBlob, keyB64: await exportKeyToBase64(key), nonceB64: ivB64, sha256B64: sha };
        },
        upload: async (url, blob, mime, signal) => {
            const res = await fetch(url, { method: 'PUT', body: blob, headers: { 'Content-Type': mime }, signal });
            if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
        },
        storage: async (sid) => {
            const r = (await axios.get(apiUrl`/servers/${sid}/storage`, auth)).data as { used_bytes?: unknown; limit_bytes?: unknown };
            return { used_bytes: Number(r.used_bytes ?? 0), limit_bytes: Number(r.limit_bytes ?? 0) };
        },
        emojiIds: async (sid) => {
            const r = (await axios.get<Array<{ emoji_id?: string; id?: string; name?: string }>>(apiUrl`/servers/${sid}/emojis`, auth)).data ?? [];
            const out: Record<string, string> = {};
            for (const e of r) { const id = e.emoji_id ?? e.id; if (id && e.name) out[e.name.toLowerCase()] = id; }
            return out;
        },
        cancel: async (sid, iid, deletePosted) => (await axios.post(`${base(sid)}/${encodeURIComponent(iid)}/cancel`, { delete_posted: deletePosted }, auth)).data,
        cancelOnUnload: (sid, iid) => {
            try {
                void fetch(`${base(sid)}/${encodeURIComponent(iid)}/cancel`, {
                    method: 'POST', keepalive: true,
                    headers: { ...auth.headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ delete_posted: false }),
                }).catch(() => undefined);
            } catch { /* best effort: the session expires after 72 h idle */ }
        },
        deviceId: o.deviceId,
        maxFileBytes: o.maxFileBytes,
    };
}
