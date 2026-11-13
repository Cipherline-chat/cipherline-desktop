import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_VOICE_SETTINGS } from '../hooks/useVoiceSettings';
import { LIVE_PROCESSOR_SETTING_KEYS, liveProcessorSettingsKey } from './voiceChain';

const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

describe('mic-chain settings apply live (owner 2026-11-13: Light <-> Strong needed a rejoin)', () => {
    it('every setting CipherlineVoiceProcessor.updateSettings() compares is in the live key', () => {
        const vp = src('./voiceProcessor.ts');
        const body = vp.slice(vp.indexOf('    updateSettings(settings: VoiceSettings) {'), vp.indexOf('// ── Level metering'));
        const read = new Set([...body.matchAll(/prev\.(\w+)\s*!==\s*settings\.\w+/g)].map(m => m[1]));
        read.add('eqBands'); // compared per band
        expect(read.size).toBeGreaterThan(6);
        for (const k of read) expect(LIVE_PROCESSOR_SETTING_KEYS as readonly string[], k).toContain(k);
    });
    it('POSITIVE CONTROL: the key changes for Strong<->Light, the gate Automatic flag, and a field left out of it would not', () => {
        const base = DEFAULT_VOICE_SETTINGS;
        const k0 = liveProcessorSettingsKey(base);
        expect(liveProcessorSettingsKey({ ...base, noiseSuppressionMode: 'strong' })).not.toBe(k0);
        expect(liveProcessorSettingsKey({ ...base, voiceGateAuto: !base.voiceGateAuto })).not.toBe(k0);
        expect(liveProcessorSettingsKey({ ...base, eqBands: [1, 0, 0, 0, 0] })).not.toBe(k0);
        // a setting the processor does not read must not retrigger it
        expect(liveProcessorSettingsKey({ ...base, speakerVolume: 150 } as typeof base)).toBe(k0);
    });
    it('the call pushes settings on that key (the old hand-written dependency list left the mode out)', () => {
        const sc = src('../components/SidebarConference.tsx');
        expect(sc).toContain('liveProcessorSettingsKey(voice.settings)');
        const i = sc.indexOf('voiceProcessorManager.updateSettings(voice.settings)');
        expect(sc.slice(i, i + 400)).toContain('[liveProcessorKey]');
        expect(sc.slice(i, i + 400)).not.toMatch(/voice\?\.settings\.noiseSuppression,/);
    });
    it('echo cancellation is already live (re-opens capture on change, SidebarConference setRoomEchoCancellation)', () => {
        expect(src('../components/SidebarConference.tsx')).toMatch(/setRoomEchoCancellation\(room, echoCancellation\)/);
    });
});
