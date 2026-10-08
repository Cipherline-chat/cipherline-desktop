/**
 * Public profile picture (owner decision 2026-10-06): the one avatar copy
 * that is not end-to-end encrypted. These pin what the client sends (only
 * the avatar image + the encrypted avatar's id), when it sends it, and that
 * none of it can fail or block an avatar save or app start.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { put, get, del, tokenStore } = vi.hoisted(() => ({
    put: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    tokenStore: { token: 'tok-from-store' as string | null },
}));
vi.mock('axios', () => ({ default: {
    put: (...a: unknown[]) => put(...a),
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
} }));
vi.mock('./secureLocalStore', () => ({ default: {
    getItem: (k: string) => (k === 'cipherline_token' ? tokenStore.token : null),
} }));
vi.mock('./avatarKeyStore', () => ({ saveAvatarKey: vi.fn(async () => undefined) }));

import {
    PUBLIC_AVATAR_ENDPOINT,
    PUBLIC_AVATAR_MAX_BYTES,
    decidePublicAvatarAction,
    publishPublicAvatar,
    publishPublicAvatarInBackground,
    sniffImageMime,
    syncPublicAvatar,
} from './publicAvatar';
import { uploadAvatarBlob } from './avatarUpload';

/** The axios request config publishPublicAvatar passes. */
interface PutCfg {
    params: Record<string, string>;
    headers: Record<string, string>;
    transformRequest: Array<(d: unknown) => unknown>;
}
const cfgOf = (i: number) => put.mock.calls[i][2] as PutCfg;

const AV1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const jpegBlob = () => new Blob([JPEG], { type: 'image/jpeg' });
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    put.mockReset().mockResolvedValue({ data: { exists: true, source: AV1, updated_at: 'x', served: false } });
    get.mockReset();
    del.mockReset().mockResolvedValue({ status: 204 });
    tokenStore.token = 'tok-from-store';
});

describe('sniffImageMime', () => {
    it('recognises the four accepted types by magic bytes, nothing else', () => {
        expect(sniffImageMime(JPEG)).toBe('image/jpeg');
        expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
        expect(sniffImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
        expect(sniffImageMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
        expect(sniffImageMime(new TextEncoder().encode('<svg xmlns='))).toBeNull();
        expect(sniffImageMime(new TextEncoder().encode('%PDF-1.4'))).toBeNull();
    });
});

describe('publishPublicAvatar: exactly what leaves the device', () => {
    it('PUTs the blob itself as the body, ?source=<encrypted avatar id>, and only auth + content-type headers', async () => {
        const blob = jpegBlob();
        await publishPublicAvatar(blob, AV1, 'tok');
        expect(put).toHaveBeenCalledTimes(1);
        const [url, body, cfg] = put.mock.calls[0] as [string, unknown, PutCfg];
        expect(url).toBe(PUBLIC_AVATAR_ENDPOINT);
        expect(url).toMatch(/\/v1\/users\/me\/public-avatar$/);
        expect(body).toBe(blob);
        expect(cfg.params).toEqual({ source: AV1 });
        expect(cfg.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'image/jpeg' });
        // The body is not transformed (no JSON / form wrapping).
        expect(cfg.transformRequest[0](blob)).toBe(blob);
    });

    it('the content type comes from the bytes, not the blob label', async () => {
        await publishPublicAvatar(new Blob([JPEG], { type: 'application/octet-stream' }), AV1, 'tok');
        expect(cfgOf(0).headers['Content-Type']).toBe('image/jpeg');
    });

    it.each([
        ['no token', jpegBlob(), AV1, null],
        ['non-uuid source', jpegBlob(), 'not-a-uuid', 'tok'],
        ['non-image bytes', new Blob(['<svg/>'], { type: 'image/svg+xml' }), AV1, 'tok'],
        ['empty blob', new Blob([]), AV1, 'tok'],
        ['over the server cap', new Blob([JPEG, new Uint8Array(PUBLIC_AVATAR_MAX_BYTES)]), AV1, 'tok'],
    ])('sends nothing for %s', async (_n, blob, src, tok) => {
        await expect(publishPublicAvatar(blob as Blob, src as string, tok as string | null)).resolves.toBeNull();
        expect(put).not.toHaveBeenCalled();
    });
});

describe('publishPublicAvatarInBackground', () => {
    it('uses the session token from the encrypted store and never throws', async () => {
        put.mockRejectedValueOnce(Object.assign(new Error('503'), { response: { status: 503 } }));
        expect(() => publishPublicAvatarInBackground(jpegBlob(), AV1)).not.toThrow();
        await flush(); await flush();
        expect(cfgOf(0).headers.Authorization).toBe('Bearer tok-from-store');
    });

    it('signed out (no token): does nothing', async () => {
        tokenStore.token = null;
        publishPublicAvatarInBackground(jpegBlob(), AV1);
        await flush(); await flush();
        expect(put).not.toHaveBeenCalled();
    });
});

describe('uploadAvatarBlob (shared by Settings and the onboarding profile step)', () => {
    it('publishes the SAME cropped blob as the public copy of the new encrypted attachment, without awaiting it', async () => {
        let releasePut: () => void = () => {};
        put.mockImplementation(() => new Promise(r => { releasePut = () => r({ data: {} }); }));
        const blob = jpegBlob();
        const deps = {
            uploadEncryptedFile: vi.fn(async () => ({ attachmentId: AV2, keyB64: 'k', nonceB64: 'n' })),
            broadcastProfileAvatarKey: vi.fn(async () => undefined),
        };
        // Resolves even though the public PUT is still pending.
        await expect(uploadAvatarBlob(blob, deps)).resolves.toBe(AV2);
        await flush(); await flush();
        expect(put).toHaveBeenCalledTimes(1);
        const [, body, cfg] = put.mock.calls[0] as [string, unknown, PutCfg];
        expect(body).toBe(blob);
        expect(cfg.params).toEqual({ source: AV2 });
        // The encrypted upload happened first and is unchanged.
        expect(deps.uploadEncryptedFile).toHaveBeenCalledWith(blob, 'avatar.jpg', 'image/jpeg');
        releasePut();
    });

    it('a failing public upload does not fail the avatar save', async () => {
        put.mockRejectedValue(new Error('network'));
        const deps = {
            uploadEncryptedFile: vi.fn(async () => ({ attachmentId: AV2, keyB64: 'k', nonceB64: 'n' })),
            broadcastProfileAvatarKey: vi.fn(async () => undefined),
        };
        await expect(uploadAvatarBlob(jpegBlob(), deps)).resolves.toBe(AV2);
        await flush();
    });
});

describe('decidePublicAvatarAction (startup sync)', () => {
    it.each([
        // avatarUrl, server status, expected
        [AV1, { exists: false, source: null }, 'upload'],      // existing user, never published
        [AV1, { exists: true, source: AV2 }, 'upload'],        // changed on a client that did not publish
        [AV1, { exists: true, source: AV1 }, 'none'],          // up to date
        [null, { exists: true, source: AV1 }, 'remove'],       // avatar removed, copy lingers
        [null, { exists: false, source: null }, 'none'],
        ['', { exists: true, source: AV1 }, 'remove'],
        [undefined, { exists: false, source: null }, 'none'],
    ] as const)('avatar %s, server %o -> %s', (avatarUrl, status, expected) => {
        expect(decidePublicAvatarAction(avatarUrl, status)).toBe(expected);
    });
});

describe('syncPublicAvatar', () => {
    const status = (s: object) => get.mockResolvedValueOnce({ data: { updated_at: null, served: false, ...s } });

    it('existing user with an avatar and no public copy: uploads the decrypted avatar once', async () => {
        status({ exists: false, source: null });
        const blob = jpegBlob();
        const load = vi.fn(async () => blob);
        await expect(syncPublicAvatar({ token: 't', avatarUrl: AV1, loadDecryptedAvatar: load })).resolves.toBe('upload');
        expect(load).toHaveBeenCalledWith(AV1);
        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0][1]).toBe(blob);
        expect(cfgOf(0).params).toEqual({ source: AV1 });
    });

    it('up to date: one GET, no write, never decrypts anything', async () => {
        status({ exists: true, source: AV1 });
        const load = vi.fn();
        await expect(syncPublicAvatar({ token: 't', avatarUrl: AV1, loadDecryptedAvatar: load })).resolves.toBe('none');
        expect(load).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
    });

    it('no avatar but a copy exists: DELETE', async () => {
        status({ exists: true, source: AV1 });
        await expect(syncPublicAvatar({ token: 't', avatarUrl: null, loadDecryptedAvatar: vi.fn() })).resolves.toBe('remove');
        expect(del).toHaveBeenCalledWith(PUBLIC_AVATAR_ENDPOINT, expect.objectContaining({ headers: { Authorization: 'Bearer t' } }));
    });

    it('avatar not available locally: skips quietly', async () => {
        status({ exists: false, source: null });
        await expect(syncPublicAvatar({ token: 't', avatarUrl: AV1, loadDecryptedAvatar: async () => null })).resolves.toBe('skipped');
        expect(put).not.toHaveBeenCalled();
    });

    it('server errors (old API without the route, 503 before the SQL): never throws', async () => {
        get.mockRejectedValueOnce(Object.assign(new Error('404'), { response: { status: 404 } }));
        await expect(syncPublicAvatar({ token: 't', avatarUrl: AV1, loadDecryptedAvatar: vi.fn() })).resolves.toBe('skipped');
        status({ exists: false, source: null });
        put.mockRejectedValueOnce(Object.assign(new Error('503'), { response: { status: 503 } }));
        await expect(syncPublicAvatar({ token: 't', avatarUrl: AV1, loadDecryptedAvatar: async () => jpegBlob() })).resolves.toBe('skipped');
    });
});
