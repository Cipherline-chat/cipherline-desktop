import { describe, it, expect } from 'vitest';
import {
    devicesOfUsers,
    keyRequestRecipientUserIds,
    CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS,
    CALL_KEY_RESPONSE_JITTER_MAX_MS,
    CALL_KEY_RESPONSE_WINDOW_MS,
    CALL_KEY_REQUEST_MAX_SENDS,
    CALL_KEY_ROTATION_GRACE_MS,
    CALL_KEY_SOLO_MINT_AFTER_MS,
    KeyResponseLimiter,
    MinGapGate,
    buildKeyRequest,
    buildShareContent,
    chooseRotator,
    decideKeyRequestResponse,
    devicesOfUser,
    isDecryptKeyFailure,
    isRotationDue,
    mintEpoch,
    nextRequestDelayMs,
    responseJitterMs,
    shouldMintSoloKey,
} from './callKeyShare';
import { contentProblem } from './contentValidation';

const CALL = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('requesting', () => {
    it('sends five requests: a short grace first, then every 4 s, then stops', () => {
        const delays: Array<number | null> = [];
        for (let sent = 0; sent <= CALL_KEY_REQUEST_MAX_SENDS; sent++) delays.push(nextRequestDelayMs(sent));
        expect(delays.slice(1, CALL_KEY_REQUEST_MAX_SENDS)).toEqual([4000, 4000, 4000, 4000]);
        expect(delays[0]).toBeLessThan(4000);
        expect(delays[CALL_KEY_REQUEST_MAX_SENDS]).toBeNull();
        expect(nextRequestDelayMs(99)).toBeNull();
    });
    it('the request it builds passes the content boundary; a malformed one does not', () => {
        expect(contentProblem(buildKeyRequest(CALL, 'm-1'))).toBeNull();
        expect(contentProblem({ type: 'call_key_request', call_id: 5 })).not.toBeNull();
    });
    it('the decryption-failure trigger is at most once per 10 s', () => {
        const g = new MinGapGate(CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS);
        expect(CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS).toBe(10_000);
        expect(g.tryPass(1_000)).toBe(true);
        expect(g.tryPass(1_001)).toBe(false);
        expect(g.tryPass(10_999)).toBe(false);
        expect(g.tryPass(11_000)).toBe(true);
        g.reset();
        expect(g.tryPass(11_001)).toBe(true);
    });
    it('only a wrong/missing key counts as a decrypt failure, not an internal fault', () => {
        expect(isDecryptKeyFailure({ reason: 0 })).toBe(true);   // InvalidKey
        expect(isDecryptKeyFailure({ reason: 1 })).toBe(true);   // MissingKey
        expect(isDecryptKeyFailure({ reason: 2 })).toBe(false);  // InternalError
        expect(isDecryptKeyFailure(new Error('boom'))).toBe(false);
        expect(isDecryptKeyFailure(null)).toBe(false);
        expect(isDecryptKeyFailure('InvalidKey')).toBe(false);
    });
});

describe('responding — decideKeyRequestResponse', () => {
    const base = () => ({
        connectedCallId: CALL as string | null,
        requestedCallId: CALL,
        holdsAcceptedKey: true,
        senderTrusted: true,
        requesterIsMember: true as boolean | undefined,
        requesterDeviceId: 'dev-req' as string | null | undefined,
        myDeviceId: 'dev-me' as string | null | undefined,
        nowMs: 1_000_000,
        limiter: new KeyResponseLimiter(),
    });
    it('answers when connected, holding an accepted key, trusted, a member', () => {
        expect(decideKeyRequestResponse(base())).toEqual({ respond: true });
    });
    it('never answers for a call it is not connected to', () => {
        expect(decideKeyRequestResponse({ ...base(), connectedCallId: null })).toEqual({ respond: false, reason: 'not_connected' });
        expect(decideKeyRequestResponse({ ...base(), connectedCallId: 'some-other-call' })).toEqual({ respond: false, reason: 'not_connected' });
    });
    it('never answers without an accepted key', () => {
        expect(decideKeyRequestResponse({ ...base(), holdsAcceptedKey: false })).toEqual({ respond: false, reason: 'no_accepted_key' });
    });
    it('never answers a requester the sender-trust gate refused', () => {
        expect(decideKeyRequestResponse({ ...base(), senderTrusted: false })).toEqual({ respond: false, reason: 'untrusted' });
    });
    it('never answers a known non-member; unknown membership is left to the server\'s device list', () => {
        expect(decideKeyRequestResponse({ ...base(), requesterIsMember: false })).toEqual({ respond: false, reason: 'not_member' });
        expect(decideKeyRequestResponse({ ...base(), requesterIsMember: undefined })).toEqual({ respond: true });
    });
    it('ignores its own request echoed back', () => {
        expect(decideKeyRequestResponse({ ...base(), requesterDeviceId: 'dev-me' })).toEqual({ respond: false, reason: 'self_device' });
    });
    it('at most one answer per (call, requesting device) per 10 s', () => {
        const limiter = new KeyResponseLimiter();
        const at = (t: number, dev = 'dev-req') => decideKeyRequestResponse({ ...base(), limiter, nowMs: t, requesterDeviceId: dev });
        expect(at(0).respond).toBe(true);
        expect(at(1).respond).toBe(false);
        expect(at(CALL_KEY_RESPONSE_WINDOW_MS - 1)).toEqual({ respond: false, reason: 'rate_limited' });
        // A different requesting device has its own window…
        expect(at(2, 'dev-other').respond).toBe(true);
        // …and the first one is answered again once the window passes.
        expect(at(CALL_KEY_RESPONSE_WINDOW_MS).respond).toBe(true);
    });
    it('a refused request does not consume the rate-limit window', () => {
        const limiter = new KeyResponseLimiter();
        expect(decideKeyRequestResponse({ ...base(), limiter, nowMs: 0, senderTrusted: false }).respond).toBe(false);
        expect(decideKeyRequestResponse({ ...base(), limiter, nowMs: 1 }).respond).toBe(true);
    });
    it('the limiter stays bounded under a flood of distinct requesters', () => {
        const limiter = new KeyResponseLimiter(CALL_KEY_RESPONSE_WINDOW_MS, 8);
        for (let i = 0; i < 100; i++) limiter.tryAcquire(CALL, `dev-${i}`, i);
        // Still working (and not grown without bound) after the flood.
        expect(limiter.tryAcquire(CALL, 'dev-new', 1000)).toBe(true);
    });
});

describe('responding — what is sent', () => {
    it('jitter is 0..1500 ms', () => {
        expect(responseJitterMs(0)).toBe(0);
        expect(responseJitterMs(0.5)).toBe(750);
        expect(responseJitterMs(0.999999)).toBeLessThan(CALL_KEY_RESPONSE_JITTER_MAX_MS);
        expect(responseJitterMs(5)).toBeLessThan(CALL_KEY_RESPONSE_JITTER_MAX_MS);
        expect(responseJitterMs(-1)).toBe(0);
        expect(responseJitterMs(Number.NaN)).toBe(0);
    });
    it('the answer carries the SAME key at its CURRENT epoch, key_id "share"', () => {
        const KEY = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=';
        const c = buildShareContent({ callId: CALL, keyB64: KEY, epoch: 7, rotatesAtMs: 5_000_000, nowMs: 4_000_000, clientMsgId: 'm-2', rotationMs: 600_000 });
        expect(c).toMatchObject({ type: 'call_key', call_id: CALL, epoch: 7, e2ee_key_b64: KEY, key_id: 'share' });
        expect(c.rotates_at).toBe(new Date(5_000_000).toISOString());
        expect(contentProblem(c)).toBeNull();
    });
    it('an overdue or unknown rotation time becomes now + 10 minutes', () => {
        const KEY = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=';
        const overdue = buildShareContent({ callId: CALL, keyB64: KEY, epoch: 2, rotatesAtMs: 1, nowMs: 4_000_000, clientMsgId: 'm', rotationMs: 600_000 });
        expect(overdue.rotates_at).toBe(new Date(4_600_000).toISOString());
        const unknown = buildShareContent({ callId: CALL, keyB64: KEY, epoch: 2, rotatesAtMs: null, nowMs: 4_000_000, clientMsgId: 'm', rotationMs: 600_000 });
        expect(unknown.rotates_at).toBe(new Date(4_600_000).toISOString());
    });
    it('recipients are ONLY the requesting user\'s devices — never another user\'s', () => {
        const devices = [
            { device_id: 'a1', user_id: 'alice' },
            { device_id: 'a2', user_id: 'alice' },
            { device_id: 'b1', user_id: 'bob' },
            { device_id: 'c1', user_id: 'carol' },
            { device_id: 'x1' },
            { device_id: 'x2', user_id: null },
        ];
        expect(devicesOfUser(devices, 'alice').map(d => d.device_id)).toEqual(['a1', 'a2']);
        expect(devicesOfUser(devices, 'dave')).toEqual([]);
        expect(devicesOfUser(devices, '')).toEqual([]);
    });
});

describe('rotation duty — chooseRotator', () => {
    it('the initiator rotates while connected', () => {
        const r = chooseRotator({ selfUserId: 'zed', selfIsInitiator: true, knownInitiatorUserId: null, connectedUserIds: ['aaa', 'zed'] });
        expect(r).toEqual({ userId: 'zed', primary: true });
        const other = chooseRotator({ selfUserId: 'aaa', selfIsInitiator: false, knownInitiatorUserId: 'zed', connectedUserIds: ['aaa', 'zed'] });
        expect(other).toEqual({ userId: 'zed', primary: true });
    });
    it('with the initiator gone, the connected participant with the lowest user id rotates', () => {
        const r = chooseRotator({ selfUserId: 'mmm', selfIsInitiator: false, knownInitiatorUserId: 'zed', connectedUserIds: ['mmm', 'ccc', 'qqq'] });
        expect(r).toEqual({ userId: 'ccc', primary: false });
    });
    it('this device counts itself even if the roster has not reported it', () => {
        expect(chooseRotator({ selfUserId: 'solo', selfIsInitiator: false, knownInitiatorUserId: null, connectedUserIds: [] }))
            .toEqual({ userId: 'solo', primary: false });
    });
    it('an unknown initiator falls back to the lowest id', () => {
        const r = chooseRotator({ selfUserId: 'bbb', selfIsInitiator: false, knownInitiatorUserId: null, connectedUserIds: ['bbb', 'aaa'] });
        expect(r).toEqual({ userId: 'aaa', primary: false });
    });
    it('exactly one connected participant is the rotator, whoever asks (agreement)', () => {
        const ids = ['u3', 'u1', 'u2'];
        const choices = ids.map(me => chooseRotator({ selfUserId: me, selfIsInitiator: false, knownInitiatorUserId: 'gone', connectedUserIds: ids }).userId);
        expect(new Set(choices)).toEqual(new Set(['u1']));
    });
    it('the rotator is the lowest by plain string order', () => {
        const r = chooseRotator({ selfUserId: 'B', selfIsInitiator: false, knownInitiatorUserId: null, connectedUserIds: ['b', 'B', 'a'] });
        expect(r.userId).toBe('B'); // 'B' < 'a' < 'b'
    });
});

describe('rotation duty — isRotationDue', () => {
    const NOW = 10_000_000;
    it('only the chosen rotator rotates', () => {
        expect(isRotationDue({ selfUserId: 'me', choice: { userId: 'other', primary: true }, rotatesAtMs: NOW - 1, nowMs: NOW })).toBe(false);
        expect(isRotationDue({ selfUserId: 'me', choice: { userId: null, primary: false }, rotatesAtMs: NOW - 1, nowMs: NOW })).toBe(false);
    });
    it('the primary rotator rotates exactly when due', () => {
        const choice = { userId: 'me', primary: true };
        expect(isRotationDue({ selfUserId: 'me', choice, rotatesAtMs: NOW + 1, nowMs: NOW })).toBe(false);
        expect(isRotationDue({ selfUserId: 'me', choice, rotatesAtMs: NOW, nowMs: NOW })).toBe(true);
    });
    it('a fallback rotator waits out the grace so the initiator wins the race', () => {
        const choice = { userId: 'me', primary: false };
        expect(isRotationDue({ selfUserId: 'me', choice, rotatesAtMs: NOW - 1, nowMs: NOW })).toBe(false);
        expect(isRotationDue({ selfUserId: 'me', choice, rotatesAtMs: NOW - CALL_KEY_ROTATION_GRACE_MS, nowMs: NOW })).toBe(true);
    });
    it('no known rotation time means no rotation', () => {
        expect(isRotationDue({ selfUserId: 'me', choice: { userId: 'me', primary: true }, rotatesAtMs: null, nowMs: NOW })).toBe(false);
    });
});

describe('nobody can answer — shouldMintSoloKey / mintEpoch', () => {
    const empty = { active: true, participants: 0 };
    const LONG = CALL_KEY_SOLO_MINT_AFTER_MS;
    it('mints only when keyless past the retries AND the room is positively empty', () => {
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: empty })).toBe(true);
    });
    it('the keyless wait is ~20 s', () => {
        expect(CALL_KEY_SOLO_MINT_AFTER_MS).toBeGreaterThanOrEqual(20_000);
        expect(CALL_KEY_SOLO_MINT_AFTER_MS).toBeLessThanOrEqual(25_000);
    });
    it('never mints before the retries are over', () => {
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG - 1, status: empty })).toBe(false);
    });
    it('never mints once a key is held', () => {
        expect(shouldMintSoloKey({ stillKeyless: false, keylessForMs: LONG, status: empty })).toBe(false);
    });
    it('never mints with remote participants present — it keeps waiting', () => {
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG * 10, status: { active: true, participants: 1, participant_ids: ['someone'] } })).toBe(false);
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: { active: true, participants: 0, participant_ids: ['someone'] } })).toBe(false);
    });
    it('never mints on an unknown, errored or ended status', () => {
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: null })).toBe(false);
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: undefined })).toBe(false);
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: { active: true, error: true } })).toBe(false);
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: { active: false } })).toBe(false);
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: {} })).toBe(false);
        expect(shouldMintSoloKey({ stillKeyless: true, keylessForMs: LONG, status: { active: true } })).toBe(false); // participants unknown
    });
    it('the minted epoch is one past the highest seen, never below 2', () => {
        expect(mintEpoch(0)).toBe(2);
        expect(mintEpoch(1)).toBe(2);
        expect(mintEpoch(5)).toBe(6);
    });
});

describe('key request addressing', () => {
    it('asks only the users the server reports as connected', () => {
        expect(keyRequestRecipientUserIds({ active: true, participants: 2, participant_ids: ['u1', 'u2', 'u1'] })).toEqual(['u1', 'u2']);
    });
    it('asks nobody when the call is empty, ended, or the status is unusable', () => {
        expect(keyRequestRecipientUserIds({ active: true, participants: 0 })).toEqual([]);
        expect(keyRequestRecipientUserIds({ active: true, participant_ids: [] })).toEqual([]);
        expect(keyRequestRecipientUserIds({ active: false, participant_ids: ['u1'] })).toEqual([]);
        expect(keyRequestRecipientUserIds(null)).toEqual([]);
        expect(keyRequestRecipientUserIds('nope')).toEqual([]);
        expect(keyRequestRecipientUserIds({ active: true, participant_ids: [1, '', null, 'x'.repeat(300)] })).toEqual([]);
    });
    it('filters the device list to those users only', () => {
        const devices = [
            { device_id: 'a', spk_pub_b64: '', user_id: 'u1' },
            { device_id: 'b', spk_pub_b64: '', user_id: 'u2' },
            { device_id: 'c', spk_pub_b64: '', user_id: 'u3' },
            { device_id: 'd', spk_pub_b64: '' },
        ];
        expect(devicesOfUsers(devices, ['u1', 'u3']).map(d => d.device_id)).toEqual(['a', 'c']);
        expect(devicesOfUsers(devices, [])).toEqual([]);
    });
});
