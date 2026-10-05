/**
 * The ghost-device attack, end to end across both clients' decision code.
 * docs/ghost-device.md.
 *
 * Cast:
 *   Bob   — devices B1 (this install) and B2 (his phone).
 *   Alice — verified Bob with the contact code before the attack.
 *   The server — adds a device G it controls to Bob's account and lists it.
 *
 * Every scenario begins by proving its premise, so a detection assertion can
 * never pass because the scenario was set up wrong:
 *   • the attack premise: with G in both views, the two contact codes MATCH,
 *     so the code comparison alone is defeated;
 *   • the detection: Bob's install withholds "your code" and raises an alarm,
 *     and Alice's badge leaves green.
 *
 * The same scenarios then cover the legitimate new device and migration.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        isAccountReady: (uid: string) => !!uid,
    },
}));

const ledger = await import('./ownDeviceLedger');
const published = await import('./publishedDeviceSets');
const { contactTrustDevices } = await import('./contactBadgeDevices');
const { deriveContactTrust, pinsToTrustDevices } = await import('./contactTrust');
const { markVerified, getKnownDevices, recordFirstSeen } = await import('./keyVerification');
const { computeContactCode, checkCode } = await import('./verificationCode');

const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));

const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B1 = { device_id: 'bob-laptop', pub: b64(1) };
const B2 = { device_id: 'bob-phone', pub: b64(2) };
const B3 = { device_id: 'bob-new-tablet', pub: b64(3) };
const G = { device_id: 'ghost', pub: b64(66) };
const BOB_SELF = { deviceId: B1.device_id, pub: B1.pub };

type Row = { device_id: string; pub: string };

/** What `GET /keys/identity_keys?user_id=<bob>` returns, to Bob and to Alice. */
const asIdentityKeys = (rows: Row[]) => rows.map(r => ({ device_id: r.device_id, identity_key_pub_b64: r.pub }));
/** Bob's rows as they appear inside Alice's `GET /conversations/:id/devices`. */
const asConversationRows = (uid: string, rows: Row[]) =>
    rows.map(r => ({ user_id: uid, device_id: r.device_id, identity_pub_b64: r.pub }));

/** Bob's install observes a complete own listing (the boot/reconnect fetch, or the modal). */
function bobSeesOwnListing(rows: Row[]) {
    const own = ledger.ownRowsFromDirectory(asIdentityKeys(rows), BOB, `/v1/keys/identity_keys?user_id=${BOB}`, BOB)!;
    ledger.observeOwnDevices(BOB, BOB_SELF, own.rows, own.complete);
}

/** What the modal does for "your code": judge the SAME rows it hashes. */
async function bobsCode(rows: Row[]) {
    bobSeesOwnListing(rows);
    const verdict = ledger.assessOwnDeviceSet(ledger.loadOwnLedger(BOB) ?? null, rows, BOB_SELF);
    return {
        verdict,
        shown: ledger.codeMayBeShown(verdict),
        code: await computeContactCode(BOB, rows.map(r => r.pub)),
    };
}

/** Alice's header shield for Bob, after her client made a normal conversation fetch. */
function alicesBadge(rowsAliceIsServed: Row[]) {
    published.observePublished(asConversationRows(BOB, rowsAliceIsServed), null, '/v1/conversations/c1/devices', ALICE);
    return deriveContactTrust({ devices: contactTrustDevices(ALICE, BOB) }).level;
}

/** Before the attack: Bob's install has a ledger, Alice verified {B1, B2} with the code. */
async function establishVerifiedPair() {
    bobSeesOwnListing([B1, B2]);
    const bob = await bobsCode([B1, B2]);
    expect(bob.shown).toBe(true);
    const aliceExpects = await computeContactCode(BOB, [B1.pub, B2.pub]);
    expect(checkCode(aliceExpects, bob.code).result).toBe('match');
    for (const d of [B1, B2]) markVerified(ALICE, BOB, d.pub, d.device_id);
    expect(alicesBadge([B1, B2])).toBe('verified');
}

beforeEach(() => {
    mem.clear();
    published._reset();
    ledger._resetSession();
});

describe('attack: a server-injected ghost device shown in BOTH views', () => {
    it('premise: the two contact codes match, so the code comparison alone is defeated', async () => {
        await establishVerifiedPair();
        const bobView = [B1, B2, G];
        const aliceView = [B1, B2, G];
        const aliceExpects = await computeContactCode(BOB, aliceView.map(r => r.pub));
        const bobReadsOut = await computeContactCode(BOB, bobView.map(r => r.pub));
        expect(checkCode(aliceExpects, bobReadsOut).result).toBe('match');
    });

    it("detected on Bob's side: his code is withheld and the ghost is named for him", async () => {
        await establishVerifiedPair();
        const bob = await bobsCode([B1, B2, G]);
        expect(bob.shown).toBe(false);
        expect(bob.verdict.kind).toBe('unconfirmed');
        if (bob.verdict.kind === 'unconfirmed') {
            expect(bob.verdict.unconfirmed.map(d => d.device_id)).toEqual([G.device_id]);
        }
        const alerts = ledger.currentOwnAlerts(BOB, BOB_SELF);
        expect(alerts.alerts.map(a => `${a.device_id}:${a.kind}`)).toEqual([`${G.device_id}:new`]);
    });

    it('detected on Bob\'s side from a normal SEND too (partial own rows in /conversations/:id/devices)', async () => {
        await establishVerifiedPair();
        const own = ledger.ownRowsFromDirectory(
            asConversationRows(BOB, [B2, G]), null, '/v1/conversations/c1/devices?claim_otp=1', BOB,
        )!;
        ledger.observeOwnDevices(BOB, BOB_SELF, own.rows, own.complete);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).alerts.map(a => a.device_id)).toEqual([G.device_id]);
    });

    it("detected on Alice's side: her shield leaves green even though G never sends", async () => {
        await establishVerifiedPair();
        const level = alicesBadge([B1, B2, G]);
        expect(level).toBe('partially_verified');
        // The pins were never touched: this is a count, not a pin.
        expect(Object.keys(getKnownDevices(ALICE, BOB)).sort()).toEqual([B1.device_id, B2.device_id].sort());
        // Control: the pins-only derivation, which the badge used before this fix, stays green.
        expect(deriveContactTrust({ devices: pinsToTrustDevices(getKnownDevices(ALICE, BOB)) }).level).toBe('verified');
    });

    it('the own-key substitution variant: a different key under Bob\'s OWN device id is refused', async () => {
        await establishVerifiedPair();
        const swapped = [{ device_id: B1.device_id, pub: G.pub }, B2];
        // Premise: both views carrying the swap still produce matching codes.
        const a = await computeContactCode(BOB, swapped.map(r => r.pub));
        const b = await computeContactCode(BOB, swapped.map(r => r.pub));
        expect(checkCode(a, b).result).toBe('match');
        const bob = await bobsCode(swapped);
        expect(bob.verdict.kind).toBe('self_key_mismatch');
        expect(bob.shown).toBe(false);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).selfKeyMismatch).toBe(true);
    });
});

describe('attack: split view (ghost shown only to Alice)', () => {
    it('the codes no longer match, and Alice\'s shield is not green', async () => {
        await establishVerifiedPair();
        const bob = await bobsCode([B1, B2]);
        expect(bob.shown).toBe(true);
        const aliceExpects = await computeContactCode(BOB, [B1, B2, G].map(r => r.pub));
        expect(checkCode(aliceExpects, bob.code).result).toBe('mismatch');
        expect(alicesBadge([B1, B2, G])).toBe('partially_verified');
    });
});

describe('legitimate new device', () => {
    it('Bob adds a tablet: flagged once, one confirmation, then everything matches and Alice can get back to green', async () => {
        await establishVerifiedPair();
        const rows = [B1, B2, B3];

        const before = await bobsCode(rows);
        expect(before.shown).toBe(false);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).alerts.map(a => a.device_id)).toEqual([B3.device_id]);

        ledger.confirmOwnDevice(BOB, B3.device_id, B3.pub);
        const after = await bobsCode(rows);
        expect(after.shown).toBe(true);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).alerts).toEqual([]);

        // Alice: amber until she re-verifies, then green again.
        expect(alicesBadge(rows)).toBe('partially_verified');
        const aliceExpects = await computeContactCode(BOB, rows.map(r => r.pub));
        expect(checkCode(aliceExpects, after.code).result).toBe('match');
        for (const d of rows) markVerified(ALICE, BOB, d.pub, d.device_id);
        expect(alicesBadge(rows)).toBe('verified');
    });

    it('a real device and a ghost added together are TWO separate alarms, not one', async () => {
        await establishVerifiedPair();
        bobSeesOwnListing([B1, B2, B3, G]);
        const ids = ledger.currentOwnAlerts(BOB, BOB_SELF).alerts.map(a => a.device_id).sort();
        expect(ids).toEqual([B3.device_id, G.device_id].sort());
        ledger.confirmOwnDevice(BOB, B3.device_id, B3.pub);
        const bob = await bobsCode([B1, B2, B3, G]);
        expect(bob.shown).toBe(false);
    });
});

describe('migration', () => {
    it('an existing install with no ledger baselines silently, offers a one-time review, and alarms on the NEXT new device', async () => {
        bobSeesOwnListing([B1, B2]);
        const first = ledger.currentOwnAlerts(BOB, BOB_SELF);
        expect(first.alerts).toEqual([]);
        expect(first.unreviewedBaseline).toEqual([B2.device_id]);
        expect((await bobsCode([B1, B2])).shown).toBe(true);

        ledger.markOwnDevicesReviewed(BOB);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).unreviewedBaseline).toEqual([]);

        bobSeesOwnListing([B1, B2, G]);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).alerts.map(a => a.device_id)).toEqual([G.device_id]);
    });

    it('a single-device account has nothing to review', () => {
        bobSeesOwnListing([B1]);
        expect(ledger.currentOwnAlerts(BOB, BOB_SELF).unreviewedBaseline).toEqual([]);
    });

    it('an existing verified contact stays green when the published set matches the pins', () => {
        for (const d of [B1, B2]) markVerified(ALICE, BOB, d.pub, d.device_id);
        expect(alicesBadge([B1, B2])).toBe('verified');
    });

    it('a legacy pub-bucket pin (pre-`sd`) is matched by key, not reported as an extra device', () => {
        // Pinned without a device id, as pre-Phase-5 senders were.
        markVerified(ALICE, BOB, B1.pub);
        expect(alicesBadge([B1])).toBe('verified');
    });

    it('an existing verified contact whose server publishes a never-pinned device drops to partly verified, not red', () => {
        for (const d of [B1, B2]) markVerified(ALICE, BOB, d.pub, d.device_id);
        recordFirstSeen(ALICE, BOB, B1.pub, B1.device_id);
        expect(alicesBadge([B1, B2, B3])).toBe('partially_verified');
    });

    it('a revoked device leaves the published set on the next complete listing (no stale amber)', () => {
        for (const d of [B1, B2]) markVerified(ALICE, BOB, d.pub, d.device_id);
        expect(alicesBadge([B1, B2, B3])).toBe('partially_verified');
        expect(alicesBadge([B1, B2])).toBe('verified');
    });
});
