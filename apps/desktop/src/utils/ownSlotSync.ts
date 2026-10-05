/**
 * ownSlotSync — the pieces every "own-device slot" sync shares.
 *
 * An own-device slot is one opaque blob per (user, slot) in the `/v1/history`
 * store (`apps/api/src/history/backup-slots.ts`), holding a snapshot that only
 * the user's OWN devices can read. Two slots use it:
 *
 *   gif_library     the saved-GIF library (gifLibraryTransport.ts, "CLGIF1")
 *   personal_saves  channel "Save for me" + personal pins (personalSavesSync.ts, "CLSAV1")
 *
 * Container (identical for every slot, only the magic differs):
 *
 *   magic   6 ASCII bytes
 *   u32be   headerLen
 *   header  utf8 JSON   { v: 1, key_envelope_b64 }
 *   body    iv(12) || AES-256-GCM(contentKey, payload JSON)
 *
 * `key_envelope_b64` is a v3 E2EE envelope (encryptForDevices) carrying
 * `{"k": contentKeyB64}`, wrapped to the user's other devices. The server
 * stores the bytes and cannot read them.
 *
 * Everything here is pure (no IPC, network or DOM), so it is unit-testable and
 * so mobile's port (cipherline-mobile src/features/own-sync/) can be checked
 * against it byte for byte by the cross-repo interop harness.
 *
 * Design: docs/OWN-DEVICE-SYNC.md in cipherline-mobile.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const OWN_SLOT_CONTAINER_VERSION = 1;

export interface OwnSlotHeader {
    v: number;
    key_envelope_b64: string;
}

// ── Framing ─────────────────────────────────────────────────────────────────

export function frameOwnSlot(magic: string, header: OwnSlotHeader, body: Uint8Array): Uint8Array {
    const magicBytes = enc.encode(magic);
    const headerBytes = enc.encode(JSON.stringify(header));
    const out = new Uint8Array(magicBytes.length + 4 + headerBytes.length + body.length);
    out.set(magicBytes, 0);
    new DataView(out.buffer).setUint32(magicBytes.length, headerBytes.length, false);
    out.set(headerBytes, magicBytes.length + 4);
    out.set(body, magicBytes.length + 4 + headerBytes.length);
    return out;
}

export function hasMagic(magic: string, bytes: Uint8Array): boolean {
    if (bytes.length < magic.length) return false;
    return dec.decode(bytes.subarray(0, magic.length)) === magic;
}

/**
 * Split a container into header and encrypted body. Every length is checked
 * against the real buffer first: these bytes come back from the server and a
 * truncated or hostile blob must fail cleanly here, not somewhere further in.
 */
export function parseOwnSlotFrame(magic: string, bytes: Uint8Array): { header: OwnSlotHeader; body: Uint8Array } {
    if (!hasMagic(magic, bytes)) throw new Error(`Not a ${magic} snapshot`);
    const off = magic.length;
    if (bytes.length < off + 4) throw new Error('Snapshot truncated: no header length');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(off, false);
    const headerStart = off + 4;
    if (headerLen === 0 || headerStart + headerLen > bytes.length) {
        throw new Error('Snapshot truncated: bad header length');
    }

    let header: OwnSlotHeader;
    try {
        header = JSON.parse(dec.decode(bytes.subarray(headerStart, headerStart + headerLen)));
    } catch {
        throw new Error('Snapshot header is not valid JSON');
    }
    if (!header || typeof header.key_envelope_b64 !== 'string' || !header.key_envelope_b64) {
        throw new Error('Snapshot header is missing its key envelope');
    }
    if (header.v !== OWN_SLOT_CONTAINER_VERSION) {
        throw new Error(`Unsupported snapshot version ${header.v}`);
    }
    const body = bytes.subarray(headerStart + headerLen);
    // iv(12) + at least the 16-byte GCM tag.
    if (body.length < 12 + 16) throw new Error('Snapshot truncated: body too short');
    return { header, body };
}

// ── The key envelope, read without decrypting ───────────────────────────────

/**
 * Device ids a v3 key envelope is addressed to — the keys of its `recipients`
 * map, which travel in the clear (the server already knows the user's own
 * device ids). Null when the envelope is not a parseable v3 envelope, which
 * callers treat as "unknown", never as "addressed to nobody".
 */
export function envelopeRecipientIds(envelopeB64: string): string[] | null {
    try {
        const env = JSON.parse(dec.decode(base64ToBytes(envelopeB64)));
        if (!env || typeof env !== 'object' || !env.recipients || typeof env.recipients !== 'object') return null;
        return Object.keys(env.recipients).sort();
    } catch {
        return null;
    }
}

// ── Ids that become file names or map keys ──────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * An id from another device that is safe to use as a map key or file name.
 * Rejects path separators, dots and anything long, so a crafted snapshot can
 * never name a file outside the library directory. Every id the clients mint
 * (UUIDs, `local-…`/`gif-…` fallbacks) passes.
 */
export function isSafeSyncId(id: unknown): id is string {
    return typeof id === 'string' && SAFE_ID.test(id);
}

// ── Sender verification ─────────────────────────────────────────────────────

export interface EnvelopeSender {
    senderUserId?: string;
    senderDeviceId?: string;
    senderPub?: string;
}

export interface OwnDeviceIdentity {
    device_id: string;
    identity_key_pub_b64: string;
}

/**
 * Did one of MY devices write this? Decrypting proves only that the bytes were
 * wrapped to this device's PUBLIC signed prekey — anyone who can write the slot
 * (the server, in the threat model) can do that. So the inner sender must be
 * this account, and its identity key must be one of this account's current
 * devices' identity keys.
 *
 * An envelope from a sender that predates `senderDeviceId` is accepted when its
 * identity key matches ANY of this account's devices.
 */
export function isOwnSender(sender: EnvelopeSender, userId: string, identities: readonly OwnDeviceIdentity[]): boolean {
    if (!sender || sender.senderUserId !== userId) return false;
    if (typeof sender.senderPub !== 'string' || !sender.senderPub) return false;
    if (sender.senderDeviceId) {
        return identities.some(d => d.device_id === sender.senderDeviceId && d.identity_key_pub_b64 === sender.senderPub);
    }
    return identities.some(d => d.identity_key_pub_b64 === sender.senderPub);
}

// ── Anti-entropy ────────────────────────────────────────────────────────────

/**
 * What this device last knew about the slot, persisted so the checks below
 * need no download while the slot is unchanged.
 */
export interface SlotView<S> {
    /** The slot's `updated_at` this view describes. */
    updatedAt: string;
    /** Devices the slot's key envelope is addressed to; null if unknown. */
    recipients: string[] | null;
    /** The device that wrote it; null if this device could not decrypt it. */
    publisher: string | null;
    /** The slot's state as published; null if this device could not read it. */
    state: S | null;
}

export type RepublishReason = 'none' | 'slot-empty' | 'slot-behind' | 'device-missing';

export interface RepublishInput<S> {
    /** Null when the slot has never been written. */
    view: SlotView<S> | null;
    /** The local state as it WOULD be published (already filtered to what is publishable). */
    local: S;
    isEmpty: (s: S) => boolean;
    merge: (a: S, b: S) => S;
    same: (a: S, b: S) => boolean;
    /** This account's current devices, or null when unknown. */
    ownDeviceIds: readonly string[] | null;
    myDeviceId: string;
}

/**
 * Should this device republish the slot although nothing changed locally?
 *
 *  • slot-empty     nothing published yet and we hold something.
 *  • slot-behind    merging our state INTO the slot would change it: our
 *                   knowledge is missing from it (a concurrent publish
 *                   overwrote ours, or this device restored from a backup).
 *                   Deliberately one-directional: the slot holding something
 *                   WE lack is not a reason, or two devices with different
 *                   gaps would republish at each other forever.
 *  • device-missing a current device of ours is neither addressed nor the
 *                   publisher, so it cannot read the slot (a new device).
 *
 * A slot this device cannot read is never republished over on these grounds:
 * we would be replacing state we never saw.
 */
export function republishReason<S>(input: RepublishInput<S>): RepublishReason {
    const { view, local } = input;
    if (!view) return input.isEmpty(local) ? 'none' : 'slot-empty';
    if (!view.state) return 'none';
    if (!input.same(input.merge(view.state, local), view.state)) return 'slot-behind';
    if (input.ownDeviceIds && view.recipients) {
        const covered = new Set(view.recipients);
        covered.add(input.myDeviceId);
        if (view.publisher) covered.add(view.publisher);
        if (input.ownDeviceIds.some(id => !covered.has(id))) return 'device-missing';
    }
    return 'none';
}

/** Anti-entropy republishes are rate-limited per slot, so a device that can
 *  never be wrapped (no valid signed prekey) cannot cause a publish loop. */
export const ANTI_ENTROPY_MIN_GAP_MS = 10 * 60 * 1000;

// ── base64 (chunked, so a large blob does not blow the argument limit) ──────

export function bytesToBase64(u8: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
