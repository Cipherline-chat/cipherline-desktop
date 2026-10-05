import * as crypto from 'crypto';
import { getChannelKey, getLatestEpoch } from './channel-keys';
import { secureStore } from './storage';
import { classifyChannelNonce, recordChannelNonce, flushChannelReplayLedger } from './channel-replay';

// H4: in-memory replay cache — ephemeral keys are unique per message; a
// duplicate eph means the server is replaying an already-processed envelope.
// Capped at 50k entries (FIFO eviction) so it never grows unbounded.
// Persisted to secureStore so cross-restart replay is also blocked.
const seenEphKeys = new Set<string>();
const REPLAY_CACHE_MAX = 50_000;
const REPLAY_PERSIST_KEY = '__eph_replay__';

/**
 * Load state for the persisted replay set. "Attempted" and "succeeded" are
 * SEPARATE facts here, and conflating them is what silently destroys the
 * on-disk history.
 *
 *   'pending' — never loaded successfully, and a retry is still worthwhile.
 *               The realistic cause is `SecureStore.get()` throwing because
 *               `initialize()` has not finished; that clears on its own.
 *   'loaded'  — the on-disk set was read into `seenEphKeys`, or confirmed
 *               genuinely absent (first run). ONLY in this state may the
 *               in-memory set be written back.
 *   'failed'  — an on-disk payload exists and cannot be understood
 *               (undecryptable entry, malformed JSON, wrong shape). Re-reading
 *               the same bytes cannot produce a different answer, so we stop
 *               retrying — but we must not overwrite it either.
 *
 * Why the distinction is load-bearing: `seenEphKeys` starts EMPTY. Persisting
 * it after a load that did not succeed writes `[]` over a real replay history,
 * and every ephemeral key that history recorded becomes acceptable again — the
 * replay control degrading to nothing, silently. Both writers below therefore
 * gate on 'loaded', so a failed load degrades to "keep what is on disk" rather
 * than "replace it with nothing".
 */
type ReplayLoadState = 'pending' | 'loaded' | 'failed';
let _replayLoadState: ReplayLoadState = 'pending';

/**
 * Re-entrancy guard, deliberately split out from `_replayLoadState`.
 *
 * The previous code set `_replayLoaded = true` BEFORE its try block, which did
 * two jobs at once: "never read the store more than once" — a real property
 * worth keeping, since a full load is an AES-GCM decrypt plus a JSON parse of
 * up to 50k entries and it sits on the per-message decrypt path — and "never
 * retry after a failure", which is the half that armed the clobber. This flag
 * keeps the first; `_replayLoadState` owns the second.
 */
let _replayLoadInProgress = false;
let _replayPersistTimer: ReturnType<typeof setTimeout> | null = null;

/** True only once the on-disk replay set has actually been read into
 *  `seenEphKeys`. Every writer of REPLAY_PERSIST_KEY must consult this. */
function replaySafeToPersist(): boolean {
    return _replayLoadState === 'loaded';
}

/** Record an unreadable on-disk payload: stop retrying, keep persisting
 *  disabled, and — unlike the `catch {}` this replaces — say so out loud. A
 *  security control turning itself off must not be a silent event. */
function replayLoadFailed(reason: string): void {
    _replayLoadState = 'failed';
    console.error(
        `[E2EE:REPLAY] Persisted replay set unreadable — ${reason}. Cross-restart replay ` +
        'protection is degraded to this session only. The on-disk history is being LEFT ' +
        'INTACT rather than overwritten with an empty set.',
    );
}

function ensureReplayLoaded(): void {
    if (_replayLoadState !== 'pending') return;
    // Preserves the old latch's re-entrancy property without also latching
    // failure: a nested call returns immediately instead of recursing.
    if (_replayLoadInProgress) return;
    _replayLoadInProgress = true;
    try {
        let raw: string | null;
        try {
            raw = secureStore.get(REPLAY_PERSIST_KEY);
            if (raw === null && secureStore.keys().includes(REPLAY_PERSIST_KEY)) {
                // `SecureStore.get()` swallows a per-entry decrypt failure and
                // returns null, which reads exactly like "never set" at this
                // call site. Treating an unreadable payload as absent is the
                // same destructive write by a quieter route, so name it.
                replayLoadFailed('the persisted entry exists but could not be decrypted');
                return;
            }
        } catch (err) {
            // Transient by nature — `SecureStore.get()` throws before
            // `initialize()` completes. Stay 'pending' so the next decrypt
            // retries; persisting stays disabled until a load succeeds.
            console.error(
                '[E2EE:REPLAY] Could not read the persisted replay set (store not ready?). ' +
                'Replay history will NOT be persisted until a load succeeds; the on-disk ' +
                'history is left intact:',
                err,
            );
            return;
        }

        if (raw === null) {
            // Genuinely absent: first run on this device. Nothing to merge,
            // and writing the set back is safe.
            _replayLoadState = 'loaded';
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            replayLoadFailed('the persisted entry is not valid JSON');
            return;
        }
        if (!Array.isArray(parsed) || parsed.some(k => typeof k !== 'string')) {
            replayLoadFailed('the persisted entry is not an array of strings');
            return;
        }

        // Merge only after the payload has FULLY validated, so a failure part
        // way through can never leave a PARTIAL set behind that then gets
        // written back over the complete one. Trimmed to the cap on the way in
        // (keeping the newest, since eviction is FIFO) so an oversized file
        // cannot park the set permanently above REPLAY_CACHE_MAX.
        for (const k of (parsed as string[]).slice(-REPLAY_CACHE_MAX)) seenEphKeys.add(k);
        _replayLoadState = 'loaded';
    } finally {
        _replayLoadInProgress = false;
    }
}

function scheduleReplayPersist(): void {
    // Never write a set that was never successfully loaded — see the
    // ReplayLoadState comment. Skipping the write keeps the on-disk history.
    if (!replaySafeToPersist()) return;
    if (_replayPersistTimer) clearTimeout(_replayPersistTimer);
    _replayPersistTimer = setTimeout(() => {
        _replayPersistTimer = null;
        try {
            // Written behind: this value alone can be megabytes (up to
            // REPLAY_CACHE_MAX keys) and it rides a whole-vault rewrite.
            secureStore.setDeferred(REPLAY_PERSIST_KEY, JSON.stringify([...seenEphKeys]));
        } catch (err) {
            console.error('[E2EE:REPLAY] Failed to persist the replay set:', err);
        }
    }, 500);
}

/**
 * Write the replay cache to disk immediately, bypassing the 500ms debounce.
 * Call on app shutdown (before-quit) — without this, envelopes decrypted in
 * the final 500ms before the process exits are recorded in memory but never
 * reach secureStore, leaving a narrow window where a malicious relay could
 * replay them after restart (they'd be admitted again since the persisted
 * set never learned about them).
 *
 * This runs on EVERY quit, including sessions that never decrypted anything —
 * so before the load-state gate existed it wrote `[]` over the whole on-disk
 * history any time the user closed the app without receiving a message. No
 * thrown error was required; the empty in-memory set was enough. The gate is
 * what makes a no-op quit a no-op.
 */
export function flushReplayCache(): void {
    // The channel-message replay ledger (G4) rides the same before-quit hook.
    flushChannelReplayLedger();
    if (_replayPersistTimer) { clearTimeout(_replayPersistTimer); _replayPersistTimer = null; }
    if (!replaySafeToPersist()) return;
    try {
        secureStore.set(REPLAY_PERSIST_KEY, JSON.stringify([...seenEphKeys]));
    } catch (err) {
        console.error('[E2EE:REPLAY] Failed to flush the replay set on shutdown:', err);
    }
}

// ============================================================================
// Cipherline ECIES Message Encryption — v:3 (sender identity inside the ciphertext)
//
// Per-message ephemeral X25519 key pair. Per-device ECDH against the device's
// signed prekey (SPK); optional one-time prekey (OTP) mixed in for forward
// secrecy (HIGH-4). HKDF-SHA256 binds the ephemeral pub and device ID to the
// per-device wrap key (MED-12). AES-256-GCM content key encrypted once and
// authenticated with AAD = eph_pub ‖ sorted_device_ids (HIGH-6). Envelope
// signed with sender Ed25519 identity key over SHA-256 transcript (HIGH-6).
//
// v:3 — sender identity inside the ciphertext: the sender's identity pub (sp),
// user ID (su) and device ID (sd) are encrypted INSIDE the ciphertext, so the
// envelope itself does not name its sender and `GET /v1/messages/pull` does not
// return one to the recipient. After AES-GCM decryption (which authenticates
// integrity), the recipient reads sp/su from the plaintext and verifies the
// Ed25519 sig. This is safe because AES-GCM authentication guarantees the
// plaintext (including sp/su) was not tampered.
//
// This is NOT sealed sender, and the server DOES learn who sent which message:
// `POST /v1/messages` is authenticated (JWT + x-device-id), and
// `MessagesService.sendMessage` stores `sender_device_id` (plus
// `conversation_id` and every recipient device) on each envelope row until it
// is acked or expires. Hiding the sender from the relay would need an
// unauthenticated send path with sender certificates (Signal's design); none
// exists here. Don't describe this format as sealed sender.
//
// Wire format v:3 (base64 of JSON):
// {
//   "v": 3,
//   "eph": "<base64: 32-byte X25519 ephemeral public key>",
//   "recipients": {
//     "<device_id>": {
//       "wrap": "<base64: 12-byte IV ‖ 16-byte tag ‖ 32-byte wrapped content key>",
//       "otp_id": 42          // present only when OTP was mixed in
//     }
//   },
//   "iv":  "<base64: 12-byte content IV>",
//   "ct":  "<base64: AES-256-GCM encrypt({ sp, su, c }) ‖ 16-byte GCM tag>",
//   "sig": "<base64: Ed25519 sig over SHA-256(eph ‖ iv ‖ ct ‖ sorted_device_ids)>"
// }
// where: sp = sender Ed25519 identity pub (base64), su = sender user UUID, c = ClientContent
//
// v:1 and v:2 envelopes are NO LONGER accepted — decryptEnvelope throws LEGACY
// for any non-v3 version. This closes the downgrade attack where a malicious
// server forced an older envelope (v:1 unsigned, v:2 optional-sig) to bypass
// v:3's mandatory signature verification.
// ============================================================================

export interface DevicePub {
    device_id: string;
    spk_pub_b64: string;        // X25519 SPK — 32 raw bytes, base64
    sig_b64?: string;           // Ed25519 signature over spk_pub_b64 bytes
    identity_pub_b64?: string;  // Ed25519 identity key — used to verify sig
    /** HIGH-4: OTP from the server's prekey bundle. Optional — null when exhausted. */
    otp_pub_b64?: string | null;
    otp_id?: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sender Ed25519 PUBLIC keys, imported once per distinct key instead of once per
 * message (freeze fix). Importing a JWK is a large share of a channel decrypt's
 * cost, and a history page or a wake-time catch-up verifies hundreds of rows
 * from the same handful of senders on the main process's only thread.
 *
 * Public keys only — nothing secret is cached — and verification itself is
 * untouched: every message is still checked against the key its row names.
 * Keyed by the canonical 32 raw bytes so a lenient base64 spelling can't
 * create a second entry. Bounded; insertion-order eviction.
 */
const ED25519_PUB_CACHE_MAX = 512;
const ed25519PubCache = new Map<string, crypto.KeyObject>();
export function importEd25519Pub(b64: string): crypto.KeyObject {
    const raw = Buffer.from(b64, 'base64');
    const k = raw.toString('base64');
    const hit = ed25519PubCache.get(k);
    if (hit) return hit;
    const key = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
        format: 'jwk',
    });
    ed25519PubCache.set(k, key);
    if (ed25519PubCache.size > ED25519_PUB_CACHE_MAX) {
        const oldest = ed25519PubCache.keys().next().value;
        if (oldest !== undefined) ed25519PubCache.delete(oldest);
    }
    return key;
}

function importX25519Pub(b64: string): crypto.KeyObject {
    return crypto.createPublicKey({
        key: {
            kty: 'OKP',
            crv: 'X25519',
            x: Buffer.from(b64, 'base64').toString('base64url'),
        },
        format: 'jwk',
    });
}

function importX25519Priv(privHex: string, pubB64: string): crypto.KeyObject {
    return crypto.createPrivateKey({
        key: {
            kty: 'OKP',
            crv: 'X25519',
            d: Buffer.from(privHex, 'hex').toString('base64url'),
            x: Buffer.from(pubB64, 'base64').toString('base64url'),
        },
        format: 'jwk',
    });
}

/** MED-11: Reject small-subgroup / low-order points (all-zero ECDH result). */
function assertNonZeroSecret(secret: Buffer, context: string): void {
    if (secret.every(b => b === 0)) {
        throw new Error(`[E2EE] All-zero ECDH result — possible low-order point attack (${context})`);
    }
}

/**
 * MED-12: Derive a 32-byte AES wrapping key.
 * HKDF info = eph_pub_bytes ‖ utf8(device_id) ‖ utf8('v2') [ ‖ BE32(otpId) ]
 * This binds the wrap key to the specific envelope, recipient, and (H3) the
 * exact OTP that was mixed in — so swapping the otp_id field in the JSON
 * invalidates authentication rather than silently producing a wrong key.
 *
 * MED-13: Zeros the IKM buffer before returning (caller is responsible for
 * zeroing the returned key after use).
 */
function deriveWrapKeyV2(ikm: Buffer, ephPubBytes: Buffer, deviceId: string, otpId?: number): Buffer {
    const parts = [ephPubBytes, Buffer.from(deviceId, 'utf8'), Buffer.from('v2', 'utf8')];
    if (otpId != null) {
        const otpIdBytes = Buffer.allocUnsafe(4);
        otpIdBytes.writeUInt32BE(otpId);
        parts.push(otpIdBytes);
    }
    const info = Buffer.concat(parts);
    const key = Buffer.from(crypto.hkdfSync('sha256', ikm, '', info, 32));
    ikm.fill(0);
    return key;
}

/** AES-256-GCM encrypt. Returns: 12-byte IV ‖ 16-byte tag ‖ ciphertext. */
function aesEncrypt(key: Buffer, plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** AES-256-GCM decrypt. Input: 12-byte IV ‖ 16-byte tag ‖ ciphertext. */
function aesDecrypt(key: Buffer, bundle: Buffer): Buffer {
    if (bundle.length < 28) throw new Error('AES bundle too short');
    const iv  = bundle.subarray(0, 12);
    const tag = bundle.subarray(12, 28);
    const ct  = bundle.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Load this device's Ed25519 identity private key from the SecureStore. */
function loadIdentityPrivKey(): crypto.KeyObject {
    const privHex = secureStore.get('identity_priv');
    const pubB64  = secureStore.get('identity_pub');
    if (!privHex || !pubB64) throw new Error('[E2EE] Identity key not initialised — run ensureSignalIdentity first');
    return crypto.createPrivateKey({
        key: { kty: 'OKP', crv: 'Ed25519',
               d: Buffer.from(privHex, 'hex').toString('base64url'),
               x: Buffer.from(pubB64,  'base64').toString('base64url') },
        format: 'jwk',
    });
}

// ---------------------------------------------------------------------------
// Public API — ECIES (DM / multi-device)
// ---------------------------------------------------------------------------

/**
 * Encrypt a JSON content string for a set of recipient devices (v:3, sender identity inside the ciphertext — NOT sealed sender, see above).
 *
 * Security properties over v:2:
 *   • Sender identity pub (sp) and user ID (su) are inside the AES-GCM ciphertext —
 *     the server stores only an opaque blob and recipient device IDs.
 *   • Ed25519 sig is verified POST-decrypt by reading sp from the plaintext, which is
 *     safe because AES-GCM authentication guarantees plaintext integrity.
 *   • AAD, wrap-key binding, OTP, low-order-point rejection, and buffer zeroing
 *     are all preserved from v:2 (HIGH-6, MED-12, HIGH-4, MED-11, MED-13).
 */
export interface EncryptForDevicesResult {
    envelope_b64: string;
    /** device_ids that actually got a `recipients` entry — the ONLY ids it
     *  is safe to store an envelope against server-side. Callers must not
     *  fall back to the full input `devices` list (see the RC-2/RC-5 note
     *  below for why that was the dominant cause of one-way delivery). */
    wrapped_device_ids: string[];
}

export async function encryptForDevices(contentJson: string, senderUserId: string, devices: DevicePub[], senderDeviceId?: string): Promise<EncryptForDevicesResult> {
    const eligible = devices.filter(d => d.spk_pub_b64);
    if (eligible.length === 0) throw new Error('[E2EE:NO_ELIGIBLE_DEVICES] No eligible recipient devices (missing SPK public keys)');

    // Ephemeral X25519 key pair
    const { privateKey: ephPriv, publicKey: ephPub } = crypto.generateKeyPairSync('x25519');
    const ephJwk = ephPub.export({ format: 'jwk' }) as { x: string };
    const ephPubBytes = Buffer.from(ephJwk.x, 'base64url');
    const ephPubB64   = ephPubBytes.toString('base64');

    // Per-message content key (MED-13: zeroed after use below)
    const contentKey = crypto.randomBytes(32);

    // Per-device wrap — deliberately runs BEFORE the AAD/sortedIds below are
    // computed. RC-5: the AAD binds the ciphertext to the recipient set
    // (HIGH-6), and that set must be who actually got wrapped, not who was
    // merely `eligible`. Wrapping can still fail per-device after this point
    // (invalid SPK signature, a low-order DH point, etc.) — if the AAD were
    // computed from `eligible` up front, one such failure would leave the
    // AAD encoding a device_id with no `recipients` entry. Encrypt-side AAD
    // would then never match decrypt-side AAD (built from
    // Object.keys(envelope.recipients), i.e. reality) — GCM authentication
    // would fail for EVERY recipient of the message, not just the one
    // problem device. This was the dominant cause of "the creator's
    // messages are invisible to everyone in a group".
    type RecipientEntry = { wrap: string; otp_id?: number };
    const recipients: Record<string, RecipientEntry> = {};

    for (const device of eligible) {
        // CRIT-7: verify SPK Ed25519 signature before ECDH
        if (!device.sig_b64 || !device.identity_pub_b64) {
            console.warn(`[E2EE] Device ${device.device_id} missing SPK sig or identity key — skipping`);
            continue;
        }
        try {
            // Node's native Ed25519 (the same primitive every DECRYPT path in
            // this file already verifies with), not @noble/curves' pure-JS
            // one: measured 0.6–1.3 ms vs 15–16 ms per recipient device on the
            // dev box, paid on the main process's only thread for every
            // device of every recipient of every DM sent. Identity keys go
            // through the same bounded public-key cache as the decrypt side.
            // Any honestly produced signature verifies under both; anything
            // only the more permissive ZIP-215 rules would accept now skips
            // the device (fails closed — that device is not encrypted to).
            const ok = crypto.verify(
                null,
                Buffer.from(device.spk_pub_b64, 'base64'),
                importEd25519Pub(device.identity_pub_b64),
                Buffer.from(device.sig_b64, 'base64'),
            );
            if (!ok) {
                console.warn(`[E2EE] SPK signature invalid for device ${device.device_id} — skipping`);
                continue;
            }
        } catch (err) {
            console.warn(`[E2EE] SPK sig error for device ${device.device_id}: ${(err as Error).message}`);
            continue;
        }

        try {
            const recipPub  = importX25519Pub(device.spk_pub_b64);
            const sharedSpk = crypto.diffieHellman({ privateKey: ephPriv, publicKey: recipPub });

            // MED-11: reject low-order-point results
            assertNonZeroSecret(sharedSpk, `SPK for ${device.device_id}`);

            let ikm: Buffer;
            const entry: RecipientEntry = { wrap: '' };

            // HIGH-4: Mix OTP when provided by the prekey bundle
            if (device.otp_pub_b64 && device.otp_id != null) {
                const otpPub    = importX25519Pub(device.otp_pub_b64);
                const sharedOtp = crypto.diffieHellman({ privateKey: ephPriv, publicKey: otpPub });
                if (!sharedOtp.every(b => b === 0)) {
                    ikm = Buffer.concat([sharedSpk, sharedOtp]);
                    sharedOtp.fill(0);
                    sharedSpk.fill(0);
                    entry.otp_id = device.otp_id;
                } else {
                    sharedOtp.fill(0);
                    ikm = sharedSpk; // degenerate OTP — fall back to SPK-only
                    // Observability for a forced FS downgrade: this message's forward
                    // secrecy now rests on the SPK alone (30-day rotation) instead of a
                    // one-time key. A malicious relay serving a crafted low-order OTP
                    // pub can force this on every message — not silent detection/
                    // blocking, but at least visible in logs rather than invisible.
                    console.warn(`[E2EE] Degenerate OTP for device ${device.device_id} — falling back to SPK-only (reduced forward secrecy)`);
                }
            } else {
                ikm = sharedSpk;
                // Same downgrade, reached when the bundle simply had no OTP left —
                // a relay that chronically strips OTPs from a peer's bundle forces
                // every session through this path with nothing to distinguish it
                // from normal exhaustion. Logged so a chronic pattern is at least
                // observable rather than fully invisible.
                console.warn(`[E2EE] No one-time prekey available for device ${device.device_id} — falling back to SPK-only (reduced forward secrecy)`);
            }

            // MED-12 + MED-13 + H3: bound wrap key derivation, zeroes IKM.
            // otp_id is passed so the derived key is unique to this specific OTP.
            const wrapKey = deriveWrapKeyV2(ikm, ephPubBytes, device.device_id, entry.otp_id);
            entry.wrap = aesEncrypt(wrapKey, contentKey).toString('base64');
            wrapKey.fill(0);

            recipients[device.device_id] = entry;
        } catch (err) {
            console.warn(`[E2EE] Skipping device ${device.device_id}: ${(err as Error).message}`);
        }
    }

    if (Object.keys(recipients).length === 0) {
        throw new Error('[E2EE:WRAP_NONE] Failed to wrap key for any recipient device');
    }

    // Phase 1 observability: this gap is exactly the class of bug that let
    // messages queue for devices they were never actually encrypted to — the
    // caller (encryptForDevices' return value) has always been silent about
    // it. Every device in `devices` that isn't a key in `recipients` will
    // receive a stored, permanently-undecryptable envelope unless the caller
    // filters recipient_device_ids down to `Object.keys(recipients)` itself.
    if (Object.keys(recipients).length !== devices.length) {
        const skipped = devices
            .filter(d => !(d.device_id in recipients))
            .map(d => d.device_id);
        console.error(
            `[E2EE] wrapped ${Object.keys(recipients).length}/${devices.length} devices — ` +
            `skipped: ${JSON.stringify(skipped)} (see prior [E2EE] warn lines above for the reason each was dropped)`,
        );
    }

    // Sorted device IDs for AAD + transcript (HIGH-6) — derived from who was
    // ACTUALLY wrapped (Object.keys(recipients)), not `eligible`. See the
    // RC-5 comment above the wrap loop for why this ordering is load-bearing.
    const sortedIds = Object.keys(recipients).sort().join(',');
    const aad = Buffer.concat([ephPubBytes, Buffer.from(sortedIds, 'utf8')]);

    // v:3: embed sender identity pub + user ID inside the ciphertext. sp/su/sd
    // travel only inside the AES-GCM payload — but the relay still knows the
    // sending DEVICE from the authenticated POST (see the v:3 header comment).
    //
    // RC-7 / Phase 5: `sd` (sender device id) is additive — each device has its
    // own identity key by design (multi-device), but the TOFU pin store used to
    // key on (me, them-user) alone, so a second device of the same contact read
    // as an identity change. `sd` lets the receiver pin per (them-user,
    // them-device) instead. Omitted (not just empty-string) when the caller
    // doesn't supply one — JSON.stringify drops an `undefined` value, so this
    // stays byte-for-byte the old wrapper shape for any caller not yet passing
    // it, and an old receiver simply never sees the key.
    const senderPub = secureStore.get('identity_pub') ?? '';
    const wrapper   = { sp: senderPub, su: senderUserId, sd: senderDeviceId, c: JSON.parse(contentJson) };

    // Encrypt content once with AAD
    const plaintext  = Buffer.from(JSON.stringify(wrapper), 'utf8');
    const contentIv  = crypto.randomBytes(12);
    const cipher     = crypto.createCipheriv('aes-256-gcm', contentKey, contentIv);
    cipher.setAAD(aad);
    const ctBody = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const ct     = Buffer.concat([ctBody, cipher.getAuthTag()]);
    const ivB64  = contentIv.toString('base64');
    const ctB64  = ct.toString('base64');

    // HIGH-6: Sign transcript hash with sender identity key
    const transcript = Buffer.concat([
        ephPubBytes,
        Buffer.from(ivB64, 'base64'),
        ct,
        Buffer.from(sortedIds, 'utf8'),
    ]);
    const transcriptHash = crypto.createHash('sha256').update(transcript).digest();
    const identPrivKey   = loadIdentityPrivKey();
    const sig            = Buffer.from(crypto.sign(null, transcriptHash, identPrivKey)).toString('base64');

    // MED-13: zero content key
    contentKey.fill(0);

    const envelope = { v: 3, eph: ephPubB64, recipients, iv: ivB64, ct: ctB64, sig };
    return {
        envelope_b64: Buffer.from(JSON.stringify(envelope)).toString('base64'),
        wrapped_device_ids: Object.keys(recipients),
    };
}

export interface DecryptResult {
    contentJson:     string;
    senderPub?:      string;
    senderUserId?:   string;
    /** RC-7 / Phase 5: absent for envelopes from a not-yet-updated sender —
     *  callers must treat absence as "unknown device", never as a mismatch. */
    senderDeviceId?: string;
    /**
     * G3: whether this device's wrap mixed in one of ITS one-time prekeys.
     * `false` means the message rests on the signed prekey alone — the pool was
     * empty, the claim failed, the server withheld it, or the OTP private was
     * already gone. The renderer uses it as a local, telemetry-free "top up my
     * prekeys" signal (src/utils/prekeyHealth.ts); nothing leaves the device.
     */
    usedOneTimePrekey: boolean;
}

/**
 * Decrypt a message envelope received from the server.
 *
 * @param ciphertextB64         The raw ciphertext_b64 field from the server envelope.
 * @param myDeviceId            The current device's UUID.
 * @param spkCandidates         Signed prekeys to try, in order. Almost always
 *                              just the active one — see the RC-6 note below
 *                              for why more than one can legitimately exist.
 * @returns Decrypted content + sealed-sender fields (senderPub/senderUserId).
 * @throws 'LEGACY' for any non-v3 envelope (very old stub OR v:1/v:2); callers skip these.
 */
export interface SpkCandidate {
    id: number;
    privHex: string;
    pubB64: string;
}

export function decryptEnvelope(
    ciphertextB64: string,
    myDeviceId: string,
    spkCandidates: SpkCandidate[],
): DecryptResult {
    let envelope: any;
    try {
        envelope = JSON.parse(Buffer.from(ciphertextB64, 'base64').toString('utf8'));
    } catch {
        throw new Error('LEGACY');
    }

    // Only v:3 (sender-in-ciphertext + mandatory signature) is accepted. v:1 and v:2 are
    // treated as LEGACY and skipped by callers. This closes the downgrade attack
    // where a malicious server forces an older envelope version to bypass v:3's
    // signature verification — v:1 had no signature and v:2's check was optional.
    if (envelope.v !== 3) throw new Error('LEGACY');

    if (spkCandidates.length === 0) {
        throw new Error('[E2EE:NO_SPK] No signed prekeys available in secure store');
    }

    // RC-6: SPK rotation used to be effectively one-way — generateRotationBundle
    // deliberately RETAINS old SPK private keys locally specifically so
    // already-in-flight messages (wrapped for the SPK that was active when
    // the sender fetched this device's bundle, which can be stale by the
    // time the message arrives) stay decryptable, but nothing ever actually
    // tried them: main.ts only ever loaded the active SPK. Any envelope
    // wrapped against a since-rotated SPK failed GCM auth forever.
    //
    // Only a WRAP_AUTH_FAILED — the per-device wrap key derived via ECDH
    // with the WRONG SPK producing the wrong AES key — is something a
    // different SPK could plausibly fix. Every other failure (no recipient
    // entry, replay, content/signature auth failure) happens independent of
    // which SPK was used; retrying those wastes work without changing the
    // outcome, so fail fast on the first attempt instead.
    let lastErr: Error = new Error('[E2EE:WRAP_AUTH_FAILED] No signed prekey could unwrap this envelope');
    for (const { privHex, pubB64 } of spkCandidates) {
        try {
            return _decryptV3(envelope, myDeviceId, privHex, pubB64);
        } catch (err) {
            lastErr = err as Error;
            if (!lastErr.message.includes('[E2EE:WRAP_AUTH_FAILED]')) throw lastErr;
        }
    }
    throw lastErr;
}

function _decryptV3(
    envelope: any,
    myDeviceId: string,
    spkPrivHex: string,
    spkPubB64: string,
): DecryptResult {
    // H4: Replay guard — ephemeral keys are unique per message. A duplicate
    // means the server is replaying a previously-processed envelope.
    // Load persisted cache on first decrypt so cross-restart replay is caught.
    ensureReplayLoaded();
    const ephKey = envelope.eph as string;
    if (seenEphKeys.has(ephKey)) throw new Error('[E2EE:REPLAY] Replay detected — duplicate ephemeral key');
    if (seenEphKeys.size >= REPLAY_CACHE_MAX) {
        seenEphKeys.delete(seenEphKeys.values().next().value!);
    }

    const ephPubBytes = Buffer.from(ephKey, 'base64');

    const myEntry = envelope.recipients?.[myDeviceId] as { wrap?: string; otp_id?: number } | undefined;
    if (!myEntry?.wrap) throw new Error(`[E2EE:NO_RECIPIENT_ENTRY] No recipient entry for device ${myDeviceId}`);

    const spkPrivKey = importX25519Priv(spkPrivHex, spkPubB64);
    const ephPub     = importX25519Pub(ephKey);
    const sharedSpk  = crypto.diffieHellman({ privateKey: spkPrivKey, publicKey: ephPub });
    assertNonZeroSecret(sharedSpk, `SPK for ${myDeviceId}`);

    let ikm: Buffer;
    // H4: Track which OTP to consume, but do NOT delete it yet — only delete
    // after wrap authentication succeeds. A server forging an otp_id in a
    // malformed envelope would otherwise silently burn the OTP.
    let otpToConsume: number | null = null;

    if (myEntry.otp_id != null) {
        const otpPrivHex = secureStore.get(`otp_priv_${myEntry.otp_id}`);
        const otpPubB64  = secureStore.get(`otp_pub_${myEntry.otp_id}`);
        if (otpPrivHex && otpPubB64) {
            const otpPrivKey = importX25519Priv(otpPrivHex, otpPubB64);
            const sharedOtp  = crypto.diffieHellman({ privateKey: otpPrivKey, publicKey: ephPub });
            ikm = Buffer.concat([sharedSpk, sharedOtp]);
            sharedOtp.fill(0);
            sharedSpk.fill(0);
            otpToConsume = myEntry.otp_id;
        } else {
            console.warn(`[E2EE] OTP ${myEntry.otp_id} not in local store — falling back to SPK-only for ${myDeviceId}`);
            ikm = sharedSpk;
        }
    } else {
        ikm = sharedSpk;
    }

    // H3: pass otpId into HKDF info so the wrap key cryptographically binds
    // which OTP was mixed in. deriveWrapKeyV2 zeroes ikm on return.
    const wrapKey = deriveWrapKeyV2(ikm, ephPubBytes, myDeviceId, otpToConsume ?? undefined);
    let contentKey: Buffer;
    try {
        contentKey = aesDecrypt(wrapKey, Buffer.from(myEntry.wrap, 'base64'));
    } catch (err) {
        // Phase 1: name the failure — this was previously an unlabeled
        // node:crypto error ("Unsupported state or unable to authenticate
        // data"), indistinguishable from every other decrypt failure.
        throw new Error(`[E2EE:WRAP_AUTH_FAILED] ${(err as Error).message}`);
    }
    wrapKey.fill(0);

    // H4: wrap authentication passed — now safe to consume the OTP.
    //
    // Written BEHIND (coalesced, off the main thread) rather than one whole-
    // vault rewrite per key: a wake-up catch-up decrypts DMs in bursts, and
    // two synchronous full rewrites per message held the window-owning thread
    // for the whole burst. The in-memory delete is immediate, so this process
    // can never use the prekey again; the on-disk copy follows within
    // SecureStore.DEFER_MAX_MS, or at once on quit (main.ts flushes). That is
    // the same order of window the replay set below already accepts.
    if (otpToConsume != null) {
        secureStore.deleteDeferred(`otp_priv_${otpToConsume}`);
        secureStore.deleteDeferred(`otp_pub_${otpToConsume}`);
    }

    const sortedIds = Object.keys(envelope.recipients).sort().join(',');
    const aad = Buffer.concat([ephPubBytes, Buffer.from(sortedIds, 'utf8')]);

    const iv     = Buffer.from(envelope.iv, 'base64');
    const ctFull = Buffer.from(envelope.ct, 'base64');
    const ctBody = ctFull.subarray(0, ctFull.length - 16);
    const ctTag  = ctFull.subarray(ctFull.length - 16);

    const dc = crypto.createDecipheriv('aes-256-gcm', contentKey, iv);
    dc.setAuthTag(ctTag);
    dc.setAAD(aad);
    let plaintext: Buffer;
    try {
        plaintext = Buffer.concat([dc.update(ctBody), dc.final()]);
    } catch (err) {
        // See the WRAP_AUTH_FAILED note above — same reasoning, next stage.
        // This is also where the AAD asymmetry (RC-5, fixed in Phase 2) shows
        // up: an AAD mismatch fails auth here with a generic node:crypto
        // error, which used to be indistinguishable from real tampering.
        throw new Error(`[E2EE:CONTENT_AUTH_FAILED] ${(err as Error).message}`);
    }
    contentKey.fill(0);

    // Parse the {sp, su, sd, c} wrapper from the decrypted plaintext
    const wrapper = JSON.parse(plaintext.toString('utf8')) as { sp?: string; su?: string; sd?: string; c?: unknown };
    const sp = wrapper.sp;
    const su = wrapper.su;
    const sd = wrapper.sd;
    const c  = wrapper.c;

    // Verify Ed25519 sig AFTER authenticated decryption (safe: AES-GCM guarantees integrity).
    // Both sp (from plaintext) and sig (from outer envelope) MUST be present — a missing sig
    // means the server stripped it, which is exactly the attack we're guarding against.
    if (!sp) throw new Error('[E2EE:SIG_INVALID] v:3 envelope missing sender identity pub — rejecting');
    // F1: `su` is mandatory too. It was previously optional, and an envelope
    // without it slipped past the ENTIRE sender-trust layer: every check in
    // `pinAndDetect`/`evaluateSender` keys on the claimed user id and returns
    // early when it is absent, so omitting `su` bought a forger a message that
    // was displayed having been evaluated by nothing at all. No compatibility
    // cost — `encryptForDevices` has always written `su` unconditionally, so
    // no real client in the fleet has ever emitted an envelope without it.
    if (!su) throw new Error('[E2EE:SIG_INVALID] v:3 envelope missing sender user id — rejecting');
    if (!envelope.sig) throw new Error(`[E2EE:SIG_INVALID] v:3 envelope missing sig — possible server tampering for device ${myDeviceId}`);
    {
        const ivBytes    = Buffer.from(envelope.iv, 'base64');
        const ctBytes    = Buffer.from(envelope.ct, 'base64');
        const transcript = Buffer.concat([ephPubBytes, ivBytes, ctBytes, Buffer.from(sortedIds, 'utf8')]);
        const hash       = crypto.createHash('sha256').update(transcript).digest();
        const senderPubKey = importEd25519Pub(sp);
        const sigValid = crypto.verify(null, hash, senderPubKey, Buffer.from(envelope.sig, 'base64'));
        if (!sigValid) throw new Error(`[E2EE:SIG_INVALID] v:3 envelope signature invalid for device ${myDeviceId}`);
    }

    // RC-9: admit this eph into the replay cache only once EVERY check has
    // passed (wrap auth, content auth, signature) — not just wrap auth.
    // Admitting it right after wrap auth (the old placement) meant a message
    // that failed content-auth or signature verification for any other
    // reason (envelope corruption, an AAD mismatch — see the Phase 2 RC-5
    // fix — a genuinely tampered message) got misclassified as REPLAY on
    // every subsequent retry, permanently hiding whatever the real error
    // was. Only a message that decrypts and verifies cleanly is a message
    // this device will genuinely never need to see wrapped under this
    // ephemeral key again.
    seenEphKeys.add(ephKey);
    scheduleReplayPersist();

    return {
        contentJson:     JSON.stringify(c),
        senderPub:       sp,
        senderUserId:    su,
        senderDeviceId:  sd,
        usedOneTimePrekey: otpToConsume != null,
    };
}

// ============================================================================
// Sender Keys — Channel Message Encryption
//
// Shared AES-256-GCM symmetric key per channel epoch, distributed via
// `channel_key` envelopes on join / rotation events. (Named "Sender Keys" for
// history; it is NOT Signal's Sender Keys construction — there is no chain
// ratchet, one key covers the whole epoch.)
//
// Wire format (stored as ChannelMessage columns, unchanged by v2):
//   epoch           — identifies which channel key to use for decryption
//   nonce_b64       — 12-byte AES-GCM nonce
//   ciphertext_b64  — AES-GCM ciphertext ‖ 16-byte GCM authentication tag
//   signature_b64   — Ed25519 signature over ciphertext_b64 bytes
//
// ── G4: context binding (format v2) ─────────────────────────────────────────
// v1 bound NOTHING about where a message belongs: no AAD, and the signature
// covers only the ciphertext. So a server could re-insert a genuine row under
// a new id (replay), re-label its sender_user_id / sender_device_id (the pin
// check is keyed on those labels, so a never-seen device id gets TOFU'd with
// the real signer's key and the message shows under someone else's name), and
// — if a key ever repeated across channels — move it between channels.
//
// v2 puts a binding object `_cb` INSIDE the plaintext JSON:
//     { ...content, _cb: { v: 2, c: channel_id, e: epoch, n: nonce_b64,
//                          m: unique message id, d: sender device, u: sender user } }
// Inside the plaintext it is covered by the AES-GCM tag (which authenticates
// plaintext exactly as it authenticates AAD) and — because the signature
// covers the ciphertext, which commits to the plaintext under this key/nonce —
// by the sender's Ed25519 signature. The server cannot alter or strip it.
//
// Why not real GCM AAD / a new signed transcript: an old client decrypts with
// no AAD and verifies the signature over the raw ciphertext; either change
// would make every new message unreadable to it. Embedding keeps the wire
// columns and both old verification rules byte-for-byte valid, so OLD CLIENTS
// READ NEW MESSAGES (they JSON.parse the content and ignore the unknown `_cb`
// key; the mobile validator is forward-compatible the same way), and no API
// change or deploy is needed. The cost is that `_cb` is visible only to
// holders of the channel key — which is who needs it.
//
// `n` (the nonce) is what separates a genuine v2 binding from a `_cb` object
// that merely rode along inside copied content: a sender cannot know a fresh
// message's nonce before choosing it, so only the encrypting engine can write
// a matching one. A `_cb` whose `n` does not match is stripped and the message
// is treated as legacy.
//
// Legacy (v1, no binding) messages are still ACCEPTED: channel rows live on
// the server for 30 days, and clients that have not updated keep sending v1.
// They get the version-independent protection below (the nonce replay
// ledger), not the binding checks.
//
// Replay: every accepted message's (channel, nonce) is recorded against its
// server id in a persisted ledger (electron/channel-replay.ts). The same
// ciphertext under a different id is refused with [E2EE:CHANNEL_REPLAY].
// ============================================================================

export const CHANNEL_BINDING_VERSION = 2;

/** Max length of a sender-supplied client_msg_id reused as the bound `m`. */
const MAX_BOUND_MSG_ID_LEN = 128;

export interface ChannelSender {
    user_id?: string | null;
    device_id?: string | null;
}

interface ChannelBinding {
    v: number;
    c: string;
    e: number;
    n: string;
    m: string;
    d?: string;
    u?: string;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function nonEmptyString(x: unknown, max = 256): x is string {
    return typeof x === 'string' && x.length > 0 && x.length <= max;
}

/**
 * Encrypt a JSON content string for a text channel using its current Sender Key.
 *
 * @param sender this device's own user/device id, bound into the message so a
 *   receiver can reject a row the server re-labelled. Optional only for
 *   compatibility with a caller that has not been updated; without it the
 *   binding still covers channel, epoch, nonce and message id.
 * @returns Wire components ready to POST to /v1/channels/:id/messages.
 */
export function encryptChannelMessage(
    contentJson: string,
    channelId: string,
    sender?: ChannelSender,
): { epoch: number; nonce_b64: string; ciphertext_b64: string; signature_b64: string } {
    const epoch = getLatestEpoch(channelId);
    if (epoch === null) throw new Error(`[E2EE] No channel key found for channel ${channelId}. Await key distribution before sending.`);

    const key = getChannelKey(channelId, epoch);
    if (!key) throw new Error(`[E2EE] Channel key for epoch ${epoch} missing`);

    const nonce    = crypto.randomBytes(12);
    const nonceB64 = nonce.toString('base64');

    // Bind the message to its context (G4). Content is always a JSON object in
    // practice (the ClientContent union); anything else is sent unbound rather
    // than wrapped, because wrapping would change what an old client parses.
    let plaintextJson = contentJson;
    let parsed: unknown;
    try { parsed = JSON.parse(contentJson); } catch { parsed = undefined; }
    if (isPlainObject(parsed)) {
        const binding: ChannelBinding = {
            v: CHANNEL_BINDING_VERSION,
            c: channelId,
            e: epoch,
            n: nonceB64,
            m: nonEmptyString(parsed.client_msg_id, MAX_BOUND_MSG_ID_LEN) ? parsed.client_msg_id : crypto.randomUUID(),
        };
        if (nonEmptyString(sender?.device_id)) binding.d = sender!.device_id!;
        if (nonEmptyString(sender?.user_id))   binding.u = sender!.user_id!;
        // Any `_cb` already on the object (copied content) is overwritten.
        plaintextJson = JSON.stringify({ ...parsed, _cb: binding });
    }

    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ptBuf  = Buffer.from(plaintextJson, 'utf8');
    const ctBody = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
    const tag    = cipher.getAuthTag();
    const ciphertext = Buffer.concat([ctBody, tag]);

    const identPrivKey = loadIdentityPrivKey();
    const signature    = crypto.sign(null, ciphertext, identPrivKey);

    return {
        epoch,
        nonce_b64:      nonceB64,
        ciphertext_b64: ciphertext.toString('base64'),
        signature_b64:  Buffer.from(signature).toString('base64'),
    };
}

/**
 * Decrypt a channel message and verify the sender's Ed25519 signature.
 *
 * `channel_id` / `epoch` must be where the message ARRIVED (the channel whose
 * thread it will be shown in), and `message_id` / `sender_*` the server row's
 * own labels — they are what the v2 binding is checked against.
 *
 * Throws `[E2EE:CHANNEL_REPLAY]` for a ciphertext already accepted under a
 * different server id, and `[E2EE:CHANNEL_BINDING]` when a v2 binding does not
 * match the arrival context. Both mean "the server served this wrongly", not
 * "we lack a key" — callers must DROP such rows rather than render an
 * undecryptable placeholder (which would also go asking for keys).
 *
 * @returns the content JSON with the binding stripped.
 */
export function decryptChannelMessage(params: {
    channel_id: string;
    epoch: number;
    nonce_b64: string;
    ciphertext_b64: string;
    signature_b64: string;
    sender_identity_pub_b64: string;
    message_id?: string | null;
    sender_user_id?: string | null;
    sender_device_id?: string | null;
}): string {
    const { channel_id, epoch, nonce_b64, ciphertext_b64, signature_b64, sender_identity_pub_b64 } = params;

    const ciphertextBuf = Buffer.from(ciphertext_b64, 'base64');
    const signatureBuf  = Buffer.from(signature_b64, 'base64');
    const nonce         = Buffer.from(nonce_b64, 'base64');

    // Every client has always written a 12-byte nonce. Refusing anything else
    // closes the GCM "arbitrary-length IV" path (a non-96-bit IV is GHASHed,
    // which a key holder can steer) and makes the nonce a canonical replay key.
    if (nonce.length !== 12) throw new Error(`[E2EE:CHANNEL_MALFORMED] nonce must be 12 bytes (channel=${channel_id})`);
    if (ciphertextBuf.length < 16) throw new Error(`[E2EE:CHANNEL_MALFORMED] ciphertext shorter than the GCM tag (channel=${channel_id})`);
    // Canonical form — base64 decoding is lenient (padding, whitespace, url
    // alphabet), so the raw string must never be the replay/binding key.
    const nonceCanon = nonce.toString('base64');

    // Verify sender's Ed25519 signature BEFORE decrypting
    const senderPubKey = importEd25519Pub(sender_identity_pub_b64);
    const sigValid = crypto.verify(null, ciphertextBuf, senderPubKey, signatureBuf);
    if (!sigValid) throw new Error(`[E2EE] Channel message signature verification failed (channel=${channel_id} epoch=${epoch})`);

    const key = getChannelKey(channel_id, epoch);
    if (!key) throw new Error(`[E2EE] Channel key for channel ${channel_id} epoch ${epoch} not in local store`);

    const ctBody = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);
    const ctTag  = ciphertextBuf.subarray(ciphertextBuf.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(ctTag);
    const plaintext = Buffer.concat([decipher.update(ctBody), decipher.final()]).toString('utf8');

    let resultJson = plaintext;
    let parsed: unknown;
    try { parsed = JSON.parse(plaintext); } catch { parsed = undefined; }
    if (isPlainObject(parsed) && '_cb' in parsed) {
        const cb = parsed._cb;
        if (isPlainObject(cb) && cb.v === CHANNEL_BINDING_VERSION && cb.n === nonceCanon) {
            // A genuine v2 binding written by the encrypting engine. Enforce it.
            const fail = (what: string) => {
                throw new Error(`[E2EE:CHANNEL_BINDING] ${what} mismatch (arrived channel=${channel_id} epoch=${epoch})`);
            };
            if (cb.c !== channel_id) fail('channel');
            if (cb.e !== epoch) fail('epoch');
            if (!nonEmptyString(cb.m, MAX_BOUND_MSG_ID_LEN)) fail('message id');
            if (cb.d !== undefined && params.sender_device_id && cb.d !== params.sender_device_id) fail('sender device');
            if (cb.u !== undefined && params.sender_user_id && cb.u !== params.sender_user_id) fail('sender user');
        }
        // Stripped in every case — genuine, copied-along, or a future version
        // this build cannot interpret — so it never reaches UI state, backups,
        // or a re-send.
        const { _cb: _dropped, ...rest } = parsed;
        void _dropped;
        resultJson = JSON.stringify(rest);
    }

    // Replay ledger — version-independent, so legacy rows are covered too.
    // Recorded only after every other check has passed (see RC-9 above for why
    // a failed message must never be admitted into a replay set).
    if (nonEmptyString(params.message_id)) {
        if (classifyChannelNonce(channel_id, nonceCanon, params.message_id) === 'replay') {
            throw new Error(`[E2EE:CHANNEL_REPLAY] ciphertext already accepted under another message id (channel=${channel_id})`);
        }
        recordChannelNonce(channel_id, nonceCanon, params.message_id);
    }

    return resultJson;
}
