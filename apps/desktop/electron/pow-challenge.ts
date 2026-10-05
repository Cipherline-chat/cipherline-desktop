/**
 * Registration proof-of-work: what the client must actually hash over.
 *
 * MUST mirror `apps/api/src/auth/pow.util.ts`. Concretely:
 *
 *   issueChallengeToken()  → `<ts>.<randomHex>.<hmac>`   (what the client is given)
 *   verifyChallengeToken() → `<ts>.<randomHex>`          (what the server hashes)
 *   meetsDifficulty(challenge, nonce) → sha256(`${challenge}:${nonce}`)
 *
 * The signature is the server proving to itself that it issued the challenge;
 * it is deliberately NOT part of the hashed material. A client that hashes the
 * full three-part token produces nonces the server rejects every time — which
 * is exactly the bug this exists to prevent recurring.
 *
 * Pure and electron-free so it is unit testable (pow-challenge.test.ts).
 */

/**
 * Reduce a server-issued PoW challenge token to the string the server hashes.
 *
 * `<ts>.<rand>.<hmac>` → `<ts>.<rand>`. Anything that is not three
 * dot-separated parts is returned unchanged: it is either already the inner
 * challenge or not our format at all, and in both cases inventing a truncation
 * would be worse than passing it through. A wrong nonce fails verification
 * server-side; it never becomes a client-side security decision.
 */
export function powChallengeToHash(token: string): string {
    const parts = token.split('.');
    if (parts.length !== 3) return token;
    return `${parts[0]}.${parts[1]}`;
}
