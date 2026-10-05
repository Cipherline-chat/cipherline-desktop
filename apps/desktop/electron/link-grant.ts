import * as crypto from 'crypto';

/**
 * QR sign-in — the NEW device's half, and the ephemeral key it must not leak.
 *
 * Full design and threat model: `docs/QR-LINKING.md` in the mobile repo. This
 * file is the byte-exact counterpart of mobile's
 * `src/core/crypto/link-grant.ts`; the two MUST stay in agreement, and
 * `scripts/interop/link-grant-protocol.mjs` proves they do, in both directions,
 * against the real implementations rather than against copies of themselves.
 *
 * ## Why this lives in the MAIN process
 *
 * The ephemeral private key is the single thing that makes a photograph of the
 * QR worthless: the grant is sealed to its public half, so whoever holds the
 * private half — and only them — can open it. Keeping it in main means it never
 * crosses the context bridge, so a compromised renderer cannot exfiltrate it,
 * and it can be zeroed deterministically. The renderer asks for
 * `beginLinkSession()` and gets back a PUBLIC key plus a fingerprint to render;
 * it asks for `openLinkGrant()` and gets back the grant. It never sees key
 * material, which is the same shape as every other privileged operation here
 * (CLAUDE.md: "All privileged ops go through the preload bridge").
 *
 * ## The construction
 *
 * ```
 * (es_priv, es_pub) = fresh X25519 pair, one per seal
 * shared            = X25519(es_priv, ek_pub)
 * salt              = es_pub ‖ ek_pub                       (64 bytes, both public)
 * key               = HKDF-SHA256(ikm = shared, salt, info = LABEL ‖ ":" ‖ linkId, 32)
 * nonce             = 12 random bytes
 * aad               = LABEL ‖ ":" ‖ linkId
 * ct‖tag            = AES-256-GCM(key, nonce, aad, utf8(JSON(payload)))
 * envelope          = base64(JSON({ v, es_pub_b64, nonce_b64, ct_b64 }))
 * ```
 *
 * Not new crypto: X25519 + HKDF-SHA256 + AES-256-GCM, exactly the primitives
 * `e2ee-engine.ts` already uses for `call_key` / `channel_key` / the wrapped
 * history transfer key, composed in the standard seal-to-a-public-key shape.
 * See the mobile module's header for why `encryptForDevices` could not be
 * reused directly (it verifies a signed prekey against a device identity, and
 * here the target device has no identity on file yet).
 */

/** Domain-separation label. Byte-identical to mobile's `LINK_GRANT_LABEL`. */
export const LINK_GRANT_LABEL = 'cipherline-link-grant:v1';

/** Envelope format version. Checked EXACTLY, never `>=`. The ENVELOPE (the
 *  crypto) has not changed; what changed in v2 is the PAYLOAD inside it. */
export const LINK_GRANT_VERSION = 1;

const X25519_PUB_LEN = 32;
const NONCE_LEN = 12;

/**
 * v1 payload — the original exchange: the approver received a token pair from
 * `approve` and sealed it here. Still opened (a legacy phone approving THIS
 * desktop's session while the server's `LINK_LEGACY_MINT_AT_APPROVE` is on),
 * never sealed by current code.
 */
export interface LinkGrantPayloadV1 {
    type: 'link_grant';
    v: 1;
    link_id: string;
    user_id: string;
    access_token: string;
    refresh_token: string;
    approved_by_device_id: string;
    approved_by_device_name: string;
    issued_at: string;
}

/**
 * v2 payload — nothing was minted at approve. The approver seals the CLAIM
 * SECRET the server handed it; the new device redeems it with
 * `POST /v1/link/sessions/:id/claim`, which is where the token pair is minted
 * (server-side A4). A grant that is never opened therefore never becomes a
 * session. `user_id` is display/consistency only — the authoritative identity
 * is whatever `/auth/me` says for the token `claim` returns.
 */
export interface LinkGrantPayloadV2 {
    type: 'link_grant';
    v: 2;
    link_id: string;
    user_id: string;
    claim_secret: string;
    approved_by_device_id: string;
    approved_by_device_name: string;
    issued_at: string;
}

export type LinkGrantPayload = LinkGrantPayloadV1 | LinkGrantPayloadV2;

const CLAIM_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface LinkEnvelope {
    v: number;
    es_pub_b64: string;
    nonce_b64: string;
    ct_b64: string;
}

function importX25519Pub(b64: string): crypto.KeyObject {
    return crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(b64, 'base64').toString('base64url') },
        format: 'jwk',
    });
}

function importX25519Priv(privRaw: Buffer, pubB64: string): crypto.KeyObject {
    return crypto.createPrivateKey({
        key: {
            kty: 'OKP', crv: 'X25519',
            d: privRaw.toString('base64url'),
            x: Buffer.from(pubB64, 'base64').toString('base64url'),
        },
        format: 'jwk',
    });
}

function rawPub(key: crypto.KeyObject): Buffer {
    const jwk = key.export({ format: 'jwk' }) as { x: string };
    return Buffer.from(jwk.x, 'base64url');
}

function requirePub(b64: string, what: string): Buffer {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length !== X25519_PUB_LEN) {
        throw new Error(`[LinkGrant] ${what} must be exactly ${X25519_PUB_LEN} bytes`);
    }
    return raw;
}

function derive(shared: Buffer, esPub: Buffer, ekPub: Buffer, linkId: string): Buffer {
    const salt = Buffer.concat([esPub, ekPub]);
    const info = Buffer.from(`${LINK_GRANT_LABEL}:${linkId}`, 'utf8');
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 32));
    // ECDH output has served its only purpose — zero it rather than leaving it
    // resident, the same discipline the engine applies to its wrap keys.
    shared.fill(0);
    return key;
}

function aadFor(linkId: string): Buffer {
    return Buffer.from(`${LINK_GRANT_LABEL}:${linkId}`, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Seal — used when THIS desktop is the already-signed-in device approving a
// link (the mirror of the flow below, for when the new device is a phone).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seal a grant so only the holder of `ekPubB64`'s private half can open it.
 *
 * `ekPubB64` MUST come from the scanned QR, never from an API response — see
 * `docs/QR-LINKING.md` §2.5. Throws rather than producing anything unsealed;
 * there is deliberately no unsealed variant of this path to fall back to.
 */
export function sealLinkGrant(payload: LinkGrantPayload, ekPubB64: string, linkId: string): string {
    const ekPub = requirePub(ekPubB64, 'ephemeral public key');
    if (!linkId) throw new Error('[LinkGrant] refusing to seal without a link id to bind to');

    const { privateKey: esPriv, publicKey: esPubKey } = crypto.generateKeyPairSync('x25519');
    const esPub = rawPub(esPubKey);
    const shared = Buffer.from(crypto.diffieHellman({ privateKey: esPriv, publicKey: importX25519Pub(ekPubB64) }));
    const key = derive(shared, esPub, ekPub, linkId);
    const nonce = crypto.randomBytes(NONCE_LEN);

    try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aadFor(linkId));
        const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
        const ct = Buffer.concat([body, cipher.getAuthTag()]);
        const envelope: LinkEnvelope = {
            v: LINK_GRANT_VERSION,
            es_pub_b64: esPub.toString('base64'),
            nonce_b64: nonce.toString('base64'),
            ct_b64: ct.toString('base64'),
        };
        return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    } finally {
        key.fill(0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open — the desktop-is-the-new-device path, the headline flow.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a grant sealed to `ekPriv`.
 *
 * The key is accepted as a `Buffer` (what the in-process session holds, so it
 * can be zeroed — QR-8) **or** as a hex string.
 *
 * The hex form is NOT legacy tolerance and must not be removed as cleanup: it
 * is the form mobile's `openLinkGrant` takes, and
 * `scripts/interop/link-grant-protocol.mjs` drives BOTH implementations through
 * the same call to prove they agree. Narrowing this parameter to `Buffer` alone
 * silently broke that harness's "desktop opens what mobile sealed" direction —
 * the interop went red while every unit test stayed green, because a unit test
 * only ever sees one side. Keep the two signatures interchangeable.
 *
 * @throws on ANY failure: malformed envelope, unknown version, wrong key,
 *   tampered ciphertext, or a `link_id` that is not this session's. Every one of
 *   these must be treated by the caller as "discard and show an error" — there
 *   is no weaker path to degrade to, and inventing one would undo the design.
 */
export function openLinkGrant(
    envelopeB64: string,
    ekPrivInput: Buffer | string,
    ekPubB64: string,
    expectedLinkId: string,
): LinkGrantPayload {
    const ekPriv = typeof ekPrivInput === 'string' ? Buffer.from(ekPrivInput, 'hex') : ekPrivInput;
    if (ekPriv.length !== X25519_PUB_LEN) {
        throw new Error(`[LinkGrant] ephemeral private key must be exactly ${X25519_PUB_LEN} bytes`);
    }
    let env: LinkEnvelope;
    try {
        env = JSON.parse(Buffer.from(envelopeB64, 'base64').toString('utf8')) as LinkEnvelope;
    } catch {
        throw new Error('[LinkGrant] envelope is not valid base64 JSON');
    }
    if (env?.v !== LINK_GRANT_VERSION) {
        throw new Error(`[LinkGrant] unsupported envelope version ${String(env?.v)}`);
    }

    const esPub = requirePub(env.es_pub_b64, 'sender ephemeral public key');
    const ekPub = requirePub(ekPubB64, 'own ephemeral public key');
    const nonce = Buffer.from(env.nonce_b64, 'base64');
    const ct = Buffer.from(env.ct_b64, 'base64');
    if (nonce.length !== NONCE_LEN) throw new Error('[LinkGrant] bad nonce length');
    if (ct.length < 16) throw new Error('[LinkGrant] ciphertext shorter than its tag');

    const shared = Buffer.from(crypto.diffieHellman({
        privateKey: importX25519Priv(ekPriv, ekPubB64),
        publicKey: importX25519Pub(env.es_pub_b64),
    }));
    const key = derive(shared, esPub, ekPub, expectedLinkId);

    let plaintext: Buffer;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(ct.subarray(ct.length - 16));
        decipher.setAAD(aadFor(expectedLinkId));
        plaintext = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    } catch {
        // Covers a tampered ciphertext, a wrong key, AND an envelope sealed for
        // a DIFFERENT link id — the id is in the AAD, so a replay fails here.
        throw new Error('[LinkGrant] envelope failed to decrypt or was tampered with');
    } finally {
        key.fill(0);
    }

    let payload: LinkGrantPayload;
    try {
        payload = JSON.parse(plaintext.toString('utf8')) as LinkGrantPayload;
    } catch {
        throw new Error('[LinkGrant] decrypted grant was not valid JSON');
    } finally {
        plaintext.fill(0);
    }

    if (payload?.type !== 'link_grant' || (payload.v !== 1 && payload.v !== 2)) {
        throw new Error('[LinkGrant] unexpected payload in grant envelope');
    }
    if (payload.link_id !== expectedLinkId) {
        throw new Error('[LinkGrant] grant was sealed for a different link session');
    }
    if (!payload.user_id) {
        throw new Error('[LinkGrant] grant is missing required session fields');
    }
    if (payload.v === 1) {
        if (!payload.access_token || !payload.refresh_token) {
            throw new Error('[LinkGrant] grant is missing required session fields');
        }
    } else if (typeof payload.claim_secret !== 'string' || !CLAIM_SECRET_PATTERN.test(payload.claim_secret)) {
        throw new Error('[LinkGrant] grant is missing a usable claim secret');
    }
    return payload;
}

// ── fingerprint ─────────────────────────────────────────────────────────────

/** 32 characters, with `0`/`1`/`I`/`O` removed so a misread glyph cannot defeat
 *  the human comparison. Byte-identical to mobile's `FP_ALPHABET`. */
const FP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * An 8-character fingerprint of an ephemeral public key, rendered `XXXX-XXXX`.
 *
 * Shown under the QR here and on the approving phone's confirmation sheet; the
 * user compares them. The attack it answers is screen-overlay substitution —
 * malware or a screen-share swapping the displayed QR for an attacker's — which
 * no cryptographic check can catch, because the substitution happens at the
 * optical layer that is the point of the design.
 *
 * Each side MUST compute this from the key it holds or scanned, never from
 * anything the server said, or the comparison is circular.
 */
export function linkFingerprint(ekPubB64: string): string {
    const raw = requirePub(ekPubB64, 'ephemeral public key');
    const digest = crypto.createHash('sha256').update(raw).digest();
    let bits = 0;
    let acc = 0;
    let out = '';
    for (let i = 0; i < 5; i++) {
        acc = (acc << 8) | digest[i];
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += FP_ALPHABET[(acc >> bits) & 31];
        }
    }
    return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session holder — the ephemeral key's whole lifetime, in one place.
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveLinkSession {
    linkId: string;
    /** QR-8 (adversarial review): kept as a Buffer, not a hex string, so it
     *  can be genuinely zeroed on discard — this is ephemeral, single-use key
     *  material that lives in the main process for at most 120s, exactly the
     *  category CLAUDE.md says belongs in a zeroed Buffer (the module's other
     *  secrets — `shared`, `key`, `plaintext` — already follow this; this was
     *  the one holdout, previously a hex string with a comment explaining why
     *  a JS string cannot be scrubbed). */
    ekPriv: Buffer;
    ekPubB64: string;
}

/**
 * At most ONE in-flight link session per app run.
 *
 * Kept in module scope in main, never persisted and never sent to the renderer.
 * Starting a new session discards the previous key rather than keeping a pool:
 * an old ephemeral key that is still openable is a liability with no upside, and
 * the server has already expired its side after 120s anyway.
 */
let active: ActiveLinkSession | null = null;

function discardActive(): void {
    if (!active) return;
    // QR-8: zero the backing buffer before dropping the reference, the same
    // discipline `derive()`/`sealLinkGrant`/`openLinkGrant` already apply to
    // their own ECDH shared secrets and derived keys.
    active.ekPriv.fill(0);
    active = null;
}

/**
 * Begin a link session: generate the ephemeral keypair and return only its
 * PUBLIC half plus the fingerprint to display. The private half stays here.
 */
export function beginLinkSession(linkId: string): { ekPubB64: string; fingerprint: string } {
    discardActive();
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const ekPubB64 = rawPub(publicKey).toString('base64');
    const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
    active = { linkId, ekPubB64, ekPriv: Buffer.from(jwk.d, 'base64url') };
    return { ekPubB64, fingerprint: linkFingerprint(ekPubB64) };
}

/**
 * Open the grant for the CURRENT session and immediately discard the key.
 *
 * The key is discarded whether or not the open succeeded: a failed open means
 * the envelope was not ours, and retrying with the same key against a second
 * envelope is not a flow we want to exist.
 */
export function openActiveLinkSession(envelopeB64: string, linkId: string): LinkGrantPayload {
    if (!active) throw new Error('[LinkGrant] no link session is in progress');
    if (active.linkId !== linkId) throw new Error('[LinkGrant] link id does not match the session in progress');
    try {
        return openLinkGrant(envelopeB64, active.ekPriv, active.ekPubB64, linkId);
    } finally {
        discardActive();
    }
}

/**
 * Attach the server-issued `link_id` to the session `beginLinkSession('')`
 * already started.
 *
 * Exists to resolve an ordering problem, not to allow re-keying: the renderer
 * needs `ek_pub_b64` INSIDE the `POST /v1/link/sessions` body that is what
 * creates `link_id` in the first place, so the id cannot be known yet when the
 * ephemeral key is minted. `beginLinkSession('')` mints the key first; once the
 * POST returns, this binds the real id to that same in-flight session.
 *
 * Deliberately narrow: it only ever moves a session out of the '' placeholder
 * state, exactly once. A session that already has a real (non-empty) linkId —
 * whether from a normal `beginLinkSession(linkId)` call or a previous bind —
 * throws rather than silently re-keying, because silently retargeting which
 * server session an already-generated private key answers to is exactly the
 * kind of mix-up `openActiveLinkSession`'s linkId check exists to catch, and
 * catching it here, loudly, is cheaper than catching it there.
 *
 * QR-4 (adversarial review): also rejects anything not shaped like a real
 * server-issued id (22-char base64url). `linkId` ends up interpolated into
 * the QR string `buildLinkQr` renders on the renderer side; validating it
 * here, main-process-side, before it is ever bound to the session is
 * defence in depth alongside `buildLinkQr`'s own `encodeURIComponent` and
 * `qrSignInController.ts`'s identical check before this IPC call is made.
 */
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function bindLinkSession(linkId: string): void {
    if (!active) throw new Error('[LinkGrant] no link session is in progress to bind');
    if (active.linkId !== '') throw new Error('[LinkGrant] session already has a link id bound');
    if (!linkId) throw new Error('[LinkGrant] refusing to bind an empty link id');
    if (!LINK_ID_PATTERN.test(linkId)) throw new Error('[LinkGrant] link id is not a well-formed session id');
    active.linkId = linkId;
}

/** Cancel an in-flight session (the user pressed Cancel, or the code expired). */
export function endLinkSession(): void {
    discardActive();
}

/** Test/diagnostic only — is a session in flight? Never exposes key material. */
export function hasActiveLinkSession(): boolean {
    return active !== null;
}
