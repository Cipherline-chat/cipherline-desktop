import { describe, it, expect, vi } from 'vitest';
import {
    ShareFallbackNoticeStore, RESTORED_NOTE_MS, lighterNoticeCopy, lighterShortSide, shareFallbackNotice,
} from './shareFallbackNotice';

function store() {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const s = new ShareFallbackNoticeStore({
        setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
        clearTimer: t => { (t as { cleared: boolean }).cleared = true; },
    });
    const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
    return { s, timers, fire };
}

describe('shareFallbackNotice — the monitor’s side', () => {
    it('showLighter puts a notice up for that share only', () => {
        const { s } = store();
        s.showLighter('TR_a', 720);
        expect(s.notice('TR_a')).toEqual({ kind: 'lighter', shortSide: 720 });
        expect(s.notice('TR_b')).toBeNull();
        expect(s.notice(null)).toBeNull();
        expect(s.notice(undefined)).toBeNull();
    });

    it('the snapshot is the same object until it changes (useSyncExternalStore)', () => {
        const { s } = store();
        const fn = vi.fn();
        s.subscribe(fn);
        s.showLighter('TR_a', 720);
        const first = s.notice('TR_a');
        s.showLighter('TR_a', 720);
        expect(s.notice('TR_a')).toBe(first);
        expect(fn).toHaveBeenCalledTimes(1);
        s.showLighter('TR_a', 1080);
        expect(s.notice('TR_a')).not.toBe(first);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('recovered after a visible notice: "Back to full quality", gone after RESTORED_NOTE_MS', () => {
        const { s, timers, fire } = store();
        s.showLighter('TR_a', 720);
        s.lifted('TR_a', 'recovered');
        expect(s.notice('TR_a')).toEqual({ kind: 'restored' });
        expect(timers.at(-1)?.ms).toBe(RESTORED_NOTE_MS);
        fire();
        expect(s.notice('TR_a')).toBeNull();
    });

    it('a new drop during "Back to full quality" replaces it, and the old fade timer cannot take it down', () => {
        const { s, fire } = store();
        s.showLighter('TR_a', 720);
        s.lifted('TR_a', 'recovered');
        s.showLighter('TR_a', 720);
        fire();
        expect(s.notice('TR_a')).toEqual({ kind: 'lighter', shortSide: 720 });
    });

    it.each(['not_needed', 'no_low_layer', 'opt_out', undefined] as const)('lifted by %s: hidden silently', reason => {
        const { s, timers } = store();
        s.showLighter('TR_a', 720);
        s.lifted('TR_a', reason);
        expect(s.notice('TR_a')).toBeNull();
        expect(timers).toHaveLength(0);
    });

    it('recovered with nothing showing (dismissed, or never shown) stays silent', () => {
        const { s } = store();
        s.lifted('TR_a', 'recovered');
        expect(s.notice('TR_a')).toBeNull();
        s.showLighter('TR_a', 720);
        s.dismiss('TR_a');
        s.lifted('TR_a', 'recovered');
        expect(s.notice('TR_a')).toBeNull();
    });

    it('forget takes the notice down but keeps the opt-out (the share may be watched again)', () => {
        const { s } = store();
        s.showLighter('TR_a', 720);
        s.forget('TR_a');
        expect(s.notice('TR_a')).toBeNull();
        s.keepFullQuality('TR_b');
        s.forget('TR_b');
        expect(s.isOptedOut('TR_b')).toBe(true);
    });
});

describe('shareFallbackNotice — the viewer’s side', () => {
    it('dismiss hides the notice; a later drop of the same share shows it again', () => {
        const { s } = store();
        s.showLighter('TR_a', 720);
        s.dismiss('TR_a');
        expect(s.notice('TR_a')).toBeNull();
        expect(s.isOptedOut('TR_a')).toBe(false);
        s.showLighter('TR_a', 720);
        expect(s.notice('TR_a')).not.toBeNull();
    });

    it('keepFullQuality hides it, tells the monitor, and no notice ever shows for that share again', () => {
        const { s } = store();
        const handler = vi.fn();
        s.onKeepFullQuality(handler);
        s.showLighter('TR_a', 720);
        s.keepFullQuality('TR_a');
        expect(handler).toHaveBeenCalledWith('TR_a');
        expect(s.notice('TR_a')).toBeNull();
        expect(s.isOptedOut('TR_a')).toBe(true);
        s.showLighter('TR_a', 720);
        expect(s.notice('TR_a')).toBeNull();
        // Another share (a new share from the same person has a new SID) is untouched.
        s.showLighter('TR_b', 720);
        expect(s.notice('TR_b')).not.toBeNull();
        expect(s.isOptedOut('TR_b')).toBe(false);
    });

    it('a throwing handler does not stop the others; unsubscribed handlers are not called', () => {
        const { s } = store();
        const bad = vi.fn(() => { throw new Error('x'); });
        const good = vi.fn();
        const gone = vi.fn();
        s.onKeepFullQuality(bad);
        s.onKeepFullQuality(good);
        s.onKeepFullQuality(gone)();
        s.keepFullQuality('TR_a');
        expect(good).toHaveBeenCalledWith('TR_a');
        expect(gone).not.toHaveBeenCalled();
    });

    it('reset (call ended) drops notices, opt-outs and timers', () => {
        const { s, timers } = store();
        s.showLighter('TR_a', 720);
        s.lifted('TR_a', 'recovered');
        s.keepFullQuality('TR_b');
        const fn = vi.fn();
        s.subscribe(fn);
        s.reset();
        expect(s.notice('TR_a')).toBeNull();
        expect(s.isOptedOut('TR_b')).toBe(false);
        expect(timers.every(t => t.cleared)).toBe(true);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('the app-wide store is one of these', () => {
        expect(shareFallbackNotice).toBeInstanceOf(ShareFallbackNoticeStore);
    });
});

describe('the words', () => {
    it('names the real size when known, and never a size it does not know', () => {
        expect(lighterNoticeCopy(720).full).toBe('Your connection can’t keep up with this stream, so it’s showing a lighter 720p version.');
        expect(lighterNoticeCopy(720).short).toBe('Showing a lighter 720p version');
        expect(lighterNoticeCopy(1080).full).toContain('lighter 1080p version');
        expect(lighterNoticeCopy(null).full).toBe('Your connection can’t keep up with this stream, so it’s showing a lighter version.');
        expect(lighterNoticeCopy(null).full).not.toMatch(/\d/);
        expect(lighterNoticeCopy(null).short).toBe('Showing a lighter version');
    });

    it('only plausible short sides become a number', () => {
        expect(lighterShortSide(720)).toBe(720);
        expect(lighterShortSide(719.6)).toBe(720);
        for (const bad of [null, undefined, 0, -720, NaN, Infinity, 8, 100_000]) expect(lighterShortSide(bad)).toBeNull();
    });

    it('showLighter sanitises the size it is given', () => {
        const { s } = store();
        s.showLighter('TR_a', 0);
        expect(s.notice('TR_a')).toEqual({ kind: 'lighter', shortSide: null });
    });
});
