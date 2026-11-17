import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** SidebarConference / CallPane cannot be mounted under vitest: pin the WIRING from the source (decisions are tested in utils/mediaSelfStop.test.ts). */
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
const SC = src('../SidebarConference.tsx');
const CP = src('../CallPane.tsx');
const GUARD = src('./LocalMediaStopGuard.tsx');
const SHOT = src('../../utils/shareFirstFrame.ts');

describe('self-stop wiring', () => {
    it('toggleCamera records the press before anything else, so its own mute is not reported', () => {
        const body = SC.slice(SC.indexOf('const toggleCamera = () => {'));
        expect(body.slice(0, 300)).toContain('noteUserCameraAction()');
    });
    it('both stop paths and the republish teardown mark the share change as deliberate', () => {
        expect(SC.split('noteDeliberateShareChange()').length - 1).toBe(3);
    });
    it('the fresh-republish capture is retried only for an adjustment of a live share', () => {
        expect(SC).toContain('retryDelaysMs: isAdjustment ? CAPTURE_RETRY_DELAYS_MS : []');
        expect(SHOT).toContain('retryTransientCapture(');
    });
    it('CallPane mounts the guard and plays the stop cue when a hold ends with a real stop', () => {
        expect(CP).toContain('<LocalMediaStopGuard />');
        expect(CP).toMatch(/end === 'timeout' \|\| end === 'cancelled' \|\| end === 'stopped'\) cues\.shareHoldClosed\(\)/);
    });
    it('the guard plays the same camera_off cue a press does, and never turns the camera back on', () => {
        expect(GUARD).toContain('playSound(cameraStopCue(), ');
        expect(GUARD).not.toMatch(/setCameraEnabled|restartTrack|\.unmute\(/);
    });
    it('the guard logs no device id or label', () => {
        expect(GUARD).not.toMatch(/deviceId|\.label|getSettings/);
    });
});
