import { describe, expect, it, vi } from 'vitest';
import { probeShareSource } from './shareSourceProbe';
import { describeShareStartError } from './screenShareStartState';

const fakeStream = (video = 1) => {
    const tracks = Array.from({ length: video }, () => ({ stop: vi.fn() }));
    return { stream: { getTracks: () => tracks, getVideoTracks: () => tracks } as unknown as MediaStream, tracks };
};

describe('probeShareSource', () => {
    it('a source that opens passes, and the capture is closed again', async () => {
        const { stream, tracks } = fakeStream();
        await expect(probeShareSource(async () => stream)).resolves.toEqual({ ok: true });
        expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    });

    it('a source that refuses fails with the error, and does not throw', async () => {
        const error = Object.assign(new Error('x'), { name: 'NotReadableError' });
        await expect(probeShareSource(() => Promise.reject(error))).resolves.toEqual({ ok: false, error });
    });

    it('a stream with no video is a failure', async () => {
        const r = await probeShareSource(async () => fakeStream(0).stream);
        expect(r.ok).toBe(false);
    });

    it('a handshake that never answers cannot hang a live share, and a late answer is closed', async () => {
        vi.useFakeTimers();
        try {
            const { stream, tracks } = fakeStream();
            let answer: (s: MediaStream) => void = () => {};
            const result = probeShareSource(() => new Promise<MediaStream>(r => { answer = r; }), 1000);
            await vi.advanceTimersByTimeAsync(1000);
            expect((await result).ok).toBe(false);
            expect(tracks[0].stop).not.toHaveBeenCalled();
            answer(stream);
            await vi.advanceTimersByTimeAsync(0);
            expect(tracks[0].stop).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });
});

describe('the notice for a source that would not open', () => {
    const refused = { name: 'NotReadableError' };

    it('says the share is still running when it is', () => {
        const v = describeShareStartError(refused, 'win', { stillSharing: true });
        expect(v.kind).toBe('failed');
        expect((v as { text: string }).text).toMatch(/still running/);
    });

    it('does not claim that for a share that is starting', () => {
        const v = describeShareStartError(refused, 'win');
        expect((v as { text: string }).text).not.toMatch(/still running/);
    });
});
