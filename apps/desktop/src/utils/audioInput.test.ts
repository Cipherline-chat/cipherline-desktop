import { describe, it, expect } from 'vitest';
import {
    DEFAULT_AUDIO_INPUT_ID,
    DEFAULT_ECHO_CANCELLATION,
    MIC_CAPTURE_BASE_CONSTRAINTS,
    UNPROCESSED_TRACK_SETTINGS,
    hasRealDeviceInfo,
    micCaptureConstraints,
    pickMicDeviceId,
    resolveEchoCancellation,
    resolveMicDeviceId,
} from './audioInput';

/** Minimal MediaDeviceInfo stand-in — only the fields our helpers read. */
const dev = (deviceId: string, label = `label:${deviceId}`, groupId = `g:${deviceId}`) =>
    ({ deviceId, label, groupId, kind: 'audioinput' } as MediaDeviceInfo);

const REAL_LIST = [dev(DEFAULT_AUDIO_INPUT_ID, 'Default - Headset'), dev('usb-headset'), dev('builtin')];
/** What Chromium hands back before mic permission has been granted. */
const PLACEHOLDER_LIST = [dev('', '')];

describe('resolveMicDeviceId', () => {
    it('maps every "follow the system default" spelling to the default device id', () => {
        // '' is what the settings <select> stores for Default; the other two
        // show up when the setting has never been written.
        expect(resolveMicDeviceId('')).toBe(DEFAULT_AUDIO_INPUT_ID);
        expect(resolveMicDeviceId(null)).toBe(DEFAULT_AUDIO_INPUT_ID);
        expect(resolveMicDeviceId(undefined)).toBe(DEFAULT_AUDIO_INPUT_ID);
    });

    it('never returns undefined, which is NOT equivalent to the default device', () => {
        // Omitting deviceId binds to whatever the default resolved to at capture
        // time; 'default' binds to the virtual device that follows the OS.
        expect(resolveMicDeviceId('')).not.toBeUndefined();
    });

    it('passes an explicit device through untouched', () => {
        expect(resolveMicDeviceId('usb-headset')).toBe('usb-headset');
    });
});

describe('pickMicDeviceId', () => {
    it('honours an explicit device that still exists', () => {
        expect(pickMicDeviceId('usb-headset', REAL_LIST)).toBe('usb-headset');
    });

    it('falls back to the default device when the stored one is gone', () => {
        // The regression this guards: a bare deviceId constraint does not throw
        // for a missing device, so without this we would silently capture from
        // whatever Chromium picked instead.
        expect(pickMicDeviceId('unplugged-mic', REAL_LIST)).toBe(DEFAULT_AUDIO_INPUT_ID);
    });

    it('switches back to the explicit device once it reappears', () => {
        expect(pickMicDeviceId('usb-headset', [dev('builtin')])).toBe(DEFAULT_AUDIO_INPUT_ID);
        expect(pickMicDeviceId('usb-headset', REAL_LIST)).toBe('usb-headset');
    });

    it('treats "follow the default" as the default device', () => {
        expect(pickMicDeviceId('', REAL_LIST)).toBe(DEFAULT_AUDIO_INPUT_ID);
    });

    it('falls back to the default device rather than erroring on an empty list', () => {
        expect(pickMicDeviceId('usb-headset', [])).toBe(DEFAULT_AUDIO_INPUT_ID);
    });
});

describe('hasRealDeviceInfo', () => {
    it('rejects the pre-permission placeholder list', () => {
        // Acting on this list would conclude the user's device vanished and
        // switch them off it for no reason.
        expect(hasRealDeviceInfo(PLACEHOLDER_LIST)).toBe(false);
    });

    it('rejects an empty list', () => {
        expect(hasRealDeviceInfo([])).toBe(false);
    });

    it('accepts a list with real ids and labels', () => {
        expect(hasRealDeviceInfo(REAL_LIST)).toBe(true);
    });

    it('rejects a list with ids but no labels (permission not yet granted)', () => {
        expect(hasRealDeviceInfo([dev('some-id', '')])).toBe(false);
    });
});

describe('MIC_CAPTURE_BASE_CONSTRAINTS', () => {
    it('leaves browser NS and AGC off so they cannot stack with the voice processor', () => {
        // Chromium AGC/NS on top of RNNoise + the gate is what turns a quiet
        // mic into a silent one (two gates in series).
        expect(MIC_CAPTURE_BASE_CONSTRAINTS.noiseSuppression).toBe(false);
        expect(MIC_CAPTURE_BASE_CONSTRAINTS.autoGainControl).toBe(false);
    });

    it('does not decide echoCancellation — that is the user setting', () => {
        expect('echoCancellation' in MIC_CAPTURE_BASE_CONSTRAINTS).toBe(false);
    });

    it('requests 48 kHz as ideal, never exact', () => {
        // An unsatisfiable `exact` fails the whole getUserMedia call instead of
        // degrading, which on a restart path leaves the mic dead.
        expect(MIC_CAPTURE_BASE_CONSTRAINTS.sampleRate).toEqual({ ideal: 48000 });
    });

    it('carries no deviceId — callers own device selection', () => {
        expect('deviceId' in MIC_CAPTURE_BASE_CONSTRAINTS).toBe(false);
    });
});

describe('micCaptureConstraints (echo cancellation)', () => {
    it('defaults to ON', () => {
        expect(DEFAULT_ECHO_CANCELLATION).toBe(true);
        expect(micCaptureConstraints().echoCancellation).toBe(true);
    });

    it('ON asks for the boolean true — the form that cancels HTMLMediaElement AND Web Audio playback', () => {
        // Not 'remote-only' (WebRTC playout only) and not 'all' (absent from the
        // track capabilities on Chromium 153): see the function's comment.
        expect(micCaptureConstraints(true).echoCancellation).toBe(true);
    });

    it('OFF asks for exactly false', () => {
        expect(micCaptureConstraints(false).echoCancellation).toBe(false);
    });

    it('only echoCancellation differs between ON and OFF; NS, AGC and voiceIsolation stay false', () => {
        const on = micCaptureConstraints(true);
        const off = micCaptureConstraints(false);
        const withoutEc = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'echoCancellation'));
        expect(withoutEc(on)).toEqual(withoutEc(off));
        for (const c of [on, off]) {
            expect(c.noiseSuppression).toBe(false);
            expect(c.autoGainControl).toBe(false);
            expect(c.voiceIsolation).toBe(false);
            expect(c.channelCount).toBe(1);
            expect(c.sampleRate).toEqual({ ideal: 48000 });
            expect('deviceId' in c).toBe(false);
        }
    });

    it('returns a fresh object each call (a caller mutating it cannot poison the next open)', () => {
        const a = micCaptureConstraints(true);
        (a as { echoCancellation: boolean }).echoCancellation = false;
        expect(micCaptureConstraints(true).echoCancellation).toBe(true);
    });

    it('negative control: the OFF form really is distinguishable from the ON form', () => {
        expect(micCaptureConstraints(false)).not.toEqual(micCaptureConstraints(true));
    });
});

describe('resolveEchoCancellation', () => {
    it('honours an explicit boolean either way', () => {
        expect(resolveEchoCancellation(true)).toBe(true);
        expect(resolveEchoCancellation(false)).toBe(false);
    });

    it('a missing or non-boolean saved value gets the default (ON), never silently OFF', () => {
        for (const v of [undefined, null, 'false', 0, 1, {}, []]) expect(resolveEchoCancellation(v)).toBe(true);
    });
});

describe('UNPROCESSED_TRACK_SETTINGS', () => {
    it('is all-false (the native screen-share audio track must not announce processing it never had)', () => {
        expect(UNPROCESSED_TRACK_SETTINGS).toEqual({ noiseSuppression: false, echoCancellation: false, autoGainControl: false });
    });
});
