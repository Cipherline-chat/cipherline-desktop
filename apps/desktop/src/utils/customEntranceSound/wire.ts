/**
 * Custom entrance sound on the call's data channel: the packet format and its
 * encryption. Pure (WebCrypto only), so it is unit-tested in node.
 *
 * ── Why our own encryption ─────────────────────────────────────────────────
 * LiveKit data packets are NOT something we may rely on the SDK to protect:
 * on livekit-client 2.18.8 a receiver cannot tell an encrypted data packet
 * from a plaintext one (`encryptionType` is always NONE, see the note in
 * hooks/useAnnotationTransport.ts), and a Room built without `encryption:`
 * sends them in the clear. So every chunk is sealed here, and nothing is sent
 * without a call key.
 *
 * ── Key ─────────────────────────────────────────────────────────────────────
 *   k = HKDF-SHA256(ikm = the call's current 32-byte media key (the key
 *       CallPane hands LiveKit's key provider), salt = empty,
 *       info = "cipherline/entrance-sound/v1")
 * Domain-separated from the media key itself, so no AES-GCM nonce is ever
 * shared between this and the frame encryption. Everyone who can hear the
 * call holds the media key, so everyone who can hear the call can open the
 * sound - and nobody else (the SFU included). After a key rotation a sender
 * and a receiver may briefly disagree on the key: that chunk fails to open
 * and the sound simply is not played, which is the safe outcome.
 *
 * ── Packet ──────────────────────────────────────────────────────────────────
 *   0  4  magic "CLES"
 *   4  1  version (1)
 *   5 16  content id (raw 16 bytes of the 32-hex id)
 *  21  1  chunk index (0-based)
 *  22  1  chunk total (1..MAX_CHUNKS)
 *  23 12  nonce (fresh random 96 bits per packet)
 *  35  -  AES-256-GCM(chunk) incl. 16-byte tag
 * AAD = bytes 0..22 (magic, version, id, index, total) || UTF-8(sender
 * identity). So a chunk cannot be moved to another id, position, or total, or
 * replayed as someone else's (the sender identity is the SFU-attested LiveKit
 * participant identity, which is the user id).
 *
 * Chunk size: 8 KiB of plaintext (+51 bytes framing), well under LiveKit's
 * ~15 KiB reliable-packet guidance. annotationCodec caps its JSON at 4 KiB
 * because a stroke is small; a sound is at most 64 KiB, so 8 chunks.
 */

import { MAX_ENCODED_BYTES } from './constants';
import { isContentId } from './identity';

export const ENTRANCE_SOUND_TOPIC = 'cl-entrance-sound';
export const WIRE_VERSION = 1;
export const HKDF_INFO = 'cipherline/entrance-sound/v1';
export const CHUNK_BYTES = 8 * 1024;
export const MAX_CHUNKS = Math.ceil(MAX_ENCODED_BYTES / CHUNK_BYTES);
const MAGIC = [0x43, 0x4c, 0x45, 0x53] as const; // "CLES"
export const HEADER_BYTES = 23;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Largest packet we ever send or accept. */
export const MAX_PACKET_BYTES = HEADER_BYTES + NONCE_BYTES + CHUNK_BYTES + TAG_BYTES;

const enc = new TextEncoder();
const KEY32_B64_RE = /^[A-Za-z0-9+/]{43}=?$/;

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesToHex(b: Uint8Array): string {
    let s = '';
    for (const v of b) s += v.toString(16).padStart(2, '0');
    return s;
}

/** The AES-GCM key for entrance sounds in a call, from the call's media key (base64, 32 bytes). */
export async function deriveEntranceKey(callKeyB64: string): Promise<CryptoKey> {
    if (typeof callKeyB64 !== 'string' || !KEY32_B64_RE.test(callKeyB64)) throw new Error('no call key');
    const raw = b64ToBytes(callKeyB64);
    try {
        const ikm = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
        return await crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
            ikm,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt'],
        );
    } finally {
        raw.fill(0);
    }
}

function header(id: string, index: number, total: number): Uint8Array {
    const h = new Uint8Array(HEADER_BYTES);
    h.set(MAGIC, 0);
    h[4] = WIRE_VERSION;
    h.set(hexToBytes(id), 5);
    h[21] = index;
    h[22] = total;
    return h;
}

function aad(head: Uint8Array, sender: string): Uint8Array {
    const s = enc.encode(sender);
    const out = new Uint8Array(head.length + s.length);
    out.set(head, 0);
    out.set(s, head.length);
    return out;
}

/** Split `bytes` into sealed packets for `sender` (the LOCAL identity). */
export async function sealSound(key: CryptoKey, id: string, bytes: Uint8Array, sender: string): Promise<Uint8Array[]> {
    if (!isContentId(id)) throw new Error('bad id');
    if (bytes.length === 0 || bytes.length > MAX_ENCODED_BYTES) throw new Error('bad size');
    if (!sender) throw new Error('no identity');
    const total = Math.ceil(bytes.length / CHUNK_BYTES);
    const out: Uint8Array[] = [];
    for (let i = 0; i < total; i++) {
        const head = header(id, i, total);
        const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad(head, sender) as BufferSource },
            key,
            bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) as BufferSource,
        ));
        const pkt = new Uint8Array(HEADER_BYTES + NONCE_BYTES + ct.length);
        pkt.set(head, 0);
        pkt.set(nonce, HEADER_BYTES);
        pkt.set(ct, HEADER_BYTES + NONCE_BYTES);
        out.push(pkt);
    }
    return out;
}

export interface PacketHeader { id: string; index: number; total: number }

/** Cheap structural parse (no crypto): null for anything that is not one of ours. */
export function parseHeader(pkt: Uint8Array): PacketHeader | null {
    if (!(pkt instanceof Uint8Array)) return null;
    if (pkt.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES + 1 || pkt.length > MAX_PACKET_BYTES) return null;
    for (let i = 0; i < 4; i++) if (pkt[i] !== MAGIC[i]) return null;
    if (pkt[4] !== WIRE_VERSION) return null;
    const total = pkt[22];
    const index = pkt[21];
    if (total < 1 || total > MAX_CHUNKS || index >= total) return null;
    return { id: bytesToHex(pkt.subarray(5, 21)), index, total };
}

/** Open one packet from `sender`; null when it does not authenticate. */
export async function openPacket(key: CryptoKey, pkt: Uint8Array, sender: string): Promise<{ header: PacketHeader; chunk: Uint8Array } | null> {
    const h = parseHeader(pkt);
    if (!h || !sender) return null;
    try {
        const pt = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: pkt.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES) as BufferSource,
                additionalData: aad(pkt.subarray(0, HEADER_BYTES), sender) as BufferSource,
            },
            key,
            pkt.subarray(HEADER_BYTES + NONCE_BYTES) as BufferSource,
        );
        const chunk = new Uint8Array(pt);
        // Every chunk but the last is exactly CHUNK_BYTES; none is empty or bigger.
        if (chunk.length === 0 || chunk.length > CHUNK_BYTES) return null;
        if (h.index < h.total - 1 && chunk.length !== CHUNK_BYTES) return null;
        return { header: h, chunk };
    } catch {
        return null;
    }
}
