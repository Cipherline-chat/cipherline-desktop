import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));
vi.mock('../constants', () => ({ API_BASE: 'http://api.test/v1' }));
vi.mock('./secureLocalStore', () => ({ default: { setItem: vi.fn() } }));
vi.mock('./keyBundleUpload', () => ({ publishIdentityBundle: vi.fn().mockResolvedValue(undefined) }));

import { registerOrReuseDevice } from './deviceRegistration';

const g = globalThis as unknown as { window: { electronAPI?: Record<string, unknown> } };
const PROOF = { identityPub: 'IDPUB', sig: 'SIG' };

beforeEach(() => {
    post.mockReset();
    g.window.electronAPI = { platform: 'windows', getDeviceName: async () => 'MY-PC', getDeviceRegisterProof: vi.fn().mockResolvedValue(PROOF) };
});
afterEach(() => { g.window.electronAPI = undefined; });

describe('registerOrReuseDevice — device approval', () => {
    it('an approved device: no approval block, requiresPairing false', async () => {
        post.mockResolvedValue({ data: { device_id: 'd1', requires_pairing: false } });
        expect(await registerOrReuseDevice('u', 'tok', 'x')).toEqual({ deviceId: 'd1', requiresPairing: false });
    });

    it('a pending device: hands the screen the nonce, expiry and OUR identity key (the code\'s other input)', async () => {
        post.mockResolvedValue({ data: {
            device_id: 'd2', requires_pairing: true,
            approval: { status: 'pending', nonce_b64: 'NONCE', expires_at: '2026-10-12T10:15:00.000Z', reset_due_at: null },
        } });
        expect(await registerOrReuseDevice('u', 'tok', 'x')).toEqual({
            deviceId: 'd2', requiresPairing: true,
            approval: { nonceB64: 'NONCE', expiresAt: '2026-10-12T10:15:00.000Z', resetDueAt: null, identityPub: 'IDPUB' },
        });
    });

    it('requires_pairing WITHOUT an approval block (a server that does not speak the pending flow) keeps the legacy screen: no approval', async () => {
        post.mockResolvedValue({ data: { device_id: 'd3', requires_pairing: true } });
        const out = await registerOrReuseDevice('u', 'tok', 'x');
        expect(out.requiresPairing).toBe(true);
        expect(out.approval).toBeUndefined();
    });

    it('a malformed approval block (no nonce) is not trusted', async () => {
        post.mockResolvedValue({ data: { device_id: 'd4', requires_pairing: true, approval: { status: 'pending', nonce_b64: '' } } });
        expect((await registerOrReuseDevice('u', 'tok', 'x')).approval).toBeUndefined();
    });

    it('no proof (web / no signer) can never produce a pending screen — the code needs our own key', async () => {
        g.window.electronAPI!.getDeviceRegisterProof = vi.fn().mockResolvedValue(null);
        post.mockResolvedValue({ data: { device_id: 'd5', requires_pairing: true, approval: { status: 'pending', nonce_b64: 'N' } } });
        expect((await registerOrReuseDevice('u', 'tok', 'x')).approval).toBeUndefined();
    });
});
