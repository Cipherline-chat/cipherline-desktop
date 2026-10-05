import { secureStore } from './storage';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// C5 — bounding the lifetime of superseded signed-prekey private keys
// ---------------------------------------------------------------------------
/**
 * How long a signed-prekey private key is kept after it stops being the active
 * one. Until this existed, `signed_prekey_priv_*` was written and NEVER deleted,
 * and `decryptEnvelope` tries every one of them as a candidate — so a single
 * dump of a device's SecureStore decrypted every message ever delivered to that
 * device (plus every `file_key_b64` and `call_key` inside them) for anyone
 * holding the ciphertext. Retention is what turns "every message ever" into a
 * bounded window.
 *
 * WHERE THE NUMBER COMES FROM — this is derived, not picked. A superseded SPK
 * is still needed for exactly as long as an envelope wrapped to it can still be
 * delivered:
 *
 *   30 days  the server's hard ceiling on an undelivered envelope.
 *            `CleanupService.sweepOldMessageEnvelopes` deletes unacked
 *            envelopes older than 30 days, so nothing older can ever arrive.
 *   +1 day   that sweep runs on a 24 h `setInterval`, so an envelope can
 *            outlive the cutoff by up to one cron period.
 *   +1 day   skew between a sender fetching our bundle and actually sending.
 *            Senders re-fetch recipient devices immediately before encrypting,
 *            so this is normally seconds; a day covers a queued/retried send.
 *   +3 days  margin for client/server clock skew and a device that was offline
 *            across its own rotation.
 *   = 35 days
 *
 * COUPLING — if `sweepOldMessageEnvelopes`' 30-day cutoff is ever raised, this
 * constant MUST be raised with it. Getting that wrong does not fail loudly: it
 * silently makes old-but-still-deliverable messages undecryptable, which looks
 * like a delivery bug, not a key-retention bug. `forwardSecrecy.test.ts` pins the
 * relationship between the two numbers so the coupling is checked, not trusted.
 */
export const SPK_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/** Server-side ceiling this retention is derived from — see SPK_RETENTION_MS. */
export const SERVER_ENVELOPE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete signed-prekey private keys that can no longer be needed.
 *
 * Safe-deletion rule, stated precisely: an SPK private is deletable once it has
 * been SUPERSEDED (a newer SPK became active, so the server no longer hands out
 * this one) for longer than `SPK_RETENTION_MS`. Supersession time — not key
 * creation time — is the clock that matters: a key created 90 days ago but still
 * active 5 minutes ago may well have messages in flight against it.
 *
 * Three invariants, each protecting against a way this could lose messages:
 *
 *   1. The ACTIVE key is never deleted, whatever its age.
 *   2. A superseded key with no recorded supersession timestamp is STAMPED,
 *      not deleted. Every device in the existing fleet is in exactly this
 *      state — they have been accumulating SPK privates with no timestamps for
 *      the product's whole history. Deleting those on first run would destroy
 *      the keys for genuinely in-flight messages. Stamping starts their clock
 *      instead, so the oldest they can be removed is 35 days after this ships.
 *      This costs one extra retention window once, and loses nothing.
 *   3. If the active id cannot be determined, the function does nothing. A
 *      store that cannot say which key is live is not a store to delete from.
 *
 * @returns the ids actually deleted (for logging/tests)
 */
export function pruneSupersededSignedPrekeys(now: number = Date.now()): number[] {
    const activeIdStr = secureStore.get('signed_prekey_active_id');
    const activeId = activeIdStr ? parseInt(activeIdStr, 10) : NaN;
    // Invariant 3: fail closed — never prune when we cannot identify the active key.
    if (!Number.isFinite(activeId)) return [];

    const ids = secureStore.keys()
        .map((k) => /^signed_prekey_priv_(\d+)$/.exec(k)?.[1])
        .filter((v): v is string => v != null)
        .map(Number);

    const deleted: number[] = [];

    for (const id of ids) {
        // Invariant 1: the live key stays, and its stamp is cleared in case it
        // was previously superseded and then somehow became active again.
        if (id === activeId) {
            secureStore.delete(`signed_prekey_superseded_${id}`);
            continue;
        }

        const stampRaw = secureStore.get(`signed_prekey_superseded_${id}`);
        const stamp = stampRaw ? Date.parse(stampRaw) : NaN;

        // Invariant 2: first sighting (or a corrupted stamp) starts the clock.
        if (!Number.isFinite(stamp)) {
            secureStore.set(`signed_prekey_superseded_${id}`, new Date(now).toISOString());
            continue;
        }

        // A stamp in the future (clock moved backwards) must not make a key
        // immediately deletable, and must not make it immortal either —
        // re-stamp to now and let it age normally.
        if (stamp > now) {
            secureStore.set(`signed_prekey_superseded_${id}`, new Date(now).toISOString());
            continue;
        }

        if (now - stamp > SPK_RETENTION_MS) {
            secureStore.delete(`signed_prekey_priv_${id}`);
            secureStore.delete(`signed_prekey_pub_${id}`);
            secureStore.delete(`signed_prekey_sig_${id}`);
            secureStore.delete(`signed_prekey_superseded_${id}`);
            deleted.push(id);
        }
    }

    if (deleted.length > 0) {
        console.log(`[E2EE] Pruned ${deleted.length} superseded signed prekey(s): ${deleted.join(', ')}`);
    }
    return deleted;
}

// ---------------------------------------------------------------------------
// Migration: populate signed_prekey_pub_${id} if it is missing from the store
// ---------------------------------------------------------------------------
export async function migrateSpkPubIfMissing(): Promise<void> {
    await secureStore.initialize();
    const spkId = secureStore.get('signed_prekey_active_id');
    if (!spkId) return;
    if (secureStore.get(`signed_prekey_pub_${spkId}`)) return;

    const privHex = secureStore.get(`signed_prekey_priv_${spkId}`);
    if (!privHex) return;

    try {
        const privKey = crypto.createPrivateKey({
            key: { kty: 'OKP', crv: 'X25519', d: Buffer.from(privHex, 'hex').toString('base64url') },
            format: 'jwk',
        });
        const pubKey = crypto.createPublicKey(privKey);
        const pubJwk = pubKey.export({ format: 'jwk' }) as { x: string };
        const pubB64 = Buffer.from(pubJwk.x, 'base64url').toString('base64');
        secureStore.set(`signed_prekey_pub_${spkId}`, pubB64);
        console.log('[E2EE] Migration: derived and stored signed prekey public key.');
        return;
    } catch (e) {
        console.warn('[E2EE] Migration: could not derive pub from priv, generating fresh pair.', e);
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const privJwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    const pubJwk  = publicKey.export({ format: 'jwk' }) as { x: string };
    secureStore.set(`signed_prekey_priv_${spkId}`, Buffer.from(privJwk.d, 'base64url').toString('hex'));
    secureStore.set(`signed_prekey_pub_${spkId}`,  Buffer.from(pubJwk.x,  'base64url').toString('base64'));
    secureStore.set('needs_bundle_reupload', 'true');
    console.warn('[E2EE] Migration: generated fresh signed prekey pair. Bundle needs re-upload.');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateEd25519Pair(): { privHex: string; pubB64: string } {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    return {
        privHex: Buffer.from(jwk.d, 'base64url').toString('hex'),
        pubB64:  Buffer.from(jwk.x, 'base64url').toString('base64'),
    };
}

function generateX25519Pair(): { privHex: string; pubB64: string } {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    return {
        privHex: Buffer.from(jwk.d, 'base64url').toString('hex'),
        pubB64:  Buffer.from(jwk.x, 'base64url').toString('base64'),
    };
}

/** Derive X25519 public key from its private key raw bytes (hex). */
function deriveX25519Pub(privHex: string): string {
    const privKey = crypto.createPrivateKey({
        key: { kty: 'OKP', crv: 'X25519', d: Buffer.from(privHex, 'hex').toString('base64url') },
        format: 'jwk',
    });
    const pubJwk = crypto.createPublicKey(privKey).export({ format: 'jwk' }) as { x: string };
    return Buffer.from(pubJwk.x, 'base64url').toString('base64');
}

function signWithEd25519(privHex: string, pubB64: string, data: Buffer): Buffer {
    const privateKey = crypto.createPrivateKey({
        key: { kty: 'OKP', crv: 'Ed25519',
               d: Buffer.from(privHex, 'hex').toString('base64url'),
               x: Buffer.from(pubB64, 'base64').toString('base64url') },
        format: 'jwk',
    });
    return Buffer.from(crypto.sign(null, data, privateKey));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IdentityBundle {
    identity_key_pub_b64: string;
    registration_id: number;
    signed_prekey: { id: number; pub_b64: string; sig_b64: string };
    one_time_prekeys: { prekey_id: number; prekey_pub_b64: string }[];
}

/**
 * Ensures a Signal-style identity exists locally. Generates one if missing.
 * Always returns the full bundle so the caller can upload it to the server.
 */
export async function ensureSignalIdentity(): Promise<{ isNew: boolean; bundle: IdentityBundle }> {
    await secureStore.initialize();
    // A new identity writes ~200 keys (100 one-time prekeys, each a priv+pub
    // pair). batch() lands them in ONE vault write instead of one per key;
    // everything is still on disk before this resolves (and so before the
    // renderer can upload the public half).
    return secureStore.batch(ensureSignalIdentitySync);
}

function ensureSignalIdentitySync(): { isNew: boolean; bundle: IdentityBundle } {
    const identityPrivHex   = secureStore.get('identity_priv');
    const registrationIdStr = secureStore.get('registration_id');

    if (!identityPrivHex || !registrationIdStr) {
        console.log('[E2EE] Generating new Signal Identity...');

        const identity        = generateEd25519Pair();
        const registrationId  = crypto.randomInt(1, 16380);
        const signedPreKeyId  = 1;
        const signedPreKey    = generateX25519Pair();
        const spkPubBytes     = Buffer.from(signedPreKey.pubB64, 'base64');
        const signature       = signWithEd25519(identity.privHex, identity.pubB64, spkPubBytes);

        secureStore.set('identity_priv',              identity.privHex);
        secureStore.set('identity_pub',               identity.pubB64);
        secureStore.set('registration_id',            registrationId.toString());
        secureStore.set(`signed_prekey_priv_${signedPreKeyId}`, signedPreKey.privHex);
        secureStore.set(`signed_prekey_pub_${signedPreKeyId}`,  signedPreKey.pubB64);
        secureStore.set(`signed_prekey_sig_${signedPreKeyId}`,  signature.toString('base64'));
        secureStore.set('signed_prekey_active_id',    signedPreKeyId.toString());

        const oneTimePrekeys: { prekey_id: number; prekey_pub_b64: string }[] = [];
        for (let i = 1; i <= 100; i++) {
            const otp = generateX25519Pair();
            secureStore.set(`otp_priv_${i}`, otp.privHex);
            secureStore.set(`otp_pub_${i}`,  otp.pubB64);
            oneTimePrekeys.push({ prekey_id: i, prekey_pub_b64: otp.pubB64 });
        }
        secureStore.set('otp_max_id', '100');
        // Mint stamp for ids 1..100 — the floor that lets `mayRetireOtp` refuse
        // an impossible retirement instruction from the server.
        stampOtpBatch(1);

        return {
            isNew: true,
            bundle: {
                identity_key_pub_b64: identity.pubB64,
                registration_id: registrationId,
                signed_prekey: { id: signedPreKeyId, pub_b64: signedPreKey.pubB64, sig_b64: signature.toString('base64') },
                one_time_prekeys: oneTimePrekeys,
            },
        };
    }

    // Keys already exist — reconstruct the bundle from the store
    return { isNew: false, bundle: _buildBundleFromStore(identityPrivHex, registrationIdStr) };
}

/** Reconstruct the key bundle entirely from the local secure store. */
function _buildBundleFromStore(identityPrivHex: string, registrationIdStr: string): IdentityBundle {
    const identityPubB64 = secureStore.get('identity_pub')!;
    const spkId          = parseInt(secureStore.get('signed_prekey_active_id')!, 10);
    const spkPubB64      = secureStore.get(`signed_prekey_pub_${spkId}`) ?? deriveX25519Pub(secureStore.get(`signed_prekey_priv_${spkId}`)!);
    // Re-sign in case the stored signature is absent (older installs)
    let sigB64 = secureStore.get(`signed_prekey_sig_${spkId}`);
    if (!sigB64) {
        const sig = signWithEd25519(identityPrivHex, identityPubB64, Buffer.from(spkPubB64, 'base64'));
        sigB64 = sig.toString('base64');
        secureStore.set(`signed_prekey_sig_${spkId}`, sigB64);
    }

    // Collect all OTPs we have stored
    const oneTimePrekeys: { prekey_id: number; prekey_pub_b64: string }[] = [];
    const maxIdStr = secureStore.get('otp_max_id');
    if (maxIdStr) {
        const maxId = parseInt(maxIdStr, 10);
        for (let i = 1; i <= maxId; i++) {
            const privHex = secureStore.get(`otp_priv_${i}`);
            if (!privHex) continue;
            const pubB64 = secureStore.get(`otp_pub_${i}`) ?? deriveX25519Pub(privHex);
            if (!secureStore.get(`otp_pub_${i}`)) secureStore.set(`otp_pub_${i}`, pubB64);
            oneTimePrekeys.push({ prekey_id: i, prekey_pub_b64: pubB64 });
        }
    }

    return {
        identity_key_pub_b64: identityPubB64,
        registration_id: parseInt(registrationIdStr, 10),
        signed_prekey: { id: spkId, pub_b64: spkPubB64, sig_b64: sigB64 },
        one_time_prekeys: oneTimePrekeys,
    };
}

/** Server-side cap on one_time_prekeys per upload (UploadBundleDto @ArrayMaxSize). */
const OTP_UPLOAD_CAP = 200;

/**
 * Key prefix for a one-time-prekey BATCH mint timestamp: `otp_mint_<startId>`
 * holds the epoch-ms at which ids `startId .. nextStartId - 1` were generated.
 *
 * Per BATCH, not per id: a batch is minted in one call, so one stamp covers all
 * 100 of them and the store grows by one key per top-up rather than 100.
 */
const OTP_MINT_PREFIX = 'otp_mint_';

/** Record that ids `startId..` were minted now. */
function stampOtpBatch(startId: number, now: number = Date.now()): void {
    secureStore.set(`${OTP_MINT_PREFIX}${startId}`, String(now));
}

/**
 * When was prekey `id` minted? `null` = unknown (no stamp covers it).
 *
 * Batches are contiguous and non-overlapping by construction — each starts at
 * the previous `otp_max_id + 1` — so the batch covering `id` is the one with
 * the greatest `startId <= id`.
 */
function otpMintTime(id: number): number | null {
    let bestStart = -1;
    let bestTs: number | null = null;
    for (const k of secureStore.keys()) {
        if (!k.startsWith(OTP_MINT_PREFIX)) continue;
        const start = Number(k.slice(OTP_MINT_PREFIX.length));
        if (!Number.isInteger(start) || start > id || start <= bestStart) continue;
        const ts = Number(secureStore.get(k));
        if (!Number.isFinite(ts)) continue;
        bestStart = start;
        bestTs = ts;
    }
    return bestTs;
}

/**
 * May the server's `retired_prekey_ids` be believed for this id?
 *
 * THE POINT OF THIS CHECK. `retired_prekey_ids` is an instruction from the
 * server to DELETE key material, and this product's whole threat model is that
 * the server is not trusted. Without a client-side sanity check, a compromised
 * or hostile server could name every id and permanently destroy this device's
 * ability to decrypt envelopes it has already been sent — a step up from "can
 * delay or drop" (which the server can always do) to "can permanently destroy",
 * and one that is invisible in testing and unrecoverable in the field.
 *
 * The check is a LOCAL CONTRADICTION test that trusts nobody: the server claims
 * this prekey was CLAIMED more than one envelope-retention window ago. A claim
 * cannot precede the mint. So if we minted it more recently than that window,
 * the server's claim is impossible and we refuse.
 *
 * It is MONOTONIC IN THE SAFE DIRECTION — it can only ever prevent a deletion,
 * never enable one. That is the right shape for client-side logic here: it does
 * not make the client load-bearing for security (the server still enforces
 * reuse prevention), it makes the client refuse to destroy its own data on
 * request.
 *
 * NO STAMP => REFUSE. Every device in the existing fleet, and every prekey
 * minted before this shipped, has no stamp. Refusing means such a store stays
 * slightly larger than necessary until its ids age out through natural
 * rotation; retiring blindly means messages can vanish. The growth is already
 * bounded by the carry-forward gate (those ids are no longer re-offered, so
 * they stop costing pool slots and bandwidth — only local bytes), so the
 * downside of refusing is the cheaper one by a wide margin.
 *
 * Clock skew resolves safely in the common direction: a clock moved BACKWARDS
 * makes keys look newer and refuses more. A clock moved far FORWARDS could
 * allow an early retirement, but only for an id the server ALSO named — two
 * independent things must go wrong, and one of them is already the server.
 *
 * `SERVER_ENVELOPE_RETENTION_MS` is the same window the server derives
 * `retired_prekey_ids` from (`UNACKED_ENVELOPE_RETENTION_MS` in
 * `apps/api/src/common/retention.ts`) and the same one `SPK_RETENTION_MS` is
 * built on — deliberately reused rather than introducing a third notion of it.
 */
function mayRetireOtp(id: number, now: number = Date.now()): boolean {
    const mintedAt = otpMintTime(id);
    if (mintedAt === null) return false;
    return now - mintedAt > SERVER_ENVELOPE_RETENTION_MS;
}

/**
 * Drop mint stamps whose batch holds no prekey privates any more.
 *
 * Without this the stamps are the one piece of state in this file that grows
 * forever: one key per top-up, and a busy device tops up whenever its pool
 * drops below 20. A stamp whose whole batch has been consumed or retired can
 * answer no future question — `mayRetireOtp` is only ever asked about an id we
 * still hold — so it is pure residue.
 *
 * Deliberately conservative: a stamp is removed only when EVERY id it covers is
 * gone. Removing one early would make `otpMintTime` fall back to an OLDER
 * batch's stamp for the survivors (the lookup takes the greatest startId <= id),
 * which would make them look older than they are — the unsafe direction. The
 * batch boundary is the next stamped startId, so the newest stamp is never
 * removed while `otp_max_id` ids could still exist under it.
 */
function pruneOtpMintStamps(): void {
    const starts = secureStore.keys()
        .filter((k) => k.startsWith(OTP_MINT_PREFIX))
        .map((k) => Number(k.slice(OTP_MINT_PREFIX.length)))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
    if (starts.length === 0) return;

    const held = new Set<number>();
    for (const k of secureStore.keys()) {
        const m = /^otp_priv_(\d+)$/.exec(k);
        if (m) held.add(Number(m[1]));
    }

    for (let i = 0; i < starts.length; i++) {
        const from = starts[i];
        // The last batch is open-ended: anything at or above its start belongs
        // to it, including ids not yet minted.
        const to = i + 1 < starts.length ? starts[i + 1] - 1 : Infinity;
        let occupied = false;
        for (const id of held) {
            if (id >= from && id <= to) { occupied = true; break; }
        }
        if (!occupied) secureStore.delete(`${OTP_MINT_PREFIX}${from}`);
    }
}

/**
 * Normalize a prekey-id list received from `GET /v1/keys/status`.
 *
 * Returns `null` for "the server did not tell us" (absent, or not an array) and
 * a filtered array otherwise. The distinction is load-bearing: `null` means the
 * carry gate is SKIPPED and nothing is retired, while `[]` means the server
 * answered and the set is genuinely empty. Collapsing the two would turn a
 * failed status call into a mass delete of every one-time-prekey private on the
 * device.
 *
 * Elements are filtered rather than the whole list rejected, because a single
 * odd element should not disable key hygiene — but a non-integer id could only
 * ever name a key that does not exist, so dropping it loses nothing.
 */
function sanitizeIdList(v: unknown): number[] | null {
    if (!Array.isArray(v)) return null;
    return v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
}

/**
 * The lowest one-time-prekey id this device still holds a private for, or null
 * if it holds none.
 *
 * This is the paging cursor for `retired_prekey_ids` (see
 * `KeysService.getKeyStatus`). The server caps that page, and spend tombstones
 * accumulate for the life of the device, so without a cursor a long-lived
 * device would be handed the same lowest page forever and never learn about the
 * rest. Anchoring the page at what we still hold makes the window SLIDE: we
 * delete the page, this value rises, and the next page is new.
 *
 * Deliberately derived from the store rather than persisted as a watermark. A
 * persisted high-water mark would permanently skip any id BELOW it that is
 * claimed later — and low ids stay claimable indefinitely, because an unclaimed
 * low id is carried forward on every top-up. Reading live state cannot skip.
 */
export function lowestHeldOtpId(): number | null {
    let min: number | null = null;
    for (const k of secureStore.keys()) {
        const m = /^otp_priv_(\d+)$/.exec(k);
        if (!m) continue;
        const id = Number(m[1]);
        if (Number.isInteger(id) && id > 0 && (min === null || id < min)) min = id;
    }
    return min;
}

/**
 * Generate a fresh key bundle: 100 new one-time prekeys, and — when
 * `rotateSpk` is true — a new signed prekey as well.
 *
 * WHY `rotateSpk` IS SEPARABLE (C5). Before OTPs were actually consumed, this
 * function ran roughly once a month and rotating the SPK every time was free.
 * Now that every message spends a recipient OTP, the pool needs topping up
 * far more often than the SPK needs rotating — and coupling the two would be
 * actively harmful: each rotation leaves ANOTHER superseded SPK private in the
 * store, `decryptEnvelope` tries every one of them as a candidate, and
 * `pruneSupersededSignedPrekeys` holds each for 35 days. Topping up OTPs every
 * 15 minutes with the SPK coupled in would accumulate thousands of retained
 * private keys — simultaneously a linear slowdown on every decrypt and a
 * direct expansion of the very SecureStore-dump exposure the pruning above
 * exists to shrink. So: SPK rotates on its own 25-day schedule
 * (`spk_age_days` from GET /v1/keys/status), OTPs top up on demand.
 *
 * Both paths return the carried-over unconsumed OTPs alongside the new ones,
 * because POST /v1/keys/upload_bundle DELETES every unclaimed prekey for the
 * device before inserting what we send. Omitting the survivors would silently
 * throw away perfectly good keys on every top-up.
 *
 * The caller is responsible for uploading the returned bundle to
 * POST /v1/keys/upload_bundle with the device's own device_id added.
 *
 * `unclaimedPrekeyIds` / `retiredPrekeyIds` come straight from
 * `GET /v1/keys/status` and drive the carry-forward decision below. Both are
 * OPTIONAL and FAIL SAFE: omitted (an older server, or a status call that
 * failed) means "carry what you hold, delete nothing" — exactly the behaviour
 * that existed before this contract.
 */
export async function generateRotationBundle(
    opts: {
        rotateSpk?: boolean;
        /** Ids the server says are still UNCLAIMED. Omitted => unknown. */
        unclaimedPrekeyIds?: number[];
        /** Ids the server says are safe to FORGET. Omitted => delete nothing. */
        retiredPrekeyIds?: number[];
    } = {},
): Promise<IdentityBundle> {
    // Default true: preserves the original behaviour for any caller that does
    // not pass the flag.
    const rotateSpk = opts.rotateSpk !== false;

    // Both sets are validated rather than trusted in shape: these arrive over
    // IPC from the renderer, which got them over the network. A non-array, or a
    // non-integer element, must degrade to "unknown" — never to a delete.
    const unclaimed = sanitizeIdList(opts.unclaimedPrekeyIds);
    const retired = sanitizeIdList(opts.retiredPrekeyIds);

    await secureStore.initialize();

    // ONE vault write for the whole top-up. Each set()/delete() below used to
    // rewrite the entire vault synchronously on the main thread — 200+ full
    // rewrites for a 100-prekey batch, on the thread that owns the window, and
    // this runs right after a wake (the WebSocket reconnect triggers the
    // prekey check). batch() keeps the durability contract: every key is on
    // disk before this resolves, so before the renderer uploads the publics.
    return secureStore.batch(() => buildRotationBundle(rotateSpk, unclaimed, retired));
}

function buildRotationBundle(rotateSpk: boolean, unclaimed: number[] | null, retired: number[] | null): IdentityBundle {
    const identityPrivHex   = secureStore.get('identity_priv');
    const identityPubB64    = secureStore.get('identity_pub');
    const registrationIdStr = secureStore.get('registration_id');
    if (!identityPrivHex || !identityPubB64 || !registrationIdStr) {
        throw new Error('[E2EE] Identity not initialized — cannot generate rotation bundle');
    }

    const currentSpkId = parseInt(secureStore.get('signed_prekey_active_id') ?? '1', 10);

    // New OTPs: IDs start AFTER the current max so existing private keys (needed
    // for decrypting already-claimed OTPs) are never overwritten.
    const currentMaxOtpId = parseInt(secureStore.get('otp_max_id') ?? '100', 10);
    const newOtps: { prekey_id: number; prekey_pub_b64: string }[] = [];
    for (let i = currentMaxOtpId + 1; i <= currentMaxOtpId + 100; i++) {
        const otp = generateX25519Pair();
        secureStore.set(`otp_priv_${i}`, otp.privHex);
        secureStore.set(`otp_pub_${i}`,  otp.pubB64);
        newOtps.push({ prekey_id: i, prekey_pub_b64: otp.pubB64 });
    }
    // Stamp the batch BEFORE the retirement loop below runs. A freshly minted id
    // can never be legitimately retired, and `mayRetireOtp` is what enforces
    // that — so the stamp has to exist by the time it is consulted.
    stampOtpBatch(currentMaxOtpId + 1);

    // Retire first: drop the privates the SERVER has told us are safe to forget,
    // so they cannot be considered for carry-forward below.
    //
    // "Safe to forget" is the server's judgement, not ours, and it is narrow on
    // purpose: an id whose claim is older than the server's own unacked-envelope
    // retention window, so no envelope encrypted to it can still be waiting to
    // be collected. See KeysService.getKeyStatus. We MUST NOT widen this — in
    // particular we must not infer "delete" from "absent from `unclaimed`" (see
    // the three-way split below).
    // `?? []` is the fail-safe: `null` means the server said nothing (an older
    // build, or a status call that failed), and that must retire NOTHING.
    //
    // An id in BOTH lists is a CONTRADICTION — the server cannot coherently say
    // a prekey is simultaneously unclaimed and claimed-long-ago. We resolve it
    // by NOT deleting. Every ambiguity in this function resolves the same
    // direction, and the reason is asymmetry of harm: keeping a private we no
    // longer need costs ~110 bytes of local storage, while deleting one we do
    // need costs a message that nothing anywhere can ever decrypt again.
    //
    // `mayRetireOtp` is the SECOND gate and it trusts nobody: the server's
    // instruction is only acted on when our OWN mint record makes its claim
    // possible. A prekey minted 3 days ago cannot have been claimed 30 days
    // ago. See that function for the full argument — in short, `retired_prekey_
    // ids` is a delete-key-material instruction from a party this product does
    // not trust, and this is the client refusing to destroy its own data on an
    // impossible request. The check can only ever PREVENT a deletion.
    const unclaimedGuard = unclaimed ? new Set(unclaimed) : null;
    for (const id of retired ?? []) {
        if (unclaimedGuard?.has(id)) continue;
        if (!mayRetireOtp(id)) continue;
        secureStore.delete(`otp_priv_${id}`);
        secureStore.delete(`otp_pub_${id}`);
    }
    // Keep the stamp table bounded by the same thing that bounds the privates.
    pruneOtpMintStamps();

    // Carry over prekeys we still hold privates for AND the server still lists
    // as unclaimed. Newest first, then trimmed to the server's cap, so a top-up
    // never drops the keys it just minted in favour of stale ones.
    //
    // WHAT THIS SET ACTUALLY IS. An earlier version of this comment claimed "a
    // private survives locally only until the message that used it is decrypted
    // (the decrypt path deletes it), so this is exactly the set that is still
    // usable." That was FALSE, and naming the failure mode is the whole reason
    // this loop now has a second gate. `otp_priv_<id>` is deleted in exactly two
    // places: e2ee-engine.ts on a SUCCESSFUL decrypt, and the retirement loop
    // directly above. A prekey that a peer CLAIMED but never actually sent to
    // (an abandoned send, a failed send, or a deliberate pool burn by a hostile
    // claimer) is never decrypted, so its private lives here until the server
    // retires it. "Do I still hold a private" alone cannot tell a live key from
    // one the server already spent — which is what produced prekey reuse:
    // measured 2026-09-15, sender ALICE claimed prekey_id 77, the then-DELETING
    // sweep removed the row, this loop re-offered 77, and sender BOB received
    // the IDENTICAL public key.
    //
    // THE THREE-WAY SPLIT — do not "simplify" this into two cases.
    //
    //   in `unclaimed`      -> CARRY. The server will still serve it; it is a
    //                          live, unspent key and dropping it would waste a
    //                          perfectly good prekey (upload_bundle deletes
    //                          every unclaimed row before inserting).
    //   in `retired`        -> DELETE, above. The server's retention window
    //                          guarantees nothing in flight still needs it.
    //   in NEITHER          -> KEEP THE PRIVATE, DO NOT CARRY THE ID.
    //
    // That last case is the conservative middle and it is the one that closes
    // the residual, so it is worth spelling out what lands there:
    //
    //   • Claimed RECENTLY. Someone holds this prekey and may not have SENT yet;
    //     an envelope encrypted to it can still be sitting unacked on the
    //     server. Deleting the private here would make that message permanently
    //     undecryptable — silent, unrecoverable data loss, strictly worse than
    //     the reuse bug. So we keep it. We also do not re-offer it: the server
    //     would reject it anyway (`uploadBundle` drops already-spent ids), and
    //     offering it burns a carry slot while adding nothing to the pool.
    //   • NO ROW AT ALL — the legacy orphans. Rows the OLD, hard-DELETING sweep
    //     already destroyed in production have no tombstone and never will, so
    //     the server cannot recognise these ids as spent. Carrying one forward
    //     re-inserts it as a FRESH, UNCLAIMED prekey and it is served a second
    //     time. This client-side gate is the ONLY thing that closes that case,
    //     because only we know we still hold the private. The private is kept
    //     (the first claimer may still send), the id is simply never re-offered.
    //
    // FAIL SAFE. When the server said nothing — an older build, or a status call
    // that failed — `unclaimed` is null and the gate is skipped entirely,
    // reverting to the pre-contract "carry what you hold" behaviour. An empty
    // ARRAY is not the same as null: it means the server answered and the pool
    // is genuinely empty, so nothing is carried. Nothing is ever deleted on an
    // error path or a missing field.
    //
    // Ids themselves are safe: `otp_max_id` is bumped on BOTH branches below,
    // so newly minted ids are strictly monotonic and never overwrite a private
    // that an in-flight envelope still needs.
    const carried: { prekey_id: number; prekey_pub_b64: string }[] = [];
    for (let i = currentMaxOtpId; i >= 1 && carried.length < OTP_UPLOAD_CAP; i--) {
        const privHex = secureStore.get(`otp_priv_${i}`);
        if (!privHex) continue;
        // `unclaimedGuard === null` (the server said nothing) skips the gate
        // entirely — the pre-contract fail-safe.
        if (unclaimedGuard && !unclaimedGuard.has(i)) continue;
        const pubB64 = secureStore.get(`otp_pub_${i}`) ?? deriveX25519Pub(privHex);
        carried.push({ prekey_id: i, prekey_pub_b64: pubB64 });
    }
    const allOtps = [...newOtps, ...carried].slice(0, OTP_UPLOAD_CAP);

    if (!rotateSpk) {
        // OTP-only top-up: reuse the active signed prekey exactly as the server
        // already has it. Nothing is superseded, so nothing is stamped.
        const spkPubB64 = secureStore.get(`signed_prekey_pub_${currentSpkId}`)
            ?? deriveX25519Pub(secureStore.get(`signed_prekey_priv_${currentSpkId}`)!);
        let sigB64 = secureStore.get(`signed_prekey_sig_${currentSpkId}`);
        if (!sigB64) {
            sigB64 = signWithEd25519(identityPrivHex, identityPubB64, Buffer.from(spkPubB64, 'base64')).toString('base64');
            secureStore.set(`signed_prekey_sig_${currentSpkId}`, sigB64);
        }
        secureStore.set('otp_max_id', (currentMaxOtpId + 100).toString());

        console.log(`[E2EE] OTP top-up: ${newOtps.length} new + ${allOtps.length - newOtps.length} carried, SPK ${currentSpkId} unchanged`);

        return {
            identity_key_pub_b64: identityPubB64,
            registration_id: parseInt(registrationIdStr, 10),
            signed_prekey: { id: currentSpkId, pub_b64: spkPubB64, sig_b64: sigB64 },
            one_time_prekeys: allOtps,
        };
    }

    // Rotate SPK: increment ID so the server stores a new entry and the old SPK
    // private key is kept locally for decrypting any in-flight messages that were
    // already wrapped for the old SPK.
    const newSpkId     = currentSpkId + 1;
    const newSpk       = generateX25519Pair();
    const newSpkSig    = signWithEd25519(identityPrivHex, identityPubB64, Buffer.from(newSpk.pubB64, 'base64'));

    // Persist new active SPK. The old private key STAYS in the store — it is
    // still needed for envelopes already in flight against it — but it is now
    // superseded, so stamp it to start its retention clock. Without this stamp
    // `pruneSupersededSignedPrekeys` would only discover the key on some later
    // run and start the clock from there; stamping at the actual moment of
    // supersession is what makes the 35-day window mean what it says.
    //
    // Stamped BEFORE the active id flips so there is no window in which the
    // outgoing key is neither active nor stamped.
    secureStore.set(`signed_prekey_superseded_${currentSpkId}`, new Date().toISOString());
    secureStore.set(`signed_prekey_priv_${newSpkId}`, newSpk.privHex);
    secureStore.set(`signed_prekey_pub_${newSpkId}`,  newSpk.pubB64);
    secureStore.set(`signed_prekey_sig_${newSpkId}`,  newSpkSig.toString('base64'));
    secureStore.set('signed_prekey_active_id', newSpkId.toString());
    secureStore.set('otp_max_id', (currentMaxOtpId + 100).toString());

    // Opportunistic prune: rotation is exactly when a key becomes superseded,
    // so it is the natural moment to retire anything that aged out.
    pruneSupersededSignedPrekeys();

    console.log(`[E2EE] Rotation bundle: SPK ${newSpkId}, OTPs ${currentMaxOtpId + 1}–${currentMaxOtpId + 100}`);

    return {
        identity_key_pub_b64: identityPubB64,
        registration_id: parseInt(registrationIdStr, 10),
        signed_prekey: { id: newSpkId, pub_b64: newSpk.pubB64, sig_b64: newSpkSig.toString('base64') },
        // Carried survivors included for the same reason as the top-up path:
        // upload_bundle wipes unclaimed prekeys before inserting.
        one_time_prekeys: allOtps,
    };
}

export async function getIdentityPrivateKey(): Promise<crypto.KeyObject> {
    const privHex = secureStore.get('identity_priv');
    const pubB64  = secureStore.get('identity_pub');
    if (!privHex || !pubB64) throw new Error('Identity not generated');
    return crypto.createPrivateKey({
        key: { kty: 'OKP', crv: 'Ed25519',
               d: Buffer.from(privHex, 'hex').toString('base64url'),
               x: Buffer.from(pubB64, 'base64').toString('base64url') },
        format: 'jwk',
    });
}

export function getLocalIdentityPub(): string | null {
    return secureStore.get('identity_pub');
}

/**
 * Sign an arbitrary message with the device's Ed25519 identity private key,
 * returning a base64 signature (or null if the identity isn't generated yet).
 * Used for device-registration proof-of-possession.
 */
export function signIdentityMessage(message: string): string | null {
    const privHex = secureStore.get('identity_priv');
    const pubB64 = secureStore.get('identity_pub');
    if (!privHex || !pubB64) return null;
    return signWithEd25519(privHex, pubB64, Buffer.from(message, 'utf8')).toString('base64');
}
