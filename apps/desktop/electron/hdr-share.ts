/**
 * HDR screen shares on Windows: decide whether a share needs our own
 * tone-mapped capture (src-native/hdr_capture.cc), and run it - hand every
 * finished frame to the renderer as a VideoFrame through Electron's
 * sharedTexture API (zero copy: a D3D11 texture shared by NT handle).
 *
 * WHY (details in hdr_capture.cc and src/utils/hdrTonemap.ts): with HDR on,
 * both of Chromium's Windows screen capturers (WGC and DXGI Desktop
 * Duplication) receive the desktop as 8-bit BGRA clipped at scRGB 1.0 = 80
 * nits, so a share is blown out and its highlight detail is gone before any
 * frame reaches the page. No Chromium 150 flag changes that. Window shares
 * are not covered (they are WGC whatever we do; see capture-flags.ts).
 *
 * Free of any `electron` import (main.ts injects the real sharedTexture /
 * ipcMain), so the decision and the frame lifecycle are unit tested
 * (hdr-share.test.ts).
 *
 * Security: the capture is a screen capture like any other - main starts it
 * only through capture-consent.ts's authorizeVideo (the same single-use grant
 * the getDisplayMedia path spends), only for a `screen:` source main itself
 * enumerated, and the frames go only to the webContents that asked. The NT
 * handles never leave this process.
 */

/** `CIPHERLINE_HDR_SHARE`: off (default) | auto | force (use our capture even on an SDR display: a pipeline test). */
export type HdrSharePref = 'auto' | 'off' | 'force';

/**
 * OFF unless asked for (2026-10-24). The native tone-mapped capture hands
 * GPU textures to the renderer (sharedTexture → VideoFrame →
 * MediaStreamTrackGenerator) — the only zero-copy native path that can run
 * INSIDE the renderer during a share — and it has not yet been verified on
 * a real HDR PC. Staging.174 had a renderer access violation (0xC0000005)
 * ~25 s into a share; on that SDR machine this path did not run
 * (share_hdr path=chromium reason=sdr_display), so it is not the proven
 * cause, but an unverified native path must not be the default while
 * renderer crashes are open. `CIPHERLINE_HDR_SHARE=auto` turns it on.
 */
export function parseHdrSharePref(v: string | undefined): HdrSharePref {
    const s = (v ?? '').trim().toLowerCase();
    return s === 'auto' || s === 'force' ? s : 'off';
}

/** Optional numeric env override (`CIPHERLINE_HDR_SDR_WHITE`, `CIPHERLINE_HDR_PEAK`, `CIPHERLINE_HDR_KNEE`); 0 = none. */
export function parseNumberEnv(v: string | undefined, min: number, max: number): number {
    const n = Number((v ?? '').trim());
    return v && Number.isFinite(n) && n >= min && n <= max ? n : 0;
}

/** `screen:3:0` -> 3 (the EnumDisplayDevicesW index; webrtc GetScreenList). */
export function screenIndexFromSourceId(id: unknown): number | null {
    if (typeof id !== 'string') return null;
    const m = /^screen:(\d{1,2}):\d+$/.exec(id);
    return m ? Number(m[1]) : null;
}

export interface HdrDisplayInfo {
    index: number;
    hdr: boolean;
    width: number;
    height: number;
    rotation: number;
    sameAdapterAsDefault: boolean;
    sdrWhiteNits: number;
    maxLuminance: number;
    maxFullFrameLuminance: number;
    bitsPerColor: number;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Validate `hdrGetDisplays()` output (an older addon lacks it: []). */
export function parseHdrDisplays(raw: unknown): HdrDisplayInfo[] {
    if (!Array.isArray(raw)) return [];
    const out: HdrDisplayInfo[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        const index = num(o.index, -1);
        if (!Number.isInteger(index) || index < 0 || index > 63) continue;
        out.push({
            index,
            hdr: o.hdr === true,
            width: num(o.width),
            height: num(o.height),
            rotation: num(o.rotation, 1),
            sameAdapterAsDefault: o.sameAdapterAsDefault === true,
            sdrWhiteNits: num(o.sdrWhiteNits),
            maxLuminance: num(o.maxLuminance),
            maxFullFrameLuminance: num(o.maxFullFrameLuminance),
            bitsPerColor: num(o.bitsPerColor),
        });
    }
    return out;
}

export type HdrDecisionReason =
    | 'hdr' | 'forced'
    | 'not_windows' | 'off' | 'no_native' | 'window_source' | 'display_unknown'
    | 'sdr_display' | 'cross_adapter' | 'rotated';

export interface HdrDecision {
    /** Run our tone-mapped capture for this share. */
    use: boolean;
    reason: HdrDecisionReason;
    /** Whether the shared display is in HDR mode (null = could not tell). */
    hdr: boolean | null;
    display: HdrDisplayInfo | null;
}

/**
 * Our capture runs only where it is needed AND can work: a whole-screen share
 * of a display that is in HDR mode right now, driven by the default adapter
 * (Chromium's GPU process opens the textures on its own device), not rotated.
 * Everything else - every SDR display included - stays on Chromium's
 * capturer at zero extra cost.
 */
export function decideHdrShare(o: {
    platform: string;
    pref: HdrSharePref;
    sourceId: unknown;
    nativeAvailable: boolean;
    displays: readonly HdrDisplayInfo[];
}): HdrDecision {
    const no = (reason: HdrDecisionReason, hdr: boolean | null = null, display: HdrDisplayInfo | null = null): HdrDecision =>
        ({ use: false, reason, hdr, display });
    if (o.platform !== 'win32') return no('not_windows');
    const index = screenIndexFromSourceId(o.sourceId);
    if (index === null) return no('window_source');
    const display = o.displays.find(d => d.index === index) ?? null;
    const hdr = display ? display.hdr : null;
    if (o.pref === 'off') return no('off', hdr, display);
    if (!o.nativeAvailable) return no('no_native', hdr, display);
    if (!display) return no('display_unknown');
    if (!display.hdr && o.pref !== 'force') return no('sdr_display', false, display);
    if (!display.sameAdapterAsDefault) return no('cross_adapter', display.hdr, display);
    // DXGI_MODE_ROTATION_UNSPECIFIED (0) / IDENTITY (1) only.
    if (display.rotation !== 0 && display.rotation !== 1) return no('rotated', display.hdr, display);
    return { use: true, reason: display.hdr ? 'hdr' : 'forced', hdr: display.hdr, display };
}

// ── the running capture ─────────────────────────────────────────────────────

export interface HdrNative {
    hdrGetDisplays?(): unknown;
    hdrCaptureStart?(opts: Record<string, number | boolean>, onEvent: (ev: unknown) => void): unknown;
    hdrCaptureRelease?(slot: number, generation: number): void;
    hdrCaptureStop?(): void;
    hdrCaptureStats?(): unknown;
}

/** The slice of Electron's `sharedTexture` (main process) this uses. */
export interface SharedTextureLike {
    importSharedTexture(options: {
        textureInfo: {
            pixelFormat: 'bgra';
            codedSize: { width: number; height: number };
            handle: { ntHandle: Buffer };
            timestamp?: number;
        };
        allReferencesReleased?: () => void;
    }): { release(): void };
    sendSharedTexture(options: { frame: unknown; importedSharedTexture: { release(): void } }, ...args: unknown[]): Promise<void>;
}

export interface HdrStartInfo {
    width: number;
    height: number;
    srcWidth: number;
    srcHeight: number;
    hdr: boolean;
    inputFormat: string;
    sdrWhiteNits: number;
    peakNits: number;
    knee: number;
}

export type HdrStartResult = { ok: true; session: number; info: HdrStartInfo } | { ok: false; error: string };

export interface HdrShareDeps {
    native: HdrNative;
    sharedTexture: SharedTextureLike;
    /** Tell the renderer its capture ended on its own. */
    notifyEnded: (target: unknown, session: number, reason: string) => void;
    log?: (msg: string) => void;
    startTimeoutMs?: number;
}

/** Consecutive failed sends after which the capture is given up (renderer gone / receiver missing). */
export const MAX_SEND_FAILURES = 10;

export function createHdrShareController(deps: HdrShareDeps) {
    const log = deps.log ?? (() => { /* quiet */ });
    let sessionSeq = 0;
    let current: {
        session: number;
        /** The native capture's generation: releases carry it, so a late one cannot free a newer capture's slot. */
        generation: number;
        target: unknown;
        handles: Buffer[];
        info: HdrStartInfo | null;
        t0: number | null;
        sendFailures: number;
        inFlight: number;
        sent: number;
        stopped: boolean;
    } | null = null;

    function stopNative(): void {
        try { deps.native.hdrCaptureStop?.(); } catch { /* already stopped */ }
    }

    function stop(why: string): void {
        if (!current) return;
        const s = current;
        current = null;
        s.stopped = true;
        stopNative();
        log(`[HdrShare] session ${s.session} stopped (${why}) after ${s.sent} frames`);
    }

    function release(slot: number, generation: number): void {
        try { deps.native.hdrCaptureRelease?.(slot, generation); } catch { /* the session is gone */ }
    }

    function onFrame(s: NonNullable<typeof current>, slot: number, timestampUs: number): void {
        const handle = s.handles[slot];
        if (s.stopped || !s.info || !handle) { release(slot, s.generation); return; }
        if (s.t0 === null) s.t0 = timestampUs;
        let imported: { release(): void };
        try {
            imported = deps.sharedTexture.importSharedTexture({
                textureInfo: {
                    pixelFormat: 'bgra',
                    codedSize: { width: s.info.width, height: s.info.height },
                    handle: { ntHandle: handle },
                    timestamp: Math.max(0, Math.round(timestampUs - s.t0)),
                },
                // Every process is done with this texture: the slot may be drawn into again.
                allReferencesReleased: () => release(slot, s.generation),
            });
        } catch (e) {
            release(slot, s.generation);
            if (++s.sendFailures >= MAX_SEND_FAILURES) stop(`import failed: ${(e as Error)?.message ?? e}`);
            return;
        }
        s.inFlight++;
        deps.sharedTexture.sendSharedTexture({ frame: s.target, importedSharedTexture: imported }, s.session, slot)
            .then(() => { s.sendFailures = 0; s.sent++; })
            .catch((e: unknown) => {
                if (++s.sendFailures >= MAX_SEND_FAILURES && current === s) {
                    stop(`send failed: ${(e as Error)?.message ?? e}`);
                    deps.notifyEnded(s.target, s.session, 'send_failed');
                }
            })
            .finally(() => {
                s.inFlight--;
                // Drop main's reference; allReferencesReleased fires once the renderer's is gone too.
                try { imported.release(); } catch { /* already released */ }
            });
    }

    /**
     * Start the capture for `target` (a WebFrameMain). Resolves once the
     * native side has its first duplication and the shared textures exist, or
     * with the reason it could not.
     */
    function start(o: {
        target: unknown;
        index: number;
        width: number;
        height: number;
        maxFps: number;
        force?: boolean;
        sdrWhiteNits?: number;
        peakNits?: number;
        knee?: number;
    }): Promise<HdrStartResult> {
        stop('superseded');
        const native = deps.native;
        if (!native.hdrCaptureStart || !native.hdrCaptureRelease || !native.hdrCaptureStop) {
            return Promise.resolve({ ok: false, error: 'no_native' });
        }
        const session = ++sessionSeq;
        const s: NonNullable<typeof current> = {
            session, generation: -1, target: o.target, handles: [], info: null, t0: null,
            sendFailures: 0, inFlight: 0, sent: 0, stopped: false,
        };
        current = s;
        return new Promise<HdrStartResult>((resolve) => {
            let settled = false;
            const settle = (r: HdrStartResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (!r.ok && current === s) { current = null; s.stopped = true; stopNative(); }
                resolve(r);
            };
            const timer = setTimeout(() => settle({ ok: false, error: 'start_timeout' }), deps.startTimeoutMs ?? 4000);
            const onEvent = (raw: unknown) => {
                const ev = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
                switch (ev.type) {
                    case 'started': {
                        const handles = Array.isArray(ev.handles) ? ev.handles.filter((h): h is Buffer => Buffer.isBuffer(h)) : [];
                        const info: HdrStartInfo = {
                            width: num(ev.width), height: num(ev.height),
                            srcWidth: num(ev.srcWidth), srcHeight: num(ev.srcHeight),
                            hdr: ev.hdr === true,
                            inputFormat: typeof ev.inputFormat === 'string' ? ev.inputFormat : '',
                            sdrWhiteNits: num(ev.sdrWhiteNits), peakNits: num(ev.peakNits), knee: num(ev.knee),
                        };
                        if (s.stopped || handles.length === 0 || info.width < 2 || info.height < 2) {
                            settle({ ok: false, error: 'bad_start' });
                            return;
                        }
                        s.handles = handles;
                        s.info = info;
                        s.generation = num(ev.generation, -1);
                        log(`[HdrShare] session ${session} started: ${info.srcWidth}x${info.srcHeight} ${info.inputFormat}` +
                            ` -> ${info.width}x${info.height}, hdr=${info.hdr} white=${info.sdrWhiteNits} peak=${info.peakNits} knee=${info.knee}`);
                        settle({ ok: true, session, info });
                        return;
                    }
                    case 'frame': {
                        const slot = num(ev.slot, -1);
                        if (!Number.isInteger(slot) || slot < 0) return;
                        if (current !== s) { release(slot, s.generation); return; }
                        onFrame(s, slot, num(ev.timestampUs));
                        return;
                    }
                    case 'params':
                        if (s.info) {
                            s.info = {
                                ...s.info,
                                hdr: ev.hdr === true,
                                inputFormat: typeof ev.inputFormat === 'string' ? ev.inputFormat : s.info.inputFormat,
                                sdrWhiteNits: num(ev.sdrWhiteNits, s.info.sdrWhiteNits),
                                peakNits: num(ev.peakNits, s.info.peakNits),
                            };
                            log(`[HdrShare] session ${session} re-duplicated: hdr=${s.info.hdr} ${s.info.inputFormat} white=${s.info.sdrWhiteNits}`);
                        }
                        return;
                    case 'error':
                        log(`[HdrShare] session ${session} could not start: ${String(ev.error ?? 'error')}`);
                        settle({ ok: false, error: String(ev.error ?? 'error').slice(0, 64) });
                        return;
                    case 'ended': {
                        const reason = String(ev.reason ?? 'ended').slice(0, 64);
                        if (current === s) {
                            stop(reason);
                            deps.notifyEnded(s.target, session, reason);
                        }
                        settle({ ok: false, error: reason });
                        return;
                    }
                }
            };
            let r: unknown;
            try {
                r = native.hdrCaptureStart!({
                    index: o.index,
                    width: o.width,
                    height: o.height,
                    maxFps: o.maxFps,
                    sdrWhiteNits: o.sdrWhiteNits ?? 0,
                    peakNits: o.peakNits ?? 0,
                    knee: o.knee ?? 0,
                    force: o.force === true,
                }, onEvent);
            } catch (e) {
                settle({ ok: false, error: `start threw: ${(e as Error)?.message ?? e}`.slice(0, 64) });
                return;
            }
            const rr = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
            if (rr.ok !== true) settle({ ok: false, error: String(rr.error ?? 'start_failed').slice(0, 64) });
        });
    }

    function stats(): Record<string, unknown> | null {
        if (!current) return null;
        let n: unknown = null;
        try { n = deps.native.hdrCaptureStats?.() ?? null; } catch { n = null; }
        return {
            session: current.session,
            sent: current.sent,
            inFlight: current.inFlight,
            info: current.info,
            native: n && typeof n === 'object' ? n : null,
        };
    }

    return {
        start,
        /** Stop the session if it is `session` (or any, when omitted). */
        stop: (why: string, session?: number) => {
            if (current && (session === undefined || current.session === session)) stop(why);
        },
        /** The webContents that owned the capture is going away. */
        stopForTarget: (target: unknown) => { if (current && current.target === target) stop('target_gone'); },
        stats,
        activeSession: () => current?.session ?? null,
    };
}

export type HdrShareController = ReturnType<typeof createHdrShareController>;
