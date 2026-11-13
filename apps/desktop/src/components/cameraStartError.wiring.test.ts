import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describeCameraPreviewError } from '../utils/cameraPreview';

const source = readFileSync(join(__dirname, 'SidebarConference.tsx'), 'utf8');
const start = source.indexOf('const toggleCamera = () => {');
const toggleCamera = source.slice(start, source.indexOf('const warmScreenSharePicker', start));

describe('turning the camera on when it cannot start says why', () => {
    it('the scan is looking at the real function', () => {
        expect(start).toBeGreaterThan(-1);
        expect(toggleCamera).toContain('startCamera(asCameraParticipant(localParticipant)');
    });

    it('a failed start shows the error and leaves the enabling state', () => {
        const failure = toggleCamera.slice(toggleCamera.indexOf('.catch(err =>'));
        expect(failure).toContain('setCameraError(describeCameraPreviewError(err))');
        expect(failure).toContain('setIsCameraEnabling(false)');
    });

    it('trying again clears the old error', () => {
        expect(toggleCamera).toContain('setCameraError(null)');
    });

    it('a camera held by another app is described as busy, not as missing or denied', () => {
        const busy = Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' });
        expect(describeCameraPreviewError(busy)).toBe('Camera is busy — close any other app using it');
    });
});
