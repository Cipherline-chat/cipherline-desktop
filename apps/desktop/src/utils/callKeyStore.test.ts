/**
 * F11 / R-06 — DM/group call keys: per (conversation, call), epochs only move
 * forward. Key sharing (utils/callKeyShare.ts) changed WHO may write: the
 * first key comes from any trusted member (whoever holds it can hand it to a
 * joiner) and a higher epoch from any member (rotation outlives the initiator).
 * Negative cases are the overwrite attacks that still must fail; positive
 * controls are initial delivery, sharing, rotation by a non-initiator, the
 * local initiator's own key and crash-recovery rejoin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'crypto';
import { CallKeyStore } from './callKeyStore';

const k = () => randomBytes(32).toString('base64');
const CONV = 'conv-a', OTHER_CONV = 'conv-b', CALL = 'call-1';
const BOB = 'bob', CAROL = 'carol', MAL = 'mallory', ME = 'me';

describe('CallKeyStore — negative', () => {
    it('a key sent in another conversation never becomes this call\'s key', () => {
        const s = new CallKeyStore();
        const bobKey = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: bobKey, epoch: 1, senderUserId: BOB });
        expect(s.recordRemote({ conversationId: OTHER_CONV, callId: CALL, keyB64: k(), epoch: 9, senderUserId: MAL })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(bobKey);
        expect(s.get(OTHER_CONV, CALL)).not.toBe(bobKey);
        // …and a lookup without a conversation refuses the ambiguity.
        expect(s.get(undefined, CALL)).toBe('');
    });
    it('a same-epoch DIFFERENT key from another member is refused (first writer wins)', () => {
        const s = new CallKeyStore();
        const bobKey = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: bobKey, epoch: 1, senderUserId: BOB });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: MAL })).toBe('refused_epoch');
        expect(s.get(CONV, CALL)).toBe(bobKey);
    });
    it('an older epoch is refused, from the first sender or anyone else (replay / rollback)', () => {
        const s = new CallKeyStore();
        const e2 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: BOB });
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e2, epoch: 2, senderUserId: BOB });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: BOB })).toBe('refused_epoch');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: CAROL })).toBe('refused_epoch');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 2, senderUserId: BOB })).toBe('refused_epoch');
        expect(s.get(CONV, CALL)).toBe(e2);
    });
    it('a known non-member is refused, even for the very first key; malformed keys/epochs are refused', () => {
        const s = new CallKeyStore();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), senderUserId: MAL, senderIsMember: false })).toBe('refused_member');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: 'short', senderUserId: BOB })).toBe('refused_invalid');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: -1, senderUserId: BOB })).toBe('refused_invalid');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1.5, senderUserId: BOB })).toBe('refused_invalid');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 0, senderUserId: BOB })).toBe('refused_invalid');
        expect(s.get(CONV, CALL)).toBe('');
    });
    it('a known non-member cannot advance the epoch of a call in progress either', () => {
        const s = new CallKeyStore();
        const e1 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 2, senderUserId: MAL, senderIsMember: false })).toBe('refused_member');
        expect(s.get(CONV, CALL)).toBe(e1);
    });
    it('a refused key does not become the highest epoch seen', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 50, senderUserId: MAL, senderIsMember: false });
        expect(s.highestEpoch(CONV, CALL)).toBe(0);
    });
    it('a local ADOPTION never displaces a key already held', () => {
        const s = new CallKeyStore();
        const e1 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB });
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ME, generated: false })).toBe('refused_held');
        expect(s.get(CONV, CALL)).toBe(e1);
    });
    it('a generated key must beat the held epoch', () => {
        const s = new CallKeyStore();
        const e3 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e3, epoch: 3, senderUserId: BOB });
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ME, generated: true, epoch: 3 })).toBe('refused_epoch');
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ME, generated: true, epoch: 2 })).toBe('refused_epoch');
        expect(s.get(CONV, CALL)).toBe(e3);
    });
});

describe('CallKeyStore — key sharing', () => {
    it('the FIRST key is accepted from any trusted member, not only the initiator', () => {
        const s = new CallKeyStore();
        const shared = k();
        // Carol (not the initiator) holds the key and hands it to a joiner.
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: shared, epoch: 4, senderUserId: CAROL, keyId: 'share' })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(shared);
        expect(s.accepted(CONV, CALL)?.epoch).toBe(4);
    });
    it('a second holder answering the same request is a duplicate, not a conflict', () => {
        const s = new CallKeyStore();
        const shared = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: shared, epoch: 4, senderUserId: CAROL });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: shared, epoch: 4, senderUserId: BOB })).toBe('duplicate');
    });
    it('a strictly higher epoch is accepted from ANY member (rotation after the initiator left)', () => {
        const s = new CallKeyStore();
        const e1 = k(), e2 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB, keyId: 'initial' });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e2, epoch: 2, senderUserId: CAROL })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(e2);
    });
    it('an unowned epoch-0 adoption is replaced by the first accepted key, from anyone', () => {
        const s = new CallKeyStore();
        const persisted = k(), fresh = k();
        s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: persisted, selfUserId: ME, generated: false });
        expect(s.accepted(CONV, CALL)).toBeNull(); // not a key to vouch for
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: fresh, epoch: 3, senderUserId: CAROL })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(fresh);
        expect(s.accepted(CONV, CALL)?.epoch).toBe(3);
    });
    it('a non-initiator rotator records its own higher epoch locally', () => {
        const s = new CallKeyStore();
        const e1 = k(), e2 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB, keyId: 'initial' });
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: e2, selfUserId: ME, generated: true, epoch: 2 })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(e2);
        // …and the initiator is still Bob, not me.
        expect(s.initiatorOf(CONV, CALL)).toBe(BOB);
    });
    it('a generated key without an explicit epoch is one past the held epoch', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 5, senderUserId: BOB });
        s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ME, generated: true });
        expect(s.entry(CONV, CALL)?.epoch).toBe(6);
    });
    it('a lone joiner\'s minted key is recorded at the epoch it was given', () => {
        const s = new CallKeyStore();
        const minted = k();
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: minted, selfUserId: ME, generated: true, epoch: 4 })).toBe('stored');
        expect(s.accepted(CONV, CALL)?.epoch).toBe(4);
        // Minting is not "starting the call": I am not recorded as its initiator.
        expect(s.initiatorOf(CONV, CALL)).toBeNull();
    });
    it('the initiator is the sender of the epoch-1 `initial` broadcast, learned once', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: BOB, keyId: 'initial' });
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 2, senderUserId: MAL, keyId: 'initial' });
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: MAL, keyId: 'initial' });
        expect(s.initiatorOf(CONV, CALL)).toBe(BOB);
        // A share is not the initiator's broadcast.
        const t = new CallKeyStore();
        t.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: CAROL, keyId: 'share' });
        expect(t.initiatorOf(CONV, CALL)).toBeNull();
    });
    it('an `initial` that was REFUSED does not name the initiator', () => {
        const s = new CallKeyStore();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: CAROL, keyId: 'share' });
        // Same epoch, different key: refused — and so is its claim to be the initiator.
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: MAL, keyId: 'initial' })).toBe('refused_epoch');
        expect(s.initiatorOf(CONV, CALL)).toBeNull();
    });
    it('the starting device is its own initiator', () => {
        const s = new CallKeyStore();
        s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: k(), selfUserId: ME, generated: true });
        expect(s.initiatorOf(CONV, CALL)).toBe(ME);
    });
    it('highestEpoch covers the held key and any epoch seen, for the mint rule', () => {
        const s = new CallKeyStore();
        expect(s.highestEpoch(CONV, CALL)).toBe(0);
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 3, senderUserId: BOB });
        expect(s.highestEpoch(CONV, CALL)).toBe(3);
        expect(s.highestEpoch(OTHER_CONV, CALL)).toBe(0);
    });
    it('rotates_at from the message carries through; junk falls back to 10 minutes', () => {
        const s = new CallKeyStore();
        const now = 1_000_000;
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: BOB, rotatesAt: new Date(now + 123_000).toISOString(), nowMs: now });
        expect(s.entry(CONV, CALL)?.rotatesAtMs).toBe(now + 123_000);
        const t = new CallKeyStore();
        t.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: BOB, rotatesAt: 'not a date', nowMs: now });
        expect(t.entry(CONV, CALL)?.rotatesAtMs).toBe(now + 10 * 60_000);
        const u = new CallKeyStore();
        u.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), epoch: 1, senderUserId: BOB, rotatesAt: new Date(now + 99 * 3_600_000).toISOString(), nowMs: now });
        expect(u.entry(CONV, CALL)?.rotatesAtMs).toBe(now + 3_600_000); // capped at an hour
    });
});

describe('CallKeyStore — positive controls', () => {
    it('initial delivery, then a rotation is adopted', () => {
        const s = new CallKeyStore();
        const e1 = k(), e2 = k();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB })).toBe('stored');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB })).toBe('duplicate');
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e2, epoch: 2, senderUserId: BOB })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(e2);
    });
    it('my own other device started the call (self fan-out), and rotates it', () => {
        const s = new CallKeyStore();
        const e1 = k(), e2 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: ME });
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e2, epoch: 2, senderUserId: ME })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(e2);
    });
    it('this device as initiator: start, then local rotation', () => {
        const s = new CallKeyStore();
        const e1 = k(), e2 = k();
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: e1, selfUserId: ME, generated: true })).toBe('stored');
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: e2, selfUserId: ME, generated: true })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(e2);
        expect(s.entry(CONV, CALL)?.epoch).toBe(2);
    });
    it('answering re-records the accepted key as a no-op, never as a takeover', () => {
        const s = new CallKeyStore();
        const e1 = k();
        s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e1, epoch: 1, senderUserId: BOB });
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: e1, selfUserId: ME, generated: false })).toBe('duplicate');
        // Bob's rotation still lands.
        const e2 = k();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: e2, epoch: 2, senderUserId: BOB })).toBe('stored');
    });
    it('crash-recovery rejoin adopts its persisted key, and the next accepted key takes over', () => {
        const s = new CallKeyStore();
        const persisted = k(), rotated = k();
        expect(s.recordLocal({ conversationId: CONV, callId: CALL, keyB64: persisted, selfUserId: ME, generated: false })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(persisted);
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: rotated, epoch: 3, senderUserId: BOB })).toBe('stored');
        expect(s.get(CONV, CALL)).toBe(rotated);
    });
    it('an older client that omits epoch is treated as epoch 1', () => {
        const s = new CallKeyStore();
        expect(s.recordRemote({ conversationId: CONV, callId: CALL, keyB64: k(), senderUserId: BOB })).toBe('stored');
        expect(s.entry(CONV, CALL)?.epoch).toBe(1);
    });
});

describe('F11 wiring — Dashboard / ChatPane', () => {
    const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const pane = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
    it('the incoming-call banner carries only a key the store accepted', () => {
        expect(dash).toContain('e2ee_key_b64: callKeyStoreRef.current.get(env.conversation_id, content.call_id),');
        expect(dash).not.toContain('e2ee_key_b64: content.e2ee_key_b64,');
    });
    it('the delivered key follows the store (rotation) before the call object\'s initial key', () => {
        expect(dash).toContain('callKeyStoreRef.current.get(activeCall.conversation_id, activeCall.id) || activeCall.e2ee_key_b64');
    });
    it('a received call_key is recorded with its conversation, epoch, sender, key id and rotation time', () => {
        const at = dash.indexOf('acceptRemoteCallKeyRef.current({');
        const call = dash.slice(at, at + 500);
        expect(call).toContain('conversationId: env.conversation_id');
        expect(call).toContain('epoch: content.epoch');
        expect(call).toContain('senderUserId: envelopeSenderUserId');
        expect(call).toContain('keyId: content.key_id');
        expect(call).toContain('rotatesAt: content.rotates_at');
    });
    it('ChatPane\'s merged-start path reads the vetted store, not a stored message row', () => {
        expect(pane).toContain('getCallKey?.(activeChat.id, initRes.data.session_id)');
        expect(pane).not.toMatch(/m\.content\?\.type === 'call_key' && m\.content\?\.call_id === initRes\.data\.session_id/);
        expect(dash).toContain('getCallKey={getAcceptedCallKey}');
    });
});
