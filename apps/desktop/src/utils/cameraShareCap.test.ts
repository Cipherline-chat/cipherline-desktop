import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cameraShareCapPlan, capEncodings, applyCameraShareCap, CAMERA_CAP_HEIGHT, CAMERA_CAP_FPS } from './cameraShareCap';

const base = { platform: 'linux', shareLive: true, shareSoftware: true, cameraLive: true, cameraSoftware: true as boolean | null, tier: 'auto' as const };

describe('cameraShareCapPlan: when the camera is capped', () => {
    it('Linux, share live, both encoders on the CPU, camera quality left on Auto -> 720p30', () => {
        expect(cameraShareCapPlan(base)).toEqual({ maxHeight: CAMERA_CAP_HEIGHT, maxFps: CAMERA_CAP_FPS });
        expect(CAMERA_CAP_HEIGHT).toBe(720);
        expect(CAMERA_CAP_FPS).toBe(30);
    });
    it('not while no share is live (this is also how it is lifted)', () => {
        expect(cameraShareCapPlan({ ...base, shareLive: false })).toBeNull();
    });
    it('not when either encoder is hardware, or the camera\'s is not known yet (never on a guess)', () => {
        expect(cameraShareCapPlan({ ...base, shareSoftware: false })).toBeNull();
        expect(cameraShareCapPlan({ ...base, cameraSoftware: false })).toBeNull();
        expect(cameraShareCapPlan({ ...base, cameraSoftware: null })).toBeNull();
    });
    it('never over an explicit camera quality: it is the user\'s setting', () => {
        for (const tier of ['1440p', '1080p', '720p', '480p'] as const) expect(cameraShareCapPlan({ ...base, tier })).toBeNull();
    });
    it('Windows, macOS and unknown platforms are unchanged', () => {
        for (const platform of ['windows', 'win32', 'mac', 'darwin', undefined]) expect(cameraShareCapPlan({ ...base, platform })).toBeNull();
    });
    it('no camera, nothing to cap', () => {
        expect(cameraShareCapPlan({ ...base, cameraLive: false })).toBeNull();
    });
});

describe('capEncodings', () => {
    const plan = { maxHeight: 720, maxFps: 30 };
    it('a 1080p simulcast camera: top layer 1.5x down, the lower layers stay smaller than it', () => {
        const out = capEncodings([{ scale: 4, fps: 30 }, { scale: 2, fps: 30 }, { scale: 1, fps: 30 }], 1080, plan);
        expect(out[2].scale).toBeCloseTo(1.5, 3);
        expect(out[1].scale).toBeCloseTo(3, 3);
        expect(out[0].scale).toBeCloseTo(6, 3);
        expect(out.map(e => e.fps)).toEqual([30, 30, 30]);
    });
    it('a 1440p camera: top layer 2x down; the half layer (also 720 before) moves below it', () => {
        const out = capEncodings([{ scale: 2 }, { scale: 1 }], 1440, plan);
        expect(out[1].scale).toBeCloseTo(2, 3);
        expect(out[0].scale).toBeCloseTo(4, 3);
        expect(out[1].fps).toBe(30);
    });
    it('a camera already at or under 720p keeps its size and is only held to 30 fps', () => {
        const out = capEncodings([{ scale: 1, fps: 60 }], 720, plan);
        expect(out[0]).toEqual({ scale: 1, fps: 30 });
        expect(capEncodings([{ scale: 1, fps: 30 }], 480, plan)[0]).toEqual({ scale: 1, fps: 30 });
    });
    it('a single layer with no scale set is the top layer', () => {
        expect(capEncodings([{}], 1080, plan)[0].scale).toBeCloseTo(1.5, 3);
    });
});

function fakeSender(encodings: RTCRtpEncodingParameters[], height: number) {
    let params = { encodings } as RTCRtpSendParameters;
    const setParameters = vi.fn(async (p: RTCRtpSendParameters) => { params = p; });
    return { sender: { getParameters: () => params, setParameters, track: { getSettings: () => ({ height }) } } as unknown as RTCRtpSender, setParameters, enc: () => params.encodings };
}

describe('applyCameraShareCap: cap while sharing, put back after', () => {
    const plan = { maxHeight: 720, maxFps: 30 };
    it('caps the top layer, is idempotent, and restores exactly what was there', async () => {
        const f = fakeSender([{ scaleResolutionDownBy: 4, maxFramerate: 30 }, { scaleResolutionDownBy: 2, maxFramerate: 30 }, { scaleResolutionDownBy: 1, maxFramerate: 30 }], 1080);
        expect(await applyCameraShareCap(f.sender, plan)).toBe('capped');
        expect(f.enc()![2].scaleResolutionDownBy).toBeCloseTo(1.5, 3);
        expect(await applyCameraShareCap(f.sender, plan)).toBe('none'); // nothing more to change
        expect(f.setParameters).toHaveBeenCalledTimes(1);
        expect(await applyCameraShareCap(f.sender, null)).toBe('restored');
        expect(f.enc()!.map(e => e.scaleResolutionDownBy)).toEqual([4, 2, 1]);
        expect(f.enc()!.map(e => e.maxFramerate)).toEqual([30, 30, 30]);
        expect(await applyCameraShareCap(f.sender, null)).toBe('none'); // nothing left to lift
    });
    it('lifting a cap that was never applied touches nothing', async () => {
        const f = fakeSender([{ scaleResolutionDownBy: 1, maxFramerate: 30 }], 1080);
        expect(await applyCameraShareCap(f.sender, null)).toBe('none');
        expect(f.setParameters).not.toHaveBeenCalled();
    });
});

describe('wiring (SidebarConference)', () => {
    const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('applies the plan for the live share and lifts it when the share ends (the effect depends on the share\'s track)', () => {
        expect(src).toMatch(/cameraShareCapPlan\(\{[\s\S]{0,400}tier: getCameraQualityTier\(\),\s*\}\);/);
        expect(src).toMatch(/applyCameraShareCap\(camSender, plan\)/);
        expect(src).toMatch(/\}, \[localParticipant, ssTrackSid, camTrackSid\]\);/);
    });
});
