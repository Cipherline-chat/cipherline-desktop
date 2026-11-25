import { describe, it, expect } from 'vitest';
import {
    CALL_KEY_REFUSAL_MAX,
    CALL_KEY_REFUSAL_TTL_MS,
    CallKeyRefusals,
    callKeyRefusalNotice,
    shouldRerequestAfterResolve,
} from './callKeyRefusal';

const T0 = 1_700_000_000_000;
const dmCall = { id: 'call-1', conversation_id: 'conv-1' };

describe('CallKeyRefusals', () => {
    it('remembers why a call key was refused, per (conversation, call)', () => {
        const r = new CallKeyRefusals();
        r.note({ conversationId: 'conv-1', callId: 'call-1', senderUserId: 'u-caller', verdict: 'unrecognized_verified', nowMs: T0 });
        expect(r.get('conv-1', 'call-1', T0)).toMatchObject({ senderUserId: 'u-caller', reason: 'unrecognized_verified' });
        expect(r.get('conv-2', 'call-1', T0)).toBeNull();
        expect(r.get('conv-1', 'call-2', T0)).toBeNull();
    });

    it('maps every non-accepting verdict, and a missing one, to a reason; never records an accepting verdict', () => {
        const r = new CallKeyRefusals();
        for (const v of ['key_changed', 'unattributed'] as const) {
            r.note({ conversationId: 'c', callId: v, senderUserId: 'u', verdict: v, nowMs: T0 });
            expect(r.get('c', v, T0)?.reason).toBe(v);
        }
        r.note({ conversationId: 'c', callId: 'none', senderUserId: 'u', verdict: null, nowMs: T0 });
        expect(r.get('c', 'none', T0)?.reason).toBe('unknown');
        r.note({ conversationId: 'c', callId: 'ok', senderUserId: 'u', verdict: 'ok', nowMs: T0 });
        r.note({ conversationId: 'c', callId: 'fc', senderUserId: 'u', verdict: 'first_contact', nowMs: T0 });
        expect(r.get('c', 'ok', T0)).toBeNull();
        expect(r.get('c', 'fc', T0)).toBeNull();
    });

    it('ignores incomplete input', () => {
        const r = new CallKeyRefusals();
        r.note({ conversationId: '', callId: 'x', senderUserId: 'u', verdict: 'key_changed' });
        r.note({ conversationId: 'c', callId: '', senderUserId: 'u', verdict: 'key_changed' });
        r.note({ conversationId: 'c', callId: 'x', senderUserId: '', verdict: 'key_changed' });
        expect(r.get('c', 'x')).toBeNull();
        expect(r.get(null, 'x')).toBeNull();
        expect(r.get('c', undefined)).toBeNull();
    });

    it('forgets a refusal on clear and after the TTL', () => {
        const r = new CallKeyRefusals();
        r.note({ conversationId: 'c', callId: 'k', senderUserId: 'u', verdict: 'key_changed', nowMs: T0 });
        expect(r.get('c', 'k', T0 + CALL_KEY_REFUSAL_TTL_MS)).not.toBeNull();
        expect(r.get('c', 'k', T0 + CALL_KEY_REFUSAL_TTL_MS + 1)).toBeNull();
        r.note({ conversationId: 'c', callId: 'k', senderUserId: 'u', verdict: 'key_changed', nowMs: T0 });
        r.clear('c', 'k');
        expect(r.get('c', 'k', T0)).toBeNull();
    });

    it('is bounded: the oldest call falls out first', () => {
        const r = new CallKeyRefusals();
        for (let i = 0; i <= CALL_KEY_REFUSAL_MAX; i++) {
            r.note({ conversationId: 'c', callId: `k${i}`, senderUserId: 'u', verdict: 'key_changed', nowMs: T0 + i });
        }
        expect(r.get('c', 'k0', T0 + CALL_KEY_REFUSAL_MAX)).toBeNull();
        expect(r.get('c', `k${CALL_KEY_REFUSAL_MAX}`, T0 + CALL_KEY_REFUSAL_MAX)).not.toBeNull();
    });
});

describe('shouldRerequestAfterResolve', () => {
    const refusal = { conversationId: 'conv-1', callId: 'call-1', senderUserId: 'u-caller', reason: 'unrecognized_verified' as const, atMs: T0 };

    it('re-asks when the person whose key was refused is the one the user just resolved', () => {
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: dmCall, hasKey: false, refusal })).toBe(true);
    });

    it('does nothing for an unrelated contact, a call that already has its key, or no refusal', () => {
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-other', activeCall: dmCall, hasKey: false, refusal })).toBe(false);
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: dmCall, hasKey: true, refusal })).toBe(false);
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: dmCall, hasKey: false, refusal: null })).toBe(false);
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: null, hasKey: false, refusal })).toBe(false);
    });

    it('only for the call that refusal is about', () => {
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: { id: 'call-2', conversation_id: 'conv-1' }, hasKey: false, refusal })).toBe(false);
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: { id: 'call-1', conversation_id: 'conv-9' }, hasKey: false, refusal })).toBe(false);
    });

    it('never for a server call (their keys do not travel as call_key)', () => {
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: { ...dmCall, callsChannelId: 'ch' }, hasKey: false, refusal })).toBe(false);
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: { ...dmCall, isVoiceChannel: true }, hasKey: false, refusal })).toBe(false);
        expect(shouldRerequestAfterResolve({ resolvedUserId: 'u-caller', activeCall: { id: 'call-1' }, hasKey: false, refusal })).toBe(false);
    });
});

describe('callKeyRefusalNotice', () => {
    it('names the person and says what to do, for every reason', () => {
        for (const reason of ['unrecognized_verified', 'key_changed', 'unattributed', 'unknown'] as const) {
            const n = callKeyRefusalNotice(reason, 'Sam');
            expect(n.title.length).toBeGreaterThan(0);
            expect(n.body).toContain('Sam');
            expect(n.body.toLowerCase()).toContain('review');
            // Never a plaintext way in.
            for (const s of [n.title, n.body]) {
                expect(s.toLowerCase()).not.toMatch(/join anyway|connect anyway|continue without|unencrypted/);
            }
        }
        expect(callKeyRefusalNotice('unrecognized_verified', 'Sam').title).toBe("Sam is calling from a device you haven't verified");
    });

    it('falls back to a neutral name', () => {
        expect(callKeyRefusalNotice('key_changed', '  ').title).toBe("The caller's safety number changed");
    });
});
