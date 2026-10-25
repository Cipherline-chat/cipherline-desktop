import { describe, it, expect, vi } from 'vitest';
import {
    cameraPreviewConstraints, describeCameraPreviewError, isCameraGoneError, isConcreteCameraPick,
    openCameraPreview, shouldReopenPreview,
} from './cameraPreview';

const streamOf = (id: string) => ({ id } as unknown as MediaStream);
const domErr = (name: string) => Object.assign(new Error(name), { name });

describe('cameraPreviewConstraints', () => {
    it('requests a concrete pick with { exact } — a bare id is only an ideal that Chromium ignores', () => {
        const c = cameraPreviewConstraints('usb-cam');
        expect(c.deviceId).toEqual({ exact: 'usb-cam' });
        // the positive control: the old shape must not come back
        expect(typeof c.deviceId).not.toBe('string');
    });

    it('sends no deviceId for "follow the system default" ({exact:"default"} is unsatisfiable)', () => {
        expect(cameraPreviewConstraints(null).deviceId).toBeUndefined();
        expect(cameraPreviewConstraints('').deviceId).toBeUndefined();
        expect(cameraPreviewConstraints('default').deviceId).toBeUndefined();
    });

    it('keeps the size an ideal, so a camera that cannot do 720p still opens', () => {
        expect(cameraPreviewConstraints('usb-cam').width).toEqual({ ideal: 1280 });
        expect(cameraPreviewConstraints('usb-cam').height).toEqual({ ideal: 720 });
    });
});

describe('isConcreteCameraPick', () => {
    it('is false for every spelling of "default"', () => {
        for (const v of ['', null, undefined, 'default']) expect(isConcreteCameraPick(v)).toBe(false);
        expect(isConcreteCameraPick('cam-1')).toBe(true);
    });
});

describe('openCameraPreview', () => {
    it('opens the picked camera exactly, and a different pick opens a different request', async () => {
        const gum = vi.fn(async (c: MediaStreamConstraints) => streamOf(JSON.stringify((c.video as MediaTrackConstraints).deviceId)));
        const a = await openCameraPreview('cam-a', gum);
        const b = await openCameraPreview('cam-b', gum);
        expect(gum).toHaveBeenCalledTimes(2);
        expect((a.stream as unknown as { id: string }).id).toBe('{"exact":"cam-a"}');
        expect((b.stream as unknown as { id: string }).id).toBe('{"exact":"cam-b"}');
        expect(a.fellBackFrom).toBeNull();
    });

    it('opens with no deviceId when nothing is picked', async () => {
        const gum = vi.fn(async (_c: MediaStreamConstraints) => streamOf('x'));
        await openCameraPreview('', gum);
        expect((gum.mock.calls[0][0].video as MediaTrackConstraints).deviceId).toBeUndefined();
    });

    it('falls back to the default camera ONCE when the pick is gone, and says which pick was missed', async () => {
        const gum = vi.fn()
            .mockRejectedValueOnce(domErr('OverconstrainedError'))
            .mockResolvedValueOnce(streamOf('default-cam'));
        const r = await openCameraPreview('unplugged', gum);
        expect(r.fellBackFrom).toBe('unplugged');
        expect(gum).toHaveBeenCalledTimes(2);
        expect((gum.mock.calls[1][0].video as MediaTrackConstraints).deviceId).toBeUndefined();
    });

    it('does not mask permission / busy-camera errors with a fallback', async () => {
        for (const name of ['NotAllowedError', 'NotReadableError']) {
            const gum = vi.fn().mockRejectedValue(domErr(name));
            await expect(openCameraPreview('cam', gum)).rejects.toMatchObject({ name });
            expect(gum).toHaveBeenCalledTimes(1);
        }
    });

    it('surfaces the error when even the default camera is missing (no camera at all)', async () => {
        const gum = vi.fn().mockRejectedValue(domErr('NotFoundError'));
        await expect(openCameraPreview('cam', gum)).rejects.toMatchObject({ name: 'NotFoundError' });
        expect(gum).toHaveBeenCalledTimes(2);
    });
});

describe('error wording', () => {
    it('classifies "device not there" errors', () => {
        expect(isCameraGoneError(domErr('OverconstrainedError'))).toBe(true);
        expect(isCameraGoneError(domErr('NotFoundError'))).toBe(true);
        expect(isCameraGoneError(domErr('NotAllowedError'))).toBe(false);
        expect(isCameraGoneError(null)).toBe(false);
    });

    it('has a line per failure and never echoes the raw message', () => {
        expect(describeCameraPreviewError(domErr('NotFoundError'))).toBe('No camera found');
        expect(describeCameraPreviewError(domErr('NotAllowedError'))).toBe('Camera access denied');
        expect(describeCameraPreviewError(domErr('NotReadableError'))).toMatch(/busy/);
        expect(describeCameraPreviewError(new Error('Could not start video source: Logitech C920'))).toBe('Camera unavailable');
    });
});

describe('shouldReopenPreview', () => {
    const list = (...ids: string[]) => ids.map(deviceId => ({ deviceId }));
    const base = { stored: 'cam-a', openedId: 'cam-a', trackLive: true, fellBack: false, available: list('cam-a', 'cam-b') };

    it('leaves a healthy preview alone', () => {
        expect(shouldReopenPreview(base)).toBe(false);
    });
    it('reopens when the running camera disappeared from the list', () => {
        expect(shouldReopenPreview({ ...base, available: list('cam-b') })).toBe(true);
    });
    it('reopens when the track ended', () => {
        expect(shouldReopenPreview({ ...base, trackLive: false })).toBe(true);
    });
    it('reopens onto the pick when it is replugged while the fallback is showing', () => {
        expect(shouldReopenPreview({ stored: 'cam-a', openedId: 'cam-b', trackLive: true, fellBack: true, available: list('cam-a', 'cam-b') })).toBe(true);
    });
    it('does not churn while the fallback is showing and the pick is still absent', () => {
        expect(shouldReopenPreview({ stored: 'cam-a', openedId: 'cam-b', trackLive: true, fellBack: true, available: list('cam-b') })).toBe(false);
    });
    it('ignores a placeholder (blank-id) list unless the track died', () => {
        expect(shouldReopenPreview({ ...base, available: list('') })).toBe(false);
        expect(shouldReopenPreview({ ...base, available: list(''), trackLive: false })).toBe(true);
    });
});
