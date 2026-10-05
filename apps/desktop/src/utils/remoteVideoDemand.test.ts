import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retainRemoteVideo, noteRemoteVideoSubscribed, PAUSE_AFTER_MS } from './remoteVideoDemand';

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
});
