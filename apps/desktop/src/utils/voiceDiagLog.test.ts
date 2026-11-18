import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    classifyMicBus, micCaptureFacts, logMicCapture, voiceSettingsDetail, VoiceSettingsLogger, VOICE_SETTINGS_SETTLE_MS,
} from './voiceDiagLog';
import { clearCallEvents, getCallEvents, getPinnedCallEvents, validateCallEvent, PINNED_KINDS } from './callEventLog';
import { bindMicTrack, updateSettings, destroyForCall, updateCallbacks, type ProcessorHostTrack } from './voiceProcessorManager';
import type { VoiceSettings } from '../hooks/useVoiceSettings';

/**
 * Report bc9aa8dc (2026-11-18): the report's settings block was read after the call, when the user had already turned
 * AGC off and mic volume to 200 % - every mic_level window of the call said otherwise. `voice_settings` records what was
 * in force during the call; `mic_capture` what the device delivered (a Bluetooth hands-free mic = robot voice).
 */

const BASE: VoiceSettings = {
    noiseSuppression: true, noiseSuppressionMode: 'light', echoCancellation: true, echoCancellationAuto: true, volumeNormalization: true, normalizeIncomingVolume: true, voiceGate: true, voiceGateThreshold: -45,
    pushToTalk: false, pushToTalkKey: null, pushToMuteKey: null, micDeviceId: '', speakerDeviceId: '', cameraDeviceId: '',
    micVolume: 100, speakerVolume: 100, eqEnabled: false, eqBands: [0, 0, 0, 0, 0],
    cameraBrightness: 100, cameraContrast: 100, cameraSaturation: 100,
};

const events = (kind: string) => getCallEvents().filter(e => e.kind === kind);

beforeEach(() => clearCallEvents());

describe('classifyMicBus', () => {
    it.each([
        ['Headset (WH-1000XM4 Hands-Free AG Audio)', 'bluetooth'],
        ['Headset Microphone (AirPods Pro Hands-Free)', 'bluetooth'],
        ['Microphone (Bluetooth Headset)', 'bluetooth'],
        ['Default - Microphone (Realtek(R) Audio)', 'builtin'],
        ['Microphone Array (Intel® Smart Sound Technology for Digital Microphones)', 'builtin'],
        ['MacBook Pro Microphone', 'builtin'],
        ['Microphone (Yeti Stereo Microphone)', 'usb'],
        ['Microphone (USB Audio Device)', 'usb'],
        ['Microphone (HyperX QuadCast)', 'usb'],
        ['Microphone (NVIDIA Broadcast)', 'virtual'],
        ['CABLE Output (VB-Audio Virtual Cable)', 'virtual'],
        ['Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)', 'virtual'],
        ['Microphone (Steam Streaming Microphone)', 'virtual'],
        ['Headset Microphone (Arctis 7 Chat)', 'unknown'],
        ['', 'unknown'],
    ])('%s -> %s', (name, bus) => {
        expect(classifyMicBus(name)).toBe(bus);
    });

    it('null / undefined name -> unknown', () => {
        expect(classifyMicBus(null)).toBe('unknown');
        expect(classifyMicBus(undefined)).toBe('unknown');
    });
});

describe('mic_capture', () => {
    const track = (st: Partial<MediaTrackSettings> & { latency?: number }, label = 'Headset (Buds2 Hands-Free AG Audio)') => ({
        label, getSettings: () => st as MediaTrackSettings,
    });

    it('reads rate, channels, latency (s -> ms), the applied browser flags and the device kind', () => {
        expect(micCaptureFacts(track({ sampleRate: 16000, channelCount: 1, latency: 0.0213, echoCancellation: false, autoGainControl: false, noiseSuppression: false }))).toEqual({
            sampleRate: 16000, channels: 1, latencyMs: 21.3, bus: 'bluetooth', osEc: false, osAgc: false, osNs: false,
        });
    });

    it('missing fields and a throwing getSettings read as unknown, never throw', () => {
        expect(micCaptureFacts(track({}))).toMatchObject({ sampleRate: 0, channels: 0, latencyMs: 0, osEc: null });
        const dead = { label: 'x', getSettings: () => { throw new Error('stopped'); } };
        expect(micCaptureFacts(dead)).toMatchObject({ sampleRate: 0, bus: 'unknown' });
    });

    it('logs a valid, pinned event that carries no part of the device name', () => {
        logMicCapture(track({ sampleRate: 48000, channelCount: 1, latency: 0.01, echoCancellation: true }, 'Microphone (Jane Doe’s AirPods Hands-Free)'));
        const [e] = events('mic_capture');
        expect(e.detail).toEqual({ sample_rate: 48000, channels: 1, lat_ms: 10, bus: 'bluetooth', os_ec: 'on', os_agc: 'na', os_ns: 'na' });
        expect(validateCallEvent(e)).toEqual([]);
        expect(JSON.stringify(e)).not.toMatch(/jane|doe|airpods|hands/i);
        expect(PINNED_KINDS.has('mic_capture')).toBe(true);
        expect(getPinnedCallEvents().some(p => p.kind === 'mic_capture')).toBe(true);
    });

    it('null track logs nothing', () => {
        logMicCapture(null);
        expect(events('mic_capture')).toEqual([]);
    });

    it('SidebarConference logs it for the call mic and again after a capture restart', () => {
        const src = readFileSync(join(__dirname, '..', 'components', 'SidebarConference.tsx'), 'utf8');
        const block = src.slice(src.indexOf('micTrack.on(TrackEvent.Restarted, onRestarted)') - 4000, src.indexOf('micTrack.on(TrackEvent.Restarted, onRestarted)'));
        expect(block.match(/logMicCapture\(readCaptureTrack\(micTrack/g)?.length).toBe(2);
    });
});

describe('voice_settings', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('maps the settings to enums / numbers', () => {
        expect(voiceSettingsDetail(BASE)).toEqual({ ns: 'light', gate: true, thrDb: -45, agc: true, ec: true, ecAuto: true, micPct: 100, eq: false, ptt: false });
        expect(voiceSettingsDetail({ ...BASE, noiseSuppression: false }).ns).toBe('off');
        expect(voiceSettingsDetail({ ...BASE, noiseSuppressionMode: 'strong' }).ns).toBe('strong');
    });

    it('join logs at once; a slider drag settles into ONE change entry with the final value', () => {
        vi.useFakeTimers();
        const log = new VoiceSettingsLogger();
        log.join(BASE);
        expect(events('voice_settings').map(e => e.detail)).toEqual([
            { reason: 'join', ns: 'light', gate: true, thr_db: -45, agc: true, aec_on: true, ec_auto: true, mic_pct: 100, eq: false, ptt: false },
        ]);
        for (const v of [110, 130, 160, 190, 200]) { log.change({ ...BASE, micVolume: v }); vi.advanceTimersByTime(200); }
        expect(events('voice_settings')).toHaveLength(1);
        vi.advanceTimersByTime(VOICE_SETTINGS_SETTLE_MS);
        const all = events('voice_settings');
        expect(all).toHaveLength(2);
        expect(all[1].detail).toMatchObject({ reason: 'change', mic_pct: 200 });
        for (const e of all) expect(validateCallEvent(e)).toEqual([]);
    });

    it('an unrelated settings write (same voice settings) and a change reverted before it settles log nothing', () => {
        vi.useFakeTimers();
        const log = new VoiceSettingsLogger();
        log.join(BASE);
        log.change({ ...BASE, speakerVolume: 50 });
        log.change({ ...BASE, volumeNormalization: false });
        log.change(BASE);
        vi.advanceTimersByTime(VOICE_SETTINGS_SETTLE_MS * 2);
        expect(events('voice_settings')).toHaveLength(1);
    });

    it('no change entries outside a call (before join, after reset); reset drops a pending change', () => {
        vi.useFakeTimers();
        const log = new VoiceSettingsLogger();
        log.change({ ...BASE, voiceGate: false });
        vi.advanceTimersByTime(VOICE_SETTINGS_SETTLE_MS * 2);
        expect(events('voice_settings')).toHaveLength(0);
        log.join(BASE);
        log.change({ ...BASE, voiceGate: false });
        log.reset();
        vi.advanceTimersByTime(VOICE_SETTINGS_SETTLE_MS * 2);
        expect(events('voice_settings')).toHaveLength(1);
    });
});

describe('voice_settings wiring (voiceProcessorManager)', () => {
    class FakeMicTrack implements ProcessorHostTrack {
        processor: unknown = undefined;
        audioContext: unknown = {};
        getProcessor() { return this.processor; }
        async setProcessor(p: unknown) { this.processor = p; }
        async stopProcessor() { this.processor = undefined; }
        setAudioContext(c: unknown) { this.audioContext = c; }
    }
    afterEach(async () => { vi.useRealTimers(); await destroyForCall('call-1'); updateCallbacks({}); });

    it('the call-time settings survive later changes: join entry, then the change - the report bc9aa8dc case', async () => {
        vi.useFakeTimers();
        const AT_CALL: VoiceSettings = { ...BASE, noiseSuppressionMode: 'strong', echoCancellation: true, volumeNormalization: true, micVolume: 100 };
        // every processing stage off, so no processor (no WebAudio) is attached: the logger does not depend on attach
        await bindMicTrack('call-1', new FakeMicTrack(), { ...AT_CALL, noiseSuppression: false, voiceGate: false, volumeNormalization: false });
        expect(events('voice_settings').map(e => e.detail?.reason)).toEqual(['join']);
        updateSettings({ ...AT_CALL, noiseSuppression: false, voiceGate: false, volumeNormalization: false, micVolume: 200, echoCancellation: false });
        vi.advanceTimersByTime(VOICE_SETTINGS_SETTLE_MS + 10);
        const ev = events('voice_settings');
        expect(ev.map(e => e.detail?.reason)).toEqual(['join', 'change']);
        expect(ev[0].detail).toMatchObject({ mic_pct: 100, aec_on: true });
        expect(ev[1].detail).toMatchObject({ mic_pct: 200, aec_on: false });
        // after the call no more entries
        await destroyForCall('call-1');
        updateSettings({ ...AT_CALL, micVolume: 50 });
        vi.advanceTimersByTime(VOICE_SETTINGS_SETTLE_MS + 10);
        expect(events('voice_settings')).toHaveLength(2);
    });

    it('CONTROL: without the manager wiring a settings change would never reach the log', () => {
        const src = readFileSync(join(__dirname, 'voiceProcessorManager.ts'), 'utf8');
        expect(src).toMatch(/export function updateSettings[\s\S]{0,200}voiceSettingsLog\.change\(settings\)/);
        expect(src).toMatch(/bound = \{ callId, track, run \};\s*voiceSettingsLog\.join\(settings\)/);
    });
});
