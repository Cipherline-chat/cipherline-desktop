import { describe, it, expect } from 'vitest';
import { dedupeDevices, partitionMediaDevices, deviceLabel, buildDeviceRowModel } from './useMediaDevices';

/** Minimal MediaDeviceInfo stand-in — only the fields the helpers read, same
 *  pattern as utils/audioInput.test.ts. */
const device = (deviceId: string, label: string, kind: MediaDeviceKind = 'audioinput') =>
    ({ deviceId, label, kind, groupId: 'g' } as MediaDeviceInfo);

describe('dedupeDevices', () => {
    it('drops the synthetic default/communications rows', () => {
        const out = dedupeDevices([
            device('default', 'Default - USB Mic'),
            device('communications', 'Communications - USB Mic'),
            device('abc123', 'USB Mic'),
        ]);
        expect(out.map(d => d.deviceId)).toEqual(['abc123']);
    });

    it('collapses duplicate labels to the first occurrence', () => {
        const out = dedupeDevices([
            device('id1', 'USB Headset'),
            device('id2', 'USB Headset'),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].deviceId).toBe('id1');
    });

    it('falls back to deviceId as the dedupe key when the label is empty', () => {
        // Two distinct empty-label devices must NOT collapse into one —
        // only a genuinely repeated key should.
        const out = dedupeDevices([
            device('id1', ''),
            device('id2', ''),
        ]);
        expect(out).toHaveLength(2);
    });

    it('keeps devices with distinct real labels', () => {
        const out = dedupeDevices([
            device('id1', 'Built-in Microphone'),
            device('id2', 'USB Headset'),
        ]);
        expect(out).toHaveLength(2);
    });

    it('handles an empty list', () => {
        expect(dedupeDevices([])).toEqual([]);
    });
});

describe('partitionMediaDevices', () => {
    it('splits by kind and dedupes each independently', () => {
        const result = partitionMediaDevices([
            device('mic1', 'USB Mic', 'audioinput'),
            device('default', 'Default', 'audioinput'),
            device('spk1', 'USB Speakers', 'audiooutput'),
            device('cam1', 'Webcam', 'videoinput'),
            device('cam2', 'Webcam', 'videoinput'),   // duplicate label
        ]);
        expect(result.inputDevices.map(d => d.deviceId)).toEqual(['mic1']);
        expect(result.outputDevices.map(d => d.deviceId)).toEqual(['spk1']);
        expect(result.videoDevices.map(d => d.deviceId)).toEqual(['cam1']);
    });

    it('rejects the pre-permission placeholder list at the boundary — callers must gate on hasRealDeviceInfo', () => {
        // Confirms the shape this hook hands back (empty id + empty label) is
        // exactly what utils/audioInput.ts's hasRealDeviceInfo is built to
        // detect — this hook does not filter it out itself, so a consumer
        // that skips the hasRealDeviceInfo check would render garbage.
        const result = partitionMediaDevices([
            device('', '', 'audioinput'),
            device('', '', 'audiooutput'),
            device('', '', 'videoinput'),
        ]);
        expect(result.inputDevices).toHaveLength(1);
        expect(result.inputDevices[0].deviceId).toBe('');
        expect(result.inputDevices[0].label).toBe('');
    });

    it('handles an empty list', () => {
        const result = partitionMediaDevices([]);
        expect(result).toEqual({ inputDevices: [], outputDevices: [], videoDevices: [] });
    });
});

describe('deviceLabel', () => {
    it('uses the real label when present', () => {
        expect(deviceLabel(device('abcdefgh1234', 'USB Mic'))).toBe('USB Mic');
    });

    it('falls back to a truncated device id when the label is empty', () => {
        expect(deviceLabel(device('abcdefgh1234', ''))).toBe('Device abcdefgh');
    });
});

describe('buildDeviceRowModel', () => {
    // The regression these cover: ControlBar's camera menu bailed on
    // `videoDevices.length <= 1`, so a user with exactly one webcam — the
    // common case — got no menu and no feedback at all from right-clicking the
    // camera button, which is indistinguishable from the feature being broken.
    // The guard is gone; these pin down that a 1-device list genuinely produces
    // a useful menu, which is the premise that makes removing it correct.
    it('produces a real, selectable menu from a SINGLE device', () => {
        const rows = buildDeviceRowModel([device('cam1', 'Integrated Webcam', 'videoinput')], '', 'Default Camera');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({ id: '', label: 'Default Camera', checked: true });
        expect(rows[1]).toEqual({ id: 'cam1', label: 'Integrated Webcam', checked: false });
    });

    it('marks the single device as checked once it is the explicit pick', () => {
        const rows = buildDeviceRowModel([device('cam1', 'Integrated Webcam', 'videoinput')], 'cam1', 'Default Camera');
        expect(rows.map(r => r.checked)).toEqual([false, true]);
    });

    // Positive control for the two above: the multi-device case was never
    // broken, so if it ever stopped working the single-device assertions would
    // be passing for the wrong reason.
    it('positive control — still builds the multi-device menu it always did', () => {
        const rows = buildDeviceRowModel(
            [device('cam1', 'Integrated Webcam', 'videoinput'), device('cam2', 'USB Camera', 'videoinput')],
            'cam2',
            'Default Camera',
        );
        expect(rows.map(r => r.id)).toEqual(['', 'cam1', 'cam2']);
        expect(rows.map(r => r.checked)).toEqual([false, false, true]);
    });

    it('degrades to the default row alone for the pre-permission placeholder list', () => {
        // One blank entry is what Chromium returns before permission. Showing
        // it as a selectable device would be garbage — but the menu must still
        // exist and still say which option is active.
        const rows = buildDeviceRowModel([device('', '', 'videoinput')], '', 'Default Camera');
        expect(rows).toEqual([{ id: '', label: 'Default Camera', checked: true }]);
    });

    it('degrades to the default row alone when no devices are present', () => {
        expect(buildDeviceRowModel([], '', 'Default Camera')).toEqual([
            { id: '', label: 'Default Camera', checked: true },
        ]);
    });

    it('falls back to a synthetic label for a real device reporting no label', () => {
        const rows = buildDeviceRowModel(
            [device('abcdefgh1234', 'Real Mic'), device('zyxwvuts9876', '')],
            '',
            'Default Microphone',
        );
        expect(rows[2].label).toBe('Device zyxwvuts');
    });
});
