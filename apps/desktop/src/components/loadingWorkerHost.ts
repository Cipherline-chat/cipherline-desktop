/**
 * Owns the loading screen's worker across mounts.
 *
 * The app shows the loading screen twice in a row (App.tsx while the session
 * restores, then HydrationGate while data loads), as two separate mounts.
 * Spawning a fresh worker for the second one would restart the scene and
 * leave blank frames while it boots. So a released worker is PARKED for
 * HANDOFF_MS (drawing nothing): the next screen re-attaches it to its own
 * canvas and the dots carry on from the same clock. If nobody comes back it
 * is terminated, which frees its GL context with it. A FINAL release (the
 * screen has exited for good) drops the context and terminates at once.
 *
 * Parking also absorbs React StrictMode's dev-only unmount/re-mount, where
 * the SAME canvas comes back: a canvas can hand its control to an
 * OffscreenCanvas only once, so that case resumes the worker that already
 * owns it instead of transferring again.
 */
import type { FromWorker, ToWorker } from '../workers/loadingScreenProtocol';
import { HANDOFF_MS } from './loadingWait';

/** The part of Worker this module uses — a test can supply a fake. */
export interface WorkerLike {
    postMessage(message: ToWorker, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
}

const defaultFactory = (): WorkerLike => new Worker(
    new URL('../workers/loadingScreen.worker.ts', import.meta.url),
    { type: 'module', name: 'loading-screen' },
) as unknown as WorkerLike;

let factory: (() => WorkerLike) | null = defaultFactory;
let parked: { worker: WorkerLike; canvas: HTMLCanvasElement; timer: ReturnType<typeof setTimeout> } | null = null;
/** WebGL (or the worker) failed once this session: don't try again. */
let broken = false;

/** Test hook: swap the worker constructor (null = workers unavailable). */
export function __setLoadingWorkerFactory(f: (() => WorkerLike) | null | 'default'): void {
    factory = f === 'default' ? defaultFactory : f;
}
/** Test hook. */
export function __resetLoadingWorkerHost(): void {
    if (parked) { clearTimeout(parked.timer); parked.worker.terminate(); }
    parked = null;
    broken = false;
}

/** Can this canvas be driven from a worker at all? */
export function canUseWorker(canvas: HTMLCanvasElement | null): boolean {
    if (broken || !factory || !canvas) return false;
    if (parked?.canvas === canvas) return true;
    if (typeof canvas.transferControlToOffscreen !== 'function') return false;
    return factory !== defaultFactory || typeof Worker !== 'undefined';
}

/**
 * Could a screen with a game plausibly get a worker-driven field at all? A
 * cheap, canvas-less guess for deciding whether to OFFER the game (the offline
 * screen's "Press Space to play"); the real answer is still the worker's
 * 'ok' / 'nogl'.
 */
export function canOfferGame(): boolean {
    if (broken || !factory) return false;
    if (typeof HTMLCanvasElement === 'undefined' || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function') return false;
    return factory !== defaultFactory || typeof Worker !== 'undefined';
}

/** WebGL or the worker failed: use the static screen for the rest of the session. */
export function markBroken(): void { broken = true; }

/**
 * A worker for a newly mounted screen: the parked one if any, else a new one.
 * `resumed` = it already owns this very canvas (send 'resume', not 'init').
 */
export function acquireWorker(canvas: HTMLCanvasElement): { worker: WorkerLike; resumed: boolean } | null {
    if (parked) {
        clearTimeout(parked.timer);
        const { worker, canvas: owned } = parked;
        parked = null;
        return { worker, resumed: owned === canvas };
    }
    try {
        return factory ? { worker: factory(), resumed: false } : null;
    } catch {
        broken = true;
        return null;
    }
}

/**
 * A fresh worker for another surface that draws the same scene: the Home
 * deck's easter-egg game (FirewallOverlay.tsx) reuses the loading screen's
 * worker module rather than forking it. Never the parked one (that belongs
 * to the loading-screen handoff), and never parked itself: release it with
 * `releaseWorker(w, canvas, true)`, which drops its GL context and
 * terminates it. Null when workers are unavailable or broken this session.
 */
export function spawnWorker(): WorkerLike | null {
    if (broken || !factory) return null;
    try {
        return factory();
    } catch {
        broken = true;
        return null;
    }
}

/**
 * The screen is unmounting. `final` (it exited, or the worker is broken):
 * release the GL context and terminate now. Otherwise park it.
 */
export function releaseWorker(w: WorkerLike, canvas: HTMLCanvasElement, final: boolean): void {
    w.onmessage = null;
    w.onerror = null;
    if (final || broken) {
        try { w.postMessage({ type: 'detach' }); } catch { /* already gone */ }
        w.terminate();
        return;
    }
    try { w.postMessage({ type: 'pause' }); } catch { /* already gone */ }
    if (parked) { clearTimeout(parked.timer); parked.worker.terminate(); }
    const timer = setTimeout(() => {
        if (parked?.worker === w) parked = null;
        w.terminate();
    }, HANDOFF_MS);
    parked = { worker: w, canvas, timer };
}
