/**
 * Recover a decrypted image's type from its magic bytes.
 *
 * The persistent avatar cache stores the decrypted bytes wrapped in AES-GCM and
 * hands them back as an untyped Blob (`type: ''`). Views decide "can this move?"
 * from the Blob's type (utils/animatedImage), so a lost type used to mean "a
 * static image" and an animated avatar played natively everywhere. Sniffing the
 * first bytes restores it with no extra download or decrypt.
 *
 * Only the four raster formats avatars and banners are ever stored as; anything
 * else is left untyped rather than guessed.
 */
export function sniffImageMime(head: Uint8Array): string | null {
    const at = (o: number, s: string) => s.length + o <= head.length && s.split('').every((c, i) => head[o + i] === c.charCodeAt(0));
    if (at(0, 'GIF8')) return 'image/gif';
    if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
    if (head.length >= 8 && head[0] === 0x89 && at(1, 'PNG')) return 'image/png';
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    return null;
}

/**
 * `blob` with its image type restored when it came back untyped. A blob that
 * already has a type, or whose bytes are not a known image, is returned as is.
 * The retyped blob is a slice (a handle onto the same bytes), not a copy.
 */
export async function withSniffedImageType(blob: Blob): Promise<Blob> {
    if (blob.type) return blob;
    try {
        const mime = sniffImageMime(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
        return mime ? blob.slice(0, blob.size, mime) : blob;
    } catch {
        return blob;
    }
}
