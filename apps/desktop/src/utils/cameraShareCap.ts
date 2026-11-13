/**
 * Software camera + software screen share on Linux: cap the camera's top layer while the share is live.
 *
 * Owner reports 2026-11-05 (CachyOS, Ryzen 5 5600X, RTX 5070 - no hardware encode on Linux): the sharer's camera
 * (VP8 1080p, software) ran at 15 fps with 13-15 freezes while the share encoded in software too. Both encoders
 * are libvpx on the same six cores; the share is the one the viewers came for. So while a share is live and BOTH are
 * on the CPU, the camera's TOP layer is held to 720p30 (a 1080p camera encodes ~44 % of the pixels, the lower layers
 * move down with it), and the moment the share ends the layer goes back to what it was.
 *
 * It is a sender parameter (scaleResolutionDownBy / maxFramerate), not a capture change: no re-open, no republish, no
 * freeze of its own. It is never applied to a person who chose a camera quality in Settings (anything but 'auto'): an
 * explicit setting is theirs. Linux only: Windows and macOS have hardware encoders or a different budget and are
 * unchanged.
 */
import type { CameraQualityTier } from './cameraQuality';

export const CAMERA_CAP_HEIGHT = 720;
export const CAMERA_CAP_FPS = 30;

export interface CameraCapPlan { maxHeight: number; maxFps: number }

export function cameraShareCapPlan(i: {
    platform: string | undefined;
    shareLive: boolean;
    /** The share's encoder is a CPU one. */
    shareSoftware: boolean;
    cameraLive: boolean;
    /** true = the camera's encoder is a CPU one; null = not known yet (never capped on a guess). */
    cameraSoftware: boolean | null;
    tier: CameraQualityTier;
}): CameraCapPlan | null {
    if (i.platform !== 'linux') return null;
    if (!i.shareLive || !i.cameraLive) return null;
    if (!i.shareSoftware || i.cameraSoftware !== true) return null;
    if (i.tier !== 'auto') return null;
    return { maxHeight: CAMERA_CAP_HEIGHT, maxFps: CAMERA_CAP_FPS };
}

export interface EncodingKnobs { scale?: number; fps?: number }

/**
 * The encodings with the top layer held to `plan`. The top layer is the one with the smallest scale; layers below it
 * keep their order and stay strictly smaller than it (they move down by the same factor when they would otherwise
 * collapse onto it). A camera already within the plan comes back unchanged.
 */
export function capEncodings(encs: readonly EncodingKnobs[], captureHeight: number, plan: CameraCapPlan): EncodingKnobs[] {
    if (!(captureHeight > 0) || encs.length === 0) return encs.map(e => ({ ...e }));
    const order = encs.map((e, i) => ({ i, scale: e.scale ?? 1 })).sort((a, b) => a.scale - b.scale);
    const topScale = order[0].scale;
    const capScale = Math.max(topScale, Math.round((captureHeight / plan.maxHeight) * 1000) / 1000);
    const out = encs.map(e => ({ ...e }));
    order.forEach((o, rank) => {
        const e = out[o.i];
        // rank 0 = the top layer; the rest keep at least the ratio they had to it (2x, 4x ...).
        const wanted = rank === 0 ? capScale : Math.max(o.scale, Math.round(capScale * (o.scale / topScale) * 1000) / 1000);
        e.scale = wanted;
        if (rank === 0) e.fps = Math.min(e.fps ?? plan.maxFps, plan.maxFps);
    });
    return out;
}

const saved = new WeakMap<object, EncodingKnobs[]>();

/**
 * Apply (plan) or lift (null) the cap on a camera sender. Remembers what the encodings were the first time it caps,
 * and puts exactly that back when lifted. Returns what it did.
 */
export async function applyCameraShareCap(sender: RTCRtpSender, plan: CameraCapPlan | null): Promise<'capped' | 'restored' | 'none'> {
    const params = sender.getParameters();
    const encs = params.encodings ?? [];
    if (encs.length === 0) return 'none';
    if (plan) {
        const h = sender.track?.getSettings?.().height ?? 0;
        if (!saved.has(sender)) saved.set(sender, encs.map(e => ({ scale: e.scaleResolutionDownBy, fps: e.maxFramerate })));
        const next = capEncodings(saved.get(sender)!, h, plan);
        let changed = false;
        encs.forEach((e, i) => {
            if (next[i].scale !== undefined && e.scaleResolutionDownBy !== next[i].scale) { e.scaleResolutionDownBy = next[i].scale; changed = true; }
            if (next[i].fps !== undefined && e.maxFramerate !== next[i].fps) { e.maxFramerate = next[i].fps; changed = true; }
        });
        if (!changed) return 'none';
        await sender.setParameters(params);
        return 'capped';
    }
    const before = saved.get(sender);
    if (!before) return 'none';
    saved.delete(sender);
    encs.forEach((e, i) => {
        const b = before[i];
        if (!b) return;
        if (b.scale === undefined) delete (e as { scaleResolutionDownBy?: number }).scaleResolutionDownBy; else e.scaleResolutionDownBy = b.scale;
        if (b.fps === undefined) delete (e as { maxFramerate?: number }).maxFramerate; else e.maxFramerate = b.fps;
    });
    await sender.setParameters(params);
    return 'restored';
}
