import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retainRemoteVideo, noteRemoteVideoSubscribed, pauseRemoteVideoBriefly, PAUSE_AFTER_MS } from './remoteVideoDemand';

/**
 * A remote video is paused at the SFU only after nothing has shown it on
 * screen for PAUSE_AFTER_MS, and resumed the moment something does.
 */
const pub = () => {
    const p = {
        isSubscribed: true,
        isEnabled: true,
        calls: [] as boolean[],
        setEnabled(v: boolean) { p.isEnabled = v; p.calls.push(v); },
    };
    return p;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('remoteVideoDemand', () => {
    it('keeps streaming while any on-screen tile holds it; pauses after the grace once none does', () => {
        const p = pub();
        const a = retainRemoteVideo(p);
        const b = retainRemoteVideo(p);
        a();
        vi.advanceTimersByTime(PAUSE_AFTER_MS * 3);
        expect(p.calls).toEqual([]);
        b();
        vi.advanceTimersByTime(PAUSE_AFTER_MS - 1);
        expect(p.isEnabled).toBe(true);
        vi.advanceTimersByTime(1);
        expect(p.calls).toEqual([false]);
    });

    it('a quick scroll-past / view switch inside the grace never touches the stream', () => {
        const p = pub();
        const a = retainRemoteVideo(p);
        a();
        vi.advanceTimersByTime(PAUSE_AFTER_MS / 2);
        const b = retainRemoteVideo(p);
        vi.advanceTimersByTime(PAUSE_AFTER_MS * 2);
        expect(p.calls).toEqual([]);
        b();
        b(); // double release is a no-op
        vi.advanceTimersByTime(PAUSE_AFTER_MS);
        expect(p.calls).toEqual([false]);
    });

    it('resumes immediately when a tile shows it again', () => {
        const p = pub();
        retainRemoteVideo(p)();
        vi.advanceTimersByTime(PAUSE_AFTER_MS);
        expect(p.isEnabled).toBe(false);
        retainRemoteVideo(p);
        expect(p.calls).toEqual([false, true]);
    });

    it('a subscription nobody ever shows is paused; one a tile claims in time is not', () => {
        const unseen = pub();
        noteRemoteVideoSubscribed(unseen);
        vi.advanceTimersByTime(PAUSE_AFTER_MS);
        expect(unseen.calls).toEqual([false]);

        const seen = pub();
        noteRemoteVideoSubscribed(seen);
        retainRemoteVideo(seen);
        vi.advanceTimersByTime(PAUSE_AFTER_MS * 2);
        expect(seen.calls).toEqual([]);
    });

    it('never touches a track that was unsubscribed meanwhile', () => {
        const p = pub();
        retainRemoteVideo(p)();
        p.isSubscribed = false;
        vi.advanceTimersByTime(PAUSE_AFTER_MS);
        expect(p.calls).toEqual([]);
    });

    describe('pauseRemoteVideoBriefly', () => {
        it('pauses a shown video and resumes it', () => {
            const p = pub();
            retainRemoteVideo(p);
            const resume = pauseRemoteVideoBriefly(p);
            expect(p.isEnabled).toBe(false);
            resume();
            expect(p.calls).toEqual([false, true]);
        });

        it('does not touch a video that is not flowing, and its resume does not start it', () => {
            const p = pub();
            p.isEnabled = false;
            pauseRemoteVideoBriefly(p)();
            expect(p.calls).toEqual([]);
            const q = pub();
            q.isSubscribed = false;
            pauseRemoteVideoBriefly(q)();
            expect(q.calls).toEqual([]);
        });

        it('every tile let go during the pause: stays paused, nobody is showing it', () => {
            const p = pub();
            const release = retainRemoteVideo(p);
            const resume = pauseRemoteVideoBriefly(p);
            release();
            vi.advanceTimersByTime(PAUSE_AFTER_MS); // the timer finds it already paused and does nothing
            resume();
            expect(p.calls).toEqual([false]);
            expect(p.isEnabled).toBe(false);
        });

        it('a tile let go but its grace is still running: resumes, and the grace then pauses it as usual', () => {
            const p = pub();
            const release = retainRemoteVideo(p);
            const resume = pauseRemoteVideoBriefly(p);
            release();
            resume();
            expect(p.isEnabled).toBe(true);
            vi.advanceTimersByTime(PAUSE_AFTER_MS);
            expect(p.calls).toEqual([false, true, false]);
        });

        it('a tile mounting mid-pause resumes it at once, and the resume is then a no-op', () => {
            const p = pub();
            const resume = pauseRemoteVideoBriefly(p);
            retainRemoteVideo(p);
            resume();
            expect(p.calls).toEqual([false, true]);
        });

        it('unsubscribed during the pause: left alone', () => {
            const p = pub();
            retainRemoteVideo(p);
            const resume = pauseRemoteVideoBriefly(p);
            p.isSubscribed = false;
            resume();
            expect(p.calls).toEqual([false]);
        });
    });
});
