import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Signup attribution: what is carried through signup, how it is parsed, how it
 * persists, and that it is one-shot. secureLocalStore is an in-memory Map here;
 * `refuseWrites` models a locked keystore (the real store performs ZERO writes
 * then). axios is mocked per test.
 */
const mem = new Map<string, string>();
let refuseWrites = false;
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { if (!refuseWrites) mem.set(k, v); },
    removeItem: (k: string) => { if (!refuseWrites) mem.delete(k); },
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const axiosGet = vi.fn();
vi.mock('axios', () => {
    const isAxiosError = (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError;
    return { default: { get: (...a: unknown[]) => axiosGet(...a), isAxiosError }, isAxiosError };
});

const A = await import('./signupAttribution');

const REF = 'AB12CD34';
const INVITE = 'zKKaUldlWXo';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const axiosErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });

beforeEach(() => {
    mem.clear();
    refuseWrites = false;
    axiosGet.mockReset();
    delete (globalThis as any).window?.electronAPI;
});

describe('parseAttributionInput — what a person might paste', () => {
    const ok: Array<[string, { kind: 'ref' | 'invite'; code: string }]> = [
        [REF, { kind: 'ref', code: REF }],
        ['  ab12cd34  ', { kind: 'ref', code: REF }],
        [`https://cipherline.chat/ref/${REF}`, { kind: 'ref', code: REF }],
        [`https://www.cipherline.chat/ref/${REF.toLowerCase()}/`, { kind: 'ref', code: REF }],
        [`https://cipherline.chat/ref/${REF}?utm=x#y`, { kind: 'ref', code: REF }],
        [`cipherline://ref/${REF}`, { kind: 'ref', code: REF }],
        [`https://cipherline.chat/invite/${INVITE}`, { kind: 'invite', code: INVITE }],
        [`cipherline://invite/${INVITE}`, { kind: 'invite', code: INVITE }],
        [`CIPHERLINE://INVITE/${INVITE}`, { kind: 'invite', code: INVITE }],
    ];
    it.each(ok)('%s', (input, expected) => {
        expect(A.parseAttributionInput(input)).toEqual(expected);
    });

    const bad: unknown[] = [
        '', '   ', 'hello', 'ZZZZZZZZ', 'AB12CD3', 'AB12CD345',
        `http://evil.example/ref/${REF}`,
        `https://cipherline.chat.evil.example/ref/${REF}`,
        `https://evil.example/cipherline.chat/ref/${REF}`,
        `https://cipherline.chat/ref/${REF} and some other text`,
        'https://cipherline.chat/ref/NOTHEX!!',
        `https://cipherline.chat/other/${REF}`,
        INVITE, // a bare invite code is not guessed at
        'x'.repeat(400), null, undefined, 42, {},
    ];
    it.each(bad.map(b => [String(b).slice(0, 40), b]))('rejects %s', (_label, input) => {
        expect(A.parseAttributionInput(input)).toBeNull();
    });
});

describe('pending referral — carried through signup, one-shot', () => {
    it('round-trips and normalises to upper case', () => {
        expect(A.setPendingReferral('ab12cd34', NOW)).toBe(true);
        expect(A.getPendingReferral(NOW)).toBe(REF);
    });

    it('AUTO-FILL: a fresh read (new AuthScreen mount / app restart) gets the carried code back', () => {
        A.setPendingReferral(REF, NOW);
        // This is exactly what AuthScreen's useState initialiser calls.
        expect(A.getPendingReferral(NOW + 60_000)).toBe(REF);
        // ...and reading is not consuming: a second mount still sees it.
        expect(A.getPendingReferral(NOW + 120_000)).toBe(REF);
    });

    it('one-shot clearing: clearPendingReferral removes it for good', () => {
        A.setPendingReferral(REF, NOW);
        A.clearPendingReferral();
        expect(A.getPendingReferral(NOW)).toBeNull();
        expect(mem.size).toBe(0);
    });

    it('refuses to store a malformed code (nothing is written)', () => {
        for (const bad of ['', 'nope', 'ZZZZZZZZ', 'AB12CD3', '<script>']) {
            expect(A.setPendingReferral(bad, NOW)).toBe(false);
        }
        expect(mem.size).toBe(0);
    });

    it('expires after the TTL and drops the stale record', () => {
        A.setPendingReferral(REF, NOW);
        expect(A.getPendingReferral(NOW + A.PENDING_TTL_MS)).toBe(REF);
        expect(A.getPendingReferral(NOW + A.PENDING_TTL_MS + 1)).toBeNull();
        expect(mem.size).toBe(0);
    });

    it('ignores (and drops) a corrupt or hand-edited record', () => {
        for (const raw of ['not json', '{}', '{"code":"ZZZZZZZZ","at":1}', JSON.stringify({ code: REF }), JSON.stringify({ code: REF, at: NOW + 10 * DAY })]) {
            mem.clear();
            mem.set('cl_attr_pending_ref_v1', raw);
            expect(A.getPendingReferral(NOW)).toBeNull();
            expect(mem.has('cl_attr_pending_ref_v1')).toBe(false);
        }
    });

    it('a locked keystore (zero writes) degrades to "nothing carried", never throws', () => {
        refuseWrites = true;
        expect(() => A.setPendingReferral(REF, NOW)).not.toThrow();
        expect(A.getPendingReferral(NOW)).toBeNull();
        expect(() => A.clearPendingReferral()).not.toThrow();
    });

    it('is independent of the pending invite', () => {
        A.setPendingReferral(REF, NOW);
        A.setPendingInvite(INVITE, NOW);
        A.clearPendingReferral();
        expect(A.getPendingInvite(NOW)).toBe(INVITE);
    });
});

describe('pending server invite — carried until the join prompt is answered', () => {
    it('round-trips; invite codes are case-sensitive and kept as typed', () => {
        expect(A.setPendingInvite(INVITE, NOW)).toBe(true);
        expect(A.getPendingInvite(NOW)).toBe(INVITE);
    });

    it('survives the sign-up steps: reading never consumes it', () => {
        A.setPendingInvite(INVITE, NOW);
        for (let step = 1; step <= 5; step++) expect(A.getPendingInvite(NOW + step * 60_000)).toBe(INVITE);
    });

    it('declining/joining clears it (one-shot) and notifies subscribers', () => {
        const seen: Array<string | null> = [];
        const off = A.onPendingInviteChange(() => seen.push(A.getPendingInvite(NOW)));
        A.setPendingInvite(INVITE, NOW);
        A.clearPendingInvite();
        off();
        A.setPendingInvite('another_code', NOW); // unsubscribed: not observed
        expect(seen).toEqual([INVITE, null]);
    });

    it('refuses malformed codes, expires, and a throwing subscriber cannot break the writer', () => {
        expect(A.setPendingInvite('has space', NOW)).toBe(false);
        expect(A.setPendingInvite('../etc', NOW)).toBe(false);
        expect(A.setPendingInvite('abc', NOW)).toBe(false); // too short
        const off = A.onPendingInviteChange(() => { throw new Error('listener bug'); });
        expect(() => A.setPendingInvite(INVITE, NOW)).not.toThrow();
        off();
        expect(A.getPendingInvite(NOW + A.PENDING_TTL_MS + 1)).toBeNull();
    });
});

describe('referrer tag — the post-signup friend-request offer', () => {
    it('remember -> peek (does not consume) -> clear (one-shot)', () => {
        A.rememberReferrer('u1', { username: 'samwise', discriminator: 4242 });
        expect(A.peekReferrer('u1')).toEqual({ username: 'samwise', discriminator: 4242 });
        expect(A.peekReferrer('u1')).toEqual({ username: 'samwise', discriminator: 4242 });
        A.clearReferrer('u1');
        expect(A.peekReferrer('u1')).toBeNull();
    });

    it('is per account', () => {
        A.rememberReferrer('u1', { username: 'samwise', discriminator: 4242 });
        expect(A.peekReferrer('u2')).toBeNull();
    });

    it('tolerates a corrupt record', () => {
        mem.set('cl_referrer_u1', '{"username":42}');
        expect(A.peekReferrer('u1')).toBeNull();
        mem.set('cl_referrer_u1', 'garbage');
        expect(A.peekReferrer('u1')).toBeNull();
    });
});

describe('resolveReferral — who owns this code', () => {
    it('returns the referrer tag for a live code', async () => {
        axiosGet.mockResolvedValue({ data: { valid: true, referrer: { username: 'samwise', discriminator: 4242 } } });
        expect(await A.resolveReferral('ab12cd34')).toEqual({ valid: true, referrer: { username: 'samwise', discriminator: 4242 } });
        expect(axiosGet.mock.calls[0][0]).toMatch(/\/auth\/resolve-referral$/);
        expect(axiosGet.mock.calls[0][1]).toEqual({ params: { code: REF } });
    });

    it('invalid code -> { valid: false } and never claims a network failure', async () => {
        axiosGet.mockResolvedValue({ data: { valid: false } });
        expect(await A.resolveReferral(REF)).toEqual({ valid: false });
    });

    it('does not call the server for a malformed code', async () => {
        expect(await A.resolveReferral('nope')).toEqual({ valid: false });
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it('a valid answer with no referrer is not trusted as valid-with-name', async () => {
        axiosGet.mockResolvedValue({ data: { valid: true } });
        expect(await A.resolveReferral(REF)).toEqual({ valid: false });
    });

    it('network/5xx/429 -> failed (so the form says "couldn\'t check", not "invalid")', async () => {
        for (const status of [429, 500, 503]) {
            axiosGet.mockReset();
            axiosGet.mockRejectedValue(axiosErr(status));
            expect(await A.resolveReferral(REF)).toEqual({ valid: false, failed: true });
        }
        axiosGet.mockReset();
        axiosGet.mockRejectedValue(new Error('offline'));
        expect(await A.resolveReferral(REF)).toEqual({ valid: false, failed: true });
    });

    it('400 is an answer about the code, not a failure', async () => {
        axiosGet.mockRejectedValue(axiosErr(400));
        expect(await A.resolveReferral(REF)).toEqual({ valid: false });
    });

    it('an API that predates the endpoint (404) falls back to check-referral — valid, but unnamed', async () => {
        axiosGet
            .mockRejectedValueOnce(axiosErr(404))
            .mockResolvedValueOnce({ data: { valid: true } });
        expect(await A.resolveReferral(REF)).toEqual({ valid: true });
        expect(axiosGet.mock.calls[1][0]).toMatch(/\/auth\/check-referral$/);
    });
});

describe('peekClipboardOnce — the first-launch hand-off', () => {
    const install = (impl: () => Promise<unknown>) => {
        (globalThis as any).window = (globalThis as any).window || {};
        (globalThis as any).window.electronAPI = { peekAttributionClipboard: vi.fn(impl) };
        return (globalThis as any).window.electronAPI.peekAttributionClipboard as ReturnType<typeof vi.fn>;
    };

    it('finds a referral link and reports it', async () => {
        install(async () => ({ kind: 'ref', code: REF }));
        expect(await A.peekClipboardOnce()).toEqual({ kind: 'ref', code: REF });
    });

    it('finds an invite link and reports it', async () => {
        install(async () => ({ kind: 'invite', code: INVITE }));
        expect(await A.peekClipboardOnce()).toEqual({ kind: 'invite', code: INVITE });
    });

    it('asks AT MOST ONCE per install, even when nothing was found', async () => {
        const peek = install(async () => null);
        expect(await A.peekClipboardOnce()).toBeNull();
        expect(await A.peekClipboardOnce()).toBeNull();
        expect(peek).toHaveBeenCalledTimes(1);
    });

    it('does not even ask once it has asked (a later, unrelated copy is never read)', async () => {
        install(async () => null);
        await A.peekClipboardOnce();
        const second = install(async () => ({ kind: 'ref', code: REF }));
        expect(await A.peekClipboardOnce()).toBeNull();
        expect(second).not.toHaveBeenCalled();
    });

    it('re-validates what the bridge returns (never trusts its shape)', async () => {
        for (const bogus of [{ kind: 'ref', code: 'nope' }, { kind: 'invite', code: '../x' }, { kind: 'other', code: REF }, 'text', 7]) {
            mem.clear();
            install(async () => bogus);
            expect(await A.peekClipboardOnce()).toBeNull();
        }
    });

    it('no Electron bridge (website/test) -> null, and does not burn the one-time check', async () => {
        expect(await A.peekClipboardOnce()).toBeNull();
        expect(mem.has('cl_attr_clipboard_checked_v1')).toBe(false);
    });

    it('a bridge error is swallowed', async () => {
        install(async () => { throw new Error('ipc'); });
        expect(await A.peekClipboardOnce()).toBeNull();
    });
});

describe('official server', () => {
    it('default is the shared constant', () => {
        expect(A.officialServerDefault()).toEqual({ invite_code: 'zKKaUldlWXo', invite_url: 'https://cipherline.chat/invite/zKKaUldlWXo' });
    });

    it('prefers GET /v1/config, so ops can re-point it', async () => {
        axiosGet.mockResolvedValue({ data: { official_server: { invite_code: 'NewCode_123' } } });
        expect(await A.fetchOfficialServer()).toEqual({ invite_code: 'NewCode_123', invite_url: 'https://cipherline.chat/invite/NewCode_123' });
    });

    it('falls back to the default on failure or a malformed answer', async () => {
        axiosGet.mockRejectedValue(new Error('offline'));
        expect((await A.fetchOfficialServer()).invite_code).toBe('zKKaUldlWXo');
        axiosGet.mockReset();
        axiosGet.mockResolvedValue({ data: { official_server: { invite_code: '<x>' } } });
        expect((await A.fetchOfficialServer()).invite_code).toBe('zKKaUldlWXo');
        axiosGet.mockReset();
        axiosGet.mockResolvedValue({ data: {} });
        expect((await A.fetchOfficialServer()).invite_code).toBe('zKKaUldlWXo');
    });
});

describe('fetchMyReferral — my link, cheaply', () => {
    it('builds the link and lists recent joiners', async () => {
        axiosGet.mockResolvedValue({ data: {
            referral_code: REF.toLowerCase(), referrals_count: 2,
            recent_referrals: [{ username: 'frodo', discriminator: 1111, joined_at: '2026-10-03T10:00:00.000Z' }, { bogus: true }],
        } });
        expect(await A.fetchMyReferral('tok')).toEqual({
            code: REF, url: `https://cipherline.chat/ref/${REF}`, count: 2,
            recent: [{ username: 'frodo', discriminator: 1111, joined_at: '2026-10-03T10:00:00.000Z' }],
        });
        expect(axiosGet.mock.calls[0][1]).toEqual({ headers: { Authorization: 'Bearer tok' } });
    });

    it('works against an API that predates the extra fields', async () => {
        axiosGet.mockResolvedValue({ data: { referral_code: REF, referrals_count: 0 } });
        expect(await A.fetchMyReferral('tok')).toMatchObject({ url: `https://cipherline.chat/ref/${REF}`, recent: [] });
    });

    it('null on no code or failure', async () => {
        axiosGet.mockResolvedValue({ data: { referral_code: null } });
        expect(await A.fetchMyReferral('tok')).toBeNull();
        axiosGet.mockRejectedValue(new Error('x'));
        expect(await A.fetchMyReferral('tok')).toBeNull();
    });
});
