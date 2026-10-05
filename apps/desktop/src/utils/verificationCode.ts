/**
 * Contact Verification Code: a machine-comparable, per-PARTY commitment to a
 * contact's whole device-key set. It is the whole-contact counterpart of the
 * per-device safety number (`safetyNumber.ts`), not a rendering of it.
 *
 * ── What problem this solves, and what it deliberately does NOT ─────────────
 *
 * The complaint this answers is ergonomic, not cryptographic: comparing twelve
 * groups of five digits by eye, once per device, is slow and people skip it or
 * get it wrong. The fix is to let the MACHINE do the comparison. The fix is NOT
 * to let the machine do the *trusting*.
 *
 * A safety number cannot be verified by the system over the channel it secures.
 * That is circular — an attacker who can forge the identity can forge the
 * confirmation. So this module does exactly one thing:
 *
 *      Given a code the user obtained OUT OF BAND, decide whether it matches
 *      the keys this client currently believes belong to that contact.
 *
 * The out-of-band step is the user's job and cannot be automated away. The UI
 * that calls this MUST say so — see `SafetyVerificationModal`. If the user
 * pastes a code that arrived over Cipherline itself, this check proves nothing
 * at all, and the honest thing is to tell them that rather than award a shield.
 *
 * ── Why it is safe to shorten the comparison this way ───────────────────────
 *
 * The code commits to the contact's ENTIRE device identity-key set at once:
 *
 *      fp = SHA-512( "cipherline-contact-fingerprint-v1" || userId || 0x00
 *                    || sorted(identity_pub_b64) joined by 0x00 )[0..25]
 *
 * 25 bytes = 200 bits, rendered as 40 Crockford-base32 characters.
 *
 * The code depends on ONE account's keys only. That is what makes it strong,
 * and it is the property safety number v1 lacked (G1: v1 hashed both parties'
 * keys together, so a MITM needed only a ~2^50 collision). Here Bob reads out
 * a code over his own key set, and Alice compares it with the code over the
 * set her client holds for Bob. A MITM who substituted keys must make the
 * substituted set hash to Bob's fixed code: a second preimage against 200
 * bits, not a collision. That is out of reach, and so is the 2^100 collision
 * bound this comment used to quote, which applies to no attack here.
 *
 * For comparison, the per-device safety number v2 is 60 displayed digits, but
 * its MITM bound is a second preimage on one 30-digit (~99.7-bit) half, plus a
 * PBKDF2 work factor. This code is the stronger of the two statements.
 *
 * Caveat, outside this module's control: the caller decides which key set
 * each side commits to. The modal computes "your code" from the directory's
 * listing of the user's OWN devices. A server that lists an extra device under
 * both views passes this comparison, because both sides then commit to the
 * same wrong set (the "ghost device"). This module cannot see that. The
 * caller must not display "your code" unless `ownDeviceLedger.assessOwnDeviceSet`
 * accepts the exact listing it hashed, and it must show the covered-device
 * count. See docs/ghost-device.md.
 *
 * ── Why this is NOT a short spoken authentication string (SAS) ──────────────
 *
 * The obvious "fast" alternative is ZRTP's model: derive a short word pair from
 * the live session, both sides say it aloud, voice liveness is the out-of-band
 * channel. It does not compose with this codebase, and the reason is specific:
 *
 * ZRTP's SAS is safe at ~20 bits ONLY because it is derived from a Diffie-
 * Hellman exchange with a hash commitment. The MITM must commit to its share
 * before learning the peer's, so it gets exactly one guess at the collision.
 *
 * Cipherline has no such exchange. `generateCallKey()` (utils/crypto.ts) mints
 * a RANDOM AES-256-GCM key locally and the caller distributes it as a
 * `call_key` message through the encrypted channel. A malicious relay that can
 * forge sender identity at all can simply plant the SAME key on both legs, or
 * grind two different keys to a colliding SAS at the cost of pure hashing (no
 * keygen at all, since the input is unconstrained random bytes). Either way
 * both sides read a MATCHING word pair while the attacker holds the media key.
 * A short SAS here would be a green shield that lies. It is not implemented,
 * and adding one would require a committed, identity-signed DH per call — a
 * protocol change, not a UI change.
 *
 * A code derived from the long-term identity keys, compared in full, has no
 * such weakness, which is why that is what this module does.
 */

/**
 * Crockford base32. Excludes I, L, O and U so a code read aloud or transcribed
 * by hand cannot be mangled by the usual confusions; `normalizeCode` maps the
 * excluded letters back onto their intended digits on the way in.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bytes of fingerprint retained. 25 * 8 = 200 bits, see the header note. */
export const FINGERPRINT_BYTES = 25;
/** 200 bits / 5 bits per base32 char. Exact, so there is never any padding. */
export const CODE_LENGTH = 40;
/** Display grouping. 10 groups of 4 reads and re-reads far better than one run. */
const GROUP_SIZE = 4;

const DOMAIN = 'cipherline-contact-fingerprint-v1';

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Commit to a contact's whole published identity-key set.
 *
 * `userId` is inside the hash so a code is bound to the account it describes —
 * a code captured for one contact cannot be replayed as another's, even if the
 * two somehow shared a device key.
 *
 * Pubs are sorted before hashing so the code is independent of whatever order
 * `GET /keys/identity_keys` happened to return, and 0x00-separated so two
 * different device lists can never concatenate to the same byte string.
 */
export async function computeContactCode(userId: string, devicePubsB64: string[]): Promise<string> {
    if (!userId) throw new Error('userId required');
    if (!devicePubsB64.length) throw new Error('no device keys to commit to');

    const enc = new TextEncoder();
    const parts: Uint8Array[] = [enc.encode(DOMAIN), new Uint8Array([0]), enc.encode(userId)];
    // Sort the base64 strings themselves: a total order over the exact values
    // being committed to, with no dependence on decode order.
    for (const pub of [...devicePubsB64].sort()) {
        parts.push(new Uint8Array([0]));
        parts.push(b64ToBytes(pub));
    }

    const total = parts.reduce((n, p) => n + p.length, 0);
    const input = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { input.set(p, off); off += p.length; }

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', input));
    return encodeBase32(digest.subarray(0, FINGERPRINT_BYTES));
}

/** Raw (ungrouped, uppercase) base32 of exactly FINGERPRINT_BYTES bytes. */
function encodeBase32(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        value = (value << 8) | bytes[i];
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    // 200 bits is a whole multiple of 5, so `bits` is always 0 here. Guard
    // anyway so changing FINGERPRINT_BYTES cannot silently drop trailing bits.
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

/** Split a raw code into space-separated groups for display. */
export function formatCode(code: string): string {
    const groups: string[] = [];
    for (let i = 0; i < code.length; i += GROUP_SIZE) groups.push(code.slice(i, i + GROUP_SIZE));
    return groups.join(' ');
}

/**
 * Canonicalize user-supplied input before comparison: strip anything that is
 * not an alphanumeric (spaces, dashes, newlines, the stray punctuation that
 * survives a copy out of a chat bubble), uppercase, then fold the Crockford
 * look-alikes. Without this a correct code typed by a human fails to match for
 * cosmetic reasons and the user learns to distrust the check.
 */
export function normalizeCode(input: string): string {
    return input
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .replace(/[ILÍ]/g, '1')
        .replace(/O/g, '0')
        .replace(/U/g, 'V');
}

export type CodeCheck =
    /** Normalized input is not 40 valid base32 characters — nothing was compared. */
    | { result: 'malformed'; reason: string }
    /** Well-formed, and every bit matches what this client has for the contact. */
    | { result: 'match' }
    /** Well-formed and definitively different. */
    | { result: 'mismatch' };

/**
 * Compare a pasted code against the expected one.
 *
 * `malformed` is kept distinct from `mismatch` on purpose. They mean opposite
 * things to the user — one is "you pasted it wrong, try again", the other is
 * "the keys you were shown are not the keys I was given, stop" — and collapsing
 * them into a single failure either cries wolf or buries a real alarm.
 *
 * The comparison is length-invariant and full-width (no early return on the
 * first differing character). There is no secret here to leak by timing, but
 * writing it the other way invites someone to copy the pattern somewhere there
 * is one.
 */
export function checkCode(expected: string, supplied: string): CodeCheck {
    const got = normalizeCode(supplied);
    if (!got) return { result: 'malformed', reason: 'Paste or type their code to compare it.' };
    if (got.length !== CODE_LENGTH) {
        return {
            result: 'malformed',
            reason: `That code is ${got.length} characters — it should be ${CODE_LENGTH}. Check you copied all of it.`,
        };
    }
    for (const ch of got) {
        if (!ALPHABET.includes(ch)) {
            return { result: 'malformed', reason: 'That code contains characters a Cipherline code never uses.' };
        }
    }

    const want = normalizeCode(expected);
    let diff = want.length ^ got.length;
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
        diff |= (want.charCodeAt(i) || 0) ^ (got.charCodeAt(i) || 0);
    }
    return diff === 0 ? { result: 'match' } : { result: 'mismatch' };
}
