/**
 * F2 — a history transfer is accepted only when THIS device asked for it, the
 * transfer is bound to that request, and it comes from one of the account's
 * own known devices; and the import waits for an explicit confirmation.
 *
 * The wrap/unwrap run through the REAL e2ee engine (window.electronAPI is
 * bridged to it), so the sender the acceptance check sees is exactly what the
 * engine reports for the envelope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';

const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
        initialize: async () => {},
    },
}));

// axios dereferences window.location at import time; the HTTP half of
// historyTransferKey.ts is not exercised here.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const engine = await import('../../electron/e2ee-engine');
const { wrapHistoryTransferKey, unwrapHistoryTransferKey, judgeHistoryTransfer, HISTORY_REQUEST_TTL_MS } = await import('./historyTransferKey');
const { evaluateSelfSender } = await import('./selfSenderTrust');
const { applyObservation } = await import('./ownDeviceLedger');

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NEW_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const OLD_DEVICE = 'dddddddd-dddd-dddd-dddd-dddddddddd00';
const OTHER_OWN = 'dddddddd-dddd-dddd-dddd-dddddddddd02';

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return { privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'), pubB64: Buffer.from(pubJwk.x, 'base64url').toString('base64') };
}
function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(ed25519.getPublicKey(priv)).toString('base64') };
}

let newDevIdentity: ReturnType<typeof ed25519Pair>;
let newDevSpk: ReturnType<typeof x25519Pair>;
let oldDevIdentity: ReturnType<typeof ed25519Pair>;
let otherOwnIdentity: ReturnType<typeof ed25519Pair>;

function bundleForNewDevice() {
    const sig = Buffer.from(ed25519.sign(Buffer.from(newDevSpk.pubB64, 'base64'), Buffer.from(newDevIdentity.privHex, 'hex'))).toString('base64');
    return {
        device_id: NEW_DEVICE,
        identity_key_pub_b64: newDevIdentity.pubB64,
        signed_prekey: { id: 1, pub_b64: newDevSpk.pubB64, sig_b64: sig },
        one_time_prekey: null,
    };
}

/** Act as `identity` (the process that encrypts). */
function actAs(identity: { privHex: string; pubB64: string }) {
    store.set('identity_priv', identity.privHex);
    store.set('identity_pub', identity.pubB64);
}

beforeEach(() => {
    store.clear();
    newDevIdentity = ed25519Pair();
    newDevSpk = x25519Pair();
    oldDevIdentity = ed25519Pair();
    otherOwnIdentity = ed25519Pair();
    // Bridge the renderer API to the real engine.
    const g = globalThis as unknown as { window?: Record<string, unknown> };
    g.window = g.window ?? {};
    g.window.electronAPI = {
        encryptMessageV2: (pt: string, uid: string, devices: Parameters<typeof engine.encryptForDevices>[2], sd?: string) =>
            engine.encryptForDevices(pt, uid, devices, sd),
        decryptMessage: async (env: string, myDeviceId: string) =>
            engine.decryptEnvelope(env, myDeviceId, [{ id: 1, privHex: newDevSpk.privHex, pubB64: newDevSpk.pubB64 }]),
    };
});

/** The new device's own-device ledger: itself + the old device (baseline). */
const ledger = () => applyObservation(null, { deviceId: NEW_DEVICE, pub: newDevIdentity.pubB64 }, [
    { device_id: NEW_DEVICE, pub: newDevIdentity.pubB64 },
    { device_id: OLD_DEVICE, pub: oldDevIdentity.pubB64 },
    { device_id: OTHER_OWN, pub: otherOwnIdentity.pubB64 },
], true, 1);

async function deliver(from: { identity: { privHex: string; pubB64: string }; deviceId: string; userId?: string }, requestTs?: number) {
    actAs(from.identity);
    const env = await wrapHistoryTransferKey(crypto.randomBytes(32).toString('base64'), bundleForNewDevice(), from.userId ?? ME, from.deviceId, requestTs);
    const unwrapped = await unwrapHistoryTransferKey(env, NEW_DEVICE);
    const verdict = evaluateSelfSender({
        senderPub: unwrapped.senderPub ?? '',
        senderDeviceId: unwrapped.senderDeviceId,
        self: { deviceId: NEW_DEVICE, pub: newDevIdentity.pubB64 },
        ledger: ledger(),
        directory: 'unknown',
    }).verdict;
    return { unwrapped, verdict };
}

const NOW = 1_800_000_000_000;
const outstanding = (over: Partial<{ capabilityTs: number; targetDeviceId: string | null; createdAt: number }> = {}) =>
    ({ capabilityTs: 1_799_999_990, targetDeviceId: OLD_DEVICE, createdAt: NOW - 30_000, ...over });

describe('F2 positive controls — a legitimate own-device history sync', () => {
    it('is accepted when it answers the outstanding request from the device that was asked', async () => {
        const { unwrapped, verdict } = await deliver({ identity: oldDevIdentity, deviceId: OLD_DEVICE }, 1_799_999_990);
        expect(unwrapped.requestTs).toBe(1_799_999_990);
        expect(verdict).toBe('ok');
        expect(judgeHistoryTransfer({ outstanding: outstanding(), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict })).toEqual({ ok: true });
    });
    it('is accepted from an older approver that does not echo the request (compat)', async () => {
        const { unwrapped, verdict } = await deliver({ identity: oldDevIdentity, deviceId: OLD_DEVICE });
        expect(unwrapped.requestTs).toBeNull();
        expect(judgeHistoryTransfer({ outstanding: outstanding(), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict }).ok).toBe(true);
    });
    it('a broadcast request (no device picked) is answered by any known own device', async () => {
        const { unwrapped, verdict } = await deliver({ identity: otherOwnIdentity, deviceId: OTHER_OWN }, 1_799_999_990);
        expect(judgeHistoryTransfer({ outstanding: outstanding({ targetDeviceId: null }), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict }).ok).toBe(true);
    });
});

describe('F2 negative — unsolicited, unbound or foreign transfers are refused', () => {
    it('no outstanding request → refused (the unsolicited device:approved)', async () => {
        const { unwrapped, verdict } = await deliver({ identity: oldDevIdentity, deviceId: OLD_DEVICE }, 1_799_999_990);
        expect(judgeHistoryTransfer({ outstanding: null, now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict })).toEqual({ ok: false, reason: 'no_request' });
    });
    it('a transfer bound to a different request → refused', async () => {
        const { unwrapped, verdict } = await deliver({ identity: oldDevIdentity, deviceId: OLD_DEVICE }, 1_700_000_000);
        expect(judgeHistoryTransfer({ outstanding: outstanding(), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict })).toEqual({ ok: false, reason: 'request_mismatch' });
    });
    it('a relay-forged transfer "from myself" with its own key → refused', async () => {
        const attacker = ed25519Pair();
        const { unwrapped, verdict } = await deliver({ identity: attacker, deviceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, 1_799_999_990);
        expect(unwrapped.senderUserId).toBe(ME); // the engine believes the claim…
        expect(verdict).toBe('unattributed');     // …the own-device ledger does not
        expect(judgeHistoryTransfer({ outstanding: outstanding({ targetDeviceId: null }), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict })).toEqual({ ok: false, reason: 'not_own_device' });
    });
    it('a forged transfer borrowing the asked device\'s id → refused', async () => {
        const attacker = ed25519Pair();
        const { unwrapped, verdict } = await deliver({ identity: attacker, deviceId: OLD_DEVICE }, 1_799_999_990);
        expect(judgeHistoryTransfer({ outstanding: outstanding(), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict }).ok).toBe(false);
    });
    it('another user\'s transfer → refused', async () => {
        const { unwrapped } = await deliver({ identity: oldDevIdentity, deviceId: OLD_DEVICE, userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, 1_799_999_990);
        expect(judgeHistoryTransfer({ outstanding: outstanding(), now: NOW, myUserId: ME, unwrapped, senderVerdict: 'ok' })).toEqual({ ok: false, reason: 'not_own_device' });
    });
    it('a different own device than the one asked → refused', async () => {
        const { unwrapped, verdict } = await deliver({ identity: otherOwnIdentity, deviceId: OTHER_OWN }, 1_799_999_990);
        expect(judgeHistoryTransfer({ outstanding: outstanding(), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict })).toEqual({ ok: false, reason: 'wrong_device' });
    });
    it('an expired request → refused', async () => {
        const { unwrapped, verdict } = await deliver({ identity: oldDevIdentity, deviceId: OLD_DEVICE }, 1_799_999_990);
        expect(judgeHistoryTransfer({ outstanding: outstanding({ createdAt: NOW - HISTORY_REQUEST_TTL_MS - 1 }), now: NOW, myUserId: ME, unwrapped, senderVerdict: verdict })).toEqual({ ok: false, reason: 'stale_request' });
    });
});

describe('F2 wiring — HistorySyncBanner', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'HistorySyncBanner.tsx'), 'utf8');
    const effect = src.slice(src.indexOf('// Handle incoming history delivery'), src.indexOf('/** F2: runs only from the confirmation step'));
    it('ignores a delivery unless this device has an open, outstanding request', () => {
        expect(effect).toContain("if (!open || (state !== 'requesting' && state !== 'timed_out') || !outstandingRef.current)");
    });
    it('judges the unwrapped sender against the own-device ledger before anything else', () => {
        expect(effect).toContain('evaluateSelfSender(');
        expect(effect).toContain('judgeHistoryTransfer(');
        expect(effect).toContain("setState('confirm_import')");
        // No import from the delivery effect itself.
        expect(effect).not.toContain('importLocalHistory(');
    });
    it('imports only from the confirmation step', () => {
        const confirm = src.slice(src.indexOf('const confirmImport = useCallback'), src.indexOf('const cancelImport = useCallback'));
        expect(confirm).toContain('importLocalHistory(');
        expect(src).toContain('onClick={confirmImport}');
        expect(src.split('importLocalHistory(').length - 1).toBe(1);
    });
    it('records the outstanding request before sending it', () => {
        const send = src.slice(src.indexOf('const sendRequest = useCallback'), src.indexOf('// Handle incoming history delivery'));
        expect(send.indexOf('outstandingRef.current = { capabilityTs')).toBeGreaterThan(-1);
        expect(send.indexOf('outstandingRef.current = { capabilityTs')).toBeLessThan(send.indexOf('/devices/history-request'));
    });
    it('the approver echoes the signed request timestamp', () => {
        const modal = readFileSync(join(__dirname, '..', 'components', 'HistoryRequestModal.tsx'), 'utf8');
        expect(modal).toMatch(/wrapHistoryTransferKey\(\s*transferKeyB64, bundle, user\.user_id, deviceId,[\s\S]{0,200}request\.capability_ts,/);
    });
});
