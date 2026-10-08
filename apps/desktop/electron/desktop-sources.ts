/**
 * One gate in front of `desktopCapturer.getSources()` for the whole main
 * process: calls run ONE AT A TIME, an identical request that is already
 * waiting or running is shared instead of repeated, and every call's cost is
 * reported (the Performance log / diagnostics report).
 *
 * ── Why this exists (owner's freeze, 1.0.18-staging.146, 2026-10-07) ──────
 *
 * A diagnostics report from a Windows 11 PC (RTX 2080 Ti + a second GPU, three
 * high-refresh monitors) showed the MAIN process blocked for 19.3 s and then
 * 16.6 s with `ipc:desktop-capturer-get-sources` in flight, while the whole
 * machine froze and the screens went black. Electron 43.2.0's
 * shell/browser/api/electron_api_desktop_capturer.cc does real DXGI work on
 * the browser UI thread (= this process's main thread) on Windows, inside
 * every getSources() call:
 *
 *   - StartHandling(): `if (CreateDesktopCaptureOptions().allow_directx_capturer())
 *       { auto duplicator = DxgiDuplicatorController::Instance();
 *         using_directx_capturer_ = ScreenCapturerWinDirectx::IsSupported(); }`
 *     IsSupported() takes the controller's mutex and, when no capture holds
 *     it, runs DoInitialize(): D3D11CreateDevice on EVERY adapter and
 *     IDXGIOutput1::DuplicateOutput on EVERY monitor. `duplicator` is the only
 *     reference, so at the end of that block the refcount drops to zero and
 *     Unload() releases all of it again. Every call — window-only and
 *     thumbnail-less ones included — duplicates and un-duplicates every
 *     display, synchronously, on the main thread.
 *   - CollectSourcesFrom() for screens: DxgiDuplicatorController::
 *     GetDeviceNames(), the same mutex, which the thumbnail capture thread
 *     holds while EnsureFrameCaptured() polls for a fresh frame (up to 500 ms
 *     per attempt, webrtc dxgi_duplicator_controller.cc).
 *
 * `allow_directx_capturer` is true on every Windows build unless the
 * `DirectXCapturer` feature is disabled (content/public/browser/
 * desktop_capture.cc, Chromium 150.0.7871.129). Since 2026-10-08 the rule is
 * stronger: whenever DXGI IS enabled in the main process (so a share can run
 * at 90+ fps), main does not call getSources() at all — the getSources this
 * gate fronts is the out-of-process helper (./sources-helper-client.ts, DXGI
 * disabled in that process); see pickerEnumeration in ./capture-flags.ts.
 * This gate is the second half: whatever capturer is configured, the picker's names pass, its
 * previews pass, a tab switch, the resolve fallback, the annotation overlay
 * and the HUD diagnostics can no longer stack getSources() calls on top of
 * each other (each one is its own capturer, its own capture thread and, with
 * DXGI, its own full display re-initialisation).
 *
 * Deliberately free of any `electron` import (unit tested with fakes in
 * desktop-sources.test.ts); main.ts supplies the real getSources.
 */

export type DesktopSourceType = 'window' | 'screen';

export interface DesktopSourcesRequest {
    types: readonly DesktopSourceType[];
    /** 0x0 = no thumbnails (Electron then skips the per-source capture). */
    thumbnailSize: { width: number; height: number };
}

export interface DesktopSourcesTiming {
    /** Stable label: `screen+window thumbs=360x360`. */
    key: string;
    /** Time spent waiting for an earlier call to finish. */
    queuedMs: number;
    /** Time getSources() itself took. */
    runMs: number;
    /** Sources returned (0 on failure). */
    count: number;
    ok: boolean;
    /** How many callers shared this one call (1 = nobody joined). */
    sharers: number;
}

export interface DesktopSourcesBroker<S> {
    /** Run (or join) a getSources call. Rejects exactly when getSources does. */
    request(req: DesktopSourcesRequest): Promise<S[]>;
    /** Calls waiting or running right now (for tests and the log). */
    pending(): number;
}

/** Canonical key: type order and duplicates never make two "different" calls. */
export function desktopSourcesKey(req: DesktopSourcesRequest): string {
    const types = [...new Set(req.types)].sort().join('+') || 'none';
    const w = Math.max(0, Math.floor(req.thumbnailSize.width));
    const h = Math.max(0, Math.floor(req.thumbnailSize.height));
    return `${types} thumbs=${w}x${h}`;
}

export function createDesktopSourcesBroker<S>(opts: {
    getSources: (req: { types: DesktopSourceType[]; thumbnailSize: { width: number; height: number } }) => Promise<S[]>;
    now?: () => number;
    onTiming?: (t: DesktopSourcesTiming) => void;
}): DesktopSourcesBroker<S> {
    const now = opts.now ?? (() => Date.now());
    // The tail of the serial chain: the next call starts after this settles.
    let tail: Promise<unknown> = Promise.resolve();
    // Identical requests that are waiting or running share one promise.
    const shared = new Map<string, { promise: Promise<S[]>; sharers: number }>();
    let inFlight = 0;

    const request = (req: DesktopSourcesRequest): Promise<S[]> => {
        const key = desktopSourcesKey(req);
        const existing = shared.get(key);
        if (existing) {
            existing.sharers++;
            return existing.promise;
        }
        const types = [...new Set(req.types)] as DesktopSourceType[];
        const thumbnailSize = {
            width: Math.max(0, Math.floor(req.thumbnailSize.width)),
            height: Math.max(0, Math.floor(req.thumbnailSize.height)),
        };
        const queuedAt = now();
        inFlight++;
        const entry = { promise: null as unknown as Promise<S[]>, sharers: 1 };
        const run = async (): Promise<S[]> => {
            const startedAt = now();
            let ok = false;
            let count = 0;
            try {
                const out = await opts.getSources({ types, thumbnailSize });
                ok = true;
                count = out.length;
                return out;
            } finally {
                // Settled: a request from now on is a NEW call (fresh list).
                if (shared.get(key) === entry) shared.delete(key);
                inFlight--;
                try {
                    opts.onTiming?.({ key, queuedMs: startedAt - queuedAt, runMs: now() - startedAt, count, ok, sharers: entry.sharers });
                } catch { /* a logging failure never fails the call */ }
            }
        };
        entry.promise = tail.then(run, run);
        // The chain must survive a rejection, or one failure would wedge
        // every later call.
        tail = entry.promise.catch(() => undefined);
        shared.set(key, entry);
        return entry.promise;
    };

    return { request, pending: () => inFlight };
}
