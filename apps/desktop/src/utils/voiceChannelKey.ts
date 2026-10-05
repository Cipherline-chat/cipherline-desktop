/**
 * Derivation of a Calls-channel LiveKit room key from the channel's Sender Key.
 *
 * ── What this is for
 *
 * Server calls channels (DB `Channel.kind` of `'huddle'` or `'voice'`; the
 * user-facing name is always "Calls channel") used to join LiveKit with an
 * empty `e2ee_key_b64`, i.e. NOT end-to-end encrypted — only the DM/group
 * `call_key` flow was. This module closes that gap by reusing the channel
 * Sender Key that the text-channel E2EE scheme already distributes, instead of
 * inventing a second key-distribution protocol.
 *
 * ── The contract (shared with apps/mobile — DO NOT change either half alone)
 *
 *     voiceKey = HKDF-SHA256(
 *       ikm  = channelSenderKey   // the 32 raw bytes of key_b64 for the
 *                                 //   channel's CURRENT epoch
 *       salt = <zero-length>      // empty salt
 *       info = UTF-8("cipherline/voice-key/v1/" + channelId + "/" + epoch)
 *       L    = 32
 *     )
 *
 * `channelId` is the canonical LOWERCASE UUID string and `epoch` a plain
 * decimal integer. Both clients must produce byte-identical output or they
 * cannot hear each other, so both are normalized and then strictly validated
 * below rather than being trusted as given: an uppercase UUID, a braced UUID,
 * a `1.0`, or a zero-padded `01` would each silently derive a DIFFERENT key
 * and present as "the call connects but nobody has audio". Rejecting loudly is
 * the only safe failure mode.
 *
 * The derivation is deliberately domain-separated per (channel, epoch): the
 * same Sender Key protects channel TEXT, and a room key must not be usable as
 * a message key or vice versa. Binding the epoch in means a rotation produces
 * an unrelated room key rather than one an evicted member could predict.
 *
 * Verified against the shared test vector in voiceChannelKey.test.ts. That
 * vector is authoritative: if this file stops reproducing it, this file is
 * wrong — never the vector.
 *
 * ── Never rolled by hand
 *
 * Uses the platform WebCrypto HKDF (`crypto.subtle.deriveBits`), matching the
 * repo's renderer-side crypto convention (see utils/crypto.ts and
 * utils/blobCacheKey.ts). The at-rest key/value store derives its per-account
 * subkeys the same way, but now does so in the MAIN process — see
 * electron/kv-crypto.ts.
 */

/** Domain-separation prefix. Bump the `v1` if the derivation ever changes. */
export const VOICE_KEY_INFO_PREFIX = 'cipherline/voice-key/v1/';

/** Sender Keys are AES-256 keys: exactly 32 bytes, always. */
export const CHANNEL_SENDER_KEY_BYTES = 32;

/** Derived room keys are AES-256 keys too. */
export const VOICE_KEY_BYTES = 32;

/** Canonical 8-4-4-4-12 hex UUID. Case-insensitive here; normalized to lower. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `info` string, exactly as both clients must build it.
 *
 * Exported so the cross-platform vector test can assert on the string itself,
 * not just the resulting bytes — a mismatch here is far easier to diagnose as
 * a bad info string than as 32 wrong bytes.
 */
export function buildVoiceKeyInfo(channelId: string, epoch: number): string {
    const id = normalizeChannelId(channelId);
    const ep = normalizeEpoch(epoch);
    return `${VOICE_KEY_INFO_PREFIX}${id}/${ep}`;
}

/** Lowercase + shape-check. Throws rather than deriving a divergent key. */
function normalizeChannelId(channelId: string): string {
    if (typeof channelId !== 'string' || !UUID_RE.test(channelId)) {
        // Deliberately does not echo the value — channel ids are routing
        // metadata and this string can reach logs.
        throw new Error('voice key derivation: channelId must be a canonical UUID');
    }
    return channelId.toLowerCase();
}

/**
 * Decimal integer form. Rejects non-integers and out-of-range values so
 * `String(epoch)` can never produce `1.0`, `1e21`, `NaN` or `-1`. Epochs are
 * 1-based (epoch 1 is a channel's first minted key).
 */
function normalizeEpoch(epoch: number): string {
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
        throw new Error(`voice key derivation: epoch must be a positive integer, got ${String(epoch)}`);
    }
    return String(epoch);
}

/** Strict base64 → bytes. */
function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/**
 * Derive the LiveKit room key for one (channel, epoch).
 *
 * Returns a freshly allocated 32-byte `ArrayBuffer` — NOT a `Uint8Array` — on
 * purpose. The consumer hands this straight to
 * `ExternalE2EEKeyProvider.setKey()`, whose two overloads behave completely
 * differently: an `ArrayBuffer` is run through HKDF (what every Cipherline
 * client must do), a `string` through PBKDF2. Returning the buffer directly
 * removes the chance of a caller writing `view.buffer` on a byte-offset view
 * and passing the wrong region, and makes the string overload unreachable by
 * accident.
 *
 * @param channelSenderKey the channel's raw 32-byte Sender Key for `epoch`
 * @param channelId        the channel's UUID (any case; normalized to lower)
 * @param epoch            the epoch those key bytes belong to
 */
export async function deriveVoiceChannelKey(
    channelSenderKey: Uint8Array,
    channelId: string,
    epoch: number,
): Promise<ArrayBuffer> {
    if (!(channelSenderKey instanceof Uint8Array) || channelSenderKey.byteLength !== CHANNEL_SENDER_KEY_BYTES) {
        throw new Error(
            `voice key derivation: channel Sender Key must be ${CHANNEL_SENDER_KEY_BYTES} bytes, ` +
            `got ${channelSenderKey?.byteLength ?? 'none'}`,
        );
    }
    // Build the info FIRST so a malformed channelId/epoch throws before any
    // key material is imported.
    const info = new TextEncoder().encode(buildVoiceKeyInfo(channelId, epoch));

    const ikm = await crypto.subtle.importKey(
        'raw',
        // Copy into a standalone buffer: importKey reads the whole underlying
        // ArrayBuffer's view range, and a caller may hand us a subarray of a
        // larger allocation.
        channelSenderKey.slice(),
        'HKDF',
        false,           // non-extractable — this only ever feeds deriveBits
        ['deriveBits'],
    );

    return crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
        ikm,
        VOICE_KEY_BYTES * 8,
    );
}

/**
 * Convenience wrapper for the wire form: the `key_b64` carried by a
 * `channel_key` ClientContent envelope.
 */
export async function deriveVoiceChannelKeyFromB64(
    channelSenderKeyB64: string,
    channelId: string,
    epoch: number,
): Promise<ArrayBuffer> {
    let bytes: Uint8Array;
    try {
        bytes = base64ToBytes(channelSenderKeyB64);
    } catch {
        throw new Error('voice key derivation: channel Sender Key is not valid base64');
    }
    return deriveVoiceChannelKey(bytes, channelId, epoch);
}
