/**
 * Linux/Wayland half of the desktop annotation overlay (electron/annotation-overlay.ts).
 *
 * An Electron window cannot be positioned or stacked on Wayland, so on a Wayland session the
 * overlay is drawn by a tiny native helper process instead (src-native/wayland_overlay/
 * cl_wayland_overlay.c, built next to the audio addon as build/Release/cl-wayland-overlay):
 *
 *   - compositors with wlr-layer-shell (KDE Plasma's KWin, Sway, Hyprland, other wlroots
 *     desktops, COSMIC): a surface on the OVERLAY layer, anchored to all four edges of ONE
 *     output, empty input region, no keyboard interactivity;
 *   - GNOME's Mutter (no layer-shell): an X11 override-redirect ARGB window with an empty input
 *     shape through XWayland, which Mutter keeps above normal windows, fullscreen included.
 *
 * Both were proven in real headless compositors with screenshots and a real pointer click
 * (harness/wayland-annotation). This module owns the helper's life cycle and everything that
 * crosses into it: it spawns it with a minimal environment, learns the compositor's outputs,
 * picks the one the share shows (annotation-overlay-wayland-protocol.ts matchWaylandOutput —
 * refusing rather than guessing), and forwards ONLY validated stroke geometry. The helper
 * never sees anything from the network and main never trusts anything it prints.
 *
 * Electron-free (spawn, displays, clock and log are injected) so the whole life cycle is unit
 * tested with a fake helper (annotation-overlay-wayland.test.ts).
 */
import {
    parseHelperLine, matchWaylandOutput, WaylandStrokeEncoder,
    type DisplayLite, type FrameSize, type HelperEvent, type ShowHint, type WaylandOutput,
} from './annotation-overlay-wayland-protocol';
import type { OverlayShowResult } from '../src/utils/annotationOverlayTypes';

/** The slice of a child process the controller drives (node's ChildProcess fits). */
export interface HelperProc {
    stdin: { write(chunk: string): boolean; end(): void; readonly writableLength: number; readonly destroyed: boolean };
    stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
    on(event: 'exit' | 'error', cb: () => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
}

export interface WaylandOverlayDeps {
    /** Start the helper, or null when its binary is not there. */
    spawnHelper(): HelperProc | null;
    getDisplays(): DisplayLite[];
    now(): number;
    log(message: string): void;
    /** The helper went away after the overlay was up (compositor closed the surface, crash). */
    onEnded(): void;
    /** Override HELPER_STEP_TIMEOUT_MS (tests). */
    stepTimeoutMs?: number;
}

/** Longest the helper may take to answer (connect + enumerate, or map the surface). */
export const HELPER_STEP_TIMEOUT_MS = 4000;
/** Held back while the surface is being created; more than this is dropped. */
const MAX_QUEUED_LINES = 400;
/** A helper that cannot keep up with its pipe is killed rather than buffered without bound. */
const MAX_PIPE_BACKLOG_BYTES = 1 << 20;
const MAX_STDOUT_LINE = 4096;

export type WaylandBackend = 'layer-shell' | 'xwayland';

export interface WaylandOverlay {
    /** Bring the overlay up over what `source` captures; resolves to a show result. */
    show(source: { id: string; display_id?: string | null }, frame: FrameSize | null, chosenDisplayId?: number | null, hint?: ShowHint): Promise<OverlayShowResult>;
    push(delta: unknown): void;
    hide(): void;
    isShown(): boolean;
    /** Starting or shown: deltas are accepted (held back until the surface is mapped). */
    isActive(): boolean;
}

type Phase = 'idle' | 'starting' | 'shown';

export function createWaylandOverlay(deps: WaylandOverlayDeps): WaylandOverlay {
    let phase: Phase = 'idle';
    let proc: HelperProc | null = null;
    let sessionKey = '';
    let queued: string[] = [];
    let encoder = new WaylandStrokeEncoder(deps.now);
    let generation = 0;
    /** The compositor has no layer-shell AND no usable XWayland: do not respawn for every stroke. */
    let unsupported: 'no_layer_shell' | null = null;

    function teardown(): void {
        generation++;
        const p = proc;
        proc = null;
        phase = 'idle';
        sessionKey = '';
        queued = [];
        encoder.reset();
        if (p) {
            try { if (!p.stdin.destroyed) { p.stdin.write('QUIT\n'); p.stdin.end(); } } catch { /* already gone */ }
            // QUIT ends it; this is only the backstop for a helper stuck on a dead compositor.
            const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 500);
            if (typeof t === 'object' && t && 'unref' in t) (t as { unref(): void }).unref();
        }
    }

    function write(line: string): boolean {
        const p = proc;
        if (!p || p.stdin.destroyed) return false;
        if (p.stdin.writableLength > MAX_PIPE_BACKLOG_BYTES) {
            deps.log('[annot-overlay] wayland helper is not draining its pipe; stopping it');
            const wasShown = phase === 'shown';
            teardown();
            if (wasShown) deps.onEnded();
            return false;
        }
        try { p.stdin.write(line + '\n'); return true; } catch { return false; }
    }

    async function show(source: { id: string; display_id?: string | null }, frame: FrameSize | null, chosenDisplayId?: number | null, hint?: ShowHint): Promise<OverlayShowResult> {
        const key = `${source.id}|${frame ? `${frame.width}x${frame.height}` : '-'}|${chosenDisplayId ?? '-'}|${hint?.stream ? `${hint.stream.x},${hint.stream.y}` : '-'}`;
        if (phase === 'shown' && sessionKey === key) return { ok: true, how: 'wayland', captured: true };
        if (phase !== 'idle') teardown();
        if (unsupported) return { ok: false, reason: unsupported };

        const gen = ++generation;
        const p = deps.spawnHelper();
        if (!p) return { ok: false, reason: 'helper_failed' };
        proc = p;
        phase = 'starting';
        encoder = new WaylandStrokeEncoder(deps.now);

        // Everything the helper prints funnels into one waiter list.
        const outputs: WaylandOutput[] = [];
        let ready = null as { layerShell: boolean; x11: boolean } | null;
        let shownEv = null as Extract<HelperEvent, { kind: 'shown' }> | null;
        let failure = null as string | null;
        let exited = false as boolean;
        let wake: (() => void) | null = null;
        const poke = (): void => { const w = wake; wake = null; w?.(); };

        let buf = '';
        p.stdout.on('data', chunk => {
            if (gen !== generation) return;
            buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const ev = parseHelperLine(line);
                if (!ev) continue;               // anything not exactly well-formed is ignored
                if (ev.kind === 'out') { if (outputs.length < 16) outputs.push(ev.out); }
                else if (ev.kind === 'ready') ready = { layerShell: ev.layerShell, x11: ev.x11 };
                else if (ev.kind === 'shown') shownEv = ev;
                else if (ev.kind === 'err') failure = ev.code;
                else if (ev.kind === 'closed') {
                    if (phase === 'shown') { teardown(); deps.onEnded(); return; }
                    failure = 'closed';
                }
            }
            if (buf.length > MAX_STDOUT_LINE) buf = '';
            poke();
        });
        const gone = (): void => {
            if (gen !== generation) return;
            exited = true;
            if (phase === 'shown') { teardown(); deps.onEnded(); return; }
            poke();
        };
        p.on('exit', gone);
        p.on('error', gone);

        const waitFor = async (done: () => boolean): Promise<boolean> => {
            const deadline = deps.now() + (deps.stepTimeoutMs ?? HELPER_STEP_TIMEOUT_MS);
            while (!done()) {
                if (failure || exited || gen !== generation) return false;
                const left = deadline - deps.now();
                if (left <= 0) return false;
                await new Promise<void>(res => {
                    wake = res;
                    const t = setTimeout(res, Math.min(left, 250));
                    if (typeof t === 'object' && t && 'unref' in t) (t as { unref(): void }).unref();
                });
            }
            return true;
        };
        const fail = (result: OverlayShowResult): OverlayShowResult => {
            if (gen === generation) teardown();
            return result;
        };

        if (!(await waitFor(() => ready !== null))) {
            deps.log(`[annot-overlay] wayland helper did not come up (${failure ?? (exited ? 'exited' : 'timeout')})`);
            return fail({ ok: false, reason: 'helper_failed' });
        }
        const r = ready;
        // layer-shell wherever the compositor has it; XWayland (GNOME) only when it does not.
        const backend: WaylandBackend | null = r?.layerShell ? 'layer-shell' : r?.x11 ? 'xwayland' : null;
        if (!backend) {
            unsupported = 'no_layer_shell';
            deps.log('[annot-overlay] this Wayland compositor has no layer-shell and no XWayland overlay path (GNOME without XWayland?); in-app preview only');
            return fail({ ok: false, reason: 'no_layer_shell' });
        }

        const displays = deps.getDisplays();
        const match = matchWaylandOutput({ displays, outputs, frame, displayId: source.display_id, chosenDisplayId, hint });
        if (!match.ok && match.why === 'ambiguous') {
            deps.log(`[annot-overlay] ${match.candidates.length} identical displays fit this share; asking the sharer which one`);
            return fail({
                ok: false,
                reason: 'needs_choice',
                displays: outputs.length,
                choice: {
                    displays: displays.slice(0, 16).map(d => ({
                        id: d.id, x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, primary: !!d.primary,
                    })),
                    candidates: match.candidates,
                },
            });
        }
        if (!match.ok) {
            deps.log(`[annot-overlay] cannot tell which of ${outputs.length} outputs the share shows (${match.why}); desktop overlay off for this share, in-app preview unaffected`);
            return fail({
                ok: false,
                reason: match.why === 'not_whole_screen' ? 'not_whole_screen' : 'no_display_match',
                displays: outputs.length,
            });
        }
        if (!write(`${backend === 'layer-shell' ? 'SHOW' : 'SHOWX'} ${match.output.index}`)) return fail({ ok: false, reason: 'helper_failed' });
        if (!(await waitFor(() => shownEv !== null))) {
            const why = failure ?? (exited ? 'exited' : 'timeout');
            deps.log(`[annot-overlay] wayland overlay was not mapped (${backend}: ${why})`);
            return fail({ ok: false, reason: why === 'no_x_monitor' ? 'no_display_match' : 'create_failed' });
        }
        if (gen !== generation) return { ok: false, reason: 'create_failed' };
        phase = 'shown';
        sessionKey = key;
        deps.log(`[annot-overlay] wayland overlay up (${backend}, ${match.how}, ${outputs.length} outputs)`);
        for (const line of queued) write(line);
        queued = [];
        return { ok: true, how: `${backend === 'layer-shell' ? 'wl-layer' : 'wl-x11'}-${match.how}`.slice(0, 32), captured: true };
    }

    return {
        show,
        push(delta: unknown): void {
            if (phase === 'idle') return;
            const lines = encoder.encode(delta);
            if (phase === 'starting') {
                for (const l of lines) if (queued.length < MAX_QUEUED_LINES) queued.push(l);
                return;
            }
            for (const l of lines) if (!write(l)) return;
        },
        hide: teardown,
        isShown: () => phase === 'shown',
        isActive: () => phase !== 'idle',
    };
}
