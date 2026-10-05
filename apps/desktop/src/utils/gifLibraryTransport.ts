/**
 * gifLibraryTransport — framing for the encrypted GIF-library snapshot that
 * moves between a user's own devices.
 *
 * WHY A SNAPSHOT AND NOT AN OP STREAM. Personal pins sync as `pin` ops through
 * the E2EE DM envelope, but that path needs a `conversation_id` the sender is
 * an active member of (`POST /v1/messages/send` enforces it) and caps a payload
 * at 10 MB of base64. A GIF library belongs to no conversation and carries
 * multi-MB blobs, so it gets its own slot in the existing `/v1/history` blob
 * store instead — user-scoped, conversation-free, and already the free-tier
 * baseline capability that carries a whole-vault device transfer.
 *
 * WHAT THE SERVER SEES: one opaque byte string. Nothing else. The container is
 *
 *   magic   "CLGIF1"            6 bytes
 *   u32be   headerLen
 *   header  utf8 JSON           { v: 1, key_envelope_b64 }
 *   body    iv(12) || AES-256-GCM ciphertext
 *
 * `key_envelope_b64` is the ECIES envelope produced by the existing
 * `encryptMessageV2`, addressed to the user's OWN devices only. It carries the
 * body's AES-256-GCM content key, wrapped per-device against each device's
 * signed prekey. A device that is not in that envelope cannot derive the
 * content key, so the server — which holds the bytes — cannot read the body.
 * Only the header is plaintext, and it holds no user data.
 *
 * The body decodes to a `GifSnapshotPayload`: the library metadata, the LWW
 * ledger (so deletions survive), the per-GIF AES keys, and the `.enc` file
 * bytes. Those bytes are already ciphertext under their own per-GIF key before
 * they are put in here, so they are double-wrapped in transit and at rest.
 *
 * Framing and validation live here and are pure — no IPC, no network, no DOM —
 * so they are unit-testable. Key wrapping and transfer live in
 * gifLibrarySyncService.ts.
 */

import type { GifEntry, GifLedger } from './gifLibrarySync';
import { isValidEntry } from './gifLibrarySync';

export const GIF_SNAPSHOT_MAGIC = 'CLGIF1';
export const GIF_SNAPSHOT_VERSION = 1;
/** The `/v1/history` slot this lives in. Must match the server allowlist. */
export const GIF_LIBRARY_SLOT = 'gif_library';

export interface GifSnapshotPayload {
    v: number;
    /** Wall clock of the device that wrote this snapshot. Diagnostics only —
     *  merge order comes from the per-GIF ledger, never from this. */
    writtenAt: number;
    entries: GifEntry[];
    ledger: GifLedger;
    /** gifId → base64 AES-256-GCM key for that GIF's `.enc` file. */
    keys: Record<string, string>;
    /** gifId → base64 of the on-disk `.enc` bytes. */
    files: Record<string, string>;
}

export interface GifSnapshotHeader {
    v: number;
    key_envelope_b64: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Framing ─────────────────────────────────────────────────────────────────

/** Wrap a header + already-encrypted body into the container byte string. */
export function frameSnapshot(header: GifSnapshotHeader, body: Uint8Array): Uint8Array {
    const magic = enc.encode(GIF_SNAPSHOT_MAGIC);
    const headerBytes = enc.encode(JSON.stringify(header));
    const out = new Uint8Array(magic.length + 4 + headerBytes.length + body.length);

    out.set(magic, 0);
    new DataView(out.buffer).setUint32(magic.length, headerBytes.length, false);
    out.set(headerBytes, magic.length + 4);
    out.set(body, magic.length + 4 + headerBytes.length);
    return out;
}

export function isGifSnapshot(bytes: Uint8Array): boolean {
    if (bytes.length < GIF_SNAPSHOT_MAGIC.length) return false;
    return dec.decode(bytes.subarray(0, GIF_SNAPSHOT_MAGIC.length)) === GIF_SNAPSHOT_MAGIC;
}

/**
 * Split a container back into its header and encrypted body.
 *
 * Every length is checked against the real buffer before it is used: these
 * bytes come back from the server, and a truncated or hostile blob must fail
 * cleanly rather than throw somewhere further in.
 */
export function parseSnapshotFrame(bytes: Uint8Array): { header: GifSnapshotHeader; body: Uint8Array } {
    if (!isGifSnapshot(bytes)) throw new Error('Not a GIF library snapshot');

    const off = GIF_SNAPSHOT_MAGIC.length;
    if (bytes.length < off + 4) throw new Error('GIF snapshot truncated: no header length');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLen = view.getUint32(off, false);
    const headerStart = off + 4;
    if (headerLen === 0 || headerStart + headerLen > bytes.length) {
        throw new Error('GIF snapshot truncated: bad header length');
    }

    let header: GifSnapshotHeader;
    try {
        header = JSON.parse(dec.decode(bytes.subarray(headerStart, headerStart + headerLen)));
    } catch {
        throw new Error('GIF snapshot header is not valid JSON');
    }
    if (!header || typeof header.key_envelope_b64 !== 'string' || !header.key_envelope_b64) {
        throw new Error('GIF snapshot header is missing its key envelope');
    }
    if (header.v !== GIF_SNAPSHOT_VERSION) {
        throw new Error(`Unsupported GIF snapshot version ${header.v}`);
    }

    return { header, body: bytes.subarray(headerStart + headerLen) };
}

// ── Payload validation ──────────────────────────────────────────────────────

/**
 * Coerce a decrypted payload into a shape the merge layer can trust.
 *
 * This ran through another of the user's own devices, but "our device" is not
 * "well-formed": a partially-written or downgraded snapshot must not be able
 * to put junk into the library metadata, which is persisted and then flows
 * into the backup vault. Unknown ids are dropped rather than repaired.
 */
export function parseSnapshotPayload(json: string): GifSnapshotPayload {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error('GIF snapshot payload is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('GIF snapshot payload is not an object');
    const raw = parsed as Record<string, unknown>;

    const entries: GifEntry[] = Array.isArray(raw.entries) ? raw.entries.filter(isValidEntry) : [];

    const ledger: GifLedger = {};
    if (raw.ledger && typeof raw.ledger === 'object') {
        for (const [id, at] of Object.entries(raw.ledger as Record<string, unknown>)) {
            if (typeof id === 'string' && id && typeof at === 'number' && Number.isFinite(at)) {
                ledger[id] = at;
            }
        }
    }

    const pickStrings = (src: unknown): Record<string, string> => {
        const out: Record<string, string> = {};
        if (src && typeof src === 'object') {
            for (const [id, v] of Object.entries(src as Record<string, unknown>)) {
                if (typeof id === 'string' && id && typeof v === 'string' && v) out[id] = v;
            }
        }
        return out;
    };

    return {
        v: typeof raw.v === 'number' ? raw.v : GIF_SNAPSHOT_VERSION,
        writtenAt: typeof raw.writtenAt === 'number' ? raw.writtenAt : 0,
        entries,
        ledger,
        keys: pickStrings(raw.keys),
        files: pickStrings(raw.files),
    };
}

export function buildSnapshotPayload(
    entries: GifEntry[],
    ledger: GifLedger,
    keys: Record<string, string>,
    files: Record<string, string>,
    now: number,
): GifSnapshotPayload {
    return { v: GIF_SNAPSHOT_VERSION, writtenAt: now, entries, ledger, keys, files };
}

// ── base64 for the file bytes ───────────────────────────────────────────────
// Chunked so a multi-MB GIF doesn't blow the argument limit on String.fromCharCode.

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
