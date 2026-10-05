import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';

/**
 * The CLIENT half of the one-time-prekey reuse fix.
 *
 * The server half is landed and stays the enforcement point: the spend
 * tombstone left by `CleanupService.sweepClaimedPrekeys`, plus `uploadBundle`'s
 * spent-id filter. This file covers the two things that half CANNOT cover, and
 * the guard that keeps closing them from becoming a worse bug.
 *
 *   1. LEGACY ORPHANS. Rows the OLD, hard-DELETING sweep already destroyed in
 *      production have no tombstone and never will — the server cannot
 *      reconstruct a ledger it destroyed, so it cannot recognise those ids as
 *      spent. Only the client can stop offering them, because only the client
 *      knows it still holds the private. This is the ALICE/BOB sequence below
 *      and it is the reason the fix exists at all.
 *
 *   2. UNBOUNDED LOCAL GROWTH. `e2ee-engine.ts` drops `otp_priv_<id>` in
 *      exactly one place — on a SUCCESSFUL decrypt — so a prekey that was
 *      claimed but never sent to keeps its private forever.
 *
 *   3. THE DATA-LOSS GUARD, which is the whole reason the contract has TWO
 *      lists. "Not unclaimed" does NOT mean "safe to forget": a recent claimer
 *      may not have SENT yet, and an envelope encrypted to that prekey can
 *      still be sitting unacked on the server for the retention window.
 *      Deleting the private there makes that message permanently undecryptable
 *      — silent, unrecoverable, and strictly worse than the reuse bug. Only the
 *      server's `retired_prekey_ids` (derived from its own envelope-retention
 *      window) may drive a delete.
 *
 * Only SecureStore is mocked (it imports `electron`). The store, the id
 * arithmetic and the carry-forward logic are the real implementations — the
 * same approach as `forwardSecrecy.test.ts`.
 */

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

const { generateRotationBundle, lowestHeldOtpId } = await import('../../electron/signal-identity');

function x25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
    const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
    return {
        privHex: Buffer.from(privJwk.d, 'base64url').toString('hex'),
        pubB64: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
    };
}

function ed25519Pair() {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    return { privHex: Buffer.from(priv).toString('hex'), pubB64: Buffer.from(pub).toString('base64') };
}

/** Put a one-time prekey in the store as if it had been minted by a past top-up. */
function installOtp(id: number) {
    const otp = x25519Pair();
    store.set(`otp_priv_${id}`, otp.privHex);
    store.set(`otp_pub_${id}`, otp.pubB64);
    return otp;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Stamp a mint batch as having been created `ageDays` ago.
 *
 * Retirement requires BOTH the server naming the id AND our own mint record
 * making that claim possible, so most tests here have to say how old the batch
 * is. `ancient` = comfortably past the retention window (retirable); `fresh` =
 * minted minutes ago (must never be retired, whatever the server says).
 */
function stampBatch(startId: number, ageDays: number) {
    store.set(`otp_mint_${startId}`, String(Date.now() - ageDays * DAY));
}
const ancient = (startId: number) => stampBatch(startId, 400);
const fresh = (startId: number) => stampBatch(startId, 0);

/** Ids the bundle actually offers to the server. */
const offered = (b: { one_time_prekeys: { prekey_id: number }[] }) =>
    b.one_time_prekeys.map(p => p.prekey_id);

/** Ids the bundle CARRIED FORWARD — i.e. excluding this round's freshly minted 100. */
const carried = (b: { one_time_prekeys: { prekey_id: number }[] }, maxBefore: number) =>
    offered(b).filter(id => id <= maxBefore);

const holdsPrivate = (id: number) => store.has(`otp_priv_${id}`);

beforeEach(() => {
    store.clear();
    const identity = ed25519Pair();
    store.set('identity_priv', identity.privHex);
    store.set('identity_pub', identity.pubB64);
    store.set('registration_id', '1234');
    // An active signed prekey, so the OTP-only top-up path can reuse it without
    // rotating. rotateSpk is orthogonal to everything under test here.
    const spk = x25519Pair();
    store.set('signed_prekey_priv_1', spk.privHex);
    store.set('signed_prekey_pub_1', spk.pubB64);
    store.set('signed_prekey_sig_1', 'sig');
    store.set('signed_prekey_active_id', '1');
});

describe('prekey reuse — the legacy-orphan sequence the tombstone cannot cover', () => {
    /**
     * ALICE claims id 77 -> never sends -> the ROW IS GONE (the old sweep's
     * hard DELETE; this is precisely the case a tombstone cannot cover, since
     * the ledger entry no longer exists) -> the client tops up.
     *
     * Pre-fix, the carry-forward loop gated only on "do I still hold a private",
     * so it re-offered 77 and BOB was served the identical public key. One
     * prekey, two senders — the forward-secrecy invariant broken.
     *
     * Post-fix, 77 is in NEITHER list (no row => not unclaimed, and not
     * retired), so it lands in the conservative middle: the private is KEPT,
     * the id is never re-offered.
     */
    it('does NOT re-offer an id the server has no row for (claimed, then swept under the legacy DELETE)', async () => {
        store.set('otp_max_id', '100');
        for (const id of [76, 77, 78]) installOtp(id);

        // The server's view AFTER the legacy sweep destroyed 77's row: 76 and 78
        // are still unclaimed, and 77 simply does not exist anywhere.
        const bundle = await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [76, 78],
            retiredPrekeyIds: [],
        });

        expect(offered(bundle)).not.toContain(77);
        expect(carried(bundle, 100).sort((a, b) => a - b)).toEqual([76, 78]);

        // ...and the private is KEPT, not deleted. ALICE claimed it and may
        // still send; dropping it here would be the data-loss bug.
        expect(holdsPrivate(77)).toBe(true);
    });

    it('re-offers it under the PRE-FIX behaviour — the regression this test exists to catch', async () => {
        store.set('otp_max_id', '100');
        for (const id of [76, 77, 78]) installOtp(id);

        // Omitting the lists IS the pre-fix behaviour (and the fail-safe path
        // for an older server): carry everything we hold a private for. 77 comes
        // back, which is exactly the two-senders bug. Pinning it here means the
        // fail-safe fallback is a deliberate, tested choice rather than a hole.
        const bundle = await generateRotationBundle({ rotateSpk: false });

        expect(offered(bundle)).toContain(77);
    });
});

describe('the data-loss guard — a RECENT claim must never be retired', () => {
    /**
     * This is the case that makes the two-list design non-negotiable. If the
     * client deleted a private merely because the id was absent from
     * `unclaimed_prekey_ids`, a claimer who has not SENT yet — or whose
     * envelope is still sitting unacked on the server — would have their
     * message rendered permanently undecryptable.
     */
    it('keeps the private for an id that is claimed-but-recent (absent from BOTH lists)', async () => {
        store.set('otp_max_id', '100');
        installOtp(50);
        installOtp(51);

        // 51 was claimed an hour ago: not unclaimed, and the server has NOT
        // retired it because its envelope may still be in flight.
        const bundle = await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [50],
            retiredPrekeyIds: [],
        });

        expect(holdsPrivate(51)).toBe(true);   // the message is still decryptable
        expect(offered(bundle)).not.toContain(51); // but we stop advertising it
    });

    it('deletes the private ONLY for ids the server has explicitly retired', async () => {
        store.set('otp_max_id', '100');
        for (const id of [10, 11, 12]) installOtp(id);
        ancient(1);

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [12],
            retiredPrekeyIds: [10],
        });

        // 10: retired -> both halves gone.
        expect(holdsPrivate(10)).toBe(false);
        expect(store.has('otp_pub_10')).toBe(false);
        // 11: claimed but recent -> kept (this is the guard above).
        expect(holdsPrivate(11)).toBe(true);
        // 12: still unclaimed -> kept and carried.
        expect(holdsPrivate(12)).toBe(true);
    });

    it('never carries a retired id forward', async () => {
        store.set('otp_max_id', '100');
        installOtp(20);
        ancient(1);
        const bundle = await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [20],
        });
        expect(offered(bundle)).not.toContain(20);
        expect(holdsPrivate(20)).toBe(false);
    });

    it('resolves a CONTRADICTORY server (an id in BOTH lists) by NOT deleting', async () => {
        store.set('otp_max_id', '100');
        installOtp(21);
        ancient(1);

        // The server cannot coherently say a prekey is both unclaimed and
        // claimed-long-ago. Every ambiguity in this function resolves toward
        // "keep the private", because the harms are asymmetric: a retained key
        // costs ~110 bytes, a wrongly-deleted one costs a message that nothing
        // anywhere can ever decrypt again.
        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [21],
            retiredPrekeyIds: [21],
        });

        expect(holdsPrivate(21)).toBe(true);
    });
});

/**
 * The mint-time floor: the client refusing to destroy its own key material on a
 * request it can prove is impossible.
 *
 * `retired_prekey_ids` is an instruction from the server to DELETE key
 * material, and this product's threat model is that the server is not trusted.
 * Without this check, a compromised server could name every id and permanently
 * destroy this device's ability to decrypt envelopes it has already been sent —
 * a step up from "can delay or drop" (always available to the server) to "can
 * permanently destroy". The check needs no trust in anyone: a claim cannot
 * precede the mint, so a prekey minted 3 days ago cannot have been claimed 30
 * days ago.
 */
describe('mint-time floor — a hostile retire list cannot destroy recent key material', () => {
    it('REFUSES to retire a freshly-minted id even when the server names it', async () => {
        store.set('otp_max_id', '100');
        installOtp(80);
        fresh(1); // minted moments ago — a 30-day-old claim is impossible

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [80],
        });

        expect(holdsPrivate(80)).toBe(true);
    });

    it('still retires a genuinely old id — the guard must not block the feature', async () => {
        store.set('otp_max_id', '100');
        installOtp(81);
        ancient(1);

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [81],
        });

        expect(holdsPrivate(81)).toBe(false);
    });

    it('refuses when there is NO stamp at all — every device in the existing fleet', async () => {
        store.set('otp_max_id', '100');
        installOtp(82); // no stampBatch call: pre-upgrade store

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [82],
        });

        // Chosen deliberately over "retire blindly": the cost is a store that
        // stays slightly larger until those ids age out, versus messages that
        // vanish. Growth is already bounded by the carry gate, which stops
        // re-offering them.
        expect(holdsPrivate(82)).toBe(true);
    });

    it('resolves per BATCH — an old batch retires while a newer one does not', async () => {
        store.set('otp_max_id', '200');
        installOtp(50);   // batch starting at 1
        installOtp(150);  // batch starting at 101
        ancient(1);
        fresh(101);

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [50, 150],
        });

        expect(holdsPrivate(50)).toBe(false);
        expect(holdsPrivate(150)).toBe(true);
    });

    it('stamps each newly minted batch, so a freshly minted id is never retirable', async () => {
        store.set('otp_max_id', '100');
        ancient(1);

        // First top-up mints 101..200 and must stamp that batch NOW.
        await generateRotationBundle({ rotateSpk: false, unclaimedPrekeyIds: [], retiredPrekeyIds: [] });
        expect(store.has('otp_mint_101')).toBe(true);

        // A server that immediately tries to retire one of them is refused.
        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [150],
        });
        expect(holdsPrivate(150)).toBe(true);
    });

    it('a backwards clock refuses MORE, never less (the safe direction)', async () => {
        store.set('otp_max_id', '100');
        installOtp(83);
        stampBatch(1, -10); // stamp in the future: now - mintedAt is negative

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [83],
        });

        expect(holdsPrivate(83)).toBe(true);
    });

    it('prunes mint stamps whose batch is fully consumed, so the table stays bounded', async () => {
        store.set('otp_max_id', '200');
        installOtp(50);
        ancient(1);
        ancient(101); // batch 101..200 holds nothing

        await generateRotationBundle({ rotateSpk: false, unclaimedPrekeyIds: [50], retiredPrekeyIds: [] });

        // 101's batch was empty and is dropped; 1's still covers id 50 and stays.
        // The newest stamp (this call's own mint) is never dropped.
        expect(store.has('otp_mint_101')).toBe(false);
        expect(store.has('otp_mint_1')).toBe(true);
    });

    it('never prunes a stamp whose batch still holds an id — that would age survivors wrongly', async () => {
        store.set('otp_max_id', '200');
        installOtp(150);
        ancient(1);
        fresh(101);

        await generateRotationBundle({ rotateSpk: false, unclaimedPrekeyIds: [150], retiredPrekeyIds: [] });

        // Dropping otp_mint_101 would make otpMintTime(150) fall back to the
        // ANCIENT batch-1 stamp, making a fresh key look retirable. That is the
        // unsafe direction, so the stamp must survive.
        expect(store.has('otp_mint_101')).toBe(true);
    });
});

describe('fail-safe — a missing or malformed contract never deletes a private', () => {
    const cases: Array<[string, any]> = [
        ['both fields absent (older server, or the status call failed)', { rotateSpk: false }],
        ['fields explicitly undefined', { rotateSpk: false, unclaimedPrekeyIds: undefined, retiredPrekeyIds: undefined }],
        ['fields are not arrays', { rotateSpk: false, unclaimedPrekeyIds: 'nope', retiredPrekeyIds: 7 }],
        ['fields are null', { rotateSpk: false, unclaimedPrekeyIds: null, retiredPrekeyIds: null }],
    ];

    for (const [name, opts] of cases) {
        it(`carries what it holds and deletes nothing — ${name}`, async () => {
            store.set('otp_max_id', '100');
            for (const id of [30, 31]) installOtp(id);

            const bundle = await generateRotationBundle(opts);

            expect(holdsPrivate(30)).toBe(true);
            expect(holdsPrivate(31)).toBe(true);
            expect(carried(bundle, 100).sort((a, b) => a - b)).toEqual([30, 31]);
        });
    }

    it('distinguishes an EMPTY list from an ABSENT one', async () => {
        store.set('otp_max_id', '100');
        installOtp(40);

        // Empty = the server answered and the pool is genuinely drained. Nothing
        // is carried — but nothing is deleted either, because retirement is a
        // separate decision.
        const bundle = await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [],
        });

        expect(carried(bundle, 100)).toEqual([]);
        expect(holdsPrivate(40)).toBe(true);
    });

    it('drops junk elements without disabling the gate', async () => {
        store.set('otp_max_id', '100');
        for (const id of [60, 61]) installOtp(id);

        const bundle = await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [60, '61' as any, 1.5 as any, -3 as any, null as any],
            retiredPrekeyIds: [],
        });

        // '61' is a string, so it names no key we hold and is dropped; 60
        // survives. The gate stays ON — a single odd element must not silently
        // revert to "carry everything".
        expect(carried(bundle, 100)).toEqual([60]);
        expect(holdsPrivate(61)).toBe(true);
    });
});

describe('freshly minted prekeys are unaffected by the gate', () => {
    it('always offers the 100 new ids, which the server has never heard of', async () => {
        store.set('otp_max_id', '100');
        installOtp(5);

        const bundle = await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [],
            retiredPrekeyIds: [],
        });

        // 101..200 are minted in THIS call. Gating them on a status response
        // fetched BEFORE they existed would publish an empty pool forever.
        const fresh = offered(bundle).filter(id => id > 100);
        expect(fresh).toHaveLength(100);
        expect(store.get('otp_max_id')).toBe('200');
    });
});

describe('lowestHeldOtpId — the retired-page cursor', () => {
    it('returns null when no prekey privates are held', () => {
        expect(lowestHeldOtpId()).toBeNull();
    });

    it('returns the lowest held id, ignoring unrelated keys', () => {
        installOtp(900);
        installOtp(12);
        installOtp(305);
        expect(lowestHeldOtpId()).toBe(12);
    });

    it('rises as retired ids are deleted, which is what makes the server page SLIDE', async () => {
        store.set('otp_max_id', '100');
        for (const id of [12, 13, 14]) installOtp(id);
        ancient(1);
        expect(lowestHeldOtpId()).toBe(12);

        await generateRotationBundle({
            rotateSpk: false,
            unclaimedPrekeyIds: [14],
            retiredPrekeyIds: [12, 13],
        });

        // Without this, a device with more retired tombstones than the server's
        // page cap would be handed the same lowest page forever and never learn
        // about the rest.
        expect(lowestHeldOtpId()).toBe(14);
    });
});
