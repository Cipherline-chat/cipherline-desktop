/**
 * Animated avatars / banners (GIF, animated WebP) - free for everyone.
 *
 * Files are end-to-end encrypted, so the server never sees whether an upload
 * is animated and has no say in how it is shown: everything below is
 * client-side. An animated file is uploaded AS-IS (the static crop would
 * flatten it to a JPEG); on the way back in, the decrypted blob keeps its real
 * MIME, so an <img> animates it natively. Views decide where that is wanted:
 * the opened profile and the settings preview animate; everything else shows
 * the FIRST FRAME and animates only on hover or while the person talks in a
 * call (`useStillGate`). Nothing animates while Cipherline is not the focused
 * window, whatever the reason it would have played (owner 2026-10-31).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { safeImageSrc } from './safeMediaUrl';

/** Cap for an animated upload (matches the API's 10 MiB avatar/banner cap). */
export const ANIMATED_MAX_BYTES = 10 * 1024 * 1024;

/** Types that can be animated. (A static GIF/WebP just has a still equal to itself.) */
export const isAnimatedCandidateMime = (mime: string | null | undefined): boolean =>
    mime === 'image/gif' || mime === 'image/webp';

/**
 * Could an image of this type MOVE? Used by the display gate, where being wrong
 * in one direction is the bug: a type that is unknown (a lost Blob type, a
 * data: URL, a local preview) must be treated as possibly animated and held on
 * its first frame, never waved through as "static" and played natively. Only a
 * type that is positively a still format is exempt.
 */
export const mayBeAnimated = (mime: string | null | undefined): boolean =>
    !mime || mime === 'application/octet-stream' || isAnimatedCandidateMime(mime) || mime === 'image/apng' || mime === 'image/avif';

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

const failed = new Set<string>();                  // source URLs whose first frame could not be made

async function extract(url: string, source?: Blob): Promise<string | null> {
    try {
        let blob = source;
        if (!blob) {
            // Only what an <img> here would be allowed to load: an object URL, an inline
            // image, or the trusted media hosts. Never an arbitrary address from a profile.
            const safe = safeImageSrc(url);
            if (!safe) { failed.add(url); return null; }
            blob = await (await fetch(safe)).blob();
        }
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width; canvas.height = bmp.height;
        canvas.getContext('2d')?.drawImage(bmp, 0, 0);
        bmp.close?.();
        const out: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (!out) throw new Error('canvas.toBlob returned null');
        if (stills.size >= MAX_STILLS) {
            const oldest = stills.keys().next().value as string | undefined;
            if (oldest) { try { URL.revokeObjectURL(stills.get(oldest)!); } catch { /* gone */ } stills.delete(oldest); }
        }
        const still = URL.createObjectURL(out);
        stills.set(url, still);
        return still;
    } catch (e) {
        // Not silent: a missing still used to mean "play the animation forever".
        failed.add(url);
        console.warn('[animatedImage] first frame unavailable; showing the static fallback', e);
        return null;
    }
}

/** True once extracting this URL's first frame has failed (the gate shows the static fallback). */
export const stillFailed = (url: string): boolean => failed.has(url);

/**
 * Extract (once) the first frame of an animated image URL. null = could not.
 * Pass `source` (the Blob behind a blob: URL) to skip re-reading it through fetch.
 */
export function getStill(url: string, source?: Blob): Promise<string | null> {
    const done = stills.get(url);
    if (done) return Promise.resolve(done);
    if (failed.has(url)) return Promise.resolve(null);
    let p = pending.get(url);
    if (!p) { p = extract(url, source).finally(() => pending.delete(url)); pending.set(url, p); }
    return p;
}

/**
 * The URL to put in an <img>: `url` itself when `animate` is true (and
 * Cipherline is the focused window: this is the one place that rule lives, so
 * no caller can forget it) or the image cannot move, else its first frame. While the first frame is still
 * being made, or if it cannot be made, this returns null so the caller shows
 * its static fallback (initials / default banner): the animated URL is NEVER
 * shown unless `animate` says so. (It used to be shown "for the instant before
 * the still is ready", which became a permanent steady state whenever the
 * extraction failed.) The still is made eagerly, even while playing, so it is
 * ready before the pointer leaves. `mime` is the decrypted blob's type
 * (null/unknown = possibly animated, see `mayBeAnimated`).
 */
export function useStillGate(url: string | null, mime: string | null, animate: boolean): string | null {
    const inFront = useAppInFront();
    const candidate = !!url && mayBeAnimated(mime);
    const [, bump] = useState(0);
    const need = candidate && !peekStill(url!) && !stillFailed(url!);
    useEffect(() => {
        if (!need || !url) return;
        let alive = true;
        getStill(url).then(() => { if (alive) bump((n) => n + 1); });
        return () => { alive = false; };
    }, [need, url]);
    return pickDisplayUrl(url, mime, animate && inFront, url ? peekStill(url) : null);
}

/**
 * For images that always play while you are here (custom emojis): the first
 * frame only while Cipherline is not the focused window. Stills are made on the
 * way out rather than eagerly, so a screen full of mostly static emojis decodes
 * nothing in normal use; the image stays as it is until its still is ready.
 */
export function useFrozenWhenAway(url: string | null): string | null {
    const inFront = useAppInFront();
    const [, bump] = useState(0);
    const need = !inFront && !!url && !peekStill(url) && !stillFailed(url);
    useEffect(() => {
        if (!need || !url) return;
        let alive = true;
        getStill(url).then(() => { if (alive) bump((n) => n + 1); });
        return () => { alive = false; };
    }, [need, url]);
    if (inFront || !url) return url;
    return peekStill(url) ?? url;
}

/**
 * Make a freshly decrypted image's first frame BEFORE its URL is handed to any
 * view, so the very first render already has the still (no flash, no frame of
 * animation). Only GIF / WebP are worth it; never throws.
 */
export async function primeStill(url: string, blob: Blob): Promise<void> {
    if (!isAnimatedCandidateMime(blob.type)) return;
    await getStill(url, blob);
}

/*
 * "Is Cipherline the window in front?" - ONE set of window listeners shared by
 * every avatar and banner (a member list can mount hundreds; useWindowFocus
 * would add three listeners each).
 */
const inFront = { now: true, wired: false, subs: new Set<() => void>() };
function readInFront(): boolean {
    return typeof document === 'undefined' ? true : !document.hidden && document.hasFocus();
}
function subscribeInFront(cb: () => void): () => void {
    if (!inFront.wired && typeof window !== 'undefined') {
        inFront.wired = true;
        inFront.now = readInFront();
        const set = (v: boolean) => { if (v !== inFront.now) { inFront.now = v; inFront.subs.forEach((f) => f()); } };
        window.addEventListener('focus', () => set(true));
        window.addEventListener('blur', () => set(false));
        document.addEventListener('visibilitychange', () => set(readInFront()));
    }
    inFront.subs.add(cb);
    return () => { inFront.subs.delete(cb); };
}
/**
 * True while the Cipherline window is focused and visible. Every animated
 * avatar, banner, icon and emoji freezes on its first frame when it is not, like
 * the profile effects do (owner 2026-10-27, widened to all of them 2026-10-31).
 */
export function useAppInFront(): boolean {
    return useSyncExternalStore(subscribeInFront, () => (inFront.wired ? inFront.now : readInFront()), () => true);
}

/** The pure rule behind `useStillGate`. */
export function pickDisplayUrl(url: string | null, mime: string | null, animate: boolean, still: string | null): string | null {
    if (!url) return null;
    if (animate || !mayBeAnimated(mime)) return url;
    return still;
}

/** Speech comes in bursts; replaying from the first frame on every word looks
 *  broken. How long an avatar keeps playing after its owner stops talking. */
export const SPEAKING_PLAY_LINGER_MS = 1500;

/**
 * `on`, held true for `ms` after it turns false. Lets a speaking avatar keep
 * playing through the gaps between words instead of snapping back to its
 * first frame (and restarting the animation) every time.
 */
export function useHeldOn(on: boolean, ms: number): boolean {
    const [held, setHeld] = useState(on);
    // Turning on is adopted during render (React's "adjust state on prop change").
    if (on && !held) setHeld(true);
    useEffect(() => {
        if (on || !held) return;
        const t = setTimeout(() => setHeld(false), ms);
        return () => clearTimeout(t);
    }, [on, held, ms]);
    return on || held;
}
