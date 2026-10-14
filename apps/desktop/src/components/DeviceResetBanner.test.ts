// @vitest-environment jsdom
/**
 * "A device reset was requested — Cancel reset" (DeviceResetBanner).
 *
 * Rendered for real (jsdom + react-dom), with only the network, the auth/toast
 * contexts and the kit button's physics replaced. The cancel flow goes through
 * the REAL `cancelDeviceReset`, so what is asserted on the wire is what ships:
 * a `deny`-decision signature from this device's main process, a POST to
 * `cancel-reset`, `x-device-id`. Negative controls: no banner without a reset,
 * and no network call without a signature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a), get: vi.fn(), put: vi.fn() } }));
vi.mock('../constants', () => ({ API_BASE: 'http://api.test/v1' }));
vi.mock('../contexts/AuthContext', () => ({
    useAuth: () => ({ token: 'TOKEN', userId: 'user-1', deviceId: 'my-device' }),
}));
const toastPush = vi.fn();
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: toastPush }) }));
vi.mock('./ClButton', () => ({
    ClButton: (p: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean }) =>
        React.createElement('button', { onClick: p.onClick, disabled: !!(p.disabled || p.loading), 'data-testid': 'cancel' }, p.children),
}));

import { DeviceResetBanner } from './DeviceResetBanner';
import type { PendingDeviceRequest } from '../utils/deviceApproval';

const FUTURE = new Date(Date.now() + 20 * 3_600_000).toISOString();
const req = (over: Partial<PendingDeviceRequest> = {}): PendingDeviceRequest => ({
    device_id: 'pending-1', device_name: 'NEW-PC', platform: 'windows',
    identity_key_pub_b64: Buffer.alloc(32, 7).toString('base64'),
    nonce_b64: Buffer.alloc(16, 9).toString('base64'),
    requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 21 * 3_600_000).toISOString(),
    reset_due_at: FUTURE, ip_hint: null,
    ...over,
});

let root: Root;
const el = () => document.getElementById('root') as HTMLElement;
const button = () => el().querySelector('[data-testid="cancel"]') as HTMLButtonElement | null;
const setApi = (a: Record<string, unknown> | undefined) => { (window as unknown as { electronAPI?: unknown }).electronAPI = a; };
function render(requests: PendingDeviceRequest[], onResolved = vi.fn()) {
    act(() => { root.render(React.createElement(DeviceResetBanner, { requests, onResolved })); });
    return onResolved;
}
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    post.mockReset(); post.mockResolvedValue({ data: { success: true } });
    toastPush.mockReset();
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(el());
});
afterEach(() => { act(() => root.unmount()); setApi(undefined); });

describe('DeviceResetBanner', () => {
    it('shows the prominent alert with the requesting device, platform and completion time', () => {
        render([req()]);
        const banner = el().querySelector('[data-testid="device-reset-banner"]')!;
        expect(banner).not.toBeNull();
        expect(banner.getAttribute('role')).toBe('alert');
        expect(banner.textContent).toContain('A device reset was requested');
        expect(banner.textContent).toContain('NEW-PC');
        expect(banner.textContent).toContain('Windows');
        expect(button()?.textContent).toBe('Cancel reset');
    });

    it('NEGATIVE: renders nothing for an ordinary request with no reset, and for a reset whose time has passed', () => {
        render([req({ reset_due_at: null })]);
        expect(el().querySelector('[data-testid="device-reset-banner"]')).toBeNull();
        render([req({ reset_due_at: new Date(Date.now() - 1000).toISOString() })]);
        expect(el().querySelector('[data-testid="device-reset-banner"]')).toBeNull();
        render([]);
        expect(el().innerHTML).toBe('');
    });

    it('Cancel reset: signs a DENY decision in main, POSTs cancel-reset with x-device-id, toasts, and reports it resolved', async () => {
        const sign = vi.fn().mockResolvedValue({ identityPub: 'IDPUB', sig: 'SIG' });
        setApi({ signDeviceApproval: sign });
        const r = req();
        const onResolved = render([r]);

        act(() => { button()!.click(); });
        await flush();

        expect(sign).toHaveBeenCalledTimes(1);
        expect(sign).toHaveBeenCalledWith('user-1', 'my-device', 'pending-1', r.identity_key_pub_b64, 'deny', expect.any(Number));
        expect(post).toHaveBeenCalledWith(
            'http://api.test/v1/devices/pending-1/cancel-reset',
            { approver_sig_b64: 'SIG', approver_ts: expect.any(Number) },
            { headers: { Authorization: 'Bearer TOKEN', 'x-device-id': 'my-device' } },
        );
        expect(toastPush).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Device reset cancelled' }));
        expect(onResolved).toHaveBeenCalledWith('pending-1');
    });

    it('NEGATIVE: with no signature (locked keystore / not the desktop shell) NOTHING is sent and the banner stays, with an error', async () => {
        setApi({ signDeviceApproval: vi.fn().mockResolvedValue(null) });
        const onResolved = render([req()]);
        act(() => { button()!.click(); });
        await flush();
        expect(post).not.toHaveBeenCalled();
        expect(onResolved).not.toHaveBeenCalled();
        expect(el().querySelector('[data-testid="device-reset-error"]')?.textContent).toMatch(/did not sign/i);
        expect(el().querySelector('[data-testid="device-reset-banner"]')).not.toBeNull();
    });

    it('a server refusal keeps the banner and shows why', async () => {
        setApi({ signDeviceApproval: vi.fn().mockResolvedValue({ identityPub: 'IDPUB', sig: 'SIG' }) });
        post.mockRejectedValue({ response: { status: 403, data: { error: 'device_approval_bad_signature' } } });
        const onResolved = render([req()]);
        act(() => { button()!.click(); });
        await flush();
        expect(onResolved).not.toHaveBeenCalled();
        expect(el().querySelector('[data-testid="device-reset-error"]')?.textContent).toMatch(/could not vouch/i);
    });

    it('a 404 (already over / cancelled elsewhere) drops the banner instead of leaving a dead button', async () => {
        setApi({ signDeviceApproval: vi.fn().mockResolvedValue({ identityPub: 'IDPUB', sig: 'SIG' }) });
        post.mockRejectedValue({ response: { status: 404, data: {} } });
        const onResolved = render([req()]);
        act(() => { button()!.click(); });
        await flush();
        expect(onResolved).toHaveBeenCalledWith('pending-1');
    });
});
