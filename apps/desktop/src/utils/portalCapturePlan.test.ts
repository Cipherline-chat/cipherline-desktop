import { describe, it, expect } from 'vitest';
import { portalRetuneTouchesCapture, type CaptureAsk } from './portalCapturePlan';
import { portalCaptureFps } from './screenShare';

const ask = (fps: number, width: number, height: number): CaptureAsk => ({ fps, width, height });
const A1080_30 = ask(30, 1920, 1080);

describe('portalRetuneTouchesCapture: a desktop whose portal restores a listed source (GNOME, KDE) - the same policy as everywhere', () => {
    const t = (asked: CaptureAsk | null, want: CaptureAsk) => portalRetuneTouchesCapture({ restoreListed: true, asked, want });
    it('nothing that fits inside the capture re-opens it: a re-open stalls the capture even when it is silent (KDE VM: 0.9-1.2 s idle; owner reports: 10-20 s)', () => {
        expect(t(ask(75, 3840, 2160), A1080_30)).toBe(false);                      // 90 fps source -> 1080p30
        expect(t(A1080_30, ask(30, 1280, 720))).toBe(false);                       // size down only
        expect(t(ask(75, 1920, 1080), A1080_30)).toBe(false);                      // rate down only
        expect(t(A1080_30, { ...A1080_30 })).toBe(false);                          // already that
    });
    it('only a HIGHER rate (or a bigger box than it was opened at) re-opens it: there is no other way to those frames', () => {
        expect(t(A1080_30, ask(60, 1920, 1080))).toBe(true);
        expect(t(A1080_30, ask(75, 3840, 2160))).toBe(true);
    });
    it('what it was asked for being unknown is never a re-open (the old rule re-opened it, silently, on a guess)', () => {
        expect(t(null, A1080_30)).toBe(false);
    });
    it('negative control: the OLD listed-mode rule fails these - it re-opened for any difference, down as well as up', () => {
        const old = (asked: CaptureAsk | null, want: CaptureAsk) => !asked || asked.fps !== want.fps || asked.width !== want.width || asked.height !== want.height;
        expect(old(ask(75, 3840, 2160), A1080_30)).toBe(true);
        expect(t(ask(75, 3840, 2160), A1080_30)).toBe(false);
        expect(old(null, A1080_30)).toBe(true);
        expect(t(null, A1080_30)).toBe(false);
    });
});

describe('portalRetuneTouchesCapture: elsewhere (a re-open may be a dialog)', () => {
    const t = (asked: CaptureAsk | null, want: CaptureAsk) => portalRetuneTouchesCapture({ restoreListed: false, asked, want });
    it('anything that fits inside the capture is the encoder\'s alone: no portal session', () => {
        expect(t(ask(75, 3840, 2160), A1080_30)).toBe(false);
        expect(t(A1080_30, A1080_30)).toBe(false);
        expect(t(A1080_30, ask(30, 1280, 720))).toBe(false);
        expect(t(A1080_30, ask(15, 1920, 1080))).toBe(false);
    });
    it('a change that needs MORE than the capture was asked for re-opens it (there is no other way to get those frames)', () => {
        expect(t(A1080_30, ask(75, 1920, 1080))).toBe(true);                        // rate up
        expect(t(A1080_30, ask(30, 2560, 1440))).toBe(true);                        // width up
        expect(t(A1080_30, ask(30, 1920, 1440))).toBe(true);                        // height up
        expect(t(A1080_30, ask(75, 3840, 2160))).toBe(true);
    });
    it('what it was asked for being unknown is never a re-open (it could be a dialog nobody expects)', () => {
        expect(t(null, ask(75, 3840, 2160))).toBe(false);
    });
    it('the restore mode no longer matters: both answers agree on every case above', () => {
        for (const [asked, want] of [[A1080_30, ask(75, 3840, 2160)], [ask(75, 3840, 2160), A1080_30], [null, A1080_30]] as const) {
            expect(portalRetuneTouchesCapture({ restoreListed: true, asked, want })).toBe(portalRetuneTouchesCapture({ restoreListed: false, asked, want }));
        }
    });
});

describe('portalCaptureFps', () => {
    it('is the chosen rate up to 30, the paced rate above', () => {
        expect(portalCaptureFps(30, 60)).toBe(30);
        expect(portalCaptureFps(24, null)).toBe(24);
        expect(portalCaptureFps(60, 60)).toBe(75);
        expect(portalCaptureFps(90, null)).toBe(113);
    });
    it('passes a nonsense rate through untouched (the caller\'s validation, not ours)', () => {
        expect(portalCaptureFps(0, 60)).toBe(0);
        expect(Number.isNaN(portalCaptureFps(NaN, 60))).toBe(true);
    });
});
