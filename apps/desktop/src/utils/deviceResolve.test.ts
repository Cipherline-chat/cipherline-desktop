import { describe, it, expect } from 'vitest';
import { findStoredDevice, deviceHintOf } from './deviceResolve';
import { micCaptureConstraints, micDeviceConstraint, pickMicDeviceId } from './audioInput';

/**
 * A stored device pick whose id no longer matches anything (Windows re-created
 * the endpoint: driver update, another USB port, a Bluetooth re-pair) is found
 * again by the label + groupId recorded when it was picked, instead of silently
 * falling back to the system default.
 */

const dev = (deviceId: string, label: string, groupId: string, kind: MediaDeviceKind = 'audioinput') =>
    ({ deviceId, label, groupId, kind, toJSON: () => ({}) }) as MediaDeviceInfo;

const LIST = [
    dev('default', 'Default - USB Headset', 'grp-headset'),
    dev('communications', 'Communications - USB Headset', 'grp-headset'),
    dev('id-headset-NEW', 'USB Headset', 'grp-headset'),
    dev('id-webcam', 'Webcam Microphone', 'grp-webcam'),
];

describe('findStoredDevice', () => {
    it('the stored id itself, when listed', () => {
        expect(findStoredDevice('id-webcam', null, LIST)).toMatchObject({ match: 'exact', device: { deviceId: 'id-webcam' } });
    });

    it('a stale id: same groupId AND label → that device', () => {
        expect(findStoredDevice('id-headset-OLD', { label: 'USB Headset', groupId: 'grp-headset' }, LIST))
            .toMatchObject({ match: 'group_label', device: { deviceId: 'id-headset-NEW' } });
    });

    it('a stale id whose groupId also changed: a UNIQUE label is enough', () => {
        expect(findStoredDevice('id-headset-OLD', { label: 'USB Headset', groupId: 'grp-gone' }, LIST))
            .toMatchObject({ match: 'label', device: { deviceId: 'id-headset-NEW' } });
    });

    it('two identical headsets share a label: groupId disambiguates, without it nothing matches', () => {
        const twins = [
            dev('a', 'Microphone (USB Audio Device)', 'grp-1'),
            dev('b', 'Microphone (USB Audio Device)', 'grp-2'),
        ];
        expect(findStoredDevice('old', { label: 'Microphone (USB Audio Device)', groupId: 'grp-2' }, twins).device?.deviceId).toBe('b');
        expect(findStoredDevice('old', { label: 'Microphone (USB Audio Device)' }, twins).device).toBeNull();
    });

    it("never resolves to Chromium's synthetic default/communications rows (they carry the CURRENT default's label)", () => {
        const onlySynthetic = [dev('default', 'USB Headset', 'grp-headset'), dev('communications', 'USB Headset', 'grp-headset')];
        expect(findStoredDevice('id-headset-OLD', { label: 'USB Headset', groupId: 'grp-headset' }, onlySynthetic).device).toBeNull();
    });

    it('no hint / no label → no guessing', () => {
        expect(findStoredDevice('id-headset-OLD', null, LIST).device).toBeNull();
        expect(findStoredDevice('id-headset-OLD', { groupId: 'grp-headset' }, LIST).device).toBeNull();
    });

    it("'' (follow the system default) is never resolved here", () => {
        expect(findStoredDevice('', { label: 'USB Headset' }, LIST)).toEqual({ device: null, match: 'none' });
    });

    it('deviceHintOf keeps only label + groupId', () => {
        expect(deviceHintOf(LIST[2])).toEqual({ label: 'USB Headset', groupId: 'grp-headset' });
        expect(deviceHintOf(null)).toEqual({ label: '', groupId: '' });
    });
});

describe('pickMicDeviceId with the stored hint', () => {
    it('follows a stale id to the same device', () => {
        expect(pickMicDeviceId('id-headset-OLD', LIST, { label: 'USB Headset', groupId: 'grp-headset' })).toBe('id-headset-NEW');
    });

    it('without a hint behaves exactly as before: a missing id → the default', () => {
        expect(pickMicDeviceId('id-headset-OLD', LIST)).toBe('default');
    });
});

describe('micDeviceConstraint — the only shape Chromium honours', () => {
    it('a picked device is asked for with {exact} (a bare or ideal id opens the DEFAULT)', () => {
        expect(micDeviceConstraint('id-webcam')).toEqual({ exact: 'id-webcam' });
    });

    it("the default stays bare ({exact:'default'} is unsatisfiable where there is no 'default' row)", () => {
        expect(micDeviceConstraint('default')).toBe('default');
        expect(micDeviceConstraint('')).toBe('default');
    });
});

describe("micCaptureConstraints overrides livekit-client's voiceIsolation default", () => {
    it('voiceIsolation is off, like the other browser DSP stages — with echo cancellation on or off', () => {
        expect(micCaptureConstraints(true).voiceIsolation).toBe(false);
        expect(micCaptureConstraints(false).voiceIsolation).toBe(false);
    });
});
