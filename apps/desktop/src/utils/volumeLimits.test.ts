import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import secureLocalStore from './secureLocalStore';
import { MAX_VOLUME_PERCENT, MAX_PER_USER_VOLUME, clampVolumePercent, clampPerUserVolume } from './volumeLimits';
import {
    DEFAULT_VOICE_SETTINGS, MIC_VOLUME_MAX, SPEAKER_VOLUME_MAX, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings,
} from '../hooks/useVoiceSettings';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

describe('every volume control tops out at 200%', () => {
    it('the ceilings', () => {
        expect(MAX_VOLUME_PERCENT).toBe(200);
        expect(MAX_PER_USER_VOLUME).toBe(2);
        expect(MIC_VOLUME_MAX).toBe(200);
        expect(SPEAKER_VOLUME_MAX).toBe(200);
    });

    it('clampVolumePercent / clampPerUserVolume', () => {
        expect(clampVolumePercent(300)).toBe(200);
        expect(clampVolumePercent(200)).toBe(200);
        expect(clampVolumePercent(150)).toBe(150);
        expect(clampVolumePercent(-5)).toBe(0);
        expect(clampVolumePercent('x')).toBe(100);
        expect(clampVolumePercent(NaN)).toBe(100);
        expect(clampPerUserVolume(4)).toBe(2);
        expect(clampPerUserVolume(2)).toBe(2);
        expect(clampPerUserVolume(0.5)).toBe(0.5);
        expect(clampPerUserVolume(-1)).toBe(0);
        expect(clampPerUserVolume(undefined)).toBe(1);
    });
});

describe('saved values above 200% come down on load', () => {
    beforeEach(() => { secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY); });

    it('mic and output volume saved at 300 load as 200', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, micVolume: 300, speakerVolume: 300 }));
        const s = loadVoiceSettings();
        expect(s.micVolume).toBe(200);
        expect(s.speakerVolume).toBe(200);
    });

    it('values at or under the ceiling are untouched (control)', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, micVolume: 200, speakerVolume: 130 }));
        const s = loadVoiceSettings();
        expect(s.micVolume).toBe(200);
        expect(s.speakerVolume).toBe(130);
    });
});

describe('no control or gain path still allows more than 200%', () => {
    it('settings sliders and the in-call menu use the 200% ceiling', () => {
        const settings = src('components', 'VoiceVideoSettings.tsx');
        expect(settings).toContain('max = MAX_VOLUME_PERCENT');
        expect(settings).toContain('max={SPEAKER_VOLUME_MAX}');
        expect(settings).not.toMatch(/max = 300/);
        const bar = src('components', 'call', 'ControlBar.tsx');
        expect(bar).toContain('max = MAX_VOLUME_PERCENT');
        expect(bar).toMatch(/voice\.setSpeakerVolume,\s*DEFAULT_VOICE_SETTINGS\.speakerVolume,\s*SPEAKER_VOLUME_MAX/);
        expect(bar).not.toMatch(/max = 300/);
    });

    it('per-participant mic and screen-share sliders stop at 2 (200%)', () => {
        const menu = src('components', 'call', 'PopoverMenu.tsx');
        expect(menu.match(/max=\{MAX_PER_USER_VOLUME\}/g)).toHaveLength(2);
        expect(menu).not.toMatch(/max=\{4\}/);
    });

    it('stored per-user / master values and the gain mapping clamp to the ceiling', () => {
        const audio = src('hooks', 'useParticipantAudio.ts');
        expect(audio).toContain('clampPerUserVolume(n)');
        expect(audio).toContain('clampVolumePercent(n)');
        expect(audio).not.toMatch(/Math\.min\(300/);
        expect(src('hooks', 'useVoiceSettings.ts')).not.toMatch(/Math\.min\(300/);
        expect(src('components', 'call', 'VideoTile.tsx')).toContain('clampPerUserVolume(parsed)');
    });
});
