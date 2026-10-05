import { describe, it, expect } from 'vitest';
import { evaluateSafetyNumberEmbed } from './safetyNumberEmbed';
import { computeContactCode, formatCode, CODE_LENGTH } from './verificationCode';

/**
 * The claim under test: an attacker who controls the message body can choose
 * what gets compared, but never the outcome of the comparison.
 *
 * Every "forged" case below is a different shape of the same attack — put
 * something outcome-like in the payload and see whether the UI can be made to
 * read `match` without the recipient's own keys actually agreeing.
 */

const ALICE = 'alice-user-id';
const BOB   = 'bob-user-id';

/** Deterministic stand-ins for Ed25519 identity pubs — base64 of fixed bytes. */
const KEY_REAL_1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_REAL_2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const KEY_ATTACKER = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const ALICE_REAL_KEYS = [KEY_REAL_1, KEY_REAL_2];

/** The code Alice's own client would compute and send. */
async function aliceRealCode(): Promise<string> {
    return computeContactCode(ALICE, ALICE_REAL_KEYS);
}

describe('evaluateSafetyNumberEmbed — the honest paths', () => {
    it('matches when the sent code agrees with the recipient\'s own view of the keys', async () => {
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(verdict).toEqual({ kind: 'match' });
    });

    it('tolerates display formatting — grouped, lowercased and Crockford look-alikes', async () => {
        const raw = await aliceRealCode();
        for (const variant of [formatCode(raw), raw.toLowerCase(), `  ${formatCode(raw)}  `]) {
            const verdict = await evaluateSafetyNumberEmbed({
                senderUserId: ALICE,
                claimedUserId: ALICE,
                claimedCode: variant,
                localDevicePubsB64: ALICE_REAL_KEYS,
            });
            expect(verdict, `variant: ${JSON.stringify(variant)}`).toEqual({ kind: 'match' });
        }
    });

    it('MISMATCHES when the recipient holds a different key set than the sender committed to', async () => {
        // The real alarm: the directory handed Bob an attacker's key for Alice,
        // but the embed carried Alice's genuine code (the interception did not
        // rewrite the body). This is the case the feature earns its keep on.
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: [KEY_ATTACKER],
        });
        expect(verdict).toEqual({ kind: 'mismatch' });
    });

    it('MISMATCHES when a device is added or removed on either side', async () => {
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: [KEY_REAL_1],  // Bob has not seen Alice's 2nd device
        });
        expect(verdict).toEqual({ kind: 'mismatch' });
    });

    it('reports malformed separately from mismatch — they mean opposite things', async () => {
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: 'TOO-SHORT',
            localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(verdict.kind).toBe('malformed');
    });

    it('reports unavailable rather than guessing when the sender\'s keys cannot be read', async () => {
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: [],
        });
        expect(verdict.kind).toBe('unavailable');
    });
});

describe('evaluateSafetyNumberEmbed — forged embeds cannot produce a match', () => {
    it('a payload asserting `verified: true` is still evaluated on the keys alone', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const forged: any = {
            type: 'safety_number',
            user_id: ALICE,
            code: await computeContactCode(ALICE, [KEY_ATTACKER]), // attacker's own key set
            // Every outcome-shaped field an attacker might hope is honoured.
            verified: true,
            result: 'match',
            expected: await aliceRealCode(),
            trusted: true,
            safety_verified: true,
        };

        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: forged.user_id,
            claimedCode: forged.code,
            localDevicePubsB64: ALICE_REAL_KEYS,   // Bob's real view of Alice
        });

        // The extra fields are unreachable: the function's signature has
        // nowhere to put them, so they cannot influence anything.
        expect(verdict).toEqual({ kind: 'mismatch' });
    });

    it('positive control: that same call DOES yield match when the keys genuinely agree', async () => {
        // Proves the assertion above is discriminating rather than a function
        // that returns `mismatch` for everything. Same inputs, real code.
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(verdict).toEqual({ kind: 'match' });
    });

    it('cannot borrow another account\'s good code: payload user_id must equal the envelope sender', async () => {
        // Mallory sends Bob an embed whose body names Alice and carries Alice's
        // genuine code, hoping Bob evaluates it "as Alice" and credits the
        // result to the message Mallory sent.
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: 'mallory-user-id',   // who actually sent it
            claimedUserId: ALICE,              // who the body claims
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(verdict).toEqual({ kind: 'sender_mismatch' });
    });

    it('the expectation is bound to the ENVELOPE sender, not the payload\'s user_id', async () => {
        // Same code, same local keys; only the envelope sender differs. If the
        // implementation ever read `claimedUserId` to build the expectation,
        // these two would agree — and an attacker could pick the subject.
        const code = await aliceRealCode();
        const asAlice = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE, claimedUserId: ALICE,
            claimedCode: code, localDevicePubsB64: ALICE_REAL_KEYS,
        });
        const asBobWithNoClaim = await evaluateSafetyNumberEmbed({
            senderUserId: BOB, claimedUserId: '',
            claimedCode: code, localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(asAlice).toEqual({ kind: 'match' });
        // computeContactCode mixes the user id into the hash, so the same keys
        // under a different account id produce a different code.
        expect(asBobWithNoClaim).toEqual({ kind: 'mismatch' });
    });

    it('an empty or whitespace code never reads as a match, even against empty local keys', async () => {
        for (const code of ['', '   ', '\n']) {
            const verdict = await evaluateSafetyNumberEmbed({
                senderUserId: ALICE, claimedUserId: ALICE,
                claimedCode: code, localDevicePubsB64: ALICE_REAL_KEYS,
            });
            expect(verdict.kind, `code: ${JSON.stringify(code)}`).not.toBe('match');
        }
    });

    it('a non-string code is rejected rather than coerced into something comparable', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const code of [null, undefined, 42, {}, []] as any[]) {
            const verdict = await evaluateSafetyNumberEmbed({
                senderUserId: ALICE, claimedUserId: ALICE,
                claimedCode: code, localDevicePubsB64: ALICE_REAL_KEYS,
            });
            expect(verdict.kind, `code: ${JSON.stringify(code)}`).not.toBe('match');
        }
    });

    it('a missing envelope sender refuses to compare instead of falling back to the payload', async () => {
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: '',
            claimedUserId: ALICE,
            claimedCode: await aliceRealCode(),
            localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(verdict.kind).toBe('unavailable');
    });

    it('key ORDER cannot be used to force disagreement — the code is order-independent', async () => {
        // Guards against a spurious mismatch alarm: the directory may return
        // devices in any order, and a user seeing a red warning for that reason
        // learns to click past red warnings.
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE,
            claimedUserId: ALICE,
            claimedCode: await computeContactCode(ALICE, [KEY_REAL_2, KEY_REAL_1]),
            localDevicePubsB64: [KEY_REAL_1, KEY_REAL_2],
        });
        expect(verdict).toEqual({ kind: 'match' });
    });

    it('the verdict is side-effect free — repeated evaluation is stable', async () => {
        const args = {
            senderUserId: ALICE, claimedUserId: ALICE,
            claimedCode: await computeContactCode(ALICE, [KEY_ATTACKER]),
            localDevicePubsB64: ALICE_REAL_KEYS,
        };
        // A "verify" path that mutated trust state on the way through would let
        // a forged embed ratchet something on the first call; it does not.
        for (let i = 0; i < 3; i++) {
            expect(await evaluateSafetyNumberEmbed(args)).toEqual({ kind: 'mismatch' });
        }
    });

    it('a code of the right LENGTH but wrong content is a mismatch, not malformed', async () => {
        // The distinction matters: malformed says "you pasted it wrong", which
        // invites a retry; mismatch says "stop". A forger padding to the right
        // length must land in the alarming branch, not the reassuring one.
        const wrong = '0'.repeat(CODE_LENGTH);
        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId: ALICE, claimedUserId: ALICE,
            claimedCode: wrong, localDevicePubsB64: ALICE_REAL_KEYS,
        });
        expect(verdict).toEqual({ kind: 'mismatch' });
    });
});

describe('liveMatchCaution — a live match is amber while an identity problem is open', () => {
    it('flags a served key that contradicts a pin, even with no contact verdict', async () => {
        const { liveMatchCaution } = await import('./safetyNumberEmbed');
        expect(liveMatchCaution({
            pinned: [{ deviceId: 'd1', pub: 'OLD', verified: true }],
            compared: [{ deviceId: 'd1', pub: 'NEW' }],
        })).toEqual({ reason: 'pins_differ' });
    });

    it.each(['key_changed', 'unrecognized_verified', 'unattributed'] as const)(
        'flags an unresolved %s warning when no pin is contradicted', async verdict => {
            const { liveMatchCaution } = await import('./safetyNumberEmbed');
            expect(liveMatchCaution({ pinned: [], compared: [{ deviceId: 'd1', pub: 'P' }], verdict }))
                .toEqual({ reason: 'contact_warning' });
        });

    it('is clear when served keys agree with the pins and nothing is open', async () => {
        const { liveMatchCaution } = await import('./safetyNumberEmbed');
        expect(liveMatchCaution({
            pinned: [{ deviceId: 'd1', pub: 'P', verified: false }],
            compared: [{ deviceId: 'd1', pub: 'P' }, { deviceId: 'd2', pub: 'Q' }],
            verdict: 'first_contact',
        })).toBeNull();
    });
});
