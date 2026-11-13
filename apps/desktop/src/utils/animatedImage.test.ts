import { describe, it, expect, vi } from 'vitest';
import {
    getStill,
    ANIMATED_MAX_BYTES, animatedPickError, bytesAreAnimated, isAnimatedCandidateMime, isAnimatedFile, pickDisplayUrl,
} from './animatedImage';

const webp = (flags: number, chunk = 'VP8X') => {
    const b = new Uint8Array(32);
    b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
    b.set([...chunk].map((c) => c.charCodeAt(0)), 12);
    b[20] = flags;
    return b;
};

describe('animated detection', () => {
    it('animated WebP = VP8X with the animation bit', () => {
        expect(bytesAreAnimated(webp(0x02), 'image/webp')).toBe(true);
        expect(bytesAreAnimated(webp(0x12), 'image/webp')).toBe(true);
        expect(bytesAreAnimated(webp(0x10), 'image/webp')).toBe(false);   // alpha only
        expect(bytesAreAnimated(webp(0x02, 'VP8 '), 'image/webp')).toBe(false);
        expect(bytesAreAnimated(new Uint8Array(4), 'image/webp')).toBe(false);
    });
    it('GIF counts as animated; JPEG/PNG never do', () => {
        expect(bytesAreAnimated(new Uint8Array(4), 'image/gif')).toBe(true);
        expect(isAnimatedCandidateMime('image/jpeg')).toBe(false);
        expect(isAnimatedCandidateMime('image/png')).toBe(false);
        expect(isAnimatedCandidateMime(null)).toBe(false);
    });
    it('sniffs real File objects', async () => {
        expect(await isAnimatedFile(new Blob([webp(0x02)], { type: 'image/webp' }))).toBe(true);
        expect(await isAnimatedFile(new Blob([webp(0x00)], { type: 'image/webp' }))).toBe(false);
        expect(await isAnimatedFile(new Blob([new Uint8Array(40)], { type: 'image/jpeg' }))).toBe(false);
    });
});

describe('size cap', () => {
    it('10 MB is fine, one byte over is not', () => {
        expect(animatedPickError(new Blob([new Uint8Array(1)]))).toBeNull();
        expect(animatedPickError({ size: ANIMATED_MAX_BYTES } as Blob)).toBeNull();
        expect(animatedPickError({ size: ANIMATED_MAX_BYTES + 1 } as Blob)).toMatch(/10 MB/);
    });
});

// Everyone sees animation (nothing is a paid perk): the only decision is WHERE it plays.
describe('pickDisplayUrl: card animates, lists show the first frame', () => {
    const URL_ = 'blob:full', STILL = 'blob:still';
    it('profile card / preview (animate=true) plays the full image', () => {
        expect(pickDisplayUrl(URL_, 'image/gif', true, STILL)).toBe(URL_);
        expect(pickDisplayUrl(URL_, 'image/webp', true, null)).toBe(URL_);
    });
    it('a list (animate=false) shows the still, and the full image on hover (animate=true)', () => {
        expect(pickDisplayUrl(URL_, 'image/gif', false, STILL)).toBe(STILL);
        expect(pickDisplayUrl(URL_, 'image/gif', true, STILL)).toBe(URL_);
    });
    it('images that are positively still are untouched either way', () => {
        expect(pickDisplayUrl(URL_, 'image/jpeg', false, null)).toBe(URL_);
        expect(pickDisplayUrl(URL_, 'image/png', false, null)).toBe(URL_);
    });
    it('an UNKNOWN type is never waved through as static: it is held on its first frame', () => {
        expect(pickDisplayUrl(URL_, null, false, STILL)).toBe(STILL);
        expect(pickDisplayUrl(URL_, '', false, STILL)).toBe(STILL);
        expect(pickDisplayUrl(URL_, 'application/octet-stream', false, STILL)).toBe(STILL);
        expect(pickDisplayUrl(URL_, null, true, STILL)).toBe(URL_);
    });
    it('no URL, no output; until the still exists the animated URL is NEVER the stand-in', () => {
        expect(pickDisplayUrl(null, 'image/gif', false, null)).toBeNull();
        expect(pickDisplayUrl(URL_, 'image/gif', false, null)).toBeNull();
        expect(pickDisplayUrl(URL_, null, false, null)).toBeNull();
    });
});

describe('a first frame is only ever fetched from somewhere an <img> may load', () => {
    it('refuses an arbitrary address without fetching it', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        try {
            await expect(getStill('https://attacker.example/x.gif')).resolves.toBeNull();
            await expect(getStill('http://169.254.169.254/latest/meta-data/')).resolves.toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });
});
