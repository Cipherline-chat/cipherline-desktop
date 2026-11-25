import { describe, it, expect, vi, beforeEach } from 'vitest';

// The default deps must build a FRESH axios instance (no global interceptors —
// see linkAvatarPreview.ts). These spies tell the two apart.
const globalGet = vi.fn();
const isolatedGet = vi.fn();
const create = vi.fn((..._a: unknown[]) => ({ get: (...a: unknown[]) => isolatedGet(...a) }));
vi.mock('axios', () => ({
    default: {
        create: (...a: unknown[]) => create(...a),
        get: (...a: unknown[]) => globalGet(...a),
    },
}));

import { fetchLinkAvatarPreview, isAvatarAttachmentId, LINK_AVATAR_MAX_BYTES, type LinkAvatarDeps } from './linkAvatarPreview';
import { API_BASE } from '../constants';

const ID = '3f0b6f6e-9d1a-4c38-9a51-2b7c1e5d8a90';
const TOKEN = 'PENDING-ACCESS';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

/** Real AES-256-GCM, same shape the avatar upload produces: ciphertext||tag, IV separate. */
async function encryptedAvatar() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, PNG));
    return { keyB64: b64(raw), ivB64: b64(iv), blob: new Blob([ct]) };
}

const realCrypto: Pick<LinkAvatarDeps, 'importKey' | 'decrypt'> = {
    importKey: (k) => crypto.subtle.importKey('raw', Buffer.from(k, 'base64'), { name: 'AES-GCM' }, false, ['decrypt']),
    decrypt: async (blob, key, ivB64, mime) => {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(ivB64, 'base64') }, key, await blob.arrayBuffer());
        return new Blob([pt], { type: mime });
    },
};

function server(over: { meta?: unknown; key?: unknown; keyStatus?: number; blob?: unknown } = {}, enc?: Awaited<ReturnType<typeof encryptedAvatar>>) {
    const calls: Array<{ url: string; config?: { headers?: Record<string, string>; responseType?: string } }> = [];
    const get = vi.fn(async (url: string, config?: { headers?: Record<string, string>; responseType?: 'blob' }) => {
        calls.push({ url, config });
        if (url.endsWith(`/attachments/${ID}/download`)) {
            return { data: over.meta ?? { attachment_id: ID, download_url: 'https://media.example/global_avatars/x?X-Amz-Signature=s', mime_type: 'image/png' } };
        }
        if (url.endsWith(`/attachments/${ID}/key`)) {
            if (over.keyStatus) throw Object.assign(new Error(String(over.keyStatus)), { response: { status: over.keyStatus } });
            return { data: over.key ?? { file_key_b64: enc?.keyB64, file_nonce_b64: enc?.ivB64 } };
        }
        if (url.startsWith('https://media.example/')) return { data: over.blob ?? enc?.blob };
        throw new Error(`unexpected ${url}`);
    });
    return { get, calls };
}

beforeEach(() => {
    globalGet.mockReset(); isolatedGet.mockReset(); create.mockClear();
});

describe('fetchLinkAvatarPreview', () => {
    it('downloads + decrypts the account\'s own avatar with the pending token; object storage gets no token', async () => {
        const enc = await encryptedAvatar();
        const http = server({}, enc);
        const out = await fetchLinkAvatarPreview(ID, TOKEN, { http, ...realCrypto });

        expect(out).not.toBeNull();
        expect(new Uint8Array(await out!.arrayBuffer())).toEqual(PNG);
        expect(out!.type).toBe('image/png');
        const api = http.calls.filter((c) => c.url.startsWith(API_BASE));
        expect(api.map((c) => c.url).sort()).toEqual([`${API_BASE}/attachments/${ID}/download`, `${API_BASE}/attachments/${ID}/key`]);
        for (const c of api) expect(c.config?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
        const media = http.calls.find((c) => c.url.startsWith('https://media.example/'))!;
        expect(media.config?.headers?.Authorization).toBeUndefined();
        expect(media.config?.responseType).toBe('blob');
    });

    it('no attachment id (null, legacy URL, junk) → null without a single request', async () => {
        const http = server();
        for (const v of [null, undefined, '', 'https://cdn.example/a.png', 'not-a-uuid', `${ID}/../x`]) {
            expect(await fetchLinkAvatarPreview(v, TOKEN, { http, ...realCrypto })).toBeNull();
        }
        expect(await fetchLinkAvatarPreview(ID, '', { http, ...realCrypto })).toBeNull();
        expect(http.get).not.toHaveBeenCalled();
    });

    it('a 403/404 on the key (no server-held key) → null', async () => {
        const enc = await encryptedAvatar();
        expect(await fetchLinkAvatarPreview(ID, TOKEN, { http: server({ keyStatus: 404 }, enc), ...realCrypto })).toBeNull();
        expect(await fetchLinkAvatarPreview(ID, TOKEN, { http: server({ keyStatus: 403 }, enc), ...realCrypto })).toBeNull();
    });

    it('refuses a non-image type or a non-http(s) download URL before fetching anything from it', async () => {
        const enc = await encryptedAvatar();
        for (const meta of [
            { download_url: 'https://media.example/x', mime_type: 'text/html' },
            { download_url: 'https://media.example/x', mime_type: 'image/svg+xml' },
            { download_url: 'file:///etc/passwd', mime_type: 'image/png' },
            { download_url: 'javascript:alert(1)', mime_type: 'image/png' },
            { mime_type: 'image/png' },
        ]) {
            const http = server({ meta }, enc);
            expect(await fetchLinkAvatarPreview(ID, TOKEN, { http, ...realCrypto })).toBeNull();
            expect(http.calls.some((c) => !c.url.startsWith(API_BASE))).toBe(false);
        }
    });

    it('a wrong key (tampered / stale) fails closed to null, never garbage', async () => {
        const enc = await encryptedAvatar();
        const other = await encryptedAvatar();
        const http = server({ key: { file_key_b64: other.keyB64, file_nonce_b64: enc.ivB64 } }, enc);
        expect(await fetchLinkAvatarPreview(ID, TOKEN, { http, ...realCrypto })).toBeNull();
    });

    it('an empty or over-cap object → null', async () => {
        const enc = await encryptedAvatar();
        expect(await fetchLinkAvatarPreview(ID, TOKEN, { http: server({ blob: new Blob([]) }, enc), ...realCrypto })).toBeNull();
        const huge = { size: LINK_AVATAR_MAX_BYTES + 1 } as Blob;
        Object.setPrototypeOf(huge, Blob.prototype);
        expect(await fetchLinkAvatarPreview(ID, TOKEN, { http: server({ blob: huge }, enc), ...realCrypto })).toBeNull();
    });

    it('default deps use a FRESH axios instance (never the global one with the signed-in account\'s interceptors)', async () => {
        isolatedGet.mockRejectedValue(new Error('offline'));
        expect(await fetchLinkAvatarPreview(ID, TOKEN)).toBeNull();
        expect(create).toHaveBeenCalledTimes(1);
        expect(isolatedGet).toHaveBeenCalled();
        expect(globalGet).not.toHaveBeenCalled();
    });
});

describe('isAvatarAttachmentId', () => {
    it('accepts only a bare UUID', () => {
        expect(isAvatarAttachmentId(ID)).toBe(true);
        expect(isAvatarAttachmentId(ID.toUpperCase())).toBe(true);
        expect(isAvatarAttachmentId(` ${ID}`)).toBe(false);
        expect(isAvatarAttachmentId(null)).toBe(false);
    });
});
