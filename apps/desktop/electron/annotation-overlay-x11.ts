/**
 * Run-time X11 checks for the desktop annotation overlay (electron/annotation-overlay.ts).
 *
 * The X11 overlay is an Electron window: transparent, always on top, click-through. Two things
 * about the session decide whether that is safe and where it goes, and Electron answers neither:
 *
 *  1. Is a COMPOSITING MANAGER running? Without one the "transparent" window is painted opaque
 *     black over the whole shared screen — into the share too, since X11 has no capture
 *     exclusion. A desktop's NAME does not say (XFCE users switch compositing off, KDE on Xorg
 *     suspends it on request or for a full-screen game; MATE / LXQt / i3 + picom do composite).
 *     The real signal is whether some client owns the `_NET_WM_CM_S<screen>` selection
 *     (XGetSelectionOwner) — the same test Chromium itself uses to decide on an ARGB visual.
 *  2. Where is the shared WINDOW, and is it visible? (window shares)
 *
 * Both come from the native helper's plain-X11 modes (src-native/wayland_overlay/x11_probe.inc,
 * libX11 dlopen()ed — no link-time dependency):
 *
 *   - `createX11CompositorProbe`: one-shot `--x11-probe`, run just before the overlay is offered
 *     (asynchronously: nothing in electron/ may block the main thread on a child process). Cached for
 *     a moment so the precheck + show pair costs one spawn. null = could not ask, and the caller
 *     falls back to the desktop-name list.
 *   - `createX11Watcher`: a long-lived `--x11-watch` while the overlay is up. It reports a change
 *     of compositor state within ~0.5 s (so the overlay can be taken down the moment the
 *     compositor goes away mid-share) and, for a window share, the window's state and rectangle on
 *     every change (~12 Hz poll in the helper; a line only when something changed).
 *
 * Electron-free (spawn, clock and log are injected) so the life cycle is unit tested with a fake
 * helper (annotation-overlay-x11.test.ts).
 */
import { parseX11HelperLine, type X11WindowState } from './annotation-overlay-x11-protocol';
import type { Rect } from './annotation-overlay-projection';
import type { HelperProc } from './annotation-overlay-wayland';

// ── One-shot probe ──────────────────────────────────────────────────────────

export interface X11CompositorProbeDeps {
    /** The helper binary exists in this install (false = the answer is null at once, nothing is spawned). */
    available(): boolean;
    /**
     * Run `--x11-probe` ASYNCHRONOUSLY (nothing in electron/ may block the main thread on a child process:
     * electron/main-thread-blockers.test.ts) and resolve to its stdout, or null when it cannot run.
     */
    run(): Promise<string | null>;
    now(): number;
    log(message: string): void;
    /** How long an answer is reused. Default 1000 ms. */
    ttlMs?: number;
}

export interface X11CompositorProbe {
    /**
     * The answer if one is fresh enough to reuse (or none can be had because the helper is absent), else
     * `undefined` (call `get()`). Lets a caller stay synchronous whenever it can.
     */
    peek(): boolean | null | undefined;
    /** A fresh-enough answer, running the helper if needed (concurrent callers share one spawn). */
    get(): Promise<boolean | null>;
}

/**
 * `true` / `false` = a compositing manager is / is not running; `null` = the probe could not
 * run (the caller keeps today's name-list guess). Failure reasons are logged once per distinct
 * reason, not per call.
 */
export function createX11CompositorProbe(deps: X11CompositorProbeDeps): X11CompositorProbe {
    const ttl = deps.ttlMs ?? 1000;
    let cached: { at: number; value: boolean | null } | null = null;
    let pending: Promise<boolean | null> | null = null;
    const loggedFailures = new Set<string>();
    const fail = (why: string): null => {
        if (!loggedFailures.has(why)) {
            loggedFailures.add(why);
            deps.log(`[annot-overlay] X11 compositor probe unavailable (${why}); guessing from the desktop name instead`);
        }
        return null;
    };
    const interpret = (out: string | null): boolean | null => {
        if (out === null) return fail('helper did not run');
        let value: boolean | null = null;
        let err: string | null = null;
        for (const line of out.split('\n')) {
            const ev = parseX11HelperLine(line);
            if (!ev) continue;
            if (ev.kind === 'cm') value = ev.compositor;
            else if (ev.kind === 'err') err = ev.code;
        }
        return value === null ? fail(err ?? 'no answer') : value;
    };
    const peek = (): boolean | null | undefined => {
        if (!deps.available()) return fail('helper not available');
        const t = deps.now();
        if (cached && t >= cached.at && t - cached.at < ttl) return cached.value;
        return undefined;
    };
    return {
        peek,
        get(): Promise<boolean | null> {
            const hit = peek();
            if (hit !== undefined) return Promise.resolve(hit);
            if (pending) return pending;
            const t = deps.now();
            pending = deps.run().then(out => {
                const value = interpret(out);
                cached = { at: t, value };
                return value;
            }, () => {
                cached = { at: t, value: fail('helper did not run') };
                return null;
            }).finally(() => { pending = null; });
            return pending;
        },
    };
}

// ── Long-lived watcher ──────────────────────────────────────────────────────

export interface X11WindowReport {
    state: X11WindowState;
    /** Client area in X root coordinates (physical pixels); null unless state is 'ok'. */
    frame: Rect | null;
}

export interface X11WatcherHandlers {
    /** The compositor appeared or went away (not called for the first answer: that is start()'s result). */
    onCompositor(compositor: boolean): void;
    /** The tracked window's state or rectangle changed. */
    onWindow(report: X11WindowReport): void;
    /** The helper stopped on its own while watching: no further reports will come. */
    onLost(): void;
}

export interface X11WatcherDeps {
    /** Start `--x11-watch`, or null when the helper's binary is not there. */
    spawnHelper(): HelperProc | null;
    log(message: string): void;
    /** Longest start() / track() wait for the helper's first answer. Default 2000 ms. */
    stepTimeoutMs?: number;
}

export interface X11Watcher {
    /** Spawn the helper; resolves to the compositor state it saw first, or null when it could not run. */
    start(): Promise<boolean | null>;
    /** Track a window (decimal XID); resolves to its first report, or null on timeout / no helper. */
    track(xid: string): Promise<X11WindowReport | null>;
    stop(): void;
    isRunning(): boolean;
}

const MAX_STDOUT_LINE = 4096;

export function createX11Watcher(deps: X11WatcherDeps, handlers: X11WatcherHandlers): X11Watcher {
    const timeout = deps.stepTimeoutMs ?? 2000;
    let proc: HelperProc | null = null;
    let generation = 0;
    let started = false;
    let firstCm: ((v: boolean | null) => void) | null = null;
    let firstWin: ((r: X11WindowReport | null) => void) | null = null;

    function stop(): void {
        generation++;
        const p = proc;
        proc = null;
        started = false;
        const fc = firstCm; firstCm = null; fc?.(null);
        const fw = firstWin; firstWin = null; fw?.(null);
        if (!p) return;
        try { if (!p.stdin.destroyed) { p.stdin.write('QUIT\n'); p.stdin.end(); } } catch { /* already gone */ }
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 500);
        if (typeof t === 'object' && t && 'unref' in t) (t as { unref(): void }).unref();
    }

    function after(ms: number, onTimeout: () => void): ReturnType<typeof setTimeout> {
        const t = setTimeout(onTimeout, ms);
        if (typeof t === 'object' && t && 'unref' in t) (t as { unref(): void }).unref();
        return t;
    }

    return {
        start(): Promise<boolean | null> {
            if (proc) stop();
            const p = deps.spawnHelper();
            if (!p) return Promise.resolve(null);
            proc = p;
            const gen = ++generation;
            return new Promise<boolean | null>(resolve => {
                let settled = false;
                const settle = (v: boolean | null): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    firstCm = null;
                    if (v === null && gen === generation) stop();
                    resolve(v);
                };
                const timer = after(timeout, () => { deps.log('[annot-overlay] X11 watch helper did not answer in time'); settle(null); });
                firstCm = settle;
                let buf = '';
                p.stdout.on('data', chunk => {
                    if (gen !== generation) return;
                    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                    let nl: number;
                    while ((nl = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        const ev = parseX11HelperLine(line);
                        if (!ev) continue;
                        if (ev.kind === 'cm') {
                            if (!started) { started = true; settle(ev.compositor); }
                            else handlers.onCompositor(ev.compositor);
                        } else if (ev.kind === 'win') {
                            const report: X11WindowReport = { state: ev.state, frame: ev.frame };
                            const fw = firstWin;
                            if (fw) { firstWin = null; fw(report); }
                            handlers.onWindow(report);
                        } else if (ev.kind === 'err') {
                            if (!started) { deps.log(`[annot-overlay] X11 watch helper failed (${ev.code})`); settle(null); }
                        }
                    }
                    if (buf.length > MAX_STDOUT_LINE) buf = '';
                });
                const gone = (): void => {
                    if (gen !== generation) return;
                    const wasStarted = started;
                    stop();
                    if (!wasStarted) settle(null);
                    else { deps.log('[annot-overlay] X11 watch helper stopped; the compositor is no longer monitored for this share'); handlers.onLost(); }
                };
                p.on('exit', gone);
                p.on('error', gone);
            });
        },

        track(xid: string): Promise<X11WindowReport | null> {
            const p = proc;
            if (!p || !started || p.stdin.destroyed) return Promise.resolve(null);
            if (!/^\d{1,10}$/.test(xid)) return Promise.resolve(null);
            return new Promise<X11WindowReport | null>(resolve => {
                const timer = after(timeout, () => { if (firstWin === done) firstWin = null; resolve(null); });
                const done = (r: X11WindowReport | null): void => { clearTimeout(timer); resolve(r); };
                firstWin = done;
                try { p.stdin.write(`WIN ${xid}\n`); } catch { done(null); firstWin = null; }
            });
        },

        stop,
        isRunning: () => proc !== null && started,
    };
}
