import { describe, it, expect } from 'vitest';
import {
    frameSnapshot,
    parseSnapshotFrame,
    isGifSnapshot,
    parseSnapshotPayload,
    buildSnapshotPayload,
    bytesToBase64,
    base64ToBytes,
    GIF_SNAPSHOT_MAGIC,
    GIF_SNAPSHOT_VERSION,
    type GifSnapshotHeader,
} from './gifLibraryTransport';
import type { GifEntry } from './gifLibrarySync';

const header = (): GifSnapshotHeader => ({ v: GIF_SNAPSHOT_VERSION, key_envelope_b64: 'ENVELOPE' });
const body = () => new Uint8Array([1, 2, 3, 4, 5]);

const gif = (id: string, addedAt = 1_000): GifEntry => ({
    id, source: 'local', fileName: `${id}.enc`, mimeType: 'image/gif', addedAt,
});

describe('snapshot framing', () => {
    it('round-trips a header and body', () => {
        const framed = frameSnapshot(header(), body());
        const out = parseSnapshotFrame(framed);
        expect(out.header.key_envelope_b64).toBe('ENVELOPE');
        expect([...out.body]).toEqual([1, 2, 3, 4, 5]);
    });

    it('round-trips an empty body', () => {
        const framed = frameSnapshot(header(), new Uint8Array(0));
        expect([...parseSnapshotFrame(framed).body]).toEqual([]);
    });

    it('round-trips a header carrying non-ASCII', () => {
        const h = { v: GIF_SNAPSHOT_VERSION, key_envelope_b64: 'ünïcødé+/=' };
        const out = parseSnapshotFrame(frameSnapshot(h, body()));
        expect(out.header.key_envelope_b64).toBe('ünïcødé+/=');
        // The multi-byte header must not bleed into the body.
        expect([...out.body]).toEqual([1, 2, 3, 4, 5]);
    });

    it('recognises its own magic and rejects anything else', () => {
        expect(isGifSnapshot(frameSnapshot(header(), body()))).toBe(true);
        expect(isGifSnapshot(new Uint8Array([0, 1, 2]))).toBe(false);
        expect(isGifSnapshot(new Uint8Array(0))).toBe(false);
    });

    it('rejects a blob that is not a snapshot', () => {
        expect(() => parseSnapshotFrame(new TextEncoder().encode('NOPE!!more')))
            .toThrow(/Not a GIF library snapshot/);
    });

    it('rejects a truncated header length', () => {
        const framed = frameSnapshot(header(), body());
        expect(() => parseSnapshotFrame(framed.subarray(0, GIF_SNAPSHOT_MAGIC.length + 2)))
            .toThrow(/truncated/);
    });

    it('rejects a header length running past the buffer', () => {
        const framed = frameSnapshot(header(), body());
        const evil = framed.slice();
        new DataView(evil.buffer).setUint32(GIF_SNAPSHOT_MAGIC.length, 0xffff, false);
        expect(() => parseSnapshotFrame(evil)).toThrow(/bad header length/);
    });

    it('rejects a zero-length header', () => {
        const framed = frameSnapshot(header(), body());
        const evil = framed.slice();
        new DataView(evil.buffer).setUint32(GIF_SNAPSHOT_MAGIC.length, 0, false);
        expect(() => parseSnapshotFrame(evil)).toThrow(/bad header length/);
    });

    it('rejects a header with no key envelope', () => {
        const framed = frameSnapshot({ v: GIF_SNAPSHOT_VERSION, key_envelope_b64: '' }, body());
        expect(() => parseSnapshotFrame(framed)).toThrow(/missing its key envelope/);
    });

    it('rejects an unsupported version', () => {
        const framed = frameSnapshot({ v: 99, key_envelope_b64: 'E' }, body());
        expect(() => parseSnapshotFrame(framed)).toThrow(/Unsupported GIF snapshot version/);
    });

    it('survives being parsed from a view with a non-zero byteOffset', () => {
        // The download path hands back a slice of a larger buffer; the frame
        // parser must honour byteOffset rather than reading from byte 0.
        const framed = frameSnapshot(header(), body());
        const padded = new Uint8Array(framed.length + 8);
        padded.set(framed, 8);
        const view = padded.subarray(8);
        expect(parseSnapshotFrame(view).header.key_envelope_b64).toBe('ENVELOPE');
    });
});

describe('payload validation', () => {
    it('round-trips a well-formed payload', () => {
        const p = buildSnapshotPayload([gif('a')], { a: 1 }, { a: 'KEY' }, { a: 'BYTES' }, 42);
        const out = parseSnapshotPayload(JSON.stringify(p));
        expect(out.entries.map(e => e.id)).toEqual(['a']);
        expect(out.ledger).toEqual({ a: 1 });
        expect(out.keys).toEqual({ a: 'KEY' });
        expect(out.files).toEqual({ a: 'BYTES' });
        expect(out.writtenAt).toBe(42);
    });

    it('drops malformed entries rather than trusting them', () => {
        const out = parseSnapshotPayload(JSON.stringify({
            entries: [gif('good'), { id: 'bad' }, null, 7],
            ledger: {}, keys: {}, files: {},
        }));
        expect(out.entries.map(e => e.id)).toEqual(['good']);
    });

    it('drops non-numeric and non-finite ledger values', () => {
        const out = parseSnapshotPayload(JSON.stringify({
            entries: [], ledger: { a: 1, b: 'x', c: null }, keys: {}, files: {},
        }));
        expect(out.ledger).toEqual({ a: 1 });
    });

    it('drops non-string key and file values', () => {
        const out = parseSnapshotPayload(JSON.stringify({
            entries: [], ledger: {},
            keys: { a: 'K', b: 5, c: '' },
            files: { a: 'F', b: null },
        }));
        expect(out.keys).toEqual({ a: 'K' });
        expect(out.files).toEqual({ a: 'F' });
    });

    it('tolerates missing sections', () => {
        const out = parseSnapshotPayload('{}');
        expect(out.entries).toEqual([]);
        expect(out.ledger).toEqual({});
        expect(out.keys).toEqual({});
        expect(out.files).toEqual({});
    });

    it('rejects payloads that are not JSON objects', () => {
        expect(() => parseSnapshotPayload('not json')).toThrow(/not valid JSON/);
        expect(() => parseSnapshotPayload('null')).toThrow(/not an object/);
        expect(() => parseSnapshotPayload('42')).toThrow(/not an object/);
    });
});

describe('base64 helpers', () => {
    it('round-trips binary including high bytes and zeros', () => {
        const bytes = new Uint8Array([0, 1, 127, 128, 254, 255, 0]);
        expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    });

    it('round-trips an empty buffer', () => {
        expect([...base64ToBytes(bytesToBase64(new Uint8Array(0)))]).toEqual([]);
    });

    it('round-trips a payload larger than the 32KB chunk size', () => {
        const bytes = new Uint8Array(70_000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
        expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    });
});
