import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const post = vi.fn();
const get = vi.fn();
const put = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) } }));
vi.mock('../constants', () => ({ API_BASE: 'http://api.test/v1' }));

import {
    NoSignerError, activeResetRequests, approvePendingDevice, cancelDeviceReset, codeForRequest, denyPendingDevice, describeApprovalError, deviceApprovalBus,
    dispatchDeviceApprovalFrame, fetchApprovalStatus, fetchPendingRequests, formatCountdown, parseApprovalPendingEvent,
    parseApprovalResolvedEvent, pruneExpired, publishRecoveryCommitment, removePending, requestDeviceReset, secondsUntil,
    submitRecoveryKeyProof, upsertPending, type DeviceApprovalEvent, type PendingDeviceRequest,
} from './deviceApproval';

const USER = '11111111-2222-3333-4444-555555555555';
const ME = 'approver-device';
const CTX = { token: 'TOKEN', userId: USER, deviceId: ME };

const req = (over: Partial<PendingDeviceRequest> = {}): PendingDeviceRequest => ({
    device_id: 'pending-1', device_name: 'NEW-PC', platform: 'windows',
    identity_key_pub_b64: Buffer.alloc(32, 7).toString('base64'),
    nonce_b64: Buffer.alloc(16, 9).toString('base64'),
    requested_at: '2026-10-12T10:00:00.000Z', expires_at: '2026-10-12T10:15:00.000Z',
    reset_due_at: null, ip_hint: '203.0.0.0',
    ...over,
});

function setApi(a: Record<string, unknown> | undefined) { (globalThis as unknown as { window: { electronAPI?: unknown } }).window.electronAPI = a; }

beforeEach(() => { post.mockReset(); get.mockReset(); put.mockReset(); post.mockResolvedValue({ data: {} }); put.mockResolvedValue({ data: {} }); });
afterEach(() => { setApi(undefined); vi.useRealTimers(); });

describe('wire parsing', () => {
    it('parses a well-formed device:approval_pending', () => {
        const wire = { ...req(), ip_hint: '203.0.0.0' };
        expect(parseApprovalPendingEvent(wire)).toEqual(req());
    });

    it.each([
        ['null', null], ['string', 'x'],
        ['no key', { ...req(), identity_key_pub_b64: '' }],
        ['no nonce', { ...req(), nonce_b64: undefined }],
        ['no name', { ...req(), device_name: 5 }],
        ['no expiry', { ...req(), expires_at: undefined }],
    ])('refuses a malformed pending event (%s) — a prompt that cannot be verified must not render', (_n, wire) => {
        expect(parseApprovalPendingEvent(wire)).toBeNull();
    });

    it('treats a missing reset/ip as null', () => {
        const rest: Partial<PendingDeviceRequest> = req();
        delete rest.reset_due_at; delete rest.ip_hint;
        expect(parseApprovalPendingEvent(rest)).toMatchObject({ reset_due_at: null, ip_hint: null });
    });

    it('parses device:approval_resolved and refuses unknown statuses', () => {
        expect(parseApprovalResolvedEvent({ device_id: 'd', status: 'denied', by_device_id: 'a' })).toEqual({ device_id: 'd', status: 'denied', by_device_id: 'a' });
        expect(parseApprovalResolvedEvent({ device_id: 'd', status: 'expired' })).toEqual({ device_id: 'd', status: 'expired', by_device_id: null });
        expect(parseApprovalResolvedEvent({ device_id: 'd', status: 'pending' })).toBeNull();
        expect(parseApprovalResolvedEvent({ status: 'approved' })).toBeNull();
        expect(parseApprovalResolvedEvent(undefined)).toBeNull();
    });
});

describe('queue reducers', () => {
    it('upsert keeps oldest first and replaces a re-announced request', () => {
        const a = req({ device_id: 'a', requested_at: '2026-10-12T10:02:00.000Z' });
        const b = req({ device_id: 'b', requested_at: '2026-10-12T10:01:00.000Z' });
        let q = upsertPending([], a);
        q = upsertPending(q, b);
        expect(q.map(r => r.device_id)).toEqual(['b', 'a']);
        q = upsertPending(q, { ...a, nonce_b64: 'NEW' });
        expect(q).toHaveLength(2);
        expect(q.find(r => r.device_id === 'a')!.nonce_b64).toBe('NEW');
    });

    it('remove returns the same array when nothing matches', () => {
        const q = [req()];
        expect(removePending(q, 'nope')).toBe(q);
        expect(removePending(q, 'pending-1')).toEqual([]);
    });

    it('pruneExpired drops lapsed requests and returns the SAME array when none lapsed', () => {
        const now = Date.parse('2026-10-12T10:10:00.000Z');
        const live = req({ device_id: 'live' });
        const dead = req({ device_id: 'dead', expires_at: '2026-10-12T10:09:59.000Z' });
        expect(pruneExpired([live, dead], now).map(r => r.device_id)).toEqual(['live']);
        const only = [live];
        expect(pruneExpired(only, now)).toBe(only);
    });

    it('secondsUntil / formatCountdown', () => {
        const now = Date.parse('2026-10-12T10:00:00.000Z');
        expect(secondsUntil('2026-10-12T10:14:34.000Z', now)).toBe(874);
        expect(secondsUntil('2026-10-12T09:00:00.000Z', now)).toBe(0);
        expect(secondsUntil(null, now)).toBeNull();
        expect(secondsUntil('garbage', now)).toBeNull();
        expect(formatCountdown(874)).toBe('14:34');
        expect(formatCountdown(65)).toBe('1:05');
        expect(formatCountdown(0)).toBe('0:00');
        expect(formatCountdown(-5)).toBe('0:00');
    });
});

describe('the verification code', () => {
    it('is the published test vector (apps/api device-approval.util.spec.ts pins the same one)', async () => {
        const r = req({ identity_key_pub_b64: Buffer.alloc(32, 7).toString('base64'), nonce_b64: Buffer.alloc(16, 9).toString('base64') });
        expect(await codeForRequest(USER, r)).toBe('024953');
    });

    it('differs when the relay substitutes the identity key', async () => {
        const honest = await codeForRequest(USER, req());
        const swapped = await codeForRequest(USER, req({ identity_key_pub_b64: Buffer.alloc(32, 8).toString('base64') }));
        expect(swapped).not.toBe(honest);
    });
});

describe('approve / deny — signed by THIS device', () => {
    it('approve signs the canonical decision, then posts code + signature with x-device-id', async () => {
        const sign = vi.fn().mockResolvedValue({ identityPub: 'IDPUB', sig: 'SIG' });
        setApi({ signDeviceApproval: sign });
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T10:00:00.000Z'));
        const r = req();
        await approvePendingDevice(CTX, r, '024953');
        const ts = Math.floor(Date.parse('2026-10-12T10:00:00.000Z') / 1000);
        // The main process shows "Approve <name> (<platform>)?" from `display` before it signs.
        expect(sign).toHaveBeenCalledWith(USER, ME, 'pending-1', r.identity_key_pub_b64, 'approve', ts, { deviceName: 'NEW-PC', platform: 'windows' });
        expect(post).toHaveBeenCalledWith(
            'http://api.test/v1/devices/pending-1/approve',
            { code: '024953', approver_sig_b64: 'SIG', approver_ts: ts },
            { headers: { Authorization: 'Bearer TOKEN', 'x-device-id': ME } },
        );
    });

    it('deny signs "deny" (an approve signature must not be reusable) and sends no code', async () => {
        const sign = vi.fn().mockResolvedValue({ identityPub: 'IDPUB', sig: 'SIG' });
        setApi({ signDeviceApproval: sign });
        await denyPendingDevice(CTX, req());
        expect(sign.mock.calls[0][4]).toBe('deny');
        const [url, body] = post.mock.calls[0];
        expect(url).toBe('http://api.test/v1/devices/pending-1/deny');
        expect(body).not.toHaveProperty('code');
        expect(body).toEqual({ approver_sig_b64: 'SIG', approver_ts: expect.any(Number) });
    });

    it('with no signer (not the desktop shell) NOTHING is sent', async () => {
        setApi({});
        await expect(approvePendingDevice(CTX, req(), '024953')).rejects.toBeInstanceOf(NoSignerError);
        await expect(denyPendingDevice(CTX, req())).rejects.toBeInstanceOf(NoSignerError);
        expect(post).not.toHaveBeenCalled();
    });

    it('a signer that returns null (locked keystore) sends nothing either', async () => {
        setApi({ signDeviceApproval: vi.fn().mockResolvedValue(null) });
        await expect(approvePendingDevice(CTX, req(), '024953')).rejects.toBeInstanceOf(NoSignerError);
        expect(post).not.toHaveBeenCalled();
    });
});

describe('cooling-off reset — notice and cancel', () => {
    const NOW = Date.parse('2026-10-12T10:00:00.000Z');
    const resetting = (over: Partial<PendingDeviceRequest> = {}) => req({ reset_due_at: '2026-10-13T10:00:00.000Z', ...over });

    it('device:reset_requested lands on the bus as a pending request carrying reset_due_at', () => {
        const seen: DeviceApprovalEvent[] = [];
        const off = deviceApprovalBus.subscribe(e => seen.push(e));
        expect(dispatchDeviceApprovalFrame('device:reset_requested', resetting())).toBe(true);
        off();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ kind: 'pending', request: { device_id: 'pending-1', reset_due_at: '2026-10-13T10:00:00.000Z' } });
    });

    it('NEGATIVE: a device:reset_requested with no reset date, or malformed, is ours but dropped — never upgraded into a prompt', () => {
        const seen: DeviceApprovalEvent[] = [];
        const off = deviceApprovalBus.subscribe(e => seen.push(e));
        expect(dispatchDeviceApprovalFrame('device:reset_requested', req({ reset_due_at: null }))).toBe(true);
        expect(dispatchDeviceApprovalFrame('device:reset_requested', { device_id: 'x' })).toBe(true);
        off();
        expect(seen).toEqual([]);
    });

    it('activeResetRequests keeps only requests whose reset is still ahead', () => {
        const list = [
            resetting({ device_id: 'a' }),
            req({ device_id: 'b', reset_due_at: null }),
            resetting({ device_id: 'c', reset_due_at: '2026-10-12T09:59:59.000Z' }),
            resetting({ device_id: 'd', reset_due_at: 'garbage' }),
        ];
        expect(activeResetRequests(list, NOW).map(r => r.device_id)).toEqual(['a']);
    });

    it('cancelDeviceReset signs a DENY decision (an approve signature must not be reusable) and posts to cancel-reset with x-device-id', async () => {
        const sign = vi.fn().mockResolvedValue({ identityPub: 'IDPUB', sig: 'SIG' });
        setApi({ signDeviceApproval: sign });
        const r = resetting();
        await cancelDeviceReset(CTX, r);
        expect(sign).toHaveBeenCalledWith(USER, ME, 'pending-1', r.identity_key_pub_b64, 'deny', expect.any(Number));
        const [url, body, cfg] = post.mock.calls[0];
        expect(url).toBe('http://api.test/v1/devices/pending-1/cancel-reset');
        expect(body).toEqual({ approver_sig_b64: 'SIG', approver_ts: expect.any(Number) });
        expect(body).not.toHaveProperty('code');
        expect(cfg).toEqual({ headers: { Authorization: 'Bearer TOKEN', 'x-device-id': ME } });
    });

    it('NEGATIVE: cancelDeviceReset with no signer, or a signer that returns null, sends nothing', async () => {
        setApi({});
        await expect(cancelDeviceReset(CTX, resetting())).rejects.toBeInstanceOf(NoSignerError);
        setApi({ signDeviceApproval: vi.fn().mockResolvedValue(null) });
        await expect(cancelDeviceReset(CTX, resetting())).rejects.toBeInstanceOf(NoSignerError);
        expect(post).not.toHaveBeenCalled();
    });
});

describe('recovery key', () => {
    it('proves with the typed key via the main process and posts the derived public key + signature', async () => {
        const prove = vi.fn().mockResolvedValue({ recoveryPub: 'RPUB', sig: 'RSIG' });
        setApi({ proveRecoveryKey: prove });
        await submitRecoveryKeyProof('TOKEN', USER, 'dev', 'IDPUB', '  TYPEDKEY  ');
        // trimmed, and passed IN to main only
        expect(prove).toHaveBeenCalledWith('TYPEDKEY', USER, 'dev', 'IDPUB', expect.any(Number));
        const [url, body, cfg] = post.mock.calls[0];
        expect(url).toBe('http://api.test/v1/devices/dev/recovery-proof');
        expect(body).toEqual({ recovery_pub_b64: 'RPUB', sig_b64: 'RSIG', ts: expect.any(Number) });
        expect(JSON.stringify(body)).not.toContain('TYPEDKEY'); // the key itself never goes to the server
        expect(cfg.headers).toEqual({ Authorization: 'Bearer TOKEN' });
    });

    it('a mistyped key (main derives nothing) is reported as an invalid key and sends nothing', async () => {
        setApi({ proveRecoveryKey: vi.fn().mockResolvedValue(null) });
        const err = await submitRecoveryKeyProof('TOKEN', USER, 'dev', 'IDPUB', 'short').catch(e => e);
        expect(describeApprovalError(err).kind).toBe('recovery_invalid');
        expect(post).not.toHaveBeenCalled();
    });

    it('publishRecoveryCommitment signs in main, PUTs only public material, and never throws', async () => {
        const getRecoveryCommitment = vi.fn().mockResolvedValue({ recoveryPub: 'RPUB', identityPub: 'IDPUB', sig: 'CSIG' });
        setApi({ getRecoveryCommitment });
        expect(await publishRecoveryCommitment('TOKEN', USER, ME)).toBe(true);
        const [url, body] = put.mock.calls[0];
        expect(url).toBe(`http://api.test/v1/devices/${ME}/recovery-commitment`);
        expect(body).toEqual({ recovery_pub_b64: 'RPUB', identity_sig_b64: 'CSIG', ts: expect.any(Number) });

        put.mockRejectedValueOnce(new Error('offline'));
        expect(await publishRecoveryCommitment('TOKEN', USER, ME)).toBe(false);
        setApi({ getRecoveryCommitment: vi.fn().mockResolvedValue(null) });
        expect(await publishRecoveryCommitment('TOKEN', USER, ME)).toBe(false);
        setApi(undefined);
        expect(await publishRecoveryCommitment('TOKEN', USER, ME)).toBe(false);
    });
});

describe('plain requests', () => {
    it('fetchPendingRequests parses the list and drops malformed rows', async () => {
        get.mockResolvedValue({ data: [req(), { garbage: true }] });
        const out = await fetchPendingRequests('TOKEN');
        expect(out).toEqual([req()]);
        expect(get).toHaveBeenCalledWith('http://api.test/v1/devices/pending', { headers: { Authorization: 'Bearer TOKEN' } });
        get.mockResolvedValue({ data: 'nope' });
        expect(await fetchPendingRequests('TOKEN')).toEqual([]);
    });

    it('fetchApprovalStatus / requestDeviceReset hit the per-device routes', async () => {
        get.mockResolvedValue({ data: { status: 'pending' } });
        expect(await fetchApprovalStatus('TOKEN', 'dev')).toEqual({ status: 'pending' });
        expect(get.mock.calls[0][0]).toBe('http://api.test/v1/devices/dev/approval');
        post.mockResolvedValue({ data: { ok: true, reset_due_at: '2026-10-13T10:00:00.000Z' } });
        expect(await requestDeviceReset('TOKEN', 'dev')).toEqual({ resetDueAt: '2026-10-13T10:00:00.000Z' });
        expect(post.mock.calls[0][0]).toBe('http://api.test/v1/devices/dev/reset-request');
    });
});

describe('describeApprovalError', () => {
    const http = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

    it.each([
        ['device_approval_code_mismatch', 'code_mismatch'],
        ['device_approval_locked', 'locked'],
        ['device_approval_expired', 'expired'],
        ['device_approval_bad_signature', 'bad_signature'],
        ['device_recovery_key_invalid', 'recovery_invalid'],
        ['device_approval_required', 'enforce_required'],
    ])('%s -> %s', (error, kind) => {
        expect(describeApprovalError(http(403, { error })).kind).toBe(kind);
    });

    it('carries attempts_left on a code mismatch', () => {
        expect(describeApprovalError(http(403, { error: 'device_approval_code_mismatch', attempts_left: 2 }))).toMatchObject({ kind: 'code_mismatch', attemptsLeft: 2 });
    });

    it('falls back to the status code, the network, then the message', () => {
        expect(describeApprovalError(http(429, {})).kind).toBe('rate_limited');
        expect(describeApprovalError(http(404, {})).kind).toBe('expired');
        expect(describeApprovalError({ request: {}, message: 'Network Error' }).kind).toBe('network');
        expect(describeApprovalError(http(500, { message: 'boom' }))).toMatchObject({ kind: 'unknown', message: 'boom' });
        expect(describeApprovalError(new NoSignerError()).kind).toBe('no_signer');
    });
});

describe('deviceApprovalBus', () => {
    it('delivers parsed frames to subscribers, in order, and ignores malformed ones', () => {
        const seen: DeviceApprovalEvent[] = [];
        const off = deviceApprovalBus.subscribe(e => seen.push(e));
        expect(dispatchDeviceApprovalFrame('device:approval_pending', req())).toBe(true);
        expect(dispatchDeviceApprovalFrame('device:approval_resolved', { device_id: 'pending-1', status: 'approved', by_device_id: 'x' })).toBe(true);
        expect(dispatchDeviceApprovalFrame('device:approval_pending', { nope: 1 })).toBe(true); // ours, but malformed: dropped
        expect(dispatchDeviceApprovalFrame('message:new', {})).toBe(false);
        off();
        dispatchDeviceApprovalFrame('device:approval_pending', req());
        expect(seen.map(e => e.kind)).toEqual(['pending', 'resolved']);
    });

    it('one failing subscriber does not stop the others', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const got = vi.fn();
        const a = deviceApprovalBus.subscribe(() => { throw new Error('boom'); });
        const b = deviceApprovalBus.subscribe(got);
        deviceApprovalBus.emit({ kind: 'resolved', resolved: { device_id: 'd', status: 'denied', by_device_id: null } });
        a(); b(); spy.mockRestore();
        expect(got).toHaveBeenCalledTimes(1);
    });
});

/**
 * Source-level wiring checks. The server events and the screens are only worth
 * anything if they are connected — the failure class this repo has hit before
 * (an event emitted into the void; a consumer written in a file nothing mounts).
 * apps/desktop's vitest has no DOM, so these scan the source, like
 * FirstWeekNudges.wiring.test.ts.
 */
describe('wiring', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

    it('useRealtime routes all three approval events onto the bus', () => {
        const rt = src('hooks/useRealtime.ts');
        expect(rt).toContain("'device:approval_pending'");
        expect(rt).toContain("'device:reset_requested'");
        expect(rt).toContain("'device:approval_resolved'");
        expect(rt).toMatch(/dispatchDeviceApprovalFrame\(msg\.event, msg\.data\)/);
    });

    it('the approver host mounts the reset banner over the whole queue (it is not parkable like the modal)', () => {
        const h = src('components/DeviceApprovalHost.tsx');
        expect(h).toMatch(/<DeviceResetBanner requests=\{queue\}/);
        expect(src('components/DeviceResetBanner.tsx')).toContain('Cancel reset');
    });

    it('Dashboard mounts the approver host with the reconnect counter', () => {
        expect(src('components/Dashboard.tsx')).toMatch(/<DeviceApprovalHost wsConnectCount=\{wsConnectCount\} \/>/);
    });

    it('AuthScreen shows the pending screen only when the server returned an approval request, and keeps the legacy screen otherwise', () => {
        const a = src('components/AuthScreen.tsx');
        expect(a).toMatch(/view === 'device-not-approved' && pendingRegPayload\?\.approval/);
        expect(a).toContain('<DeviceApprovalPending');
        expect(a).toMatch(/view === 'device-not-approved' && pendingRegPayload\) \{/); // legacy fallback still there
        // Approval hands off to the ordinary existing-account login, not a bespoke path.
        expect(a).toMatch(/onApproved=\{\(\) => \{ void finishExistingAccountLogin\(/);
    });

    it('Settings → Devices lists pending requests and reviews them in the shared modal', () => {
        const d = src('components/settings/panes/DevicesPane.tsx');
        expect(d).toContain('fetchPendingRequests');
        expect(d).toContain('deviceApprovalBus.subscribe');
        expect(d).toContain('<DeviceApprovalModal');
        expect(d).toContain('Waiting for approval');
    });

    it('the QR panels carry the device-approval material (new device advertises its key; approver signs)', () => {
        expect(src('components/link/QrSignInPanel.tsx')).toContain('getIdentityPub');
        expect(src('components/link/PhoneLinkPanel.tsx')).toContain('signLinkApproval');
    });

    it('registration exposes the pending approval to its callers', () => {
        const r = src('utils/deviceRegistration.ts');
        expect(r).toContain('approval');
        expect(r).toMatch(/identityPub: proof\.identityPub/);
    });

    it('the "This wasn\'t me" path denies first and then offers a password change (modal + notice exist)', () => {
        const m = src('components/DeviceApprovalModal.tsx');
        expect(m).toContain("This wasn't me");
        expect(m).toMatch(/denyPendingDevice\(ctx, request\)/);
        expect(m).toContain('DeviceRemovedNotice');
        expect(src('components/DeviceApprovalHost.tsx')).toContain('ChangePasswordModal');
    });

    it('every main-process signer is registered in main.ts, exposed in preload.ts and typed in env.d.ts', () => {
        const electron = (rel: string) => readFileSync(join(__dirname, '..', '..', 'electron', rel), 'utf8');
        const main = electron('main.ts');
        const preload = electron('preload.ts');
        const env = src('env.d.ts');
        const pairs: Array<[channel: string, bridge: string]> = [
            ['crypto:identity-pub', 'getIdentityPub'],
            ['crypto:device-approval-sign', 'signDeviceApproval'],
            ['crypto:link-approval-sign', 'signLinkApproval'],
            ['crypto:recovery-commitment', 'getRecoveryCommitment'],
            ['crypto:recovery-proof', 'proveRecoveryKey'],
        ];
        for (const [channel, bridge] of pairs) {
            expect(main, channel).toContain(`ipcMain.handle('${channel}'`);
            expect(preload, channel).toContain(`ipcRenderer.invoke('${channel}'`);
            expect(preload, bridge).toMatch(new RegExp(`\\b${bridge}:`));
            expect(env, bridge).toMatch(new RegExp(`\\b${bridge}\\??:`));
        }
    });

    it('the approver modal never displays the code (it must be typed from the new device)', () => {
        const m = src('components/DeviceApprovalModal.tsx');
        expect(m).not.toMatch(/formatDeviceApprovalCode/);
        expect(m).toMatch(/typed !== derived/);
    });
});
