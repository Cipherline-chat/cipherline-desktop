import { describe, it, expect } from 'vitest';
import { validateClipboardPng, MAX_CLIPBOARD_IMAGE_BYTES, MAX_CLIPBOARD_IMAGE_PIXELS } from './clipboard-image';

/** A structurally valid PNG prefix: signature + IHDR(w,h) + padding. */
function png(width = 4, height = 4, total = 64): Uint8Array {
  const b = new Uint8Array(total);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

describe('validateClipboardPng', () => {
  it('accepts a small PNG and returns a Buffer over the same bytes', () => {
    const input = png();
    const out = validateClipboardPng(input);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBe(input.length);
    expect(out[1]).toBe(0x50);
  });

  it('accepts a Buffer too (Buffer is a Uint8Array)', () => {
    expect(validateClipboardPng(Buffer.from(png()))).toBeTruthy();
  });

  it('accepts a PNG at exactly the byte limit', () => {
    expect(validateClipboardPng(png(4, 4, MAX_CLIPBOARD_IMAGE_BYTES)).length).toBe(MAX_CLIPBOARD_IMAGE_BYTES);
  });

  it('rejects a PNG one byte over the limit', () => {
    expect(() => validateClipboardPng(png(4, 4, MAX_CLIPBOARD_IMAGE_BYTES + 1))).toThrow(/too large/);
  });

  const notPngs: Array<[string, unknown]> = [
    ['JPEG', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(0)])],
    ['GIF', Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new Array(60).fill(0)])],
    ['plain text', new TextEncoder().encode('hello this is definitely not a png file, no sir at all')],
    ['all zeros', new Uint8Array(64)],
    ['empty', new Uint8Array(0)],
    ['signature only (truncated)', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['string', 'iVBORw0KGgo='],
    ['plain array', [0x89, 0x50, 0x4e, 0x47]],
    ['ArrayBuffer', png().buffer],
    ['null', null],
    ['undefined', undefined],
    ['object', { length: 64 }],
  ];
  it.each(notPngs)('rejects: %s', (_label, data) => {
    expect(() => validateClipboardPng(data)).toThrow();
  });

  it('rejects a PNG signature without a real IHDR chunk', () => {
    const bad = png();
    bad.set([0x58, 0x58, 0x58, 0x58], 12);
    expect(() => validateClipboardPng(bad)).toThrow(/not a PNG/);
    const badLen = png();
    new DataView(badLen.buffer).setUint32(8, 99);
    expect(() => validateClipboardPng(badLen)).toThrow(/not a PNG/);
  });

  it('rejects zero or enormous dimensions (decompression bomb)', () => {
    expect(() => validateClipboardPng(png(0, 10))).toThrow(/dimensions/);
    expect(() => validateClipboardPng(png(10, 0))).toThrow(/dimensions/);
    expect(() => validateClipboardPng(png(50000, 50000))).toThrow(/dimensions/);
    expect(() => validateClipboardPng(png(0xffffffff, 0xffffffff))).toThrow(/dimensions/);
    // exactly at the pixel ceiling is fine
    expect(() => validateClipboardPng(png(10000, MAX_CLIPBOARD_IMAGE_PIXELS / 10000))).not.toThrow();
  });

  it('respects a subarray view (byteOffset) rather than reading the whole backing buffer', () => {
    const backing = new Uint8Array(200);
    backing.set(png(), 100);
    expect(validateClipboardPng(backing.subarray(100, 164)).length).toBe(64);
    // the same backing buffer from offset 0 is NOT a PNG
    expect(() => validateClipboardPng(backing.subarray(0, 64))).toThrow();
  });
});
