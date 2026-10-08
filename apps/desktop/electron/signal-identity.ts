import { secureStore } from './storage';
import * as crypto from 'crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

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

    // The prefix index, not a scan of the whole vault (which also holds every
    // one-time prekey, both replay sets and every channel key).
    const ids = secureStore.keysWithPrefix('signed_prekey_priv_')
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
            secureStore.delete(`${SPK_CREATED_PREFIX}${id}`);
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
        // (A d-only JWK import here always threw on Node 22 and fell through
        // to REPLACING the signed prekey private below — see deriveX25519Pub.)
        const pubB64 = deriveX25519Pub(privHex);
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

type KeyPairHex = { privHex: string; pubB64: string };

function exportPair(privateKey: crypto.KeyObject): KeyPairHex {
    const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    return {
        privHex: Buffer.from(jwk.d, 'base64url').toString('hex'),
        pubB64:  Buffer.from(jwk.x, 'base64url').toString('base64'),
    };
}

/**
 * Key generation OFF the main thread. `crypto.generateKeyPair` (the async
 * variant) runs in libuv's thread pool; the result is the same key the
 * synchronous call would have produced from the same CSPRNG. A top-up mints a
 * hundred of these, and the main thread owns every window.
 */
function generatePairAsync(type: 'x25519' | 'ed25519'): Promise<KeyPairHex> {
    return new Promise((resolve, reject) => {
        const done = (err: Error | null, _pub: crypto.KeyObject, priv: crypto.KeyObject) => {
            if (err) reject(err);
            else resolve(exportPair(priv));
        };
        if (type === 'x25519') crypto.generateKeyPair('x25519', undefined, done);
        else crypto.generateKeyPair('ed25519', undefined, done);
    });
}

function generateX25519PairsAsync(n: number): Promise<KeyPairHex[]> {
    return Promise.all(Array.from({ length: n }, () => generatePairAsync('x25519')));
}

/**
 * One key operation at a time. ensureSignalIdentity and generateRotationBundle
 * read the store, generate keys asynchronously, then write; two of them
 * interleaving across that await could both decide to mint (two identities, or
 * two batches over the same id range). Serialising them makes each one see the
 * other's finished result.
 */
let keyOpTail: Promise<unknown> = Promise.resolve();
function serializedKeyOp<T>(op: () => Promise<T>): Promise<T> {
    const run = keyOpTail.then(op, op);
    keyOpTail = run.catch(() => {});
    return run;
}

const OTP_PRIV_PREFIX = 'otp_priv_';

/**
 * Ids of every one-time prekey this device still holds a private for, read
 * from the store's prefix index.
 *
 * This replaced walking `1..otp_max_id` with a `get()` per id. `otp_max_id`
 * grows by 100 on every top-up and never shrinks, and every `get()` of a held
 * id is an AES-GCM decrypt — on a long-lived install that walk was the single
 * biggest block on the main thread (measured ~1.2 s for 20k held prekeys, and
 * it ran on every `crypto:ensure-identity-bundle`).
 */
function heldOtpIds(): number[] {
    const out: number[] = [];
    for (const k of secureStore.keysWithPrefix(OTP_PRIV_PREFIX)) {
        const digits = k.slice(OTP_PRIV_PREFIX.length);
        const id = Number(digits);
        // Canonical decimal only (same set the old /^otp_priv_(\d+)$/ matched,
        // minus leading zeros, which no writer produces) — without a regex per
        // key, because a long-lived device holds tens of thousands of these.
        if (Number.isSafeInteger(id) && id > 0 && String(id) === digits) out.push(id);
    }
    return out;
}

/** Stamp when a signed prekey was minted: `signed_prekey_created_<id>` (ms). */
const SPK_CREATED_PREFIX = 'signed_prekey_created_';

/**
 * Rotate the active signed prekey once it is this old by THIS DEVICE'S clock.
 * Same 25 days the server uses for `spk_age_days` (KeysService.getKeyStatus).
 *
 * Why the client keeps its own clock: the server's `spk_age_days` is computed
 * from `signed_prekey_created`, a TypeORM CreateDateColumn — set when the
 * device's bundle row is first INSERTED and never updated by a later upload.
 * So 25 days after a device's first upload the server reports "rotate" on
 * EVERY status check, forever, and a client that obeys mints a new signed
 * prekey every 15 minutes (each one retained 35 days and tried on every
 * decrypt). The local stamp is what makes "roughly monthly" true.
 */
export const SPK_ROTATE_AFTER_MS = 25 * DAY_MS;

/**
 * Is the active signed prekey due for rotation by the local clock?
 *
 * A key with no creation stamp (every key minted before this existed) or a
 * stamp in the future (clock moved back) is STAMPED NOW and reported not due —
 * the same "start the clock, never act on an unknown age" rule the
 * superseded-key pruning uses. Costs at most one extra rotation period once.
 */
function localSpkRotationDue(spkId: number, now: number): boolean {
    const raw = secureStore.get(`${SPK_CREATED_PREFIX}${spkId}`);
    const created = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(created) || created > now) {
        secureStore.set(`${SPK_CREATED_PREFIX}${spkId}`, String(now));
        return false;
    }
    return now - created >= SPK_ROTATE_AFTER_MS;
}

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

/**
 * PKCS#8 header for a raw 32-byte X25519 private key (RFC 8410: SEQUENCE {
 * version 0, AlgorithmIdentifier id-X25519 (1.3.101.110), OCTET STRING {
 * OCTET STRING key } }). Only an ENCODING of the key for Node's importer.
 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** Import a raw X25519 private key (hex) with no public half to hand. */
function importRawX25519Priv(privHex: string): crypto.KeyObject {
    const raw = Buffer.from(privHex, 'hex');
    if (raw.length !== 32) throw new Error('X25519 private key must be 32 bytes');
    return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

/**
 * Derive X25519 public key from its private key raw bytes (hex).
 *
 * This used to import a JWK carrying only `d`. Node 22 (and the Node inside
 * Electron 43) rejects an OKP JWK without `x` — "The "key.x" property must be
 * of type string" — so every derivation threw. It is only reached when a
 * stored public half is missing, which is why it went unnoticed.
 */
function deriveX25519Pub(privHex: string): string {
    const pubJwk = crypto.createPublicKey(importRawX25519Priv(privHex)).export({ format: 'jwk' }) as { x: string };
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
 * Returns the bundle the caller uploads to POST /v1/keys/upload_bundle.
 *
 * For an EXISTING identity the one-time prekeys in the bundle are what this
 * device can safely re-offer, bounded by the server's upload cap:
 *
 *   • newest first, at most OTP_UPLOAD_CAP (200). The bundle used to carry
 *     EVERY held prekey. Once a device held more than 200 — which every device
 *     whose top-ups were failing did (see useKeyRotation) — the upload was a
 *     guaranteed 400 (UploadBundleDto @ArrayMaxSize(200)), useKeyBundleSync
 *     retried it three times, and each try rebuilt the whole list on the main
 *     thread: the "ensure-identity-bundle ×3, ~2.5 s each" freeze.
 *   • `unclaimedPrekeyIds` (from GET /v1/keys/status), when given, is the same
 *     carry gate generateRotationBundle applies: only ids the server still
 *     lists as unclaimed are re-offered, so a prekey that was claimed — or a
 *     legacy orphan the server has no row for — is never served twice. Absent
 *     means the server said nothing; the bundle then falls back to "newest
 *     held", exactly as generateRotationBundle does without the lists.
 *
 * Every key it writes is on disk before this resolves, and so before the
 * renderer can upload a public half.
 */
export async function ensureSignalIdentity(
    opts: { unclaimedPrekeyIds?: unknown } = {},
): Promise<{ isNew: boolean; bundle: IdentityBundle }> {
    const unclaimed = sanitizeIdList(opts.unclaimedPrekeyIds);
    return serializedKeyOp(async () => {
        await secureStore.initialize();
        // A brand-new identity needs 102 key pairs; generate them in the
        // thread pool BEFORE taking the store, not one by one on this thread.
        const isNew = !secureStore.get('identity_priv') || !secureStore.get('registration_id');
        const fresh = isNew
            ? { identity: await generatePairAsync('ed25519'), spk: await generatePairAsync('x25519'), otps: await generateX25519PairsAsync(100) }
            : null;
        const result = secureStore.batch(() => ensureSignalIdentitySync(fresh, unclaimed ? new Set(unclaimed) : null));
        // The vault write is asynchronous now: wait for it. Nothing generated
        // above may reach the renderer (and from there the server) before its
        // private half is on disk.
        await secureStore.whenDurable();
        return result;
    });
}

function ensureSignalIdentitySync(
    fresh: { identity: KeyPairHex; spk: KeyPairHex; otps: KeyPairHex[] } | null,
    unclaimedGate: Set<number> | null,
): { isNew: boolean; bundle: IdentityBundle } {
    const identityPrivHex   = secureStore.get('identity_priv');
    const registrationIdStr = secureStore.get('registration_id');

    if (!identityPrivHex || !registrationIdStr) {
        console.log('[E2EE] Generating new Signal Identity...');
        const now = Date.now();

        const identity        = fresh?.identity ?? generateEd25519Pair();
        const registrationId  = crypto.randomInt(1, 16380);
        const signedPreKeyId  = 1;
        const signedPreKey    = fresh?.spk ?? generateX25519Pair();
        const spkPubBytes     = Buffer.from(signedPreKey.pubB64, 'base64');
        const signature       = signWithEd25519(identity.privHex, identity.pubB64, spkPubBytes);

        secureStore.set('identity_priv',              identity.privHex);
        secureStore.set('identity_pub',               identity.pubB64);
        secureStore.set('registration_id',            registrationId.toString());
        secureStore.set(`signed_prekey_priv_${signedPreKeyId}`, signedPreKey.privHex);
        secureStore.set(`signed_prekey_pub_${signedPreKeyId}`,  signedPreKey.pubB64);
        secureStore.set(`signed_prekey_sig_${signedPreKeyId}`,  signature.toString('base64'));
        secureStore.set(`${SPK_CREATED_PREFIX}${signedPreKeyId}`, String(now));
        secureStore.set('signed_prekey_active_id',    signedPreKeyId.toString());

        const oneTimePrekeys: { prekey_id: number; prekey_pub_b64: string }[] = [];
        for (let i = 1; i <= 100; i++) {
            const otp = fresh?.otps[i - 1] ?? generateX25519Pair();
            secureStore.set(`otp_priv_${i}`, otp.privHex);
            secureStore.set(`otp_pub_${i}`,  otp.pubB64);
            oneTimePrekeys.push({ prekey_id: i, prekey_pub_b64: otp.pubB64 });
        }
        secureStore.set('otp_max_id', '100');
        // Mint stamp for ids 1..100 — the floor that lets `mayRetireOtp` refuse
        // an impossible retirement instruction from the server.
        stampOtpBatch(1, now);

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
    return { isNew: false, bundle: _buildBundleFromStore(identityPrivHex, registrationIdStr, unclaimedGate) };
}

/** Reconstruct the key bundle from the local secure store (see
 *  ensureSignalIdentity for which one-time prekeys it carries and why). */
function _buildBundleFromStore(identityPrivHex: string, registrationIdStr: string, unclaimedGate: Set<number> | null): IdentityBundle {
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

    // Held prekeys from the index (never the 1..otp_max_id range), newest
    // first, gated, capped — so the cost is bounded by what is published,
    // not by the device's whole prekey history.
    const oneTimePrekeys: { prekey_id: number; prekey_pub_b64: string }[] = [];
    const maxId = parseInt(secureStore.get('otp_max_id') ?? '', 10);
    if (Number.isFinite(maxId)) {
        const ids = heldOtpIds()
            .filter((id) => id <= maxId && (!unclaimedGate || unclaimedGate.has(id)))
            .sort((a, b) => b - a);
        for (const id of ids) {
            if (oneTimePrekeys.length >= OTP_UPLOAD_CAP) break;
            let pubB64 = secureStore.get(`otp_pub_${id}`);
            if (!pubB64) {
                const privHex = secureStore.get(`otp_priv_${id}`);
                if (!privHex) continue;
                pubB64 = deriveX25519Pub(privHex);
                secureStore.set(`otp_pub_${id}`, pubB64);
            }
            oneTimePrekeys.push({ prekey_id: id, prekey_pub_b64: pubB64 });
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
 * The mint stamps, read ONCE per operation: ascending batch starts and their
 * epoch-ms (only stamps with a readable time — an unreadable stamp covers
 * nothing, exactly as before).
 */
interface MintTable { starts: number[]; times: number[] }

function loadMintTable(): MintTable {
    const rows: [number, number][] = [];
    for (const k of secureStore.keysWithPrefix(OTP_MINT_PREFIX)) {
        const start = Number(k.slice(OTP_MINT_PREFIX.length));
        if (!Number.isInteger(start)) continue;
        const ts = Number(secureStore.get(k));
        if (!Number.isFinite(ts)) continue;
        rows.push([start, ts]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    return { starts: rows.map((r) => r[0]), times: rows.map((r) => r[1]) };
}

/**
 * When was prekey `id` minted? `null` = unknown (no stamp covers it).
 *
 * Batches are contiguous and non-overlapping by construction — each starts at
 * the previous `otp_max_id + 1` — so the batch covering `id` is the one with
 * the greatest `startId <= id`. A binary search over the table: this used to
 * scan every key in the vault AND decrypt every stamp, once per retired id —
 * with the server's 500-id page that was ~6.6 s on one main-thread turn.
 */
function otpMintTime(id: number, table: MintTable): number | null {
    let lo = 0;
    let hi = table.starts.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (table.starts[mid] <= id) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best >= 0 ? table.times[best] : null;
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
function mayRetireOtp(id: number, table: MintTable, now: number = Date.now()): boolean {
    const mintedAt = otpMintTime(id, table);
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
    const starts = secureStore.keysWithPrefix(OTP_MINT_PREFIX)
        .map((k) => Number(k.slice(OTP_MINT_PREFIX.length)))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
    if (starts.length === 0) return;

    const held = heldOtpIds().sort((a, b) => a - b);

    for (let i = 0; i < starts.length; i++) {
        const from = starts[i];
        // The last batch is open-ended: anything at or above its start belongs
        // to it, including ids not yet minted.
        const to = i + 1 < starts.length ? starts[i + 1] - 1 : Infinity;
        // Lowest held id >= from (binary search), then: is it inside the batch?
        let lo = 0;
        let hi = held.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (held[mid] < from) lo = mid + 1; else hi = mid;
        }
        const occupied = lo < held.length && held[lo] <= to;
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
    for (const id of heldOtpIds()) if (min === null || id < min) min = id;
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
/** Options as the legacy callers pass them: always mint, rotate per flag. */
export interface RotationOptions {
    rotateSpk?: boolean;
    /** Ids the server says are still UNCLAIMED. Omitted => unknown. */
    unclaimedPrekeyIds?: number[];
    /** Ids the server says are safe to FORGET. Omitted => delete nothing. */
    retiredPrekeyIds?: number[];
}

/**
 * STATUS-AWARE mode (what useKeyRotation sends): the renderer says whether the
 * server's one-time-prekey pool is low, and this decides whether anything
 * needs publishing at all.
 *
 *   • pool low                       -> mint 100 and top up (as before)
 *   • signed prekey due (server says
 *     >= 25 days AND the LOCAL stamp
 *     agrees, see SPK_ROTATE_AFTER_MS) -> rotate it, carry the live pool
 *   • neither                        -> null: nothing minted, nothing to upload
 *
 * The third case is the fix for unbounded growth. The server's `needs_rotation`
 * is stuck true for any device older than 25 days, and a top-up whose pool is
 * already healthy pushes 100 still-unclaimed prekeys OUT of the upload (the cap
 * is 200, new ones first) — the server deletes those rows, so their privates
 * are in neither status list and are held forever. Minting only when the pool
 * is actually low is what keeps "carried + new" under the cap.
 */
export interface StatusAwareRotationOptions extends RotationOptions {
    otpPoolLow: boolean;
}

export function generateRotationBundle(opts?: RotationOptions): Promise<IdentityBundle>;
export function generateRotationBundle(opts: StatusAwareRotationOptions): Promise<IdentityBundle | null>;
export function generateRotationBundle(
    opts: RotationOptions & { otpPoolLow?: unknown } = {},
): Promise<IdentityBundle | null> {
    // Default true: preserves the original behaviour for any caller that does
    // not pass the flag.
    const rotateSpk = opts.rotateSpk !== false;
    // Status-aware only when the flag is a real boolean. Anything else from
    // the IPC boundary degrades to the legacy behaviour, never to "skip".
    const statusAware = typeof opts.otpPoolLow === 'boolean';
    const otpPoolLow = opts.otpPoolLow === true;

    // Both sets are validated rather than trusted in shape: these arrive over
    // IPC from the renderer, which got them over the network. A non-array, or a
    // non-integer element, must degrade to "unknown" — never to a delete.
    const unclaimed = sanitizeIdList(opts.unclaimedPrekeyIds);
    const retired = sanitizeIdList(opts.retiredPrekeyIds);

    return serializedKeyOp(async () => {
        await secureStore.initialize();
        if (!secureStore.get('identity_priv') || !secureStore.get('identity_pub') || !secureStore.get('registration_id')) {
            throw new Error('[E2EE] Identity not initialized — cannot generate rotation bundle');
        }

        // Decide BEFORE generating anything.
        const currentSpkId = parseInt(secureStore.get('signed_prekey_active_id') ?? '1', 10);
        const spkDue = !statusAware ? rotateSpk : rotateSpk && localSpkRotationDue(currentSpkId, Date.now());
        if (statusAware && !otpPoolLow && !spkDue) {
            // The only possible write above is a first-sighting SPK stamp.
            await secureStore.whenDurable();
            return null;
        }

        // Key generation in the thread pool, not on the window's thread. A
        // batch is always pre-generated: even an SPK-only rotation mints one
        // when there is nothing live to carry (an upload needs >= 1 prekey).
        const pairs = await generateX25519PairsAsync(100);
        const newSpk = spkDue ? await generatePairAsync('x25519') : null;

        // ONE coalesced vault write for the whole top-up.
        const bundle = secureStore.batch(() => buildRotationBundle({
            mintOtps: !statusAware || otpPoolLow,
            newSpk,
            pairs,
        }, unclaimed, retired));
        // Durability before publication: every private is on disk before the
        // renderer can upload its public half.
        await secureStore.whenDurable();
        return bundle;
    });
}

interface RotationPlan {
    /** Mint a fresh batch (else only when there is nothing live to carry). */
    mintOtps: boolean;
    /** The new signed prekey, when rotating it; null keeps the active one. */
    newSpk: KeyPairHex | null;
    /** 100 pre-generated X25519 pairs for the batch. */
    pairs: KeyPairHex[];
}

function buildRotationBundle(plan: RotationPlan, unclaimed: number[] | null, retired: number[] | null): IdentityBundle {
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
    const mintBatch = () => {
        for (let n = 0; n < 100; n++) {
            const i = currentMaxOtpId + 1 + n;
            const otp = plan.pairs[n] ?? generateX25519Pair();
            secureStore.set(`otp_priv_${i}`, otp.privHex);
            secureStore.set(`otp_pub_${i}`,  otp.pubB64);
            newOtps.push({ prekey_id: i, prekey_pub_b64: otp.pubB64 });
        }
        // Stamp the batch BEFORE the retirement loop below runs. A freshly
        // minted id can never be legitimately retired, and `mayRetireOtp` is
        // what enforces that — so the stamp has to exist by the time it is
        // consulted. `otp_max_id` moves with the mint, so ids stay strictly
        // monotonic and never overwrite a private an in-flight envelope needs.
        stampOtpBatch(currentMaxOtpId + 1);
        secureStore.set('otp_max_id', (currentMaxOtpId + 100).toString());
    };
    if (plan.mintOtps) mintBatch();

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
    // The mint stamps, read once (after this batch's stamp was written).
    const mintTable = retired && retired.length > 0 ? loadMintTable() : null;
    for (const id of retired ?? []) {
        if (unclaimedGuard?.has(id)) continue;
        if (!mintTable || !mayRetireOtp(id, mintTable)) continue;
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
    //
    // Walks the HELD ids (the store's index), newest first — not every id from
    // otp_max_id down to 1 with a decrypt per id, which on a long-lived device
    // was tens of thousands of decrypts per top-up.
    const carried: { prekey_id: number; prekey_pub_b64: string }[] = [];
    const carryIds = heldOtpIds()
        // `unclaimedGuard === null` (the server said nothing) skips the gate
        // entirely — the pre-contract fail-safe.
        .filter((i) => i <= currentMaxOtpId && (!unclaimedGuard || unclaimedGuard.has(i)))
        .sort((a, b) => b - a);
    for (const i of carryIds) {
        if (carried.length >= OTP_UPLOAD_CAP) break;
        let pubB64 = secureStore.get(`otp_pub_${i}`);
        if (!pubB64) {
            const privHex = secureStore.get(`otp_priv_${i}`);
            if (!privHex) continue;
            pubB64 = deriveX25519Pub(privHex);
        }
        carried.push({ prekey_id: i, prekey_pub_b64: pubB64 });
    }
    // An upload needs at least one prekey (UploadBundleDto @ArrayMinSize(1)).
    // A status-aware SPK-only rotation with nothing live to carry mints after
    // all — after the retirement loop, so these ids were never candidates for
    // it, and still stamped.
    if (!plan.mintOtps && carried.length === 0) mintBatch();
    const allOtps = [...newOtps, ...carried].slice(0, OTP_UPLOAD_CAP);

    if (!plan.newSpk) {
        // OTP-only top-up: reuse the active signed prekey exactly as the server
        // already has it. Nothing is superseded, so nothing is stamped.
        const spkPubB64 = secureStore.get(`signed_prekey_pub_${currentSpkId}`)
            ?? deriveX25519Pub(secureStore.get(`signed_prekey_priv_${currentSpkId}`)!);
        let sigB64 = secureStore.get(`signed_prekey_sig_${currentSpkId}`);
        if (!sigB64) {
            sigB64 = signWithEd25519(identityPrivHex, identityPubB64, Buffer.from(spkPubB64, 'base64')).toString('base64');
            secureStore.set(`signed_prekey_sig_${currentSpkId}`, sigB64);
        }

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
    const newSpk       = plan.newSpk;
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
    secureStore.set(`${SPK_CREATED_PREFIX}${newSpkId}`, String(Date.now()));
    secureStore.set('signed_prekey_active_id', newSpkId.toString());

    // Opportunistic prune: rotation is exactly when a key becomes superseded,
    // so it is the natural moment to retire anything that aged out.
    pruneSupersededSignedPrekeys();

    console.log(`[E2EE] Rotation bundle: SPK ${newSpkId}, ${newOtps.length} new + ${allOtps.length - newOtps.length} carried OTPs`);

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
