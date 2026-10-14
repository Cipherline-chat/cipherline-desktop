/**
 * Validation for the `clipboard:write-image` IPC channel.
 *
 * The renderer hands main a PNG it already decoded and re-encoded itself
 * (src/utils/copyImage.ts). Main still treats the bytes as untrusted: it
 * hands them to a native image decoder, so anything that is not a plausibly
 * sized PNG is refused BEFORE it gets there. Free of any `electron` import so
 * the decision is unit-testable (see clipboard-image.test.ts).
 */

/** Largest PNG accepted (bytes). Mirrors MAX_COPY_IMAGE_PNG_BYTES in the renderer. */
export const MAX_CLIPBOARD_IMAGE_BYTES = 50 * 1024 * 1024;
/** Decoded-pixel ceiling (decompression-bomb guard). */
export const MAX_CLIPBOARD_IMAGE_PIXELS = 100_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * @param data whatever arrived over IPC
 * @returns the bytes as a Buffer when they are a PNG of reasonable size
 * @throws when they are anything else
 */
export function validateClipboardPng(data: unknown): Buffer {
  if (!(data instanceof Uint8Array)) throw new Error('clipboard:write-image expects a Uint8Array');
  // 8 signature + 25 for the mandatory IHDR chunk (4 len + 4 type + 13 data + 4 crc).
  if (data.length < 33) throw new Error('clipboard:write-image: not a PNG');
  if (data.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('clipboard:write-image: image too large');
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) throw new Error('clipboard:write-image: not a PNG');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ihdrLen = view.getUint32(8);
  const ihdrType = String.fromCharCode(data[12], data[13], data[14], data[15]);
  if (ihdrLen !== 13 || ihdrType !== 'IHDR') throw new Error('clipboard:write-image: not a PNG');
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width * height > MAX_CLIPBOARD_IMAGE_PIXELS) {
    throw new Error('clipboard:write-image: image dimensions out of range');
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
