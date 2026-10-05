import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The speaking analyser must share ONE analysis AudioContext and ONE poll
 * timer across every participant (it used to be one of each per participant),
 * keep the per-identity behaviour (threshold, 300 ms release, track swap,
 * ref-counting), and close the context once nothing uses it.
 */

let level = 0; // RMS-ish amplitude every analyser reports, 0..1
const contexts: FakeCtx[] = [];
class FakeAnalyser {
    fftSize = 256; smoothingTimeConstant = 0; frequencyBinCount = 128;
    getByteTimeDomainData(buf: Uint8Array) { for (let i = 0; i < buf.length; i++) buf[i] = 128 + Math.round((i % 2 ? 1 : -1) * level * 127); }
    disconnect() {}
}
class FakeSource { connect() {} disconnect() {} }
class FakeCtx {
    state: 'running' | 'suspended' | 'closed' = 'running';
    opts: unknown;
    sources = 0;
    constructor(opts?: unknown) { this.opts = opts; contexts.push(this); }
    createMediaStreamSource() { this.sources++; return new FakeSource(); }
    createAnalyser() { return new FakeAnalyser(); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
}

const track = (id: string) => ({ id, readyState: 'live' }) as unknown as MediaStreamTrack;

async function load() {
    vi.resetModules();
    return import('./speakingAnalyser');
}

beforeEach(() => {
    vi.useFakeTimers();
    contexts.length = 0;
    level = 0;
    vi.stubGlobal('AudioContext', FakeCtx);
    vi.stubGlobal('MediaStream', class { tracks: unknown[]; constructor(t: unknown[]) { this.tracks = t; } });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('speakingAnalyser', () => {
    it('uses one silent-sink context and one timer for many participants', async () => {
        const sa = await load();
        const spy = vi.spyOn(globalThis, 'setInterval');
        for (let i = 0; i < 8; i++) sa.acquireSpeakingAnalyser('u' + i, track('t' + i), () => {});
        expect(contexts).toHaveLength(1);
        expect(contexts[0].opts).toEqual({ sinkId: { type: 'none' } });
        expect(contexts[0].sources).toBe(8);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(sa.speakingAnalyserStats()).toEqual({ entries: 8, contextOpen: true, polling: true });
    });

    it('reports speaking within one poll and releases after 300 ms of silence', async () => {
        const sa = await load();
        const seen: boolean[] = [];
        sa.acquireSpeakingAnalyser('a', track('t'), (s) => seen.push(s));
        expect(seen).toEqual([false]);
        level = 0.5;
        vi.advanceTimersByTime(sa.POLL_MS);
        expect(seen).toEqual([false, true]);
        level = 0;
        vi.advanceTimersByTime(sa.POLL_MS + sa.RELEASE_MS - 1);
        expect(seen).toEqual([false, true]);
        vi.advanceTimersByTime(sa.POLL_MS);
        expect(seen).toEqual([false, true, false]);
    });

    it('a brief dip shorter than the release does not flicker', async () => {
        const sa = await load();
        const seen: boolean[] = [];
        sa.acquireSpeakingAnalyser('a', track('t'), (s) => seen.push(s));
        level = 0.5; vi.advanceTimersByTime(sa.POLL_MS);
        level = 0; vi.advanceTimersByTime(sa.POLL_MS * 3);
        level = 0.5; vi.advanceTimersByTime(sa.POLL_MS * 20);
        expect(seen).toEqual([false, true]);
    });

    it('shares one entry per identity, ref-counted, and keeps polling until the last release', async () => {
        const sa = await load();
        const mst = track('t');
        const t1 = sa.acquireSpeakingAnalyser('a', mst, () => {})!;
        const t2 = sa.acquireSpeakingAnalyser('a', mst, () => {})!;
        expect(contexts[0].sources).toBe(1);
        sa.releaseSpeakingAnalyser('a', t1);
        expect(sa.speakingAnalyserStats().entries).toBe(1);
        sa.releaseSpeakingAnalyser('a', t1); // double release is a no-op
        expect(sa.speakingAnalyserStats().entries).toBe(1);
        sa.releaseSpeakingAnalyser('a', t2);
        expect(sa.speakingAnalyserStats()).toMatchObject({ entries: 0, polling: false });
    });

    it('re-points an identity in place when its track is replaced', async () => {
        const sa = await load();
        const seen: boolean[] = [];
        sa.acquireSpeakingAnalyser('a', track('old'), (s) => seen.push(s));
        sa.acquireSpeakingAnalyser('a', track('new'), () => {});
        expect(contexts).toHaveLength(1);
        expect(contexts[0].sources).toBe(2);
        level = 0.5; vi.advanceTimersByTime(sa.POLL_MS);
        expect(seen.at(-1)).toBe(true); // the first subscriber still hears the new track
    });

    it('closes the context after the idle grace, and reopens on demand', async () => {
        const sa = await load();
        const t = sa.acquireSpeakingAnalyser('a', track('t'), () => {})!;
        sa.releaseSpeakingAnalyser('a', t);
        vi.advanceTimersByTime(sa.IDLE_CLOSE_MS - 1);
        expect(contexts[0].state).toBe('running');
        // Re-acquired inside the grace: the same context is reused.
        const t2 = sa.acquireSpeakingAnalyser('b', track('t2'), () => {})!;
        vi.advanceTimersByTime(sa.IDLE_CLOSE_MS * 2);
        expect(contexts).toHaveLength(1);
        expect(contexts[0].state).toBe('running');
        sa.releaseSpeakingAnalyser('b', t2);
        vi.advanceTimersByTime(sa.IDLE_CLOSE_MS);
        expect(contexts[0].state).toBe('closed');
        expect(sa.speakingAnalyserStats().contextOpen).toBe(false);
        sa.acquireSpeakingAnalyser('c', track('t3'), () => {});
        expect(contexts).toHaveLength(2);
    });

    it('falls back to a default context where sinkId:none is rejected', async () => {
        vi.stubGlobal('AudioContext', class extends FakeCtx {
            constructor(opts?: { sinkId?: unknown }) { if (opts?.sinkId) throw new TypeError('bad sinkId'); super(opts); }
        });
        const sa = await load();
        expect(sa.acquireSpeakingAnalyser('a', track('t'), () => {})).not.toBeNull();
        expect(contexts).toHaveLength(1);
        expect(contexts[0].opts).toBeUndefined();
    });
});
