/**
 * The screen-share picker's three named presets (Low / Default / High), kept
 * apart from the picker component so other code (the encoder-overload notice,
 * shareEncoderOverload.ts) names a setting the way the picker does.
 */
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

export type PresetKey = 'low' | 'default' | 'high';

export const PRESETS: Record<PresetKey, { resolution: ScreenShareOptions['resolution']; frameRate: ScreenShareOptions['frameRate']; label: string; desc: string }> = {
    low:     { resolution: '720p',  frameRate: 30, label: 'Low',     desc: '720p · 30fps'  },
    default: { resolution: '1080p', frameRate: 30, label: 'Default', desc: '1080p · 30fps' },
    high:    { resolution: '1080p', frameRate: 60, label: 'High',    desc: '1080p · 60fps' },
};

export function detectPreset(
    resolution: ScreenShareOptions['resolution'],
    frameRate: ScreenShareOptions['frameRate'],
): PresetKey | null {
    for (const [key, p] of Object.entries(PRESETS)) {
        if (p.resolution === resolution && p.frameRate === frameRate) return key as PresetKey;
    }
    return null;
}

/** "High" for 1080p/60, null when the setting is not one of the presets. */
export function presetNameFor(
    resolution: ScreenShareOptions['resolution'],
    frameRate: ScreenShareOptions['frameRate'],
): string | null {
    const k = detectPreset(resolution, frameRate);
    return k ? PRESETS[k].label : null;
}
