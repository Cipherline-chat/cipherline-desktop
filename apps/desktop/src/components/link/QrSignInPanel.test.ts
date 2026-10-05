import { describe, expect, it, vi } from 'vitest';
import { QrSignInController, type QrSignInDeps } from '../../utils/qrSignInController';
import { buildLinkQr } from '../../utils/linkQr';

/**
 * Covers `QrSignInPanel.tsx`'s behaviour via the controller it is a thin view
 * over (`../../utils/qrSignInController.ts`) — `apps/desktop`'s vitest config
 * runs a plain Node environment with no DOM and no `@testing-library` (see
 * `vitest.config.ts`'s header comment and its `include` glob, which matches
 * `*.test.ts` only), so every suite in this app tests logic directly rather
 * than mounting a component. This file is intentionally named `.test.ts`
 * rather than `.test.tsx` for exactly that reason: a `.tsx` suite would not
 * be picked up by `include` at all and would silently contribute zero tests —
 * the same "reads like a pass" trap CLAUDE.md warns about for the wrong jest
 * environment, just one layer up.
 *
 * Full design + threat model: docs/QR-LINKING.md §2, §7.
 */

const POLL_INTERVAL_MS = 2000;
const COUNTDOWN_TICK_MS = 250;
const TTL_MS = 120_000;

const EK_PUB_B64 = 'EK_PUB_B64==';
const FINGERPRINT = 'ABCD-1234';
// 22-char base64url — the real shape the server issues (and, since QR-4, the
// shape begin() now validates before use). A short placeholder like
// 'LINK123' used to work only because nothing checked its shape.
const LINK_ID = 'LiNK1234567890abcdEF-_';
/** The A1 verification code this desktop "generates" under test. */
const CODE = '123456';
const CLAIM_SECRET = 'c'.repeat(43);

function makeDeps(overrides: Partial<QrSignInDeps> = {}): QrSignInDeps {
    const now = Date.now();
    return {
        linkBegin: vi.fn().mockResolvedValue({ ekPubB64: EK_PUB_B64, fingerprint: FINGERPRINT }),
        linkBind: vi.fn().mockResolvedValue(undefined),
        linkOpen: vi.fn().mockResolvedValue({
            type: 'link_grant', v: 1, link_id: LINK_ID,
            user_id: 'USER1', access_token: 'ACCESS1', refresh_token: 'REFRESH1',
            approved_by_device_id: 'DEV_APPROVER', approved_by_device_name: 'Pixel',
            issued_at: new Date(now).toISOString(),
        }),
        linkEnd: vi.fn().mockResolvedValue(undefined),
        getDeviceName: vi.fn().mockResolvedValue('Test-PC'),
        getPlatform: vi.fn(() => 'windows'),
        generateCode: vi.fn(() => CODE),
        createSession: vi.fn().mockResolvedValue({
            link_id: LINK_ID,
            expires_at: new Date(now + TTL_MS).toISOString(),
            ttl_s: TTL_MS / 1000,
        }),
        pollSession: vi.fn().mockResolvedValue({ state: 'pending' }),
        claimSession: vi.fn().mockResolvedValue({ access_token: 'CLAIMED-ACCESS', refresh_token: 'CLAIMED-REFRESH', user_id: 'USER1' }),
        destroySession: vi.fn().mockResolvedValue(undefined),
        whoAmI: vi.fn().mockResolvedValue({ user_id: 'USER1', username: 'dawson', discriminator: 1234, avatar_url: null }),
        registerDevice: vi.fn().mockResolvedValue({ deviceId: 'DEVICE1', requiresPairing: false }),
        login: vi.fn().mockResolvedValue(undefined),
        renderQr: vi.fn().mockResolvedValue('data:image/png;base64,FAKE'),
        buildQrText: vi.fn(buildLinkQr),
        pollIntervalMs: POLL_INTERVAL_MS,
        countdownTickMs: COUNTDOWN_TICK_MS,
        ...overrides,
    };
}

describe('QrSignInController', () => {
    it('stops polling and calls link:end when the countdown reaches zero', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps();
            const controller = new QrSignInController(deps);

            await controller.begin();
            expect(controller.getSnapshot().phase).toBe('active');

            // A couple of ordinary poll ticks while the phone hasn't scanned yet.
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
            expect((deps.pollSession as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
            expect(controller.getSnapshot().phase).toBe('active');
            expect(deps.linkEnd).not.toHaveBeenCalled();

            // Advance past the full TTL.
            await vi.advanceTimersByTimeAsync(TTL_MS);

            expect(controller.getSnapshot().phase).toBe('expired');
            expect(deps.linkEnd).toHaveBeenCalledTimes(1);

            // Polling has genuinely stopped — further ticks must not call
            // pollSession again.
            const callsAtExpiry = (deps.pollSession as ReturnType<typeof vi.fn>).mock.calls.length;
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
            expect((deps.pollSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtExpiry);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the declined state when a poll reports denied', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps({
                pollSession: vi.fn().mockResolvedValue({ state: 'denied' }),
            });
            const controller = new QrSignInController(deps);

            await controller.begin();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // one poll tick

            expect(controller.getSnapshot().phase).toBe('denied');
            expect(deps.linkEnd).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not persist a session and shows an error when link:open fails', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps({
                pollSession: vi.fn().mockResolvedValue({ state: 'granted', envelope_b64: 'SEALED_ENVELOPE' }),
                linkOpen: vi.fn().mockRejectedValue(new Error('envelope failed to decrypt or was tampered with')),
            });
            const controller = new QrSignInController(deps);

            await controller.begin();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            // openGrant chains several awaits past the timer tick itself
            // (linkOpen -> catch -> stopSession -> linkEnd); flush microtasks.
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(0);

            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('error');
            expect(snap.error).toContain('tampered');

            // The core invariant under test: NO session was ever persisted.
            expect(deps.registerDevice).not.toHaveBeenCalled();
            expect(deps.login).not.toHaveBeenCalled();
            // And the abandoned main-process session was torn down, not left
            // dangling with a live ephemeral private key.
            expect(deps.linkEnd).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('builds the QR text locally from the IPC-returned key, never from the API response', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const buildQrText = vi.fn((linkId: string, ekPubB64: string) => `built:${linkId}:${ekPubB64}`);
            const deps = makeDeps({
                buildQrText,
                // A hostile or merely buggy server response carrying
                // key-shaped decoy fields the client must never act on —
                // docs/QR-LINKING.md §2.5's whole point.
                createSession: vi.fn().mockResolvedValue({
                    link_id: LINK_ID,
                    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
                    ttl_s: TTL_MS / 1000,
                    ek_pub_b64: 'ATTACKER_SUPPLIED_KEY',
                    k: 'ATTACKER_SUPPLIED_KEY',
                }),
            });
            const controller = new QrSignInController(deps);

            await controller.begin();

            expect(buildQrText).toHaveBeenCalledTimes(1);
            expect(buildQrText).toHaveBeenCalledWith(LINK_ID, EK_PUB_B64);
            const [, keyArgUsed] = buildQrText.mock.calls[0] as [string, string];
            expect(keyArgUsed).toBe(EK_PUB_B64);
            expect(keyArgUsed).not.toBe('ATTACKER_SUPPLIED_KEY');
            expect(controller.getSnapshot().qrDataUrl).toBe('data:image/png;base64,FAKE');
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancel() tears down the session and returns to idle without a new key', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps();
            const controller = new QrSignInController(deps);

            await controller.begin();
            expect(controller.getSnapshot().phase).toBe('active');

            await controller.cancel();
            expect(controller.getSnapshot().phase).toBe('idle');
            expect(deps.linkEnd).toHaveBeenCalledTimes(1);
            expect(deps.linkBegin).toHaveBeenCalledTimes(1); // not called again by cancel itself

            // A cancelled session must not keep polling in the background.
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
            expect(deps.pollSession).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('QR-1 — account confirmation before persisting (adversarial review)', () => {
    function grantedDeps(overrides: Partial<QrSignInDeps> = {}): QrSignInDeps {
        return makeDeps({
            pollSession: vi.fn().mockResolvedValue({ state: 'granted', envelope_b64: 'SEALED_ENVELOPE' }),
            ...overrides,
        });
    }

    /** Runs begin() through to a landed 'granted' poll and drains the extra
     *  microtask hop QR-1 added (linkOpen -> whoAmI -> set 'confirm'). */
    async function driveToGranted(): Promise<void> {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
    }

    it('a successful decrypt moves to "confirm" with the WHOAMI-resolved identity — not "success", and persists nothing yet', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = grantedDeps({
                whoAmI: vi.fn().mockResolvedValue({ user_id: 'USER1', username: 'realaccountname', discriminator: 4242, avatar_url: 'att-1' }),
            });
            const controller = new QrSignInController(deps);

            await controller.begin();
            await driveToGranted();

            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('confirm');
            // The identity shown is exactly what whoAmI (the AUTHORITATIVE,
            // server-resolved source) returned — never anything read off the
            // grant, which carries no username/discriminator at all.
            expect(snap.confirmIdentity).toEqual({
                userId: 'USER1',
                username: 'realaccountname',
                discriminator: 4242,
                avatarUrl: 'att-1',
                approvedByDeviceName: 'Pixel', // grant.approved_by_device_name, display-only
            });
            expect(deps.whoAmI).toHaveBeenCalledTimes(1);
            expect(deps.whoAmI).toHaveBeenCalledWith('ACCESS1'); // the grant's own access_token
            // The core QR-1 invariant: decrypting successfully must not, by
            // itself, register a device or log anything in.
            expect(deps.registerDevice).not.toHaveBeenCalled();
            expect(deps.login).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('confirmAccount() ("Continue") is the only path that registers, logs in, purges the session, and reaches success', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = grantedDeps();
            const controller = new QrSignInController(deps);

            await controller.begin();
            await driveToGranted();
            expect(controller.getSnapshot().phase).toBe('confirm');

            await controller.confirmAccount();

            expect(deps.registerDevice).toHaveBeenCalledWith('USER1', 'ACCESS1');
            expect(deps.login).toHaveBeenCalledWith('ACCESS1', 'USER1', 'DEVICE1', false, 'REFRESH1');
            expect(deps.destroySession).toHaveBeenCalledWith(LINK_ID, 'ACCESS1');
            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('success');
            expect(snap.confirmIdentity).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejectAccount() ("This isn\'t my account") discards everything and never persists', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = grantedDeps();
            const controller = new QrSignInController(deps);

            await controller.begin();
            await driveToGranted();
            expect(controller.getSnapshot().phase).toBe('confirm');
            const linkEndCallsBeforeReject = (deps.linkEnd as ReturnType<typeof vi.fn>).mock.calls.length;

            await controller.rejectAccount();

            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('error');
            expect(snap.error).toMatch(/someone else's account/i);
            expect(snap.confirmIdentity).toBeNull();
            expect(deps.registerDevice).not.toHaveBeenCalled();
            expect(deps.login).not.toHaveBeenCalled();
            // The main-process ephemeral-key session was torn down.
            expect((deps.linkEnd as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(linkEndCallsBeforeReject);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a whoAmI failure fails CLOSED exactly like an explicit rejection, not like a retryable blip', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = grantedDeps({
                whoAmI: vi.fn().mockRejectedValue(new Error('network down')),
            });
            const controller = new QrSignInController(deps);

            await controller.begin();
            await driveToGranted();

            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('error');
            expect(snap.error).toMatch(/someone else's account/i);
            expect(deps.registerDevice).not.toHaveBeenCalled();
            expect(deps.login).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('2026-09-28 hardening — verification code (A1) and claim-then-mint (A4), new-device side', () => {
    /** Drains the extra microtask hops openGrant chains (linkOpen → claim →
     *  whoAmI → set 'confirm'). */
    async function drain(): Promise<void> {
        for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    }

    it('sends the generated code (and platform) with the session, but keeps it OFF the snapshot until the server says scanned', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const pollSession = vi.fn()
                .mockResolvedValueOnce({ state: 'pending' })
                .mockResolvedValue({ state: 'scanned' });
            const deps = makeDeps({ pollSession });
            const controller = new QrSignInController(deps);

            await controller.begin();
            expect(deps.generateCode).toHaveBeenCalledTimes(1);
            expect(deps.createSession).toHaveBeenCalledWith(EK_PUB_B64, 'Test-PC', CODE, 'windows');
            // The QR string never carries the code.
            expect(controller.getSnapshot().phase).toBe('active');
            expect(controller.getSnapshot().verificationCode).toBeNull();

            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // pending
            expect(controller.getSnapshot().verificationCode).toBeNull();

            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // scanned
            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('scanned');
            expect(snap.verificationCode).toBe(CODE);
            // The main-process key is still live — the phone has not approved yet.
            expect(deps.linkEnd).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a fresh begin() gets a fresh code — never reuses the previous session\'s', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const generateCode = vi.fn().mockReturnValueOnce('111111').mockReturnValueOnce('222222');
            const deps = makeDeps({ generateCode });
            const controller = new QrSignInController(deps);
            await controller.begin();
            await controller.cancel();
            await controller.begin();
            expect((deps.createSession as ReturnType<typeof vi.fn>).mock.calls.map(c => c[2])).toEqual(['111111', '222222']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses to open a session with a malformed code from the generator (fails closed, nothing created)', async () => {
        vi.useFakeTimers();
        try {
            const deps = makeDeps({ generateCode: vi.fn(() => '12345') });
            const controller = new QrSignInController(deps);
            await controller.begin();
            expect(controller.getSnapshot().phase).toBe('error');
            expect(deps.createSession).not.toHaveBeenCalled();
            expect(deps.linkEnd).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a v2 grant (claim secret, no tokens) is redeemed via claimSession, and the CLAIMED token is what whoAmI / register / login use', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps({
                pollSession: vi.fn().mockResolvedValue({ state: 'granted', envelope_b64: 'SEALED_ENVELOPE' }),
                linkOpen: vi.fn().mockResolvedValue({
                    type: 'link_grant', v: 2, link_id: LINK_ID, user_id: 'USER1', claim_secret: CLAIM_SECRET,
                    approved_by_device_id: 'DEV_APPROVER', approved_by_device_name: 'Pixel', issued_at: new Date().toISOString(),
                }),
            });
            const controller = new QrSignInController(deps);

            await controller.begin();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            await drain();

            expect(deps.claimSession).toHaveBeenCalledWith(LINK_ID, CLAIM_SECRET);
            expect(deps.whoAmI).toHaveBeenCalledWith('CLAIMED-ACCESS');
            expect(controller.getSnapshot().phase).toBe('confirm');
            expect(deps.login).not.toHaveBeenCalled();

            await controller.confirmAccount();
            expect(deps.registerDevice).toHaveBeenCalledWith('USER1', 'CLAIMED-ACCESS');
            expect(deps.login).toHaveBeenCalledWith('CLAIMED-ACCESS', 'USER1', 'DEVICE1', false, 'CLAIMED-REFRESH');
            expect(deps.destroySession).toHaveBeenCalledWith(LINK_ID, 'CLAIMED-ACCESS');
            expect(controller.getSnapshot().phase).toBe('success');
        } finally {
            vi.useRealTimers();
        }
    });

    it('a failed claim (server refused / already claimed) ends in error with nothing persisted', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps({
                pollSession: vi.fn().mockResolvedValue({ state: 'granted', envelope_b64: 'SEALED_ENVELOPE' }),
                linkOpen: vi.fn().mockResolvedValue({
                    type: 'link_grant', v: 2, link_id: LINK_ID, user_id: 'USER1', claim_secret: CLAIM_SECRET,
                    approved_by_device_id: 'DEV_APPROVER', approved_by_device_name: 'Pixel', issued_at: new Date().toISOString(),
                }),
                claimSession: vi.fn().mockRejectedValue(new Error('This session has already been claimed')),
            });
            const controller = new QrSignInController(deps);
            await controller.begin();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            await drain();

            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('error');
            expect(snap.error).toContain('already been claimed');
            expect(deps.whoAmI).not.toHaveBeenCalled();
            expect(deps.login).not.toHaveBeenCalled();
            expect(deps.linkEnd).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a v1 grant (legacy approver, tokens inside) still works without any claim call', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps({
                pollSession: vi.fn().mockResolvedValue({ state: 'granted', envelope_b64: 'SEALED_ENVELOPE' }),
            });
            const controller = new QrSignInController(deps);
            await controller.begin();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            await drain();
            expect(deps.claimSession).not.toHaveBeenCalled();
            expect(deps.whoAmI).toHaveBeenCalledWith('ACCESS1');
            expect(controller.getSnapshot().phase).toBe('confirm');
        } finally {
            vi.useRealTimers();
        }
    });

    it('a server-side burn (denied + reason locked) surfaces as denied/locked, tears down, and the code leaves the snapshot', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const pollSession = vi.fn()
                .mockResolvedValueOnce({ state: 'scanned' })
                .mockResolvedValue({ state: 'denied', reason: 'locked' });
            const deps = makeDeps({ pollSession });
            const controller = new QrSignInController(deps);
            await controller.begin();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            expect(controller.getSnapshot().verificationCode).toBe(CODE);
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
            const snap = controller.getSnapshot();
            expect(snap.phase).toBe('denied');
            expect(snap.deniedReason).toBe('locked');
            expect(snap.verificationCode).toBeNull();
            expect(deps.linkEnd).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('buildLinkQr', () => {
    it('matches docs/QR-LINKING.md §2.2\'s wire format exactly', () => {
        // A 32-byte key, standard base64 (what electronAPI.linkBegin returns).
        const ekPubB64 = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
        const linkId = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 chars, as the server issues them

        const text = buildLinkQr(linkId, ekPubB64);

        expect(text.startsWith(`cipherline://link/1?i=${linkId}&k=`)).toBe(true);
        // The key half must be base64url — no '+', '/', or '=' padding.
        const k = text.split('&k=')[1];
        expect(k).not.toContain('+');
        expect(k).not.toContain('/');
        expect(k).not.toContain('=');
    });

    it('QR-4: encodeURIComponent on linkId defeats the exact &k= injection payload from the review', () => {
        const ekPubB64 = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
        // The finding's own shape: 22 valid chars, then an appended &k=
        // that would shadow the real key for a first-wins duplicate-key
        // parser if it reached the QR string unescaped.
        const maliciousLinkId = 'AAAAAAAAAAAAAAAAAAAAAA&k=ATTACKER_SUPPLIED_KEY_B64URL';

        const text = buildLinkQr(maliciousLinkId, ekPubB64);

        // The malicious id must appear PERCENT-ENCODED, never as a second
        // literal '&k=' in the query string — encodeURIComponent turns '&'
        // into '%26', so a decoder sees ONE 'i' param and ONE 'k' param.
        expect(text).not.toContain('&k=ATTACKER_SUPPLIED_KEY_B64URL');
        expect(text.split('&k=')).toHaveLength(2); // exactly one real &k=, the appended one is encoded
        expect(text).toContain(encodeURIComponent(maliciousLinkId));
    });
});
