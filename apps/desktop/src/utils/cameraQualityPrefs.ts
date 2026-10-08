import { useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';
import {
    parseCameraQualityTier, parseCameraCodecPref,
    type CameraQualityTier, type CameraCodecPref,
} from './cameraQuality';
import { parseIncomingVideoMode, type IncomingVideoMode } from './remoteVideoQuality';

/**
 * Camera quality preferences — device-local, deliberately NOT in backups
 * (backupRegistry.ts): what resolution this PC can encode, and which encoder
 * its GPU has, are statements about THIS machine; restored onto another one
 * they would be wrong in either direction.
 *
 *   - Voice & Video → Camera → "Camera quality": Auto (default — the best
 *     the camera does: up to 1440p with a hardware encoder, 1080p in
 *     software) / 1440p / 1080p / 720p / 480p. "Lower" on the performance
 *     offer writes 720p here, persistently: a PC that could not
 *     keep up once will not keep up next call either, and the setting is
 *     visible and reversible in the same place.
 *   - Voice & Video → "Incoming video quality": Auto / Reduced / Data saver
 *     (remoteVideoQuality.ts IncomingVideoMode). "Lower" on the
 *     performance offer's incoming variant writes Reduced, persistently.
 *   - Settings → Advanced → "Camera encoder": Auto / H.264 / VP8, for A/B
 *     testing against the stream-stats overlay (mirrors the screen-share one).
 *
 * External store so a change in Settings reaches a call that is already live.
 */

const TIER_KEY = 'cipherline_camera_quality';
const CODEC_KEY = 'cipherline_camera_codec';
const INCOMING_KEY = 'cipherline_incoming_video';

const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) { try { l(); } catch { /* isolate */ } } };
export const subscribeCameraQualityPrefs = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function read(key: string): string | null {
    try { return secureLocalStore.getItem(key); } catch { return null; }
}

export function getCameraQualityTier(): CameraQualityTier {
    return parseCameraQualityTier(read(TIER_KEY));
}

export function setCameraQualityTier(tier: CameraQualityTier): void {
    try { secureLocalStore.setItem(TIER_KEY, parseCameraQualityTier(tier)); } catch { /* locked store: in-memory only */ }
    emit();
}

export function getCameraCodecPref(): CameraCodecPref {
    return parseCameraCodecPref(read(CODEC_KEY));
}

export function setCameraCodecPref(pref: CameraCodecPref): void {
    try { secureLocalStore.setItem(CODEC_KEY, parseCameraCodecPref(pref)); } catch { /* locked store */ }
    emit();
}

export function useCameraQualityTier(): CameraQualityTier {
    return useSyncExternalStore(subscribeCameraQualityPrefs, getCameraQualityTier, () => 'auto' as const);
}

export function useCameraCodecPref(): CameraCodecPref {
    return useSyncExternalStore(subscribeCameraQualityPrefs, getCameraCodecPref, () => 'auto' as const);
}

export function getIncomingVideoMode(): IncomingVideoMode {
    return parseIncomingVideoMode(read(INCOMING_KEY));
}

export function setIncomingVideoMode(mode: IncomingVideoMode): void {
    try { secureLocalStore.setItem(INCOMING_KEY, parseIncomingVideoMode(mode)); } catch { /* locked store */ }
    emit();
}

export function useIncomingVideoMode(): IncomingVideoMode {
    return useSyncExternalStore(subscribeCameraQualityPrefs, getIncomingVideoMode, () => 'auto' as const);
}
