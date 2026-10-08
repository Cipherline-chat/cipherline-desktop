import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const get = vi.mocked(axios.get);
const post = vi.mocked(axios.post);

import { toUploadBundleBody, publishIdentityBundle, isRetryableUploadError } from './keyBundleUpload';
import { otpPoolIsLow } from './prekeyHealth';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEVICE = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
const BUNDLE = {
    identity_key_pub_b64: 'ik',
    registration_id: 7,
    signed_prekey: { id: 3, pub_b64: 'spk', sig_b64: 'sig' },
    one_time_prekeys: [{ prekey_id: 9, prekey_pub_b64: 'p9' }],
};

/** The fields POST /v1/keys/upload_bundle (UploadBundleDto) whitelists. */
const UPLOAD_DTO_FIELDS = [
    'device_id', 'identity_key_pub_b64', 'one_time_prekeys', 'registration_id',
    'signed_prekey_id', 'signed_prekey_pub_b64', 'signed_prekey_sig_b64',
].sort();
const uploadDtoFields = () => UPLOAD_DTO_FIELDS;

/** Property names declared on the API's UploadBundleDto, read from source when
 *  the monorepo has it (the open-source client repo does not). */
const DTO_PATH = path.resolve(here, '..', '..', '..', 'api', 'src', 'keys', 'dto', 'keys.dto.ts');
function apiDtoFields(): string[] {
    const dto = fs.readFileSync(DTO_PATH, 'utf8');
    const body = dto.slice(dto.indexOf('export class UploadBundleDto'));
    const cls = body.slice(0, body.indexOf('\n}') + 2);
    return [...cls.matchAll(/^\s+(\w+)!:/gm)].map((m) => m[1]).sort();
}

describe('upload body shape (the every-top-up-400s bug)', () => {
    it.skipIf(!fs.existsSync(DTO_PATH))('the field list matches the API\'s UploadBundleDto source', () => {
        expect(apiDtoFields()).toEqual(UPLOAD_DTO_FIELDS);
    });

    it('toUploadBundleBody produces EXACTLY the fields UploadBundleDto whitelists — flat, nothing extra', () => {
        const body = toUploadBundleBody({ ...BUNDLE, ...({ device_id: 'ignored', is_new: true } as object) } as typeof BUNDLE, DEVICE);
        expect(Object.keys(body).sort()).toEqual(uploadDtoFields());
        expect(body).toEqual({
            device_id: DEVICE,
            identity_key_pub_b64: 'ik',
            registration_id: 7,
            signed_prekey_id: 3,
            signed_prekey_pub_b64: 'spk',
            signed_prekey_sig_b64: 'sig',
            one_time_prekeys: [{ prekey_id: 9, prekey_pub_b64: 'p9' }],
        });
    });

    it('POSITIVE CONTROL: the old `{ ...bundle, device_id }` body is NOT what the DTO accepts', () => {
        // forbidNonWhitelisted rejects `signed_prekey`; IsInt rejects the
        // missing signed_prekey_id. This is the 400 every top-up got.
        const old = Object.keys({ ...BUNDLE, device_id: DEVICE }).sort();
        expect(old).not.toEqual(uploadDtoFields());
        expect(old).toContain('signed_prekey');
        expect(uploadDtoFields()).not.toContain('signed_prekey');
    });

    it('no caller posts a raw bundle any more — every upload goes through toUploadBundleBody', () => {
        for (const rel of ['../hooks/useKeyRotation.ts', '../hooks/useKeyBundleSync.ts', './deviceRegistration.ts', './keyBundleUpload.ts']) {
            // Code only: the comments describing the old bug may quote it.
            const src = fs.readFileSync(path.resolve(here, rel), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            expect(src, rel).not.toMatch(/\.\.\.bundle\b/);
            expect(src, rel).not.toMatch(/keys\/upload_bundle`,\s*\{\s*\n?\s*device_id/);
        }
        const rotation = fs.readFileSync(path.resolve(here, '../hooks/useKeyRotation.ts'), 'utf8');
        expect(rotation).toMatch(/postBundle\(toUploadBundleBody\(bundle, deviceId\), token\)/);
    });
});

describe('publishIdentityBundle (launch / login)', () => {
    let ensure: ReturnType<typeof vi.fn>;
    let rotation: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        get.mockReset();
        post.mockReset();
        post.mockResolvedValue({ data: { ok: true } });
        ensure = vi.fn();
        rotation = vi.fn();
        (globalThis as { window: { electronAPI?: unknown } }).window.electronAPI = {
            ensureIdentityBundle: ensure,
            getRotationBundle: rotation,
            getLowestHeldOtpId: async () => 5,
        };
    });

    it('gates an existing identity by the server\'s unclaimed list and posts the flat body', async () => {
        get.mockResolvedValue({ data: { otp_remaining: 80, spk_age_days: 3, needs_rotation: false, unclaimed_prekey_ids: [9, 10], retired_prekey_ids: [] } });
        ensure.mockResolvedValue({ device_id: DEVICE, is_new: false, ...BUNDLE });
        await publishIdentityBundle(DEVICE, 'tok');
        expect(get.mock.calls[0][1]).toMatchObject({ params: { device_id: DEVICE, held_from: 5 } });
        expect(ensure).toHaveBeenCalledWith(DEVICE, { unclaimedPrekeyIds: [9, 10] });
        expect(rotation).not.toHaveBeenCalled();
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][1]).toEqual(toUploadBundleBody(BUNDLE, DEVICE));
    });

    it('nothing left to re-offer (empty pool / no server bundle) → mints a fresh batch via the rotation path', async () => {
        get.mockResolvedValue({ data: { otp_remaining: 0, spk_age_days: 0, needs_rotation: true, unclaimed_prekey_ids: [], retired_prekey_ids: [] } });
        ensure.mockResolvedValue({ device_id: DEVICE, is_new: false, ...BUNDLE, one_time_prekeys: [] });
        const fresh = { ...BUNDLE, one_time_prekeys: [{ prekey_id: 101, prekey_pub_b64: 'n' }] };
        rotation.mockResolvedValue(fresh);
        await publishIdentityBundle(DEVICE, 'tok');
        expect(rotation).toHaveBeenCalledWith({ rotateSpk: false, unclaimedPrekeyIds: [], retiredPrekeyIds: [], otpPoolLow: true });
        expect(post.mock.calls[0][1]).toEqual(toUploadBundleBody(fresh, DEVICE));
    });

    it('status call failed → no gate (main falls back to its newest held, capped), nothing retired', async () => {
        get.mockRejectedValue(new Error('offline'));
        ensure.mockResolvedValue({ device_id: DEVICE, is_new: false, ...BUNDLE });
        await publishIdentityBundle(DEVICE, 'tok');
        expect(ensure).toHaveBeenCalledWith(DEVICE, undefined);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('a brand-new identity uploads its own fresh bundle as is', async () => {
        get.mockResolvedValue({ data: { otp_remaining: 0, spk_age_days: 0, needs_rotation: true, unclaimed_prekey_ids: [], retired_prekey_ids: [] } });
        ensure.mockResolvedValue({ device_id: DEVICE, is_new: true, ...BUNDLE });
        await publishIdentityBundle(DEVICE, 'tok');
        expect(rotation).not.toHaveBeenCalled();
        expect(post.mock.calls[0][1]).toEqual(toUploadBundleBody(BUNDLE, DEVICE));
    });

    it('outside Electron it does nothing', async () => {
        (globalThis as { window: { electronAPI?: unknown } }).window.electronAPI = undefined;
        expect(await publishIdentityBundle(DEVICE, 'tok')).toBe('skipped');
        expect(post).not.toHaveBeenCalled();
    });
});

describe('retry policy and pool predicate', () => {
    it('a 4xx (the server rejecting THIS body) is not retried; network and 5xx are', () => {
        expect(isRetryableUploadError({ response: { status: 400 } })).toBe(false);
        expect(isRetryableUploadError({ response: { status: 403 } })).toBe(false);
        expect(isRetryableUploadError({ response: { status: 503 } })).toBe(true);
        expect(isRetryableUploadError({ response: { status: 429 } })).toBe(true);
        expect(isRetryableUploadError(new Error('Network Error'))).toBe(true);
    });

    it('otpPoolIsLow: below 50 or unknown is low; a full pool is not, whatever needs_rotation says', () => {
        expect(otpPoolIsLow({ otp_remaining: 0 })).toBe(true);
        expect(otpPoolIsLow({ otp_remaining: 49 })).toBe(true);
        expect(otpPoolIsLow({ otp_remaining: 50 })).toBe(false);
        expect(otpPoolIsLow({ otp_remaining: 200 })).toBe(false);
        expect(otpPoolIsLow({})).toBe(true);
        expect(otpPoolIsLow({ otp_remaining: NaN })).toBe(true);
    });
});
