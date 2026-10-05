import { describe, it, expect } from 'vitest';
import { DEFAULT_CAMERA_ID, resolveCameraDeviceId, pickCameraDeviceId } from './cameraInput';

const dev = (deviceId: string, label = `label:${deviceId}`, groupId = `g:${deviceId}`) =>
    ({ deviceId, label, groupId, kind: 'videoinput' } as MediaDeviceInfo);

const DEVICES = [dev(DEFAULT_CAMERA_ID, 'Default - Webcam'), dev('usb-cam'), dev('builtin-cam')];

describe('resolveCameraDeviceId', () => {
    it('maps every "follow the system default" spelling to the default device id', () => {
        expect(resolveCameraDeviceId('')).toBe(DEFAULT_CAMERA_ID);
        expect(resolveCameraDeviceId(null)).toBe(DEFAULT_CAMERA_ID);
        expect(resolveCameraDeviceId(undefined)).toBe(DEFAULT_CAMERA_ID);
    });

    it('passes through an explicit device id unchanged', () => {
        expect(resolveCameraDeviceId('usb-cam')).toBe('usb-cam');
    });
});

describe('pickCameraDeviceId', () => {
    it('keeps the stored device when it still exists', () => {
        expect(pickCameraDeviceId('usb-cam', DEVICES)).toBe('usb-cam');
    });

    it('falls back to the default when the stored device is gone (unplugged)', () => {
        expect(pickCameraDeviceId('now-unplugged-cam', DEVICES)).toBe(DEFAULT_CAMERA_ID);
    });

    it('falls back to the default when nothing is stored', () => {
        expect(pickCameraDeviceId('', DEVICES)).toBe(DEFAULT_CAMERA_ID);
        expect(pickCameraDeviceId(null, DEVICES)).toBe(DEFAULT_CAMERA_ID);
        expect(pickCameraDeviceId(undefined, DEVICES)).toBe(DEFAULT_CAMERA_ID);
    });
});
