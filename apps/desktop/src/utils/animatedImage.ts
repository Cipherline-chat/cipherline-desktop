/**
 * Animated avatars / banners (GIF, animated WebP) - free for everyone.
 *
 * Files are end-to-end encrypted, so the server never sees whether an upload
 * is animated and has no say in how it is shown: everything below is
 * client-side. An animated file is uploaded AS-IS (the static crop would
 * flatten it to a JPEG); on the way back in, the decrypted blob keeps its real
 * MIME, so an <img> animates it natively. Views decide where that is wanted:
 * the profile card and the settings preview always animate; lists show the
 * FIRST FRAME and animate on hover (`useStillGate`).
 */
import { useEffect, useState } from 'react';

/** Cap for an animated upload (matches the API's 10 MiB avatar/banner cap). */
export const ANIMATED_MAX_BYTES = 10 * 1024 * 1024;

/** Types that can be animated. (A static GIF/WebP just has a still equal to itself.) */
export const isAnimatedCandidateMime = (mime: string | null | undefined): boolean =>
    mime === 'image/gif' || mime === 'image/webp';

/**
 * Is this WebP animated? RIFF....WEBP then a VP8X chunk whose flags byte has
 * the animation bit (0x02). A GIF is treated as animated (cheap and safe: a
 * single-frame GIF merely round-trips unchanged).
 */
export function bytesAreAnimated(head: Uint8Array, mime: string): boolean {
    if (mime === 'image/gif') return true;
    if (mime !== 'image/webp' || head.length < 21) return false;
    const tag = (o: number, s: string) => s.split('').every((c, i) => head[o + i] === c.charCodeAt(0));
    return tag(0, 'RIFF') && tag(8, 'WEBP') && tag(12, 'VP8X') && (head[20] & 0x02) !== 0;
}

/** Sniff a picked file. Never throws. */
export async function isAnimatedFile(file: Blob): Promise<boolean> {
    if (!isAnimatedCandidateMime(file.type)) return false;
    try {
        const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
        return bytesAreAnimated(head, file.type);
    } catch {
        return false;
    }
}

/** Why an animated pick cannot be used, or null. */
export function animatedPickError(file: Blob): string | null {
    return file.size > ANIMATED_MAX_BYTES
        ? `Animated images can be up to ${ANIMATED_MAX_BYTES / 1024 / 1024} MB. This one is ${(file.size / 1024 / 1024).toFixed(1)} MB.`
        : null;
}

// ── first frame ──────────────────────────────────────────────────────────────

const stills = new Map<string, string>();            // source URL -> still URL (resolved)
const pending = new Map<string, Promise<string | null>>();
const MAX_STILLS = 300;

/** The still for `url` if already extracted. */
export const peekStill = (url: string): string | null => stills.get(url) ?? null;

async function extract(url: string): Promise<string | null> {
    try {
        const blob = await (await fetch(url)).blob();
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width; canvas.height = bmp.height;
        canvas.getContext('2d')?.drawImage(bmp, 0, 0);
        bmp.close?.();
        const out: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (!out) return null;
        if (stills.size >= MAX_STILLS) {
            const oldest = stills.keys().next().value as string | undefined;
            if (oldest) { try { URL.revokeObjectURL(stills.get(oldest)!); } catch { /* gone */ } stills.delete(oldest); }
        }
        const still = URL.createObjectURL(out);
        stills.set(url, still);
        return still;
    } catch {
        return null;
    }
}

/** Extract (once) the first frame of an animated image URL. null = could not. */
export function getStill(url: string): Promise<string | null> {
    const done = stills.get(url);
    if (done) return Promise.resolve(done);
    let p = pending.get(url);
    if (!p) { p = extract(url).finally(() => pending.delete(url)); pending.set(url, p); }
    return p;
}

/**
 * The URL to put in an <img>: `url` itself when `animate` is true or the
 * image cannot move, else its first frame (the animated URL is shown only
 * for the instant before the still is ready, never as a steady state).
 * `mime` is the decrypted blob's type (null/unknown = treat as static).
 */
export function useStillGate(url: string | null, mime: string | null, animate: boolean): string | null {
    const candidate = !!url && isAnimatedCandidateMime(mime);
    const [, bump] = useState(0);
    const need = candidate && !animate && !peekStill(url!);
    useEffect(() => {
        if (!need || !url) return;
        let alive = true;
        getStill(url).then(() => { if (alive) bump((n) => n + 1); });
        return () => { alive = false; };
    }, [need, url]);
    return pickDisplayUrl(url, mime, animate, url ? peekStill(url) : null);
}

/** The pure rule behind `useStillGate`. */
export function pickDisplayUrl(url: string | null, mime: string | null, animate: boolean, still: string | null): string | null {
    if (!url) return null;
    if (animate || !isAnimatedCandidateMime(mime)) return url;
    return still ?? url;
}
