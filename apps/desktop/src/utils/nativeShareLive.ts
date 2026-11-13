/**
 * The live native (hardware) share's own numbers, for the stream-stats overlay. A native share's RTP sender carries a stand-in track,
 * so its getStats() report says "128x72, software" about a stream that is really NVENC at 3440x1440: while a native share is live, the
 * overlay shows the helper's encoder, resolution and encoded frame rate instead (see applyNativeToSenderHud).
 */
import type { SenderHudStats } from './streamStatsHud';

export interface NativeLiveStats { encoder: string; width: number; height: number; fps: number; kbps: number; encMsP95: number }

let provider: (() => NativeLiveStats) | null = null;
export function setNativeShareLive(p: (() => NativeLiveStats) | null): void { provider = p; }
export function getNativeShareLive(): NativeLiveStats | null { try { return provider ? provider() : null; } catch { return null; } }

/** "nvenc" -> "NVENC (native)". Unknown names are shown as given (length-limited upstream). */
export function nativeEncoderLabel(name: string): string {
    return name ? `${name.toUpperCase()} (native)` : 'native';
}

/** Overlay the helper's numbers onto the sender stats of the stand-in track. Pure. With no live native share the stats pass through untouched. */
export function applyNativeToSenderHud(stats: SenderHudStats, live: NativeLiveStats | null): SenderHudStats {
    if (!live) return stats;
    return {
        ...stats,
        encoder: nativeEncoderLabel(live.encoder),
        hardware: true,
        codec: 'video/H264',
        encodedFps: live.fps,
        encodedWidth: live.width,
        encodedHeight: live.height,
        captureWidth: live.width,
        captureHeight: live.height,
        encodeMs: live.encMsP95 > 0 ? live.encMsP95 : undefined,
        sendMbps: live.kbps > 0 ? live.kbps / 1000 : stats.sendMbps,
        layers: undefined,
    };
}

/**
 * Is the sharer's own tile showing a NATIVE share? Its track is the stand-in the encoder's access units ride on (a tiny generated frame), so
 * drawing it shows a garbage picture: the tile draws the helper's own thumbnail instead (nativeSharePreview.ts, NativeSharePreview.tsx).
 * false = not a native share: draw the track as usual.
 */
export function isNativeShareLive(live: NativeLiveStats | null): boolean {
    return live !== null;
}
