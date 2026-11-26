import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for refused call keys (utils/callKeyRefusal.ts).
 * Dashboard has no render harness (vitest runs in node, .test.ts only), so the
 * registration properties are pinned by a text scan, like
 * callKeySharingWiring.test.ts.
 *
 * The incident (2026-11-25): a verified contact rang from a device the user had
 * not verified. Every call_key from it was refused at the trust gate — the
 * start broadcast and both answers to this device's key requests — while the
 * call panel said "Securing call…" / "hasn't reached this device yet, call
 * again", and nothing ever asked for the key again once the user reviewed the
 * device.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const dashboard = read('components', 'Dashboard.tsx');
const hook = read('hooks', 'useCallKeySharing.ts');
const indicator = read('components', 'server', 'CallEncryptionIndicator.tsx');

const slice = (src: string, needle: string, len: number) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found`).toBeGreaterThan(-1);
    return src.slice(i, i + len);
};

describe('a call_key refused at the sender-trust gate', () => {
    it('is remembered (reason only) in the refusal branch, never adopted', () => {
        const at = slice(dashboard, 'console.warn(`[E2EE] call_key rejected: sender identity not attributable', 1200);
        expect(at).toContain('callKeyRefusalsRef.current.note({');
        expect(at).toContain('verdict: senderVerdict');
        expect(at).not.toContain('keyB64');
        expect(at).not.toContain('e2ee_key_b64');
    });
    it('the call_key gate refuses through routeIncomingCallKey; only accept / accept_warn adopt (utils/callKeyTrust.ts)', () => {
        // 2026-11-25 owner decision: the incident's own case (a verified contact's
        // published, unverified device) is now accept_warn, not a refusal — the
        // decision table is unit-tested in utils/callKeyTrust.test.ts.
        const at = slice(dashboard, "if (content.type === 'call_key' && content.call_id && content.e2ee_key_b64) {", 5200);
        expect(at).toContain('routeIncomingCallKey({');
        expect(at).toContain('adopt: () => acceptRemoteCallKeyRef.current({');
        expect(at).toContain('onRefused: () => {');
    });
    it('is forgotten once a key for that call is accepted', () => {
        const at = slice(dashboard, 'const d = callKeyStoreRef.current.recordRemote({ ...input, senderIsMember });', 600);
        expect(at).toContain('callKeyRefusalsRef.current.clear(input.conversationId, input.callId)');
    });
});

describe('the keyless call panel', () => {
    it('gets the refusal for the active DM/group call', () => {
        expect(dashboard).toContain('callKeyRefusalsRef.current.get(activeCall.conversation_id, activeCall.id)');
        const at = slice(dashboard, '<CallEncryptionIndicator\n                                            mode={keyNoticeMode}', 2200);
        expect(at).toContain('refusal={activeCallKeyRefusal');
        expect(at).toContain('callKeyRefusalNotice(r.reason, callKeySenderName(r.senderUserId, r.conversationId))');
        expect(at).toContain('onReview: reviewCallKeySender(r.senderUserId, r.conversationId)');
        // Review opens the person's DM (where the identity banner lives), else the call's conversation.
        const review = slice(dashboard, 'const reviewCallKeySender = (senderUserId: string, conversationId: string) => {', 900);
        expect(review).toContain('return () => handleStartChat({');
    });
    it('renders the reason with a review action and a leave, and still never a plaintext way in', () => {
        const at = slice(indicator, 'if (refusal && !channelName) {', 2200);
        expect(at).toContain('{refusal.title}');
        expect(at).toContain('{refusal.body}');
        expect(at).toContain('onClick={refusal.onReview}');
        expect(at).toContain('onClick={onLeave}');
        for (const banned of ['join anyway', 'connect anyway', 'continue without']) expect(indicator.toLowerCase()).not.toContain(banned);
    });
});

describe('answering the identity warning re-asks for the key', () => {
    it('ChatPane resolves warnings through resolveSenderWarning, not the bare clear', () => {
        expect(dashboard).toContain('onKeyChangeResolved={resolveSenderWarning}');
        expect(dashboard).not.toContain('onKeyChangeResolved={clearSenderWarning}');
    });
    it('resolveSenderWarning retires the warning, then restarts the request schedule only when the refusal came from that person', () => {
        const at = slice(dashboard, 'const resolveSenderWarning = useCallback((uid: string) => {', 1500);
        expect(at).toContain('clearSenderWarning(uid);');
        expect(at).toContain('shouldRerequestAfterResolve({ resolvedUserId: uid, activeCall: call, hasKey, refusal })');
        expect(at).toContain('setCallKeyRerequestNonce(n => n + 1)');
    });
    it('the nonce reaches the sharing hook, whose REQUEST schedule restarts on it', () => {
        expect(slice(dashboard, 'const callKeySharing = useCallKeySharing({', 800)).toContain('rerequestNonce: callKeyRerequestNonce');
        const effect = slice(hook, '// ── REQUEST', 1800);
        expect(effect).toMatch(/\}, \[isConvCall, hasAcceptedKey, canSend, callId, convId, token, deviceId, userId, storeRef, rerequestNonce\]\);/);
        // Still the ordinary key request: E2EE message, only to the call's connected participants.
        expect(effect).toContain('await sendKeyRequest(auth, convId, callId);');
        expect(hook).toContain('const recipients = keyRequestRecipientUserIds(status.data);');
    });
});
