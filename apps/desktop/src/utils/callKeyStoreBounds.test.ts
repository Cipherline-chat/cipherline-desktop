/**
 * Audit run 2, lead 10 — peer-supplied epoch / rotates_at must be bounded, and
 * the rotator must not be wedgeable. Real CallKeyStore + the real rotation
 * decision functions (chooseRotator / isRotationDue / buildShareContent); only
 * the clock is injected (nowMs). The React hook's effect is not rendered here:
 * its decisions are nextRotationEpoch + the store's return value, both covered.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CallKeyStore, CALL_KEY_ROTATION_MS, CALL_KEY_MAX_EPOCH, CALL_KEY_FIRST_EPOCH_MAX,
    CALL_KEY_EPOCH_SLACK, nextRotationEpoch, CALL_KEY_ID_INITIAL,
} from './callKeyStore';
import { buildShareContent, chooseRotator, isRotationDue, mintEpoch } from './callKeyShare';

const k = () => randomBytes(32).toString('base64');
const CONV = 'conv-g', CALL = 'call-1';
const ALICE = 'alice', BOB = 'bob', MAL = 'mallory';
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('CallKeyStore — epoch bounds (negative)', () => {
    it('the audit PoC: MAX_SAFE_INTEGER after an honest epoch 1 is refused, the rotator keeps a representable successor', () => {
        const s = new CallKeyStore();
        const honest = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: honest, epoch: 1, senderUserId: ALICE, nowMs: T0 });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: Number.MAX_SAFE_INTEGER, senderUserId: MAL, nowMs: T0 })).toBe('refused_epoch');
        expect(s.accepted(CONV, CALL)?.keyB64).toBe(honest);
        expect(s.highestEpoch(CONV, CALL)).toBe(1); // a refused epoch does not poison seenEpoch / mintEpoch
        expect(nextRotationEpoch(1)).toBe(2);
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ALICE, generated: true, epoch: 2, nowMs: T0 })).toBe('stored');
    });
    it('a jump just past the budget is refused, the largest in-budget jump is accepted', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: ALICE, nowMs: T0 });
        const limit = 1 + CALL_KEY_EPOCH_SLACK;
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: limit + 1, senderUserId: MAL, nowMs: T0 })).toBe('refused_epoch');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: limit, senderUserId: MAL, nowMs: T0 })).toBe('stored');
    });
    it('fast-forwarding cannot outrun wall time: repeated max jumps stop long before the ceiling', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: ALICE, nowMs: T0 });
        // Hostile member hammers "+40" for 5 minutes of wall time at 5 msgs / 3 s.
        let now = T0;
        for (let i = 0; i < 100; i++) {
            now += 3_000;
            s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: (s.accepted(CONV, CALL)?.epoch ?? 0) + 40, senderUserId: MAL, nowMs: now });
        }
        const reached = s.accepted(CONV, CALL)!.epoch;
        expect(reached).toBeLessThan(CALL_KEY_EPOCH_SLACK + 1 + 10); // slack + ~5 min of budget
        expect(nextRotationEpoch(reached)).toBe(reached + 1);
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ALICE, generated: true, epoch: reached + 1, nowMs: now })).toBe('stored');
    });
    it('the first key a device holds is capped (a hostile first key cannot park the call near the ceiling)', () => {
        const s = new CallKeyStore();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: CALL_KEY_FIRST_EPOCH_MAX + 1, senderUserId: MAL, nowMs: T0 })).toBe('refused_epoch');
        expect(s.accepted(CONV, CALL)).toBeNull();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: Number.MAX_SAFE_INTEGER, senderUserId: MAL, nowMs: T0 })).toBe('refused_epoch');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: CALL_KEY_FIRST_EPOCH_MAX, senderUserId: MAL, nowMs: T0 })).toBe('stored');
        // headroom for the honest rotator remains
        expect(nextRotationEpoch(CALL_KEY_FIRST_EPOCH_MAX)).toBe(CALL_KEY_FIRST_EPOCH_MAX + 1);
    });
    it('recordLocal refuses past the ceiling and nextRotationEpoch says "stop" there', () => {
        const s = new CallKeyStore();
        expect(nextRotationEpoch(CALL_KEY_MAX_EPOCH)).toBeNull();
        expect(nextRotationEpoch(Number.MAX_SAFE_INTEGER)).toBeNull();
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ALICE, generated: true, epoch: CALL_KEY_MAX_EPOCH + 1, nowMs: T0 })).toBe('refused_invalid');
        expect(s.accepted(CONV, CALL)).toBeNull();
    });
    it('negative control: shape errors are still refused_invalid, distinct from the new bound', () => {
        const s = new CallKeyStore();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1.5, senderUserId: ALICE, nowMs: T0 })).toBe('refused_invalid');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 0, senderUserId: ALICE, nowMs: T0 })).toBe('refused_invalid');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: Infinity, senderUserId: ALICE, nowMs: T0 })).toBe('refused_invalid');
    });
});

describe('CallKeyStore — rotates_at bounds', () => {
    const rotatesAtOf = (rotatesAt: string, now = T0) => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: ALICE, rotatesAt, nowMs: now });
        return s.accepted(CONV, CALL)!.rotatesAtMs!;
    };
    it('a far-future rotates_at is clamped to one rotation interval plus the skew margin (not an hour)', () => {
        const v = rotatesAtOf(iso(T0 + 60 * MIN));
        expect(v).toBeLessThanOrEqual(T0 + CALL_KEY_ROTATION_MS + 2 * MIN);
        expect(v).toBeGreaterThanOrEqual(T0 + CALL_KEY_ROTATION_MS);
    });
    it('what legitimate rotation writes (now + interval) is kept exactly', () => {
        expect(rotatesAtOf(iso(T0 + CALL_KEY_ROTATION_MS))).toBe(T0 + CALL_KEY_ROTATION_MS);
    });
    it('a sharer-passed-through value with less time left is kept', () => {
        expect(rotatesAtOf(iso(T0 + 3 * MIN))).toBe(T0 + 3 * MIN);
    });
    it('a past value is "due now", never an earlier-than-now number', () => {
        expect(rotatesAtOf(iso(T0 - 5 * MIN))).toBe(T0);
    });
    it('garbage falls back to now + interval', () => {
        expect(rotatesAtOf('not a date')).toBe(T0 + CALL_KEY_ROTATION_MS);
    });
    it('the delayed-rotation variant (epoch+1 with rotates_at 1 h out) now delays by at most interval+margin, via the real isRotationDue', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, keyId: CALL_KEY_ID_INITIAL, senderUserId: ALICE, rotatesAt: iso(T0 + CALL_KEY_ROTATION_MS), nowMs: T0 });
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 2, senderUserId: MAL, rotatesAt: iso(T0 + 60 * MIN), nowMs: T0 });
        const held = s.accepted(CONV, CALL)!;
        const choice = chooseRotator({ selfUserId: ALICE, selfIsInitiator: true, knownInitiatorUserId: ALICE, connectedUserIds: [ALICE, BOB] });
        expect(isRotationDue({ selfUserId: ALICE, choice, rotatesAtMs: held.rotatesAtMs, nowMs: T0 + 12 * MIN + 1 })).toBe(true);
        expect(isRotationDue({ selfUserId: ALICE, choice, rotatesAtMs: held.rotatesAtMs, nowMs: T0 + 5 * MIN })).toBe(false);
    });
});

describe('legitimate call sequences still work (positive)', () => {
    it('late joiner with NO key accepts the current epoch of a 24 h call (~144) and then follows +1 rotations', () => {
        const s = new CallKeyStore();
        const now = T0 + 24 * 60 * MIN;
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 145, senderUserId: BOB, nowMs: now })).toBe('stored');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 146, senderUserId: BOB, nowMs: now + CALL_KEY_ROTATION_MS })).toBe('stored');
        expect(s.accepted(CONV, CALL)?.epoch).toBe(146);
    });
    it('a device that missed several rotations catches up (3 h away = 18 epochs)', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 5, senderUserId: BOB, nowMs: T0 });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 23, senderUserId: BOB, nowMs: T0 + 180 * MIN })).toBe('stored');
    });
    it('a device that missed 10 rotations in quick succession (a short network drop) catches up', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 5, senderUserId: BOB, nowMs: T0 });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 15, senderUserId: BOB, nowMs: T0 + MIN })).toBe('stored');
    });
    it("'initial' epoch 1 and the normal +1 rotation", () => {
        const s = new CallKeyStore();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, keyId: CALL_KEY_ID_INITIAL, senderUserId: ALICE, rotatesAt: iso(T0 + CALL_KEY_ROTATION_MS), nowMs: T0 })).toBe('stored');
        expect(s.initiatorOf(CONV, CALL)).toBe(ALICE);
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 2, senderUserId: ALICE, rotatesAt: iso(T0 + 2 * CALL_KEY_ROTATION_MS), nowMs: T0 + CALL_KEY_ROTATION_MS })).toBe('stored');
        expect(s.accepted(CONV, CALL)?.epoch).toBe(2);
    });
    it('full 24 h call: initiator and follower stay in lock-step through 144 rotations, via the real decision functions', () => {
        const alice = new CallKeyStore(); // rotator
        const bob = new CallKeyStore();   // follower
        const first = k();
        alice.recordLocal({ conversationId: CONV, callId: CALL, keyB64: first, selfUserId: ALICE, generated: true, nowMs: T0 });
        bob.recordRemote({ conversationId: CONV, callId: CALL, keyB64: first, epoch: 1, keyId: CALL_KEY_ID_INITIAL, senderUserId: ALICE, rotatesAt: iso(T0 + CALL_KEY_ROTATION_MS), nowMs: T0 });
        let now = T0;
        for (let i = 0; i < 144; i++) {
            now += CALL_KEY_ROTATION_MS + 5_000; // the 5 s tick finds rotation due
            const held = alice.accepted(CONV, CALL)!;
            const choice = chooseRotator({ selfUserId: ALICE, selfIsInitiator: true, knownInitiatorUserId: ALICE, connectedUserIds: [ALICE, BOB] });
            expect(isRotationDue({ selfUserId: ALICE, choice, rotatesAtMs: held.rotatesAtMs, nowMs: now })).toBe(true);
            const next = nextRotationEpoch(held.epoch)!;
            const key = k();
            expect(bob.recordRemote({ conversationId: CONV, callId: CALL, keyB64: key, epoch: next, keyId: `rotate-${next}`, senderUserId: ALICE, rotatesAt: iso(now + CALL_KEY_ROTATION_MS), nowMs: now })).toBe('stored');
            expect(alice.recordLocal({ conversationId: CONV, callId: CALL, keyB64: key, selfUserId: ALICE, generated: true, epoch: next, nowMs: now })).toBe('stored');
        }
        expect(alice.accepted(CONV, CALL)?.epoch).toBe(145);
        expect(bob.accepted(CONV, CALL)?.keyB64).toBe(alice.accepted(CONV, CALL)?.keyB64);
        // A late joiner now gets the held key via the real share builder and accepts it.
        const heldB = bob.accepted(CONV, CALL)!;
        const share = buildShareContent({ callId: CALL, keyB64: heldB.keyB64, epoch: heldB.epoch, rotatesAtMs: heldB.rotatesAtMs, nowMs: now, clientMsgId: 'x', rotationMs: CALL_KEY_ROTATION_MS });
        const carol = new CallKeyStore();
        expect(carol.recordRemote({ conversationId: CONV, callId: CALL, keyB64: share.e2ee_key_b64, epoch: share.epoch, keyId: share.key_id, senderUserId: BOB, rotatesAt: share.rotates_at, nowMs: now })).toBe('stored');
        expect(carol.accepted(CONV, CALL)?.epoch).toBe(145);
    });
    it('epochs this device generated itself are credited, so a peer\'s matching rotation is not out-paced', () => {
        const bob = new CallKeyStore();
        bob.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: ALICE, nowMs: T0 });
        for (let e = 2; e <= 100; e++) bob.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: BOB, generated: true, epoch: e, nowMs: T0 + e });
        expect(bob.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 101, senderUserId: ALICE, nowMs: T0 + MIN })).toBe('stored');
    });
    it('mintEpoch of a bounded highest-seen stays small even after a hostile huge epoch was offered', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: ALICE, nowMs: T0 });
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: Number.MAX_SAFE_INTEGER, senderUserId: MAL, nowMs: T0 });
        expect(mintEpoch(s.highestEpoch(CONV, CALL))).toBe(2);
    });
});

describe('rotator does not spin (hook wiring, source-scan like callKeySharingWiring.test.ts)', () => {
    const hook = readFileSync(join(__dirname, '..', 'hooks', 'useCallKeySharing.ts'), 'utf8');
    const at = hook.indexOf('// ── ROTATE');
    const rotate = hook.slice(at, hook.indexOf('// ── RESPOND'));
    it('stops at the ceiling instead of broadcasting an unrecordable successor', () => {
        expect(rotate).toContain('nextRotationEpoch(held.epoch)');
        expect(rotate.indexOf('nextRotationEpoch(held.epoch)')).toBeLessThan(rotate.indexOf('sendControlMessage'));
    });
    it('backs off when the store refuses the generated key (a refusal is not an exception)', () => {
        expect(rotate).toMatch(/recordGeneratedKey\([^)]*\) !== 'stored'\) \{\s*rotateBackoffUntilRef\.current = Date\.now\(\) \+ ROTATION_STALL_BACKOFF_MS/);
    });
});
