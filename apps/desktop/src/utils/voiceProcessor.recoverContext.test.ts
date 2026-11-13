import { describe, it, expect, vi } from 'vitest';
import { CipherlineVoiceProcessor } from './voiceProcessor';

/**
 * The silence watchdog's one safe self-repair: a processing AudioContext that is
 * not running delivers nothing to the published track (a sender fed by a
 * suspended context sends NO RTP — measured in Chromium, see
 * outboundAudioStats.ts), so recoverContext() resumes it.
 */
function processorWith(ctx: unknown): CipherlineVoiceProcessor {
    const p = new CipherlineVoiceProcessor({} as never, {});
    (p as unknown as { ctx: unknown }).ctx = ctx;
    return p;
}
const fakeCtx = (state: string, resume = vi.fn().mockResolvedValue(undefined)) => ({ state, resume });

describe('CipherlineVoiceProcessor.recoverContext', () => {
    it('resumes a suspended context and says so', () => {
        const ctx = fakeCtx('suspended');
        expect(processorWith(ctx).recoverContext()).toEqual({ state: 'suspended', resumed: true });
        expect(ctx.resume).toHaveBeenCalledTimes(1);
    });

    it('resumes an interrupted context (the state some platforms use after a device or OS interruption)', () => {
        const ctx = fakeCtx('interrupted');
        expect(processorWith(ctx).recoverContext()).toEqual({ state: 'interrupted', resumed: true });
        expect(ctx.resume).toHaveBeenCalledTimes(1);
    });

    it('leaves a running context alone', () => {
        const ctx = fakeCtx('running');
        expect(processorWith(ctx).recoverContext()).toEqual({ state: 'running', resumed: false });
        expect(ctx.resume).not.toHaveBeenCalled();
    });

    it('does not touch a closed context, and reports "none" before init / after destroy', () => {
        const ctx = fakeCtx('closed');
        expect(processorWith(ctx).recoverContext()).toEqual({ state: 'closed', resumed: false });
        expect(ctx.resume).not.toHaveBeenCalled();
        expect(processorWith(undefined).recoverContext()).toEqual({ state: 'none', resumed: false });
    });

    it('a rejected resume() (no user gesture yet) is swallowed: the unlock registry retries on the next gesture', async () => {
        const ctx = fakeCtx('suspended', vi.fn().mockRejectedValue(new Error('NotAllowedError')));
        expect(() => processorWith(ctx).recoverContext()).not.toThrow();
        await Promise.resolve();
    });
});
