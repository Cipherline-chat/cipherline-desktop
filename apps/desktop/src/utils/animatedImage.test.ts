import { describe, it, expect } from 'vitest';
import {
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
    it('static images are untouched either way', () => {
        expect(pickDisplayUrl(URL_, 'image/jpeg', false, null)).toBe(URL_);
        expect(pickDisplayUrl(URL_, null, false, null)).toBe(URL_);
    });
    it('no URL, no output; before the still is ready the full URL stands in', () => {
        expect(pickDisplayUrl(null, 'image/gif', false, null)).toBeNull();
        expect(pickDisplayUrl(URL_, 'image/gif', false, null)).toBe(URL_);
    });
});
