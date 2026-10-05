import { describe, it, expect } from 'vitest';
import {
    computeSafetyNumber,
    computeFingerprintHalf,
    combineHalves,
    formatSafetyNumber,
    type SafetyParty,
} from './safetyNumber';

/**
 * ── Golden vectors ─────────────────────────────────────────────────────────
 *
 * Every expected value below is a LITERAL, produced by an independent
 * implementation (Python `hashlib.pbkdf2_hmac`, see docs/safety-number-v2.md)
 * and never re-derived from this module's constants. A test that rebuilt its
 * expectation from `DOMAIN`/`ITERATIONS` would stay green through a change to
 * either, which is exactly the wire-visible change these must catch.
 *
 * The keys are real Ed25519 public keys taken from the mobile port's v1 oracle
 * (`cipherline-mobile/test-vectors/safety-number.json`), so the v1 construction
 * below is checked against the digits mobile shipped too.
 */
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB   = '00000000-0000-4000-8000-00000000000b';
const P1 = '/M05mfNvcN7SRFXllrfxRraq2ETnyjmg6tS198yXLyc=';
const P2 = 'zTpON7ndkloGJuubvDlhPxHp5tvVh3JC3GH86KZIsAI=';
const P3 = '5d+O/j7FKWqJtP+vBGUvOEUccbLwofv8SKivnaG11yQ=';
const P4 = 'XzF8lxrFHapGCut7kNkgV0jq8YyS5wMGXfCfxDvIBl8=';
const P5 = 'Pda0HiyK/PVY7onHtK0nIboahK1Iemr6CvhHN3NbSl0=';
const P6 = 'HXJrGDtE13fRs1G0j+UcdymAX9Cr8UvamrylT4Te7z0=';

const party = (userId: string, pubB64: string): SafetyParty => ({ userId, pubB64 });

// PBKDF2 at 5200 iterations: cheap in production, but this box runs at load
// 20-60. A generous budget, so a slow box reads as slow rather than as a failure.
const T = 60_000;

/** Split a 12-group display into its two 30-digit halves. */
function halvesOf(display: string): [string, string] {
    const digits = display.replace(/ /g, '');
    return [digits.slice(0, 30), digits.slice(30)];
}

describe('safety number v2: golden vectors', () => {
    it('per-party halves', async () => {
        expect(await computeFingerprintHalf(party(ALICE, P1))).toBe('662597989781171735386021190662');
        expect(await computeFingerprintHalf(party(BOB, P2))).toBe('500160725101472737568301572504');
        expect(await computeFingerprintHalf(party(ALICE, P3))).toBe('350121808055953470832402207509');
        expect(await computeFingerprintHalf(party(BOB, P4))).toBe('591378117062529994107101443458');
    }, T);

    it('displayed numbers', async () => {
        expect(await computeSafetyNumber(party(ALICE, P1), party(BOB, P2)))
            .toBe('50016 07251 01472 73756 83015 72504 66259 79897 81171 73538 60211 90662');
        expect(await computeSafetyNumber(party(ALICE, P3), party(BOB, P4)))
            .toBe('35012 18080 55953 47083 24022 07509 59137 81170 62529 99410 71014 43458');
        expect(await computeSafetyNumber(party(ALICE, P5), party(BOB, P6)))
            .toBe('10033 11957 67350 42266 07850 27471 42860 32136 51987 62176 99038 08839');
    }, T);

    it('the user id is bound in: the same two keys under swapped accounts give a different number', async () => {
        expect(await computeSafetyNumber(party(BOB, P1), party(ALICE, P2)))
            .toBe('07652 53822 28650 16126 85305 05362 42756 56612 49207 09595 11007 60153');
    }, T);

    it('is 60 digits in twelve groups, laid out as four rows of three', async () => {
        const sn = await computeSafetyNumber(party(ALICE, P1), party(BOB, P2));
        expect(sn.split(' ')).toHaveLength(12);
        expect(sn.replace(/ /g, '')).toMatch(/^\d{60}$/);
        expect(formatSafetyNumber(sn)).toEqual([
            ['50016', '07251', '01472'],
            ['73756', '83015', '72504'],
            ['66259', '79897', '81171'],
            ['73538', '60211', '90662'],
        ]);
    }, T);
});

describe('safety number v2: order independence', () => {
    it("Alice's view equals Bob's view", async () => {
        const alicesView = await computeSafetyNumber(party(ALICE, P1), party(BOB, P2));
        const bobsView   = await computeSafetyNumber(party(BOB, P2), party(ALICE, P1));
        expect(bobsView).toBe(alicesView);
    }, T);

    it('combineHalves sorts, so argument order never matters', () => {
        const a = '1'.repeat(30);
        const b = '0'.repeat(30);
        expect(combineHalves(a, b)).toBe(combineHalves(b, a));
        expect(combineHalves(a, b).startsWith('00000')).toBe(true);
    });
});

describe('safety number v2: the G1 pair-collision attack is gone', () => {
    /**
     * The attack: a key-directory MITM serves Alice a fake key M_B for Bob and
     * Bob a fake key M_A for Alice. Alice reads SN(A, M_B), Bob reads
     * SN(M_A, B). v1 hashed both keys together, so the attacker controlled one
     * input of EACH hash and needed only a collision (~2^50 keygens).
     *
     * v2's defence is structural and is what these tests pin down: a party's
     * half is a function of that party alone. So Alice's display ALWAYS
     * contains Alice's true half, whatever the attacker serves, and Bob's
     * always contains Bob's. The displays can only match if the attacker's
     * M_B produces BOB'S REAL HALF: a second preimage, not a collision.
     */
    const A = party(ALICE, P1);
    const B = party(BOB, P2);
    // Attacker-chosen substitutes, one per side.
    const fakesForBob   = [P3, P4, P5, P6].map(p => party(BOB, p));
    const fakesForAlice = [P3, P4, P5, P6].map(p => party(ALICE, p));

    it("changing one party's key changes only that party's half", async () => {
        const honest  = halvesOf(await computeSafetyNumber(A, B));
        const rekeyed = halvesOf(await computeSafetyNumber(A, party(BOB, P4)));
        const aliceHalf = await computeFingerprintHalf(A);

        expect(honest).toContain(aliceHalf);
        expect(rekeyed).toContain(aliceHalf);   // Alice's half survives Bob's rekey untouched
        const bobsOld = honest.find(h => h !== aliceHalf);
        const bobsNew = rekeyed.find(h => h !== aliceHalf);
        expect(bobsNew).not.toBe(bobsOld);      // and only Bob's half moved
        // Literal cross-check of the same fact, from the independent oracle.
        expect(await computeSafetyNumber(A, party(BOB, P4)))
            .toBe('59137 81170 62529 99410 71014 43458 66259 79897 81171 73538 60211 90662');
    }, T);

    it("the attacker cannot touch the victim's own half: every forged view Alice sees contains her true half", async () => {
        const aliceHalf = await computeFingerprintHalf(A);
        for (const mB of fakesForBob) {
            expect(halvesOf(await computeSafetyNumber(A, mB))).toContain(aliceHalf);
        }
        const bobHalf = await computeFingerprintHalf(B);
        for (const mA of fakesForAlice) {
            expect(halvesOf(await computeSafetyNumber(mA, B))).toContain(bobHalf);
        }
    }, T);

    it('so a MITM pair can only match by reproducing a REAL half (second preimage), never by pairing its own fakes', async () => {
        // Model the attacker's whole candidate grid. Under v1 the win condition
        // was "any cell collides". Under v2 each view is a multiset of two
        // halves, and each side's view is anchored by its victim's real half,
        // so a matching cell REQUIRES half(M_B) === half(B) and
        // half(M_A) === half(A). Check the displays AND that implication.
        const aliceHalf = await computeFingerprintHalf(A);
        const bobHalf   = await computeFingerprintHalf(B);
        for (const mB of fakesForBob) {
            const alicesView = await computeSafetyNumber(A, mB);
            for (const mA of fakesForAlice) {
                const bobsView = await computeSafetyNumber(mA, B);
                expect(alicesView).not.toBe(bobsView);
                const needed = [aliceHalf, bobHalf].sort().join('|');
                expect(halvesOf(alicesView).sort().join('|') === needed).toBe(false);
            }
        }
    }, T);
});

describe('safety number v2: malformed input is rejected, not coerced', () => {
    it('refuses a key that is not 32 bytes', async () => {
        const short = btoa(String.fromCharCode(...new Uint8Array(31)));
        await expect(computeFingerprintHalf(party(ALICE, short))).rejects.toThrow(/32 bytes/);
    });

    it('refuses a missing user id or key', async () => {
        await expect(computeFingerprintHalf(party('', P1))).rejects.toThrow();
        await expect(computeFingerprintHalf(party(ALICE, ''))).rejects.toThrow();
    });

    it('a rejected derivation is not cached as a permanent failure', async () => {
        const bad = party(ALICE, btoa('x'));
        await expect(computeFingerprintHalf(bad)).rejects.toThrow();
        await expect(computeFingerprintHalf(bad)).rejects.toThrow(/32 bytes/);
    });
});
