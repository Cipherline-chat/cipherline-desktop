/**
 * Bytes out of a `net:fetch-binary` reply.
 *
 * Today the main process answers `{ b64, mimeType }`; the decode is
 * `base64ToBytes` (utils/base64Bytes.ts: native decoder, no per-byte callback).
 * Also accepts a raw `bytes` field so the main
 * process can switch to sending an ArrayBuffer (structured clone, no base64 at
 * all) without another renderer change.
 */
import { base64ToBytes } from './base64Bytes';

export interface BinaryPayload {
    mimeType: string;
    b64?: string;
    bytes?: ArrayBuffer | Uint8Array;
}

export function bytesFromBinaryPayload(res: BinaryPayload): Uint8Array {
    if (res.bytes) return res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);
    return base64ToBytes(res.b64 ?? '');
}
