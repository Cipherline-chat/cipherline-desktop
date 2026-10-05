import { describe, expect, it, vi } from 'vitest';
import { PhoneLinkController, type PhoneLinkDeps } from './phoneLinkController';
import { buildInviteQr } from './linkQr';

/**
 * "Sign in on your phone" — the desktop-as-approver state machine behind
 * `components/link/PhoneLinkPanel.tsx`. Same convention as
 * `QrSignInPanel.test.ts`: the controller is exercised directly with injected
 * deps (this app's vitest has no DOM). Weighted at the refusals: a wrong code
 * must not end the flow, a locked/denied invite must, and nothing may be
 * sealed to anything but the key the `joined` poll carried.
 */

const POLL_MS = 2000;
const TICK_MS = 250;
const TTL_MS = 120_000;
const INVITE_ID = 'InViTe1234567890abcdE_';
const PHONE_EK = 'P'.repeat(43) + '=';
const CLAIM_SECRET = 'c'.repeat(43);

function axiosError(status: number, data: Record<string, unknown>) {
    return Object.assign(new Error(String(data.message ?? 'request failed')), { isAxiosError: true, response: { status, data } });
}

function makeDeps(overrides: Partial<PhoneLinkDeps> = {}): PhoneLinkDeps {
    return {
        createInvite: vi.fn().mockResolvedValue({ invite_id: INVITE_ID, ttl_s: 120, expires_at: new Date(Date.now() + TTL_MS).toISOString() }),
        pollInvite: vi.fn().mockResolvedValue({ state: 'open', expires_in_s: 118 }),
        approve: vi.fn().mockResolvedValue({ v: 2, claim_secret: CLAIM_SECRET, user_id: 'USER1', approved_by_device_id: 'LAPTOP', approved_by_device_name: 'Work Laptop' }),
        deny: vi.fn().mockResolvedValue(undefined),
        seal: vi.fn().mockResolvedValue('SEALED_ENVELOPE'),
        postGrant: vi.fn().mockResolvedValue(undefined),
        renderQr: vi.fn().mockResolvedValue('data:image/png;base64,FAKE'),
        buildQrText: vi.fn(buildInviteQr),
        pollIntervalMs: POLL_MS,
        countdownTickMs: TICK_MS,
        ...overrides,
    };
}

const JOINED = { state: 'joined' as const, expires_in_s: 100, device_label: 'Dawson’s iPhone', platform: 'ios', ek_pub_b64: PHONE_EK, requires_2fa: null };

async function withTimers<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        return await fn();
    } finally {
        vi.useRealTimers();
    }
}

describe('buildInviteQr', () => {
    it('carries only the invite id, in the format mobile\'s parser expects', () => {
        expect(buildInviteQr(INVITE_ID)).toBe(`cipherline://invite/1?i=${INVITE_ID}`);
        // QR-4 discipline: a hostile id cannot smuggle a second parameter.
        expect(buildInviteQr('AAAAAAAAAAAAAAAAAAAAAA&k=EVIL')).not.toContain('&k=');
    });
});

describe('PhoneLinkController', () => {
    it('begin() creates an invite, renders the QR locally from the id alone, and polls until a phone joins', async () => {
        await withTimers(async () => {
            const pollInvite = vi.fn().mockResolvedValueOnce({ state: 'open' }).mockResolvedValue(JOINED);
            const deps = makeDeps({ pollInvite });
            const c = new PhoneLinkController(deps);
            await c.begin();
            expect(c.getSnapshot().phase).toBe('active');
            expect(deps.buildQrText).toHaveBeenCalledWith(INVITE_ID);
            expect(c.getSnapshot().qrDataUrl).toBe('data:image/png;base64,FAKE');

            await vi.advanceTimersByTimeAsync(POLL_MS);
            expect(c.getSnapshot().phase).toBe('active');
            await vi.advanceTimersByTimeAsync(POLL_MS);
            const snap = c.getSnapshot();
            expect(snap.phase).toBe('joined');
            expect(snap.joined).toEqual({ deviceLabel: 'Dawson’s iPhone', platform: 'ios', requires2fa: null });
            // The form stays put across later `joined` polls (the user is typing).
            await vi.advanceTimersByTimeAsync(POLL_MS * 2);
            expect(c.getSnapshot().phase).toBe('joined');
        });
    });

    it('rejects a malformed invite id before rendering anything', async () => {
        await withTimers(async () => {
            const deps = makeDeps({ createInvite: vi.fn().mockResolvedValue({ invite_id: 'bad&k=x', ttl_s: 120, expires_at: new Date(Date.now() + TTL_MS).toISOString() }) });
            const c = new PhoneLinkController(deps);
            await c.begin();
            expect(c.getSnapshot().phase).toBe('error');
            expect(deps.renderQr).not.toHaveBeenCalled();
        });
    });

    it('approve(): sends the typed code, seals a v2 grant to the JOINED phone\'s key, posts it, and reaches done when the phone claims', async () => {
        await withTimers(async () => {
            const pollInvite = vi.fn().mockResolvedValue(JOINED);
            const deps = makeDeps({ pollInvite });
            const c = new PhoneLinkController(deps);
            await c.begin();
            await vi.advanceTimersByTimeAsync(POLL_MS);
            expect(c.getSnapshot().phase).toBe('joined');

            await c.approve('654 321');
            expect(deps.approve).toHaveBeenCalledWith(INVITE_ID, { code: '654321' });
            const [payload, ekPub, linkId] = (deps.seal as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(ekPub).toBe(PHONE_EK);
            expect(linkId).toBe(INVITE_ID);
            expect(payload).toMatchObject({ type: 'link_grant', v: 2, link_id: INVITE_ID, user_id: 'USER1', claim_secret: CLAIM_SECRET, approved_by_device_name: 'Work Laptop' });
            expect(JSON.stringify(payload)).not.toMatch(/access_token|refresh_token/);
            expect(deps.postGrant).toHaveBeenCalledWith(INVITE_ID, 'SEALED_ENVELOPE');
            expect(c.getSnapshot().phase).toBe('granted');

            pollInvite.mockResolvedValue({ state: 'claimed' });
            await vi.advanceTimersByTimeAsync(POLL_MS);
            expect(c.getSnapshot().phase).toBe('done');
        });
    });

    it('a wrong code keeps the form open with the server\'s message and attempts left; locked ends the flow', async () => {
        await withTimers(async () => {
            const approve = vi.fn()
                .mockRejectedValueOnce(axiosError(403, { error: 'link_code_mismatch', message: 'That code does not match the one on the other device.', attempts_left: 4 }))
                .mockRejectedValueOnce(axiosError(403, { error: 'link_locked', message: 'Too many wrong codes' }));
            const deps = makeDeps({ pollInvite: vi.fn().mockResolvedValue(JOINED), approve });
            const c = new PhoneLinkController(deps);
            await c.begin();
            await vi.advanceTimersByTimeAsync(POLL_MS);

            await c.approve('000000');
            let snap = c.getSnapshot();
            expect(snap.phase).toBe('joined');
            expect(snap.formError).toContain('does not match');
            expect(snap.formError).toContain('4 tries left');
            expect(deps.seal).not.toHaveBeenCalled();

            await c.approve('000001');
            snap = c.getSnapshot();
            expect(snap.phase).toBe('denied');
            expect(snap.deniedReason).toBe('locked');
            expect(deps.postGrant).not.toHaveBeenCalled();
        });
    });

    it('a second factor: forwards totp_code / backup_code, and a 2fa-required answer flips the form to ask for one', async () => {
        await withTimers(async () => {
            const approve = vi.fn()
                .mockRejectedValueOnce(axiosError(403, { error: 'link_2fa_required', message: 'Enter your authenticator code to approve this sign-in.', method: 'totp' }))
                .mockResolvedValue({ v: 2, claim_secret: CLAIM_SECRET, user_id: 'USER1', approved_by_device_id: 'LAPTOP', approved_by_device_name: 'Work Laptop' });
            const deps = makeDeps({ pollInvite: vi.fn().mockResolvedValue(JOINED), approve });
            const c = new PhoneLinkController(deps);
            await c.begin();
            await vi.advanceTimersByTimeAsync(POLL_MS);

            await c.approve('654321');
            expect(c.getSnapshot().phase).toBe('joined');
            expect(c.getSnapshot().joined?.requires2fa).toBe('totp');
            await c.approve('654321', { totp_code: '424 242' });
            expect(approve).toHaveBeenLastCalledWith(INVITE_ID, { code: '654321', totp_code: '424242' });
            expect(c.getSnapshot().phase).toBe('granted');
        });
    });

    it('refuses to seal anything if the server answered with a v1 (tokens) shape — this desktop never handles another device\'s tokens', async () => {
        await withTimers(async () => {
            const deps = makeDeps({
                pollInvite: vi.fn().mockResolvedValue(JOINED),
                approve: vi.fn().mockResolvedValue({ v: 1, access_token: 'A', refresh_token: 'R', user_id: 'USER1' }),
            });
            const c = new PhoneLinkController(deps);
            await c.begin();
            await vi.advanceTimersByTimeAsync(POLL_MS);
            await c.approve('654321');
            expect(c.getSnapshot().phase).toBe('error');
            expect(deps.seal).not.toHaveBeenCalled();
            expect(deps.postGrant).not.toHaveBeenCalled();
        });
    });

    it('denyJoined() ("Not this phone") burns the invite and stops polling; a phone-side denial/lock reaches denied too', async () => {
        await withTimers(async () => {
            const pollInvite = vi.fn().mockResolvedValue(JOINED);
            const deps = makeDeps({ pollInvite });
            const c = new PhoneLinkController(deps);
            await c.begin();
            await vi.advanceTimersByTimeAsync(POLL_MS);
            await c.denyJoined();
            expect(deps.deny).toHaveBeenCalledWith(INVITE_ID);
            expect(c.getSnapshot()).toMatchObject({ phase: 'denied', deniedReason: 'not_me' });
            const polls = pollInvite.mock.calls.length;
            await vi.advanceTimersByTimeAsync(POLL_MS * 3);
            expect(pollInvite.mock.calls.length).toBe(polls);

            const c2 = new PhoneLinkController(makeDeps({ pollInvite: vi.fn().mockResolvedValue({ state: 'denied', reason: 'locked' }) }));
            await c2.begin();
            await vi.advanceTimersByTimeAsync(POLL_MS);
            expect(c2.getSnapshot()).toMatchObject({ phase: 'denied', deniedReason: 'locked' });
        });
    });

    it('expires on the local countdown and never auto-refreshes; cancel() returns to idle', async () => {
        await withTimers(async () => {
            const deps = makeDeps();
            const c = new PhoneLinkController(deps);
            await c.begin();
            await vi.advanceTimersByTimeAsync(TTL_MS + TICK_MS);
            expect(c.getSnapshot().phase).toBe('expired');
            expect(deps.createInvite).toHaveBeenCalledTimes(1);

            const c2 = new PhoneLinkController(makeDeps());
            await c2.begin();
            c2.cancel();
            expect(c2.getSnapshot().phase).toBe('idle');
        });
    });

    it('dispose() mid-flight stops every timer and swallows late results', async () => {
        await withTimers(async () => {
            const pollInvite = vi.fn().mockResolvedValue(JOINED);
            const deps = makeDeps({ pollInvite });
            const c = new PhoneLinkController(deps);
            await c.begin();
            c.dispose();
            const polls = pollInvite.mock.calls.length;
            await vi.advanceTimersByTimeAsync(POLL_MS * 3);
            expect(pollInvite.mock.calls.length).toBe(polls);
            expect(c.getSnapshot().phase).toBe('active'); // frozen, never advanced to joined
        });
    });
});
