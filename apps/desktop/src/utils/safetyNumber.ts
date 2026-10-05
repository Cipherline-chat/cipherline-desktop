/**
 * Safety number (version 2): per-device, out-of-band identity verification.
 *
 * ── What went wrong with version 1, and why the construction changed ────────
 *
 * v1 was `SHA-512(sorted(pubA, pubB))`, truncated to SIX groups of five
 * digits: 30 digits, about 99.7 bits. (Its docstring claimed twelve groups
 * and ~199 bits; the loop never produced them.) The real flaw was not the
 * length. It was that ONE hash covered BOTH parties' keys.
 *
 * A key-directory man-in-the-middle serves Alice a fake key M_B for Bob and
 * serves Bob a fake key M_A for Alice. Alice then reads H(A, M_B) and Bob reads
 * H(M_A, B). The attacker controls one input of each hash, so it only needs
 * those two values to COLLIDE. That is a birthday search of about 2^50 Ed25519
 * keygens, which a funded attacker can afford and which parallel collision
 * search makes cheap in memory.
 *
 * ── Version 2: one half per party (Signal's shape) ──────────────────────────
 *
 * Each party gets its own 30-digit half, derived ONLY from that party's user
 * id and device identity key:
 *
 *     okm  = PBKDF2-HMAC-SHA-512(password   = identity pub, raw 32 bytes,
 *                                salt       = "cipherline-safety-number-v2"
 *                                             || 0x00 || UTF-8(userId),
 *                                iterations = 5200,
 *                                length     = 30 bytes)
 *     half = for i in 0,5,10,15,20,25:
 *                (big-endian uint40 of okm[i..i+5]) mod 100000, zero-padded to 5
 *            -> 30 digits
 *
 * The displayed number is the two halves sorted as strings and concatenated:
 * 60 digits, rendered as twelve groups of five. Both parties sort the same two
 * halves, so both see the same number.
 *
 * Why this closes the attack: Alice's display always contains HER OWN true
 * half, which the attacker cannot influence. Bob's always contains his. For
 * the two displays to match, the half Alice computes for "Bob" from M_B must
 * EQUAL Bob's real half. That is a second preimage against a fixed 30-digit
 * (about 99.7-bit) target, not a collision. Each attempt costs one Ed25519
 * keygen plus 5200 PBKDF2 iterations, which adds about 12 bits of work. Binding
 * the user id into the salt means one candidate key can only ever hit one
 * account's halves, so the attacker cannot amortise a search across many
 * users at once. The 60 digits are NOT 199 bits of MITM resistance. The bound
 * is the per-half second preimage.
 *
 * PBKDF2 rather than Signal's hand-rolled `SHA-512` loop: it is the same kind
 * of iterated work factor, but it is a single native call in WebCrypto, Node
 * and react-native-quick-crypto. A 5200-step `await digest()` loop measured
 * seconds per half under load. This is a standard KDF used as specified, not
 * custom crypto.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * This is the per-DEVICE comparison: this device's key against one of the
 * contact's device keys. The whole-contact comparison is the 40-character
 * contact code (`verificationCode.ts`), which was always per-party.
 *
 * The algorithm, its test vectors and the mobile port contract are in
 * `docs/safety-number-v2.md`. Any change here is a wire-visible change: users
 * on other platforms read these digits aloud to each other.
 */

/** Bumped only with a construction change; shown next to the digits. */
export const SAFETY_NUMBER_VERSION = 2;

const DOMAIN = 'cipherline-safety-number-v2';
/** Signal's iteration count for the same purpose. Part of the format. */
const ITERATIONS = 5200;
/** 6 groups x 5 bytes of okm per half. */
const HALF_BYTES = 30;
const GROUP_DIGITS = 5;
/** 30 digits per party, 60 displayed. */
export const HALF_DIGITS = 30;
export const SAFETY_NUMBER_GROUPS = 12;
/** An Ed25519 public key. Anything else is malformed, not "close enough". */
const PUB_BYTES = 32;

/** One side of the comparison: an account and ONE of its device keys. */
export interface SafetyParty {
    userId: string;
    /** Standard base64 of the raw 32-byte Ed25519 identity public key. */
    pubB64: string;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Halves are pure functions of public inputs (a user id and a public key), so
 * memoising them leaks nothing. It saves real work: the modal pairs this
 * device's half with every one of the contact's devices, on every open.
 * Bounded, oldest-first eviction. The Promise is cached so concurrent callers
 * share one derivation.
 */
const HALF_CACHE_MAX = 128;
const halfCache = new Map<string, Promise<string>>();

async function deriveHalf(userId: string, pubB64: string): Promise<string> {
    const pub = b64ToBytes(pubB64);
    if (pub.length !== PUB_BYTES) {
        throw new Error(`identity key must be ${PUB_BYTES} bytes, got ${pub.length}`);
    }
    const enc = new TextEncoder();
    const domain = enc.encode(DOMAIN);
    const uid = enc.encode(userId);
    const salt = new Uint8Array(domain.length + 1 + uid.length);
    salt.set(domain, 0);
    salt[domain.length] = 0;
    salt.set(uid, domain.length + 1);

    const key = await crypto.subtle.importKey('raw', pub, 'PBKDF2', false, ['deriveBits']);
    const okm = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-512', salt, iterations: ITERATIONS },
        key,
        HALF_BYTES * 8,
    ));

    let digits = '';
    for (let i = 0; i < HALF_BYTES; i += 5) {
        // 40 bits does not fit JS's 32-bit bitwise operators, so multiply.
        let n = 0;
        for (let j = 0; j < 5; j++) n = n * 256 + okm[i + j];
        digits += String(n % 100000).padStart(GROUP_DIGITS, '0');
    }
    return digits;
}

/**
 * One party's 30-digit half. Depends on that party's user id and key ONLY,
 * which is the property the whole construction rests on.
 */
export function computeFingerprintHalf(party: SafetyParty): Promise<string> {
    if (!party.userId) return Promise.reject(new Error('userId required'));
    if (!party.pubB64) return Promise.reject(new Error('identity key required'));
    const k = `${party.userId}\u0000${party.pubB64}`;
    const hit = halfCache.get(k);
    if (hit) return hit;
    const p = deriveHalf(party.userId, party.pubB64);
    // A failed derivation must not stay cached: it would pin the failure.
    p.catch(() => { if (halfCache.get(k) === p) halfCache.delete(k); });
    halfCache.set(k, p);
    if (halfCache.size > HALF_CACHE_MAX) {
        const oldest = halfCache.keys().next().value;
        if (oldest !== undefined) halfCache.delete(oldest);
    }
    return p;
}

/**
 * Join two halves into the displayed number: sorted, concatenated, grouped.
 * Exported so the ordering rule is testable apart from the derivation.
 */
export function combineHalves(halfA: string, halfB: string): string {
    const [lo, hi] = [halfA, halfB].sort();
    const all = lo + hi;
    const groups: string[] = [];
    for (let i = 0; i < all.length; i += GROUP_DIGITS) groups.push(all.slice(i, i + GROUP_DIGITS));
    return groups.join(' ');
}

/**
 * The v2 safety number for one device pair: 60 digits, as twelve
 * space-separated groups of five. Order-independent, so either side may pass
 * itself as `local`.
 */
export async function computeSafetyNumber(local: SafetyParty, remote: SafetyParty): Promise<string> {
    const [a, b] = await Promise.all([computeFingerprintHalf(local), computeFingerprintHalf(remote)]);
    return combineHalves(a, b);
}

/**
 * Lay a safety number out as rows of three groups: four rows for v2's twelve
 * groups.
 */
export function formatSafetyNumber(safetyNumber: string): string[][] {
    const groups = safetyNumber.split(' ');
    const rows: string[][] = [];
    for (let i = 0; i < groups.length; i += 3) {
        rows.push(groups.slice(i, i + 3));
    }
    return rows;
}
