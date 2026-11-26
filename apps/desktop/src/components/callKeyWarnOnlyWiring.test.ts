import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for warn-only call keys (utils/callKeyTrust.ts,
 * owner decision 2026-11-25). Dashboard has no render harness, so — like
 * callKeyRefusalWiring.test.ts — the registration is pinned by a text scan.
 * The behaviour itself (decision → real CallKeyStore → real gate CONNECTS) is
 * proven in utils/callKeyTrust.test.ts; this file pins that Dashboard uses
 * exactly that path, and nothing else moved.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const dashboard = read('components', 'Dashboard.tsx');
const indicator = read('components', 'server', 'CallEncryptionIndicator.tsx');
const banner = read('components', 'UnverifiedDeviceBanner.tsx');

const slice = (src: string, needle: string, len: number) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found`).toBeGreaterThan(-1);
    return src.slice(i, i + len);
};

describe('the call_key branch', () => {
    // Exactly the branch: up to the call_key_request handler that follows it.
    const branchStart = dashboard.indexOf("if (content.type === 'call_key' && content.call_id && content.e2ee_key_b64) {");
    const branch = dashboard.slice(branchStart, dashboard.indexOf("// A joiner without the call's media key is asking for it.", branchStart));
    it('exists', () => { expect(branchStart).toBeGreaterThan(-1); expect(branch.length).toBeGreaterThan(500); });

    it('routes through routeIncomingCallKey with the verdict, device id and a fresh directory status', () => {
        expect(branch).toContain('routeIncomingCallKey({');
        expect(branch).toContain('verdict: senderVerdict,');
        expect(branch).toContain('senderDeviceId: envelopeSenderDeviceId,');
        expect(branch).toContain('deviceDirectory.status(envelopeSenderUserId, envelopeSenderPub, envelopeSenderDeviceId ?? undefined)');
        // The bare fail-closed gate no longer decides call keys on its own.
        expect(branch).not.toContain("actionFor(senderVerdict, 'key_material')");
    });

    it('adopts only through acceptRemoteCallKey (the store still applies membership + epoch rules)', () => {
        expect(branch).toContain('adopt: () => acceptRemoteCallKeyRef.current({');
    });

    it('a warned key records the in-call warning (reason only, never the key or ids in the log)', () => {
        const warned = slice(branch, 'onWarned: () => {', 700);
        expect(warned).toContain('callKeyWarningsRef.current.note({');
        expect(warned).not.toContain('e2ee_key_b64');
        const log = slice(warned, "console.warn('[E2EE] call_key adopted with a warning", 200);
        expect(log).not.toMatch(/\$\{/);
    });

    it('a refused key still feeds the refusal card and re-ask flow', () => {
        const refused = slice(branch, 'onRefused: () => {', 1400);
        expect(refused).toContain('callKeyRefusalsRef.current.note({');
        expect(refused).not.toContain('e2ee_key_b64');
    });
});

describe('answering a call_key_request uses the same warn-only decision (owner 2026-11-25: late joiners too)', () => {
    const reqStart = dashboard.indexOf("if (content.type === 'call_key_request' && content.call_id && envelopeSenderUserId) {");
    const req = dashboard.slice(reqStart, dashboard.indexOf('// Own-device transfer (contract section 7)', reqStart));
    it('exists', () => { expect(reqStart).toBeGreaterThan(-1); expect(req.length).toBeGreaterThan(400); });
    it('routes through routeIncomingKeyRequest with the verdict, device id and a fresh directory status', () => {
        expect(req).toContain('routeIncomingKeyRequest({');
        expect(req).toContain('verdict: senderVerdict,');
        expect(req).toContain('senderDeviceId: envelopeSenderDeviceId,');
        expect(req).toContain('deviceDirectory.status(envelopeSenderUserId, envelopeSenderPub, envelopeSenderDeviceId ?? undefined)');
        expect(req).not.toContain("actionFor(senderVerdict, 'key_material')");
    });
    it('still answers only through the sharing hook (connected, holding a key, member, rate limit)', () => {
        expect(req).toContain('answer: senderTrusted => handleCallKeyRequestRef.current({');
        expect(req).toContain('senderTrusted,');
    });
    it('an answered unverified device records the late-joiner warning (kind sent), reason-only log', () => {
        const warned = slice(req, 'onWarned: () => {', 700);
        expect(warned).toContain('callKeyWarningsRef.current.note({');
        expect(warned).toContain("kind: 'sent',");
        expect(slice(warned, "console.warn('[CallKeyShare] answered a key request from an unverified device", 200)).not.toMatch(/\$\{/);
    });
    it('the card names the direction', () => {
        expect(dashboard).toContain('callKeyWarningNotice(callKeySenderName(w.senderUserId, w.conversationId), w.kind)');
    });
});

describe('every other key-material path is unchanged (fail-closed actionFor)', () => {
    it('the huddle guest key', () => {
        expect(dashboard).toContain("return !!verdict && actionFor(verdict, 'key_material') === 'accept';");
    });
    it('channel keys', () => {
        expect(dashboard).toContain("if (!ckVerdict || actionFor(ckVerdict, 'key_material') !== 'accept') {");
    });
    it('routeIncomingCallKey / routeIncomingKeyRequest are used once each (call_key / call_key_request only)', () => {
        expect(dashboard.match(/routeIncomingCallKey\(/g)?.length).toBe(1);
        expect(dashboard.match(/routeIncomingKeyRequest\(/g)?.length).toBe(1);
    });
});

describe('the connected call shows the warning', () => {
    it('Dashboard derives it for the active DM/group call only while it HAS a key', () => {
        const at = slice(dashboard, 'const activeCallKeyWarning =', 300);
        expect(at).toContain('!activeCall.callsChannelId && !activeCall.isVoiceChannel && deliveredCallKeyB64');
        expect(at).toContain('callKeyWarningsRef.current.get(activeCall.conversation_id, activeCall.id)');
    });
    it('renders the unverified_device indicator when the call is not blocked, with Review device', () => {
        const at = slice(dashboard, '{!keyNoticeMode && activeCallKeyWarning && snapCall && !snapCall.callsChannelId && (() => {', 700);
        expect(at).toContain('mode="unverified_device"');
        expect(at).toContain('callKeyWarningNotice(callKeySenderName(w.senderUserId, w.conversationId), w.kind)');
        expect(at).toContain('onReview: reviewCallKeySender(w.senderUserId, w.conversationId)');
        expect(at).not.toContain('onLeave');
    });
    it('Review device opens the sender\'s DM first (identity warnings are DM-only)', () => {
        const at = slice(dashboard, 'const reviewCallKeySender = (senderUserId: string, conversationId: string) => {', 400);
        expect(at).toContain("conversations.find(c => c.type === 'dm' && c.other_user_id === senderUserId)");
    });
    it('verifying (or explicitly dismissing) that person\'s warning retires it', () => {
        const at = slice(dashboard, 'const resolveSenderWarning = useCallback((uid: string) => {', 1500);
        expect(at).toContain('warned.senderUserId === uid');
        expect(at).toContain('callKeyWarningsRef.current.clear(call.conversation_id, call.id)');
        // …and the refusal re-ask is still there.
        expect(at).toContain('setCallKeyRerequestNonce(n => n + 1)');
    });
});

describe('the indicator\'s unverified_device mode', () => {
    // Just this mode's block: from its branch to the next one ('mixed').
    const start = indicator.indexOf("if (mode === 'unverified_device') {");
    const at = indicator.slice(start, indicator.indexOf("if (mode === 'mixed') {", start));
    it('exists', () => { expect(start).toBeGreaterThan(-1); });
    it('is non-blocking: title, body, Review device — no leave', () => {
        expect(at).toContain('{warning.title}');
        expect(at).toContain('{warning.body}');
        expect(at).toContain('onClick={warning.onReview}');
        expect(at).toContain('Review device');
        expect(at).not.toContain('onLeave');
    });
    it('never offers or implies a plaintext call', () => {
        for (const banned of ['join anyway', 'connect anyway', 'continue without', 'unencrypted call is offered']) {
            expect(indicator.toLowerCase()).not.toContain(banned);
        }
        expect(at.toLowerCase()).not.toContain('unencrypted');
    });
});

describe('the DM banner no longer says calls from an unrecognized_verified device are refused', () => {
    it('says channel keys are refused and calls connect with a warning', () => {
        expect(banner).toContain("verdict === 'unrecognized_verified'");
        expect(banner).toContain('Calls from it can connect, with a warning in the call.');
        // unattributed keeps the old sentence: its call keys are still refused.
        expect(banner).toContain('Encrypted calling and channel keys from this device are being refused until you verify it.');
    });
});
