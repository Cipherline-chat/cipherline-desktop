import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guard for call-key sharing (utils/callKeyShare.ts,
 * hooks/useCallKeySharing.ts). Dashboard has no render harness, and every
 * property below is a registration/ordering property a text scan pins cheaply
 * (same approach as dmCallKeyWiring.test.ts).
 */
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const dashboard = read('components', 'Dashboard.tsx');
const chatPane = read('components', 'ChatPane.tsx');
const callPane = read('components', 'CallPane.tsx');
const hook = read('hooks', 'useCallKeySharing.ts');

const slice = (src: string, needle: string, len: number) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found`).toBeGreaterThan(-1);
    return src.slice(i, i + len);
};

describe('receiving a call_key_request', () => {
    it('is answered only after the sender-trust gate, through the sharing hook', () => {
        const at = slice(dashboard, "content.type === 'call_key_request' && content.call_id", 1400);
        expect(at).toContain("actionFor(senderVerdict, 'key_material') === 'accept'");
        expect(at).toContain('handleCallKeyRequestRef.current({');
        expect(at).toContain('senderTrusted: trusted');
        // The requester's device id comes from the envelope, never the payload.
        expect(at).toContain('senderDeviceId: envelopeSenderDeviceId');
    });
    it('gets the same fresh identity-directory look as a call_key sender', () => {
        expect(dashboard).toContain("(content?.type === 'call_key' || content?.type === 'call_key_request') && envelopeSenderUserId");
    });
    it('is logged by reason only — no user or device identifiers', () => {
        const at = slice(dashboard, "content.type === 'call_key_request' && content.call_id", 1400);
        const logs = at.match(/console\.\w+\([^;]*\);/g) ?? [];
        expect(logs.length).toBeGreaterThan(0);
        for (const l of logs) expect(l).not.toMatch(/UserId|DeviceId|senderPub|env\./);
    });
    it('never rings: a shared, rotated or minted key is not an incoming call', () => {
        expect(dashboard).toContain("content.key_id !== CALL_KEY_ID_SHARE && !(typeof content.epoch === 'number' && content.epoch > 1)");
    });
    it('never becomes a thread row, an unread count or a notification', () => {
        // The unread/notify loop counts only these content types.
        expect(dashboard).toContain("(isPlaceholder || ['text', 'attachment', 'server_invite', 'safety_number', 'klipy_gif'].includes(m.content.type))");
    });
});

describe('the sharing hook', () => {
    it('is mounted in Dashboard with the vetted store and the connected-call id', () => {
        const at = slice(dashboard, 'const callKeySharing = useCallKeySharing({', 700);
        expect(at).toContain('roomConnectedCallId');
        expect(at).toContain('storeRef: callKeyStoreRef');
        expect(at).toContain('keyEpoch: callKeyEpoch');
        expect(at).toContain('recordGeneratedKey');
    });
    it('records generated keys through recordCallKey (epoch bump), never the ref', () => {
        expect(dashboard).toContain('recordGeneratedKey: (conversationId, callId, keyB64, epoch) => recordCallKey(conversationId, callId, keyB64, true, epoch)');
        const direct = dashboard.match(/callKeyStoreRef\.current\.record(Local|Remote)\(/g) ?? [];
        expect(direct).toHaveLength(2);
    });
    it('sends with the same pattern as the call_key sends: device list, claim_otp, encryptAndAddress, /messages/send', () => {
        expect(hook).toContain('/devices?claim_otp=1');
        expect(hook).toContain('encryptAndAddress(');
        expect(hook).toContain('/messages/send');
        expect(hook).toContain("envelope_type: 'signal_chat'");
    });
    it('answers only the requester\'s own devices, with the held key and its current epoch', () => {
        const at = slice(hook, 'const content = buildShareContent({', 900);
        expect(at).toContain('keyB64: held.keyB64');
        expect(at).toContain('epoch: held.epoch');
        expect(at).toContain('req.senderUserId');
        expect(hook).toContain('devicesOfUser(devices, onlyUserId)');
    });
    it('re-checks that it is still connected, with a key, when the jitter timer fires', () => {
        const at = slice(hook, 'setTimeout(() => {\n            const b = latest.current;', 700);
        expect(at).toContain('b.roomConnectedCallId === req.callId');
        expect(at).toContain('b.storeRef.current.accepted(req.conversationId, req.callId)');
    });
    it('only an ACCEPTED key is ever shared (never the unconfirmed epoch-0 adoption)', () => {
        expect(hook).not.toMatch(/storeRef\.current\.get\([^)]*\)[^;]*buildShareContent/);
        expect(slice(hook, 'holdsAcceptedKey:', 80)).toContain('.accepted(');
    });
    it('never mints with remote participants present, and checks the server status twice', () => {
        expect(hook).toContain('shouldMintSoloKey(');
        expect((hook.match(/\/status/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(hook).toContain('mintEpoch(storeRef.current.highestEpoch(convId, callId))');
    });
    it('never builds or joins a room: no LiveKit, no setActiveCall, no gate bypass', () => {
        expect(hook).not.toMatch(/from '(livekit|@livekit)/);
        expect(hook).not.toContain('setActiveCall');
        expect(hook).not.toContain('resolveCallKeyGate');
    });
    it('never logs user ids, device ids or who asked whom', () => {
        const logs = hook.match(/console\.\w+\(([^;]|\n)*?\);/g) ?? [];
        expect(logs.length).toBeGreaterThan(0);
        for (const l of logs) {
            expect(l).not.toMatch(/userId|deviceId|senderUserId|senderDeviceId|auth\./);
        }
    });
});

describe('rotation moved out of ChatPane', () => {
    it('ChatPane no longer runs the initiator-only 10-minute timer', () => {
        expect(chatPane).not.toContain('Epoch Rotation (10m)');
        expect(chatPane).not.toContain("key_id: `rotate-${nextEpoch}`");
        expect(chatPane).not.toContain('setIsCallInitiator');
    });
    it('the hook rotates with the connected-participant fallback', () => {
        expect(hook).toContain('chooseRotator({');
        expect(hook).toContain('isRotationDue({');
        expect(hook).toContain('key_id: `rotate-${nextEpoch}`');
    });
});

describe('CallPane reports what the hook needs', () => {
    it('roster identities and remote decryption failures reach the hook', () => {
        expect(dashboard).toContain('onParticipantIdentities={callKeySharing.reportParticipants}');
        expect(dashboard).toContain('onDecryptKeyFailure={callKeySharing.requestKeyAfterDecryptFailure}');
        expect(callPane).toContain('if (isDecryptKeyFailure(err)) onDecryptKeyFailure?.();');
    });
});
