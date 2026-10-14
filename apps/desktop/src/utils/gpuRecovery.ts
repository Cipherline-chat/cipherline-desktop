/**
 * Recover a call's video after a GPU process restart ("graphics driver reset").
 *
 * electron/gpu-restart.ts explains the main-process half: on Windows,
 * Chromium's GPU process exits on purpose (exit code 34,
 * RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST) when its D3D device is lost, and a new
 * one starts. The compositor recovers by itself; a call's video may not —
 * hardware decoders / encoders and the camera's D3D11 capture path live in the
 * dead process, and Chromium's WebRTC has no software H.265 at all. Prod,
 * 2026-10-11 (stable 1.0.20, NVIDIA + AMD, four displays): "after switching
 * displays cameras don't load" — both remote cameras froze ~20 s after the
 * GPU process died, and stayed frozen even across a leave + rejoin.
 *
 * Flow (main → `gpu:process-restarted` → here → `gpu:recovery-outcome` → main):
 *
 *   handleGpuRestarted(payload)
 *     ├─ validate the payload (parseGpuRestartedPayload) — dropped if malformed
 *     ├─ call event `gpu_process_restarted`
 *     ├─ no call registered → answer `not_in_call` (nothing of ours to fix)
 *     └─ in a call → the call's handler (GpuRecoveryController → runGpuVideoRecovery):
 *          settle (the new GPU process comes up)
 *          1. camera   — restartTrack(): re-acquire the capture on the new GPU
 *                        process. Same sender, so the E2EE transform and the
 *                        sender-codec pin (E2EESenderCodecPin) are untouched.
 *          2. hevc     — H.265 leaves this app session in both directions
 *                        (hevcNegotiation.markHevcGpuLost): advertise "no
 *                        H.265 decode" → every peer drops to H.264/VP8 through
 *                        the existing all-capable negotiation; our own camera
 *                        / share follow on SidebarConference's next tick.
 *          3. reattach — every remote video element gets a fresh srcObject
 *                        (new media player / frame sink in the renderer).
 *          4. share    — reported only: a screen share cannot be re-acquired
 *                        without the picker; its encoder falls back to software
 *                        (H.264/VP8) or is moved off H.265 by step 2.
 *          5. verify   — remote video still not decoding over 3 s?
 *               → keyframe: pause + resume at the SFU (it asks the sender for
 *                 a keyframe on resume — remoteVideoDemand.ts), verify again;
 *               → resubscribe (cameras): unsubscribe + subscribe — a new
 *                 transceiver, a new decoder, a keyframe.
 *          6. watch    — 10 s: any remote video frozen for all of it, or the
 *                        camera restart failed → `restart_prompted` and the
 *                        in-app "Video stopped after a graphics driver reset —
 *                        Restart Cipherline to fix" prompt; else `recovered`.
 *
 * Every step is a `video_recovery {step, ok, …}` call event (callEventLog.ts
 * contract: counts / booleans / enums only, no identities). A newer restart
 * while one is running cancels the older run (its seq gets no answer — the
 * newer one answers for the same crash record).
 */
import { useSyncExternalStore } from 'react';
import { logCallEvent } from './callEventLog';

// ── Payload (main → renderer) ───────────────────────────────────────────────

export const GPU_GONE_REASONS = ['crashed', 'abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure'] as const;
export type GpuGoneReason = (typeof GPU_GONE_REASONS)[number];

export interface GpuRestartedSignal {
    seq: number;
    reason: GpuGoneReason;
    exitCode: number | null;
    /** exit code 34 — Chromium exited the GPU process to recover a lost D3D device. */
    ctxLost: boolean;
}

const MAX_SEQ = 1_000_000;

/**
 * Narrow main's `gpu:process-restarted` payload. Mirrors
 * electron/gpu-restart.ts GpuRestartedPayload (v1); anything malformed → null
 * (the signal is ignored — never "repaired").
 */
export function parseGpuRestartedPayload(v: unknown): GpuRestartedSignal | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const p = v as Record<string, unknown>;
    if (p.v !== 1) return null;
    if (typeof p.seq !== 'number' || !Number.isInteger(p.seq) || p.seq < 1 || p.seq > MAX_SEQ) return null;
    if (typeof p.reason !== 'string' || !(GPU_GONE_REASONS as readonly string[]).includes(p.reason)) return null;
    let exitCode: number | null;
    if (p.exit_code === null) exitCode = null;
    else if (typeof p.exit_code === 'number' && Number.isInteger(p.exit_code)) exitCode = p.exit_code;
    else return null;
    if (typeof p.ctx_lost !== 'boolean') return null;
    return { seq: p.seq, reason: p.reason as GpuGoneReason, exitCode, ctxLost: p.ctx_lost };
}

// ── Outcome (renderer → main) ───────────────────────────────────────────────

export type GpuRecoveryOutcome = 'recovered' | 'restart_prompted' | 'not_in_call';

export interface GpuRecoveryBridge {
    onGpuProcessRestarted?: (cb: (payload: unknown) => void) => () => void;
    reportGpuRecovery?: (report: { seq: number; outcome: GpuRecoveryOutcome }) => Promise<void>;
}

// ── Timings ─────────────────────────────────────────────────────────────────

/** Let the new GPU process come up before touching anything. */
export const SETTLE_MS = 1500;
/** Window over which a remote video must decode at least one new frame. */
export const VERIFY_MS = 3000;
/** Pause → resume gap for the keyframe step. */
export const KEYFRAME_GAP_MS = 400;
/** Unsubscribe → subscribe gap for the resubscribe step. */
export const RESUBSCRIBE_GAP_MS = 600;
/** Frozen for this long after every step → the restart prompt. */
export const FROZEN_PROMPT_MS = 10_000;
/** Sampling period while watching. */
export const WATCH_SAMPLE_MS = 2000;

// ── Orchestration ───────────────────────────────────────────────────────────

/** One remote video the call is currently showing: subscribed, enabled, unmuted. */
export interface RemoteVideoSample {
    /** Internal key (a track sid) — never logged. */
    key: string;
    /** inbound-rtp framesDecoded. */
    frames: number;
    /** Camera (resubscribable) vs screen share (keyframe only). */
    camera: boolean;
}

export type CameraRestartResult = 'restarted' | 'none' | 'failed';

export interface GpuRecoveryDeps {
    sleep(ms: number): Promise<void>;
    now(): number;
    /** A newer restart, or the call ended: stop at the next step. */
    cancelled(): boolean;
    restartCamera(): Promise<CameraRestartResult>;
    /** Take H.265 out of the session; `was` = it was in use; decode/encode = what the probes say now. */
    reevaluateHevc(): Promise<{ was: boolean; decode: boolean; encode: boolean }>;
    /** Fresh srcObject on every remote video element; returns how many. */
    reattachRemoteVideo(): number;
    /** Our screen share, if any: 'live' | 'ended' | 'none'. */
    shareState(): 'live' | 'ended' | 'none';
    sampleRemoteVideo(): Promise<RemoteVideoSample[]>;
    /** Pause + resume at the SFU (keyframe on resume). Returns how many. */
    requestKeyframes(keys: readonly string[]): Promise<number>;
    /** Unsubscribe + subscribe (cameras only). Returns how many. */
    resubscribe(keys: readonly string[]): Promise<number>;
}

/** Remote videos whose decoded-frame count did not move over `ms`. */
export async function frozenOver(deps: Pick<GpuRecoveryDeps, 'sleep' | 'sampleRemoteVideo'>, ms: number): Promise<RemoteVideoSample[]> {
    const before = new Map((await deps.sampleRemoteVideo()).map(s => [s.key, s.frames]));
    await deps.sleep(ms);
    const after = await deps.sampleRemoteVideo();
    return after.filter(s => before.has(s.key) && before.get(s.key) === s.frames);
}

/**
 * Remote videos that decoded NOTHING for at least `ms` (sampled every
 * WATCH_SAMPLE_MS). A video that advances even once restarts its clock; one
 * that goes away (unsubscribed, paused offscreen, left) is dropped.
 */
export async function watchFrozen(deps: Pick<GpuRecoveryDeps, 'sleep' | 'now' | 'sampleRemoteVideo' | 'cancelled'>, ms: number): Promise<string[]> {
    const start = deps.now();
    const state = new Map<string, { frames: number; since: number }>();
    for (const s of await deps.sampleRemoteVideo()) state.set(s.key, { frames: s.frames, since: start });
    while (deps.now() - start < ms) {
        await deps.sleep(WATCH_SAMPLE_MS);
        if (deps.cancelled()) return [];
        const t = deps.now();
        const seen = new Set<string>();
        for (const s of await deps.sampleRemoteVideo()) {
            seen.add(s.key);
            const st = state.get(s.key);
            if (!st) state.set(s.key, { frames: s.frames, since: t });
            else if (st.frames !== s.frames) { st.frames = s.frames; st.since = t; }
        }
        for (const k of [...state.keys()]) if (!seen.has(k)) state.delete(k);
    }
    const end = deps.now();
    return [...state.entries()].filter(([, st]) => end - st.since >= ms).map(([k]) => k);
}

/**
 * The in-call recovery sequence (module doc). Returns the outcome, or null
 * when cancelled (a newer restart took over, or the call ended).
 */
export async function runGpuVideoRecovery(deps: GpuRecoveryDeps): Promise<'recovered' | 'restart_prompted' | null> {
    await deps.sleep(SETTLE_MS);
    if (deps.cancelled()) return null;

    // 1. Camera first: the H.265 step below makes SidebarConference republish
    //    the camera from its CURRENT capture — so that capture must be the
    //    re-acquired one, not the one that died with the GPU process.
    let cam: CameraRestartResult = 'none';
    try { cam = await deps.restartCamera(); } catch { cam = 'failed'; }
    if (cam !== 'none') logCallEvent('video_recovery', { step: 'camera', ok: cam === 'restarted' });
    if (deps.cancelled()) return null;

    // 2. H.265 out of the session (both directions).
    try {
        const h = await deps.reevaluateHevc();
        logCallEvent('video_recovery', { step: 'hevc', ok: true, from: h.was ? 'h265' : 'base', to: 'base', decode: h.decode, encode: h.encode });
    } catch {
        logCallEvent('video_recovery', { step: 'hevc', ok: false });
    }
    if (deps.cancelled()) return null;

    // 3. Re-attach every remote video element.
    let reattached = 0;
    try { reattached = deps.reattachRemoteVideo(); } catch { /* counted as 0 */ }
    logCallEvent('video_recovery', { step: 'reattach', ok: true, count: reattached });

    // 4. Our screen share (report only).
    const share = deps.shareState();
    if (share !== 'none') logCallEvent('video_recovery', { step: 'share', ok: share === 'live' });

    // 5. Verify → keyframe → verify → resubscribe.
    let frozen = await frozenOver(deps, VERIFY_MS);
    if (deps.cancelled()) return null;
    if (frozen.length > 0) {
        const n = await deps.requestKeyframes(frozen.map(s => s.key)).catch(() => 0);
        logCallEvent('video_recovery', { step: 'keyframe', ok: n > 0, count: n, frozen: frozen.length });
        frozen = await frozenOver(deps, VERIFY_MS);
        if (deps.cancelled()) return null;
    }
    const cameras = frozen.filter(s => s.camera);
    if (cameras.length > 0) {
        const n = await deps.resubscribe(cameras.map(s => s.key)).catch(() => 0);
        logCallEvent('video_recovery', { step: 'resubscribe', ok: n > 0, count: n, frozen: frozen.length });
    }

    // 6. Watch: frozen for the whole window after every attempt → prompt.
    const stuck = await watchFrozen(deps, FROZEN_PROMPT_MS);
    if (deps.cancelled()) return null;
    const ok = stuck.length === 0 && cam !== 'failed';
    logCallEvent('video_recovery', { step: 'verify', ok, frozen: stuck.length, camera: cam !== 'failed' });
    return ok ? 'recovered' : 'restart_prompted';
}

// ── The call's handler (one call at a time) ────────────────────────────────

export type CallGpuRecoveryHandler = (signal: GpuRestartedSignal) => Promise<'recovered' | 'restart_prompted' | null>;
let callHandler: CallGpuRecoveryHandler | null = null;

/** The live call registers its recovery (GpuRecoveryController). Returns the unregister. */
export function registerCallGpuRecovery(handler: CallGpuRecoveryHandler): () => void {
    callHandler = handler;
    return () => { if (callHandler === handler) callHandler = null; };
}

/**
 * main's signal → the call's recovery (or `not_in_call`) → the answer to main,
 * and the prompt when video could not be confirmed. Never throws.
 */
export async function handleGpuRestarted(
    raw: unknown,
    report: (r: { seq: number; outcome: GpuRecoveryOutcome }) => unknown,
): Promise<GpuRecoveryOutcome | null> {
    const signal = parseGpuRestartedPayload(raw);
    if (!signal) return null;
    const handler = callHandler;
    logCallEvent('gpu_process_restarted', {
        count: signal.seq, reason: signal.reason, exit_code: signal.exitCode ?? -1, ctx_lost: signal.ctxLost, in_call: !!handler,
    });
    console.warn(`[GPU] GPU process restarted (#${signal.seq}, ${signal.reason}, exit ${signal.exitCode}${signal.ctxLost ? ' = context lost' : ''})${handler ? ' — recovering call video' : ''}`);
    let outcome: GpuRecoveryOutcome | null;
    if (!handler) {
        outcome = 'not_in_call';
    } else {
        try { outcome = await handler(signal); } catch (e) { console.warn('[GPU] recovery failed:', e); outcome = 'restart_prompted'; }
    }
    if (!outcome) return null; // superseded by a newer restart, or the call ended mid-run
    if (outcome === 'restart_prompted') showGpuRestartPrompt({ inCall: true });
    try { await report({ seq: signal.seq, outcome }); } catch { /* an older main: nothing to tell */ }
    return outcome;
}

/** Subscribe to main's signal (App root, once). Returns the unsubscribe. */
export function installGpuRestartListener(api: GpuRecoveryBridge | undefined): () => void {
    if (!api?.onGpuProcessRestarted) return () => {};
    return api.onGpuProcessRestarted(raw => {
        void handleGpuRestarted(raw, r => api.reportGpuRecovery?.(r));
    });
}

// ── The restart prompt (store) ─────────────────────────────────────────────

export interface GpuRestartPromptState { inCall: boolean }
let promptState: GpuRestartPromptState | null = null;
const promptListeners = new Set<() => void>();
const emitPrompt = () => { for (const l of [...promptListeners]) { try { l(); } catch { /* isolate */ } } };

export function showGpuRestartPrompt(s: GpuRestartPromptState): void { promptState = { ...s }; emitPrompt(); }
export function dismissGpuRestartPrompt(): void { if (promptState) { promptState = null; emitPrompt(); } }
export function getGpuRestartPrompt(): GpuRestartPromptState | null { return promptState; }
export function subscribeGpuRestartPrompt(cb: () => void): () => void {
    promptListeners.add(cb);
    return () => { promptListeners.delete(cb); };
}
export function useGpuRestartPrompt(): GpuRestartPromptState | null {
    return useSyncExternalStore(subscribeGpuRestartPrompt, getGpuRestartPrompt, () => null);
}

export function __resetGpuRecoveryForTests(): void {
    callHandler = null;
    promptState = null;
    promptListeners.clear();
}
