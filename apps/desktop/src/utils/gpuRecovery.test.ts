import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    FROZEN_PROMPT_MS, SETTLE_MS, VERIFY_MS, __resetGpuRecoveryForTests, frozenOver, getGpuRestartPrompt,
    handleGpuRestarted, installGpuRestartListener, parseGpuRestartedPayload, registerCallGpuRecovery,
    runGpuVideoRecovery, watchFrozen, type CameraRestartResult, type GpuRecoveryDeps, type RemoteVideoSample,
} from './gpuRecovery';
import { clearCallEvents, getCallEvents, validateCallEvent, type CallEvent } from './callEventLog';

/** main's payload for the prod GPU death (crashed, exit 34). */
const PROD = { v: 1, seq: 1, reason: 'crashed', exit_code: 34, ctx_lost: true };

/**
 * A scripted call on a virtual clock. Each remote video has a function
 * time → framesDecoded; the recovery steps can change the script (e.g. a
 * resubscribe "fixes" a decoder).
 */
class FakeCall implements GpuRecoveryDeps {
    t = 0;
    calls: string[] = [];
    cancel = false;
    camera: CameraRestartResult = 'restarted';
    share: 'live' | 'ended' | 'none' = 'none';
    videos = new Map<string, { camera: boolean; frames: (t: number) => number }>();
    onKeyframe: (keys: readonly string[]) => void = () => {};
    onResubscribe: (keys: readonly string[]) => void = () => {};

    sleep = async (ms: number) => { this.t += ms; };
    now = () => this.t;
    cancelled = () => this.cancel;
    async restartCamera() { this.calls.push('camera'); return this.camera; }
    async reevaluateHevc() { this.calls.push('hevc'); return { was: true, decode: true, encode: true }; }
    reattachRemoteVideo() { this.calls.push('reattach'); return this.videos.size; }
    shareState() { return this.share; }
    async sampleRemoteVideo(): Promise<RemoteVideoSample[]> {
        return [...this.videos].map(([key, v]) => ({ key, camera: v.camera, frames: v.frames(this.t) }));
    }
    async requestKeyframes(keys: readonly string[]) { this.calls.push(`keyframe:${keys.join(',')}`); this.onKeyframe(keys); return keys.length; }
    async resubscribe(keys: readonly string[]) { this.calls.push(`resubscribe:${keys.join(',')}`); this.onResubscribe(keys); return keys.length; }
}

const flowing = (t: number) => Math.floor(t / 33);
const frozenAt = (n: number) => () => n;
/** Frames advance only from `from` on (a decoder that came back). */
const flowingFrom = (from: number) => (t: number) => (t < from ? 500 : 500 + Math.floor((t - from) / 33));

const events = () => getCallEvents();
const recovery = () => events().filter(e => e.kind === 'video_recovery').map(e => e.detail);
const allValid = (evs: CallEvent[]) => evs.flatMap(validateCallEvent);

beforeEach(() => {
    clearCallEvents();
    __resetGpuRecoveryForTests();
});

describe('parseGpuRestartedPayload (main → renderer)', () => {
    it('accepts main\'s v1 payload', () => {
        expect(parseGpuRestartedPayload(PROD)).toEqual({ seq: 1, reason: 'crashed', exitCode: 34, ctxLost: true });
        expect(parseGpuRestartedPayload({ ...PROD, exit_code: null, ctx_lost: false })?.exitCode).toBeNull();
    });

    it('rejects malformed payloads (negative controls)', () => {
        const bad: unknown[] = [
            null, undefined, 1, 'gpu', [],
            { ...PROD, v: 2 }, { ...PROD, v: undefined },
            { ...PROD, seq: 0 }, { ...PROD, seq: 2.5 }, { ...PROD, seq: '1' }, { ...PROD, seq: 1e9 },
            { ...PROD, reason: 'clean-exit' }, { ...PROD, reason: 'CRASHED' }, { ...PROD, reason: 7 },
            { ...PROD, exit_code: '34' }, { ...PROD, exit_code: 3.4 }, { ...PROD, exit_code: undefined },
            { ...PROD, ctx_lost: 'yes' }, { ...PROD, ctx_lost: undefined },
        ];
        for (const b of bad) expect(parseGpuRestartedPayload(b)).toBeNull();
    });
});

describe('frozen detection', () => {
    it('frozenOver: only videos whose frame count did not move', async () => {
        const c = new FakeCall();
        c.videos.set('a', { camera: true, frames: flowing });
        c.videos.set('b', { camera: true, frames: frozenAt(10) });
        expect((await frozenOver(c, VERIFY_MS)).map(s => s.key)).toEqual(['b']);
    });

    it('watchFrozen: a video that advances even once restarts its clock', async () => {
        const c = new FakeCall();
        c.videos.set('stuck', { camera: true, frames: frozenAt(1) });
        // Advances once at t = 4 s, then stops again: frozen 6 s < 10 s.
        c.videos.set('blip', { camera: true, frames: t => (t < 4000 ? 1 : 2) });
        expect(await watchFrozen(c, FROZEN_PROMPT_MS)).toEqual(['stuck']);
    });
});

describe('runGpuVideoRecovery — signal → steps → events → verdict', () => {
    it('video flowing after the cheap steps → recovered; camera first, then H.265, then re-attach; no keyframe / resubscribe', async () => {
        const c = new FakeCall();
        c.videos.set('remote-1', { camera: true, frames: flowing });
        c.videos.set('remote-2', { camera: false, frames: flowing });
        expect(await runGpuVideoRecovery(c)).toBe('recovered');
        expect(c.calls).toEqual(['camera', 'hevc', 'reattach']);
        expect(c.t).toBeGreaterThanOrEqual(SETTLE_MS + VERIFY_MS + FROZEN_PROMPT_MS);
        expect(recovery()).toEqual([
            { step: 'camera', ok: true },
            { step: 'hevc', ok: true, from: 'h265', to: 'base', decode: true, encode: true },
            { step: 'reattach', ok: true, count: 2 },
            { step: 'verify', ok: true, frozen: 0, camera: true },
        ]);
        expect(allValid(events())).toEqual([]);
        expect(getGpuRestartPrompt()).toBeNull();
    });

    it('frozen until a keyframe → keyframe step, no resubscribe, recovered', async () => {
        const c = new FakeCall();
        c.videos.set('remote-1', { camera: true, frames: frozenAt(500) });
        c.onKeyframe = () => { c.videos.set('remote-1', { camera: true, frames: flowingFrom(c.t) }); };
        expect(await runGpuVideoRecovery(c)).toBe('recovered');
        expect(c.calls).toEqual(['camera', 'hevc', 'reattach', 'keyframe:remote-1']);
        expect(recovery()).toContainEqual({ step: 'keyframe', ok: true, count: 1, frozen: 1 });
    });

    it('frozen until resubscribed (cameras only) → recovered', async () => {
        const c = new FakeCall();
        c.videos.set('cam', { camera: true, frames: frozenAt(500) });
        c.videos.set('share', { camera: false, frames: flowing });
        c.onResubscribe = keys => { for (const k of keys) c.videos.set(k, { camera: true, frames: flowingFrom(c.t) }); };
        expect(await runGpuVideoRecovery(c)).toBe('recovered');
        expect(c.calls).toEqual(['camera', 'hevc', 'reattach', 'keyframe:cam', 'resubscribe:cam']);
    });

    it('the prod case: frozen through EVERY step for 10 s → restart_prompted, with the evidence logged', async () => {
        const c = new FakeCall();
        c.videos.set('r1', { camera: true, frames: frozenAt(900) });
        c.videos.set('r2', { camera: true, frames: frozenAt(1200) });
        expect(await runGpuVideoRecovery(c)).toBe('restart_prompted');
        expect(c.calls).toEqual(['camera', 'hevc', 'reattach', 'keyframe:r1,r2', 'resubscribe:r1,r2']);
        expect(recovery().at(-1)).toEqual({ step: 'verify', ok: false, frozen: 2, camera: true });
        expect(allValid(events())).toEqual([]);
    });

    it('a frozen SCREEN SHARE is never resubscribed (watching state belongs to the share UI)', async () => {
        const c = new FakeCall();
        c.videos.set('share', { camera: false, frames: frozenAt(5) });
        expect(await runGpuVideoRecovery(c)).toBe('restart_prompted');
        expect(c.calls.some(x => x.startsWith('resubscribe'))).toBe(false);
    });

    it('camera restart failed → prompt even with remote video fine', async () => {
        const c = new FakeCall();
        c.camera = 'failed';
        c.videos.set('r', { camera: true, frames: flowing });
        expect(await runGpuVideoRecovery(c)).toBe('restart_prompted');
        expect(recovery()[0]).toEqual({ step: 'camera', ok: false });
    });

    it('negative control: a freeze that clears within the window is NOT prompted', async () => {
        const c = new FakeCall();
        // Frozen through the verify/keyframe/resubscribe steps, then the
        // decoder recovers on its own 6 s into the watch.
        const thawAt = SETTLE_MS + 3 * VERIFY_MS + 6000;
        c.videos.set('r', { camera: true, frames: flowingFrom(thawAt) });
        expect(await runGpuVideoRecovery(c)).toBe('recovered');
        expect(getGpuRestartPrompt()).toBeNull();
    });

    it('negative control: no camera, no remote video → recovered, nothing restarted beyond the no-ops', async () => {
        const c = new FakeCall();
        c.camera = 'none';
        expect(await runGpuVideoRecovery(c)).toBe('recovered');
        expect(recovery().some(d => d?.step === 'camera')).toBe(false);
    });

    it('cancelled (a newer restart / the call ended) → null, stops at the next step', async () => {
        const c = new FakeCall();
        c.videos.set('r', { camera: true, frames: frozenAt(1) });
        c.restartCamera = async () => { c.calls.push('camera'); c.cancel = true; return 'restarted'; };
        expect(await runGpuVideoRecovery(c)).toBeNull();
        expect(c.calls).toEqual(['camera']);
    });
});

describe('handleGpuRestarted — dispatch, answer to main, prompt', () => {
    it('no call → not_in_call reported, event logged, no prompt', async () => {
        const report = vi.fn();
        expect(await handleGpuRestarted(PROD, report)).toBe('not_in_call');
        expect(report).toHaveBeenCalledWith({ seq: 1, outcome: 'not_in_call' });
        expect(events()[0]).toMatchObject({ kind: 'gpu_process_restarted', detail: { count: 1, reason: 'crashed', exit_code: 34, ctx_lost: true, in_call: false } });
        expect(allValid(events())).toEqual([]);
        expect(getGpuRestartPrompt()).toBeNull();
    });

    it('in a call: recovered → reported, no prompt', async () => {
        registerCallGpuRecovery(async () => 'recovered');
        const report = vi.fn();
        expect(await handleGpuRestarted(PROD, report)).toBe('recovered');
        expect(report).toHaveBeenCalledWith({ seq: 1, outcome: 'recovered' });
        expect(events()[0].detail?.in_call).toBe(true);
        expect(getGpuRestartPrompt()).toBeNull();
    });

    it('in a call: still frozen → the restart prompt + restart_prompted reported', async () => {
        registerCallGpuRecovery(async () => 'restart_prompted');
        const report = vi.fn();
        expect(await handleGpuRestarted(PROD, report)).toBe('restart_prompted');
        expect(getGpuRestartPrompt()).toEqual({ inCall: true });
        expect(report).toHaveBeenCalledWith({ seq: 1, outcome: 'restart_prompted' });
    });

    it('a recovery that throws is treated as unconfirmed → prompt', async () => {
        registerCallGpuRecovery(async () => { throw new Error('boom'); });
        expect(await handleGpuRestarted(PROD, () => {})).toBe('restart_prompted');
        expect(getGpuRestartPrompt()).not.toBeNull();
    });

    it('superseded run (null) → no answer for that seq, no prompt', async () => {
        registerCallGpuRecovery(async () => null);
        const report = vi.fn();
        expect(await handleGpuRestarted(PROD, report)).toBeNull();
        expect(report).not.toHaveBeenCalled();
        expect(getGpuRestartPrompt()).toBeNull();
    });

    it('malformed payload → ignored completely (negative control)', async () => {
        const handler = vi.fn(async () => 'recovered' as const);
        registerCallGpuRecovery(handler);
        const report = vi.fn();
        expect(await handleGpuRestarted({ ...PROD, reason: 'clean-exit' }, report)).toBeNull();
        expect(handler).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        expect(events()).toEqual([]);
    });

    it('an unregistered (ended) call no longer handles restarts', async () => {
        const off = registerCallGpuRecovery(async () => 'recovered');
        off();
        expect(await handleGpuRestarted(PROD, () => {})).toBe('not_in_call');
    });

    it('an older main without reportGpuRecovery: still handled, never throws', async () => {
        let cb: ((p: unknown) => void) | null = null;
        const unsub = installGpuRestartListener({ onGpuProcessRestarted: c => { cb = c; return () => { cb = null; }; } });
        expect(cb).not.toBeNull();
        cb!(PROD);
        await new Promise(r => setTimeout(r, 0));
        expect(events()[0]?.kind).toBe('gpu_process_restarted');
        unsub();
        expect(cb).toBeNull();
        // No bridge at all → a no-op unsubscribe.
        expect(() => installGpuRestartListener(undefined)()).not.toThrow();
    });
});
