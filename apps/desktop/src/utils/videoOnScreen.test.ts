// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWatchingVideo } from './videoOnScreen';

interface Opts { paused?: boolean; ended?: boolean; readyState?: number; loop?: boolean; local?: boolean; frames?: number; rect?: Partial<DOMRect>; visible?: boolean }

function addVideo(o: Opts = {}) {
    const v = document.createElement('video');
    const state = { frames: o.frames ?? 100 };
    Object.defineProperties(v, {
        paused: { get: () => o.paused ?? false },
        ended: { get: () => o.ended ?? false },
        readyState: { get: () => o.readyState ?? 4 },
    });
    v.loop = o.loop ?? false;
    if (o.local) v.dataset.localPreview = 'true';
    v.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frames }) as VideoPlaybackQuality;
    v.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 200, ...o.rect }) as DOMRect;
    (v as unknown as { checkVisibility: () => boolean }).checkVisibility = () => o.visible ?? true;
    document.body.appendChild(v);
    return { v, advance: (n = 450) => { state.frames += n; } };
}

const setHidden = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

afterEach(() => { document.body.innerHTML = ''; setHidden(false); });

describe('isWatchingVideo', () => {
    it('a remote stream with frames arriving counts, on first sight and on every later check', () => {
        const { advance } = addVideo();
        expect(isWatchingVideo(document)).toBe(true);
        advance();
        expect(isWatchingVideo(document)).toBe(true);
    });

    it('a frozen stream stops counting: "playing" with no new frames (a remote camera turned off)', () => {
        const { advance } = addVideo();
        expect(isWatchingVideo(document)).toBe(true);
        expect(isWatchingVideo(document)).toBe(false);
        advance();
        expect(isWatchingVideo(document)).toBe(true);
    });

    it('nothing on screen, or a video not showing anything, does not count', () => {
        expect(isWatchingVideo(document)).toBe(false);
        addVideo({ paused: true });
        addVideo({ ended: true });
        addVideo({ readyState: 1 });
        addVideo({ frames: 0 });
        expect(isWatchingVideo(document)).toBe(false);
    });

    it('your own picture never counts: a self view cannot hold the lock off', () => {
        addVideo({ local: true });
        expect(isWatchingVideo(document)).toBe(false);
    });

    it('a looping clip never counts: a GIF sent as video plays with nobody watching', () => {
        addVideo({ loop: true });
        expect(isWatchingVideo(document)).toBe(false);
    });

    it('off screen, zero-sized or hidden by CSS does not count', () => {
        addVideo({ rect: { left: -500, right: -100 } });
        addVideo({ rect: { top: 5000, bottom: 5200 } });
        addVideo({ rect: { right: 0, bottom: 0 } });
        addVideo({ visible: false });
        expect(isWatchingVideo(document)).toBe(false);
    });

    it('a minimized window does not count', () => {
        addVideo();
        setHidden(true);
        expect(isWatchingVideo(document)).toBe(false);
    });

    it('one real stream among excluded ones is enough, and every frame count stays current', () => {
        addVideo({ local: true });
        const a = addVideo();
        const b = addVideo();
        expect(isWatchingVideo(document)).toBe(true);
        a.advance();
        expect(isWatchingVideo(document)).toBe(true);
        // b was frozen through that check; had it been skipped, it would look new now.
        expect(isWatchingVideo(document)).toBe(false);
        b.advance();
        expect(isWatchingVideo(document)).toBe(true);
    });
});

describe('wiring', () => {
    const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

    it('the inactivity poll treats watching as activity, before it decides to lock', () => {
        const src = read('hooks/useScreenLock.ts');
        const watch = src.indexOf('if (isWatchingVideo(document)) lastActiveAt = Date.now();');
        expect(watch).toBeGreaterThan(-1);
        expect(watch).toBeLessThan(src.indexOf('if (Date.now() - lastActiveAt >= thresholdMs) lockNow();'));
    });

    it('the OS-lock path is untouched: locking the PC still locks Cipherline while a video plays', () => {
        expect(read('hooks/useScreenLock.ts')).toMatch(/onOsLockScreen\?\.\(\(\) => lockNow\(\)\)/);
    });

    it('self views are marked', () => {
        expect(read('components/call/VideoTile.tsx')).toContain("data-local-preview={isLocal ? 'true' : undefined}");
        expect(read('components/VoiceVideoSettings.tsx')).toContain('data-local-preview="true"');
    });
});
