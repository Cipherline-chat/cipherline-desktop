import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The key-bundle paths against the REAL SecureStore (real AES-GCM values, real
 * envelope file, real asynchronous writer) — only `electron` is mocked.
 *
 * What the owner hit: `crypto:ensure-identity-bundle` held the Electron main
 * thread ~2.5 s, three times in 25 s, on first focus. Two compounding causes,
 * both pinned here:
 *
 *   1. COST SCALED WITH HISTORY. The bundle builder walked every id from 1 to
 *      `otp_max_id` and decrypted the private AND (twice) the public of every
 *      held prekey. `otp_max_id` only grows and, while top-ups were failing,
 *      every 15-minute check added 100 more held prekeys. The builder now
 *      reads held ids from the store's index and touches at most the 200 it
 *      publishes.
 *   2. THE BUNDLE COULD NEVER BE ACCEPTED. It carried EVERY held prekey; past
 *      200 the server's @ArrayMaxSize(200) rejected it, and the renderer
 *      retried — rebuilding it — three times.
 *
 * Plus the durability contract the asynchronous vault writer must keep: a
 * private key is on disk BEFORE its public half is handed out for upload.
 */

let tmpDir = '';
vi.mock('electron', () => ({
    app: { getPath: () => tmpDir },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`WRAPPED:${s}`, 'utf8'),
        decryptString: (buf: Buffer) => buf.toString('utf8').slice('WRAPPED:'.length),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));

type StorageMod = typeof import('../../electron/storage');
type SigMod = typeof import('../../electron/signal-identity');

async function freshModules(): Promise<{ store: StorageMod['secureStore']; sig: SigMod }> {
    vi.resetModules();
    const { secureStore } = await import('../../electron/storage');
    await secureStore.initialize();
    const sig = await import('../../electron/signal-identity');
    return { store: secureStore, sig };
}

const DAY = 24 * 60 * 60 * 1000;
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
const diskKeys = () => Object.keys(JSON.parse(fs.readFileSync(path.join(tmpDir, 'secure-store.json'), 'utf8')));

/** A long-lived identity: `held` prekey privates spread over 1..maxId. */
function seedLongLivedVault(store: StorageMod['secureStore'], held: number, maxId: number): number[] {
    const id = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    const spk = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    const ids = new Set<number>();
    for (let i = maxId; ids.size < Math.min(held, 300); i--) ids.add(i);
    while (ids.size < held) ids.add(1 + Math.floor(Math.random() * maxId));
    store.batch(() => {
        store.set('identity_priv', Buffer.from(id.d, 'base64url').toString('hex'));
        store.set('identity_pub', Buffer.from(id.x, 'base64url').toString('base64'));
        store.set('registration_id', '4242');
        store.set('signed_prekey_priv_1', Buffer.from(spk.d, 'base64url').toString('hex'));
        store.set('signed_prekey_pub_1', Buffer.from(spk.x, 'base64url').toString('base64'));
        store.set('signed_prekey_sig_1', b64(64));
        store.set('signed_prekey_active_id', '1');
        for (const i of ids) { store.set(`otp_priv_${i}`, hex(32)); store.set(`otp_pub_${i}`, b64(32)); }
        for (let s = 1; s <= maxId; s += 100) store.set(`otp_mint_${s}`, String(Date.now() - 60 * DAY));
        store.set('otp_max_id', String(maxId));
        // Bulk that every whole-vault write drags along.
        store.set('__eph_replay__', JSON.stringify(Array.from({ length: 20_000 }, () => b64(32))));
    });
    return [...ids].sort((a, b) => a - b);
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-keybundle-vault-'));
});
afterEach(async () => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureSignalIdentity on a long-lived vault (the first-focus freeze)', () => {
    const HELD = 20_000;
    const MAX_ID = 40_000;

    it('PERF REGRESSION: work is bounded by what is published, not by the prekey history — and nothing is written', async () => {
        const { store, sig } = await freshModules();
        seedLongLivedVault(store, HELD, MAX_ID);
        await store.whenDurable();

        const getSpy = vi.spyOn(store, 'get');
        const writesBefore = store.writeCount;
        // (Seeding the 20k-prekey vault above is the slow part of this test,
        // not the call under test.)
        const t0 = performance.now();
        const { isNew, bundle } = await sig.ensureSignalIdentity();
        const ms = performance.now() - t0;

        expect(isNew).toBe(false);
        // Bounded by the published set: <= 200 prekeys + a handful of identity
        // reads. The old builder made ~3 x HELD (60,000) decrypting get()s here.
        expect(getSpy.mock.calls.length).toBeLessThan(260);
        // Generous wall-clock bound (the old code measured ~1,000-1,400 ms for
        // this vault on the dev box; the new path is a few ms). Catches a
        // regression to O(history) without flaking on a loaded machine.
        expect(ms).toBeLessThan(400);
        // A read-only rebuild must not cost a whole-vault write.
        await store.whenDurable();
        expect(store.writeCount).toBe(writesBefore);
        expect(store.hasPendingWrites()).toBe(false);
        expect(bundle.one_time_prekeys.length).toBe(200);
    }, 60_000);

    it('returns the NEWEST held prekeys, at most the server\'s 200, never one above otp_max_id', async () => {
        const { store, sig } = await freshModules();
        const held = seedLongLivedVault(store, 1_000, 5_000);
        store.set('otp_priv_999999', hex(32));      // stray id above otp_max_id
        const { bundle } = await sig.ensureSignalIdentity();
        const got = bundle.one_time_prekeys.map(p => p.prekey_id);
        expect(got).toEqual(held.slice(-200).reverse());
        expect(got).not.toContain(999999);
        // And each one is the stored public half for that id.
        for (const p of bundle.one_time_prekeys.slice(0, 5)) expect(p.prekey_pub_b64).toBe(store.get(`otp_pub_${p.prekey_id}`));
    });

    it('applies the server\'s unclaimed gate: only ids it still lists are re-offered (may be none)', async () => {
        const { store, sig } = await freshModules();
        const held = seedLongLivedVault(store, 500, 2_000);
        const unclaimed = [held[3], held[10], 1_999_999 /* not held */];
        const gated = await sig.ensureSignalIdentity({ unclaimedPrekeyIds: unclaimed });
        expect(gated.bundle.one_time_prekeys.map(p => p.prekey_id).sort((a, b) => a - b)).toEqual([held[3], held[10]]);

        const empty = await sig.ensureSignalIdentity({ unclaimedPrekeyIds: [] });
        expect(empty.bundle.one_time_prekeys).toEqual([]);

        // Malformed gate from the IPC boundary degrades to NO gate, never wider.
        const junk = await sig.ensureSignalIdentity({ unclaimedPrekeyIds: 'everything' as unknown });
        expect(junk.bundle.one_time_prekeys.length).toBe(200);
    });

    it('derives and stores a missing public half only for prekeys it actually publishes', async () => {
        const { store, sig } = await freshModules();
        const held = seedLongLivedVault(store, 400, 1_000);
        const newest = held[held.length - 1];
        const oldest = held[0];
        const { privateKey } = crypto.generateKeyPairSync('x25519');
        const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
        store.set(`otp_priv_${newest}`, Buffer.from(jwk.d, 'base64url').toString('hex'));
        store.delete(`otp_pub_${newest}`);
        store.delete(`otp_pub_${oldest}`);
        const { bundle } = await sig.ensureSignalIdentity();
        expect(bundle.one_time_prekeys[0]).toEqual({ prekey_id: newest, prekey_pub_b64: Buffer.from(jwk.x, 'base64url').toString('base64') });
        expect(store.get(`otp_pub_${newest}`)).toBe(Buffer.from(jwk.x, 'base64url').toString('base64'));
        expect(store.get(`otp_pub_${oldest}`)).toBeNull();          // not published, not touched
    });
});

describe('durability before publication (the asynchronous vault writer)', () => {
    it('a NEW identity is entirely on disk by the time ensureSignalIdentity resolves', async () => {
        const { store, sig } = await freshModules();
        const { isNew, bundle } = await sig.ensureSignalIdentity();
        expect(isNew).toBe(true);
        expect(bundle.one_time_prekeys).toHaveLength(100);
        // Nothing awaited after the call: whatever the renderer could upload
        // now, the private half is already in the file.
        const keys = diskKeys();
        for (const k of ['identity_priv', 'identity_pub', 'registration_id', 'signed_prekey_priv_1', 'signed_prekey_active_id', 'otp_max_id']) {
            expect(keys).toContain(k);
        }
        for (const p of bundle.one_time_prekeys) expect(keys).toContain(`otp_priv_${p.prekey_id}`);
        expect(store.hasPendingWrites()).toBe(false);
        // ...and a fresh process reads back the same identity.
        vi.resetModules();
        const again = await import('../../electron/storage');
        await again.secureStore.initialize();
        expect(again.secureStore.get('identity_pub')).toBe(bundle.identity_key_pub_b64);
    });

    it('if the vault write FAILS, ensureSignalIdentity rejects — no bundle exists to upload', async () => {
        const { store, sig } = await freshModules();
        const openSpy = vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('ENOSPC: simulated full disk'), { code: 'ENOSPC' }));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(sig.ensureSignalIdentity()).rejects.toThrow(/ENOSPC/);
        openSpy.mockRestore();
        expect(store.hasPendingWrites()).toBe(true);     // still owed; retried, not dropped
    });

    it('a top-up\'s new privates are on disk before generateRotationBundle resolves; a failed write rejects it', async () => {
        const { sig } = await freshModules();
        await sig.ensureSignalIdentity();
        const bundle = await sig.generateRotationBundle({ rotateSpk: true });
        const keys = diskKeys();
        for (const p of bundle.one_time_prekeys.filter(p => p.prekey_id > 100)) expect(keys).toContain(`otp_priv_${p.prekey_id}`);
        expect(keys).toContain(`signed_prekey_priv_${bundle.signed_prekey.id}`);

        const openSpy = vi.spyOn(fs.promises, 'open').mockRejectedValue(new Error('EIO: simulated'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(sig.generateRotationBundle({ rotateSpk: false })).rejects.toThrow(/EIO/);
        openSpy.mockRestore();
    });

    it('two concurrent ensure calls on an empty vault mint ONE identity', async () => {
        const { store, sig } = await freshModules();
        const [a, b] = await Promise.all([sig.ensureSignalIdentity(), sig.ensureSignalIdentity()]);
        expect([a.isNew, b.isNew].sort()).toEqual([false, true]);
        expect(a.bundle.identity_key_pub_b64).toBe(b.bundle.identity_key_pub_b64);
        expect(store.get('identity_pub')).toBe(a.bundle.identity_key_pub_b64);
    });
});

describe('rotation on a long-lived vault', () => {
    it('a top-up with the server\'s full 500-id retired page reads each mint stamp ONCE (was: every stamp per retired id)', async () => {
        const { store, sig } = await freshModules();
        const held = seedLongLivedVault(store, 5_000, 20_000);
        const stampsBefore = store.keysWithPrefix('otp_mint_').length;
        const getSpy = vi.spyOn(store, 'get');
        const t0 = performance.now();
        await sig.generateRotationBundle({ rotateSpk: false, unclaimedPrekeyIds: held.slice(-50), retiredPrekeyIds: held.slice(0, 500) });
        const ms = performance.now() - t0;
        const stampReads = getSpy.mock.calls.filter(([k]) => String(k).startsWith('otp_mint_')).length;
        // Old shape: 500 retired ids x every stamp (~200) = ~100,000 decrypts.
        // Now: each stamp (plus this batch's new one) once.
        expect(stampReads).toBeLessThanOrEqual(stampsBefore + 1);
        expect(ms).toBeLessThan(1_500);
        // The page really was retired (stamps are 60 days old).
        for (const id of held.slice(0, 500)) expect(store.get(`otp_priv_${id}`)).toBeNull();
    }, 60_000);
});

describe('status-aware rotation (stops the unbounded growth)', () => {
    async function identity() {
        const m = await freshModules();
        await m.sig.ensureSignalIdentity();
        return m;
    }

    it('pool healthy and signed prekey not due → null: nothing minted, nothing to upload', async () => {
        const { store, sig } = await identity();
        const maxBefore = store.get('otp_max_id');
        const held = store.keysWithPrefix('otp_priv_').length;
        const out = await sig.generateRotationBundle({ rotateSpk: true, otpPoolLow: false, unclaimedPrekeyIds: [1, 2, 3], retiredPrekeyIds: [] });
        expect(out).toBeNull();
        expect(store.get('otp_max_id')).toBe(maxBefore);
        expect(store.keysWithPrefix('otp_priv_').length).toBe(held);
        expect(store.get('signed_prekey_active_id')).toBe('1');
    });

    it('pool low → mints 100 and tops up; the signed prekey stays put when its own clock says it is young', async () => {
        const { store, sig } = await identity();
        const out = await sig.generateRotationBundle({ rotateSpk: true, otpPoolLow: true, unclaimedPrekeyIds: [], retiredPrekeyIds: [] });
        expect(out).not.toBeNull();
        expect(out!.one_time_prekeys.map(p => p.prekey_id)).toEqual(Array.from({ length: 100 }, (_, i) => 101 + i));
        expect(out!.signed_prekey.id).toBe(1);
        expect(store.get('otp_max_id')).toBe('200');
    });

    it('a signed prekey with NO creation stamp (the existing fleet) is stamped now and NOT rotated, even when the server says 25+ days', async () => {
        const { store, sig } = await identity();
        store.delete('signed_prekey_created_1');
        const before = Date.now();
        const out = await sig.generateRotationBundle({ rotateSpk: true, otpPoolLow: false });
        expect(out).toBeNull();
        expect(store.get('signed_prekey_active_id')).toBe('1');
        expect(Number(store.get('signed_prekey_created_1'))).toBeGreaterThanOrEqual(before);
    });

    it('rotates once the LOCAL stamp is 25 days old — carrying the live pool, minting nothing', async () => {
        const { store, sig } = await identity();
        store.set('signed_prekey_created_1', String(Date.now() - 26 * DAY));
        const out = await sig.generateRotationBundle({ rotateSpk: true, otpPoolLow: false, unclaimedPrekeyIds: [5, 6, 7], retiredPrekeyIds: [] });
        expect(out!.signed_prekey.id).toBe(2);
        expect(out!.one_time_prekeys.map(p => p.prekey_id).sort((a, b) => a - b)).toEqual([5, 6, 7]);
        expect(store.get('otp_max_id')).toBe('100');
        expect(Number(store.get('signed_prekey_created_2'))).toBeGreaterThan(Date.now() - DAY);
        expect(store.get('signed_prekey_superseded_1')).not.toBeNull();
        // ...and the next check does NOT rotate again (the churn this prevents).
        expect(await sig.generateRotationBundle({ rotateSpk: true, otpPoolLow: false })).toBeNull();
    });

    it('an SPK-only rotation with nothing live to carry still mints (an upload needs >= 1 prekey)', async () => {
        const { store, sig } = await identity();
        store.set('signed_prekey_created_1', String(Date.now() - 30 * DAY));
        const out = await sig.generateRotationBundle({ rotateSpk: true, otpPoolLow: false, unclaimedPrekeyIds: [], retiredPrekeyIds: [] });
        expect(out!.signed_prekey.id).toBe(2);
        expect(out!.one_time_prekeys).toHaveLength(100);
        expect(store.get('otp_mint_101')).not.toBeNull();
    });

    it('a non-boolean otpPoolLow from the IPC boundary means the LEGACY behaviour (always mint), never "skip"', async () => {
        const { sig } = await identity();
        const out = await sig.generateRotationBundle({ rotateSpk: false, otpPoolLow: 'no' as unknown as boolean });
        expect(out!.one_time_prekeys.filter(p => p.prekey_id > 100)).toHaveLength(100);
    });
});
