import { useSyncExternalStore } from 'react';
import type { H264Profile, HardwareEncoderSupport, ScreenShareCodec, ScreenShareCodecPref } from './screenShare';

/**
 * What the stream-stats overlay knows about the LOCAL screen share beyond
 * getStats(): the decisions made when it was published (codec + why, the
 * hardware-encoder probe) and what the main process reports about the OS side
 * (captured display's refresh rate, which capturer Chromium uses, GPUs).
 *
 * A tiny module-level store rather than React context: it is written once per
 * publish from SidebarConference and read by whichever tile is showing the
 * share, which can be in a different subtree (focused view, grid, popout).
 * Holds no content and nothing sensitive — device-capability facts only.
 */

export type CaptureBackend = 'wgc' | 'dxgi' | 'pipewire' | 'x11' | 'macos' | 'unknown';

/** Narrowed copy of electron/capture-flags.ts + main.ts 'screenshare:get-diagnostics'. */
export interface MainShareDiagnostics {
    platform: string;
    windowsBuild: number | null;
    sourceKind: 'screen' | 'window' | 'unknown';
    /** Refresh rate of the display being captured; null = unknown. */
    displayHz: number | null;
    /** How displayHz was found: the captured display itself, or a guess
     *  (the only display / the primary). null with displayHz null. */
    displayHzSource: 'matched' | 'only-display' | 'primary' | null;
    capturer: { backend: CaptureBackend; why: string };
    capturerPref: 'auto' | 'dxgi' | 'wgc';
    gpus: Array<{ vendor: string; vendorId: number; deviceId: number; name?: string; active: boolean }>;
    /** Chromium GPU feature status for video encode ('enabled', 'disabled_software', …). */
    videoEncode: string | null;
    h264CbpHwEnabled: boolean;
    /** Chromium capture-timing log is being written (Settings → Advanced → Capture timing log). */
    captureLog: boolean;
}

/** Narrowed copy of electron/capture-flags.ts CaptureTiming. */
export interface CaptureTiming {
    samples: number;
    captureMs: number;
    periodMs: number;
    pollFps: number;
    unchangedRatio: number;
    requestedFps?: number;
    maxCpuPercent?: number;
    wgcScreenAllowed?: boolean;
    /** Measured mean time between grabs (Chromium's delta_ms), ms. */
    intervalMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const BACKENDS: readonly CaptureBackend[] = ['wgc', 'dxgi', 'pipewire', 'x11', 'macos', 'unknown'];
const HZ_SOURCES = ['matched', 'only-display', 'primary'] as const;

/** Trust nothing from IPC: take the fields we know, typed, and drop the rest. */
export function parseMainDiagnostics(v: unknown): MainShareDiagnostics | null {
    if (!isObj(v)) return null;
    const cap = isObj(v.capturer) ? v.capturer : {};
    const backend = BACKENDS.includes(cap.backend as CaptureBackend) ? cap.backend as CaptureBackend : 'unknown';
    const kind = v.sourceKind === 'screen' || v.sourceKind === 'window' ? v.sourceKind : 'unknown';
    const pref = v.capturerPref === 'dxgi' || v.capturerPref === 'wgc' ? v.capturerPref : 'auto';
    const gpus = Array.isArray(v.gpus)
        ? v.gpus.filter(isObj).map(g => ({
            vendor: typeof g.vendor === 'string' ? g.vendor.slice(0, 40) : '?',
            vendorId: numOrNull(g.vendorId) ?? 0,
            deviceId: numOrNull(g.deviceId) ?? 0,
            name: typeof g.name === 'string' ? g.name.slice(0, 80) : undefined,
            active: g.active === true,
        }))
        : [];
    const hz = numOrNull(v.displayHz);
    return {
        platform: typeof v.platform === 'string' ? v.platform : 'unknown',
        windowsBuild: numOrNull(v.windowsBuild),
        sourceKind: kind,
        displayHz: hz !== null && hz > 0 ? hz : null,
        displayHzSource: hz !== null && hz > 0 && HZ_SOURCES.includes(v.displayHzSource as never)
            ? v.displayHzSource as MainShareDiagnostics['displayHzSource'] : null,
        capturer: { backend, why: typeof cap.why === 'string' ? cap.why.slice(0, 80) : '' },
        capturerPref: pref,
        gpus,
        videoEncode: typeof v.videoEncode === 'string' ? v.videoEncode : null,
        h264CbpHwEnabled: v.h264CbpHwEnabled === true,
        captureLog: v.captureLog === true,
    };
}

export function parseCaptureTiming(v: unknown): CaptureTiming | null {
    if (!isObj(v)) return null;
    const samples = numOrNull(v.samples);
    const cap = numOrNull(v.captureMs);
    const period = numOrNull(v.periodMs);
    if (samples === null || cap === null || period === null) return null;
    return {
        samples,
        captureMs: cap,
        periodMs: period,
        pollFps: numOrNull(v.pollFps) ?? (period > 0 ? 1000 / period : 0),
        unchangedRatio: numOrNull(v.unchangedRatio) ?? 0,
        requestedFps: numOrNull(v.requestedFps) ?? undefined,
        maxCpuPercent: numOrNull(v.maxCpuPercent) ?? undefined,
        wgcScreenAllowed: typeof v.wgcScreenAllowed === 'boolean' ? v.wgcScreenAllowed : undefined,
        intervalMs: (() => { const n = numOrNull(v.intervalMs); return n !== null && n > 0 ? n : undefined; })(),
    };
}

export interface ScreenShareSession {
    sourceId: string;
    /** The frame rate the user asked to SEND (encoder maxFramerate). */
    requestedFps: number;
    /** The resolution the user picked ('source', '1440p', …) — for the issue
     *  reporter. Absent on sessions written before it existed. */
    resolution?: string;
    /** What the capturer was asked for — above requestedFps on purpose
     *  (captureFrameRateFor). Absent on sessions written before pacing. */
    captureFps?: number;
    codecPref: ScreenShareCodecPref;
    codec: ScreenShareCodec;
    /** For an H.264 share: the profile asked for. */
    h264Profile?: H264Profile;
    codecReason: string;
    hw: HardwareEncoderSupport | null;
    main: MainShareDiagnostics | null;
    /** performance.now() when the share went live — lets the overlay tell a
     *  bandwidth estimate that is still ramping from one that has settled. */
    startedAt?: number;
}

let current: ScreenShareSession | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function setScreenShareSession(s: ScreenShareSession | null): void {
    current = s;
    emit();
}

/** Merge into the session for `sourceId` — ignored if a newer share replaced it. */
export function updateScreenShareSession(sourceId: string, patch: Partial<ScreenShareSession>): void {
    if (!current || current.sourceId !== sourceId) return;
    current = { ...current, ...patch };
    emit();
}

export function getScreenShareSession(): ScreenShareSession | null {
    return current;
}

function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function useScreenShareSession(): ScreenShareSession | null {
    return useSyncExternalStore(subscribe, getScreenShareSession, getScreenShareSession);
}
