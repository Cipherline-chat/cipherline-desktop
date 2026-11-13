import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * playGeneratedSound is the one sink for entrance sounds. It used to end in
 * `el.play().catch(() => {})`: a rejected play (interrupted load, sink not
 * ready) was swallowed, so the cue was simply lost - "works sometimes".
 */
interface FakeEl {
    src: string; volume: number; currentTime: number;
    play: ReturnType<typeof vi.fn>;
    setSinkId: ReturnType<typeof vi.fn>;
    sinkId: string;
}
let els: FakeEl[] = [];
let playImpl: (el: FakeEl, n: number) => Promise<void>;

beforeEach(() => {
    vi.resetModules();
    els = [];
    let n = 0;
    class MockAudio implements FakeEl {
        src = ''; volume = 1; currentTime = 0; sinkId = '';
        play = vi.fn(() => playImpl(this as FakeEl, ++n));
        setSinkId = vi.fn(async (id: string) => { this.sinkId = id; });
        addEventListener = vi.fn(); removeEventListener = vi.fn();
        constructor() { els.push(this as FakeEl); }
    }
    (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;
    playImpl = async () => {};
});
afterEach(() => { vi.restoreAllMocks(); });

const prefs = { sounds_enabled: true, master_volume: 1 } as never;

describe('playGeneratedSound', () => {
    it('a rejected play() is retried once and then reported as played', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        playImpl = async (_el, n) => { if (n === 1) throw Object.assign(new Error('x'), { name: 'AbortError' }); };
        const { playGeneratedSound } = await import('./notificationSounds');
        expect(await playGeneratedSound('blob:a', 0.6, prefs)).toBe(true);
        expect(els[0].play).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalled();
    });

    it('a play() that keeps rejecting is logged (error name only) and reported as failed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        playImpl = async () => { throw Object.assign(new Error('secret detail'), { name: 'NotAllowedError' }); };
        const { playGeneratedSound } = await import('./notificationSounds');
        expect(await playGeneratedSound('blob:a', 0.6, prefs)).toBe(false);
        expect(warn).toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('blob:a');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
    });

    it('a cue replaced by a newer one is not retried over it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let rejectFirst: (e: unknown) => void = () => {};
        playImpl = (_el, n) => (n === 1 ? new Promise<void>((_r, rej) => { rejectFirst = rej; }) : Promise.resolve());
        const { playGeneratedSound } = await import('./notificationSounds');
        const first = playGeneratedSound('blob:a', 0.6, prefs);
        const second = playGeneratedSound('blob:b', 0.6, prefs);
        rejectFirst(Object.assign(new Error('interrupted'), { name: 'AbortError' }));
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(els[0].src).toBe('blob:b');
        expect(els[0].play).toHaveBeenCalledTimes(2);
    });

    it('sounds switched off is deliberate silence, not a failure', async () => {
        const { playGeneratedSound } = await import('./notificationSounds');
        expect(await playGeneratedSound('blob:a', 0.6, { sounds_enabled: false, master_volume: 1 } as never)).toBe(true);
        expect(els.length === 0 || els[0].play.mock.calls.length === 0).toBe(true);
    });
});
