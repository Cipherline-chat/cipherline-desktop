/**
 * First frame of an animated emoji as a static image, for people who ask the OS
 * for reduced motion. Decoded once per emoji per session.
 *
 * `createImageBitmap` on an animated WebP/GIF yields its first frame; drawing it
 * to a canvas and re-encoding as PNG gives an <img>-able, non-animating URL.
 */
const cache = new Map<string, Promise<string | null>>();

export function stillFrameUrl(key: string, bytes: Uint8Array, mime: string): Promise<string | null> {
    let p = cache.get(key);
    if (!p) {
        p = (async () => {
            try {
                const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
                const canvas = document.createElement('canvas');
                canvas.width = bmp.width; canvas.height = bmp.height;
                canvas.getContext('2d')!.drawImage(bmp, 0, 0);
                bmp.close();
                const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
                return blob ? URL.createObjectURL(blob) : null;
            } catch { return null; }
        })();
        cache.set(key, p);
    }
    return p;
}
