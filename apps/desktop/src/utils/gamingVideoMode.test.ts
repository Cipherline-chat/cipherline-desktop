import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    applyCameraDegradation, loadGamingVideoMode, setGamingVideoMode, getGamingVideoSnapshot, subscribeGamingVideo,
    __resetGamingVideoModeForTests, GAMING_CAMERA_DEGRADATION, gamingVideoDescription, gamingVideoRestartCopy,
    type DegradableCameraTrack,
} from './gamingVideoMode';

/** Mirrors LiveKit's LocalVideoTrack: the preference lives in a (typed-private) field. */
function fakeCamera(initial?: RTCDegradationPreference) {
    const t = {
        degradationPreference: initial as RTCDegradationPreference | undefined,
        calls: [] as RTCDegradationPreference[],
        setDegradationPreference(p: RTCDegradationPreference) { this.calls.push(p); this.degradationPreference = p; return Promise.resolve(); },
    };
    return t as typeof t & DegradableCameraTrack;
}

describe('applyCameraDegradation', () => {
    it('on → maintain-framerate; off → back to exactly what LiveKit had', () => {
        const cam = fakeCamera('balanced');
        applyCameraDegradation(cam, true);
        expect(cam.degradationPreference).toBe(GAMING_CAMERA_DEGRADATION);
        expect(GAMING_CAMERA_DEGRADATION).toBe('maintain-framerate');
        applyCameraDegradation(cam, false);
        expect(cam.degradationPreference).toBe('balanced');
        expect(cam.calls).toEqual(['maintain-framerate', 'balanced']);
    });

    it('restores a non-default original too (e.g. a 1080p camera on maintain-resolution)', () => {
        const cam = fakeCamera('maintain-resolution');
        applyCameraDegradation(cam, true);
        applyCameraDegradation(cam, false);
        expect(cam.degradationPreference).toBe('maintain-resolution');
    });

    it('is idempotent both ways and never touches a track it did not change', () => {
        const cam = fakeCamera('balanced');
        applyCameraDegradation(cam, true);
        applyCameraDegradation(cam, true);
        expect(cam.calls).toEqual(['maintain-framerate']);
        applyCameraDegradation(cam, false);
        applyCameraDegradation(cam, false);
        expect(cam.calls).toEqual(['maintain-framerate', 'balanced']);
        const untouched = fakeCamera('balanced');
        applyCameraDegradation(untouched, false);
        expect(untouched.calls).toEqual([]);
    });

    it('an unpublished track (no recorded preference) restores to LiveKit\'s camera default, balanced', () => {
        const cam = fakeCamera(undefined);
        applyCameraDegradation(cam, true);
        applyCameraDegradation(cam, false);
        expect(cam.calls).toEqual(['maintain-framerate', 'balanced']);
    });

    it('swallows a rejecting / throwing setter (LiveKit logs its own failures)', async () => {
        const rejecting: DegradableCameraTrack = { setDegradationPreference: () => Promise.reject(new Error('InvalidModificationError')) };
        const throwing: DegradableCameraTrack = { setDegradationPreference: () => { throw new Error('gone'); } };
        expect(() => applyCameraDegradation(rejecting, true)).not.toThrow();
        expect(() => applyCameraDegradation(throwing, true)).not.toThrow();
        await Promise.resolve();
    });
});

describe('the mode store (main is the source of truth)', () => {
    const g = globalThis as unknown as { window: { electronAPI?: Record<string, unknown> } };
    let saved = false;
    let active = false;
    const reply = () => ({
        platform: 'win32',
        saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: saved },
        active: { screenCapturer: 'auto', captureLog: false, gamingVideo: active },
        envOverride: {},
    });

    beforeEach(() => {
        __resetGamingVideoModeForTests();
        saved = false;
        active = false;
        g.window.electronAPI = {
            getStartupFlags: vi.fn(async () => reply()),
            setStartupFlags: vi.fn(async (patch: { gamingVideo?: unknown }) => {
                if (typeof patch.gamingVideo !== 'boolean') throw new Error('rejected');
                saved = patch.gamingVideo;
                return reply();
            }),
        };
    });
    afterEach(() => { delete g.window.electronAPI; __resetGamingVideoModeForTests(); });

    it('is unavailable until loaded, and without the bridge', async () => {
        expect(getGamingVideoSnapshot().available).toBe(false);
        delete g.window.electronAPI;
        await loadGamingVideoMode();
        expect(getGamingVideoSnapshot().available).toBe(false);
    });

    it('loads the saved value (default off)', async () => {
        await loadGamingVideoMode();
        expect(getGamingVideoSnapshot()).toEqual({ available: true, enabled: false, restartPending: false, platform: 'win32' });
    });

    it('turning it on saves through main, notifies subscribers, and reports the pending restart', async () => {
        await loadGamingVideoMode();
        const seen: boolean[] = [];
        const off = subscribeGamingVideo(() => seen.push(getGamingVideoSnapshot().enabled));
        const snap = await setGamingVideoMode(true);
        expect(g.window.electronAPI!.setStartupFlags).toHaveBeenCalledWith({ gamingVideo: true });
        expect(snap).toEqual({ available: true, enabled: true, restartPending: true, platform: 'win32' });
        expect(seen).toEqual([true]);
        // After a restart main reports active === saved → nothing pending.
        active = true;
        await loadGamingVideoMode(true);
        expect(getGamingVideoSnapshot().restartPending).toBe(false);
        // Turning it back off needs a restart to drop the switches.
        await setGamingVideoMode(false);
        expect(getGamingVideoSnapshot()).toMatchObject({ enabled: false, restartPending: true });
        off();
    });

    it('a refused save leaves the snapshot unchanged and rejects', async () => {
        await loadGamingVideoMode();
        (g.window.electronAPI!.setStartupFlags as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
        await expect(setGamingVideoMode(true)).rejects.toThrow('disk full');
        expect(getGamingVideoSnapshot().enabled).toBe(false);
    });
});

describe('Settings copy', () => {
    it('is honest about the FPS cost on every platform', () => {
        for (const p of ['win32', 'linux', 'darwin']) {
            expect(gamingVideoDescription(p)).toMatch(/can cost your game a few FPS/);
        }
    });
    it('mentions the Windows CPU priority only on Windows', () => {
        expect(gamingVideoDescription('win32')).toContain('asks Windows for more CPU time');
        expect(gamingVideoDescription('linux')).not.toContain('Windows');
        expect(gamingVideoDescription('linux')).toMatch(/^For when .*Cipherline keeps drawing video/);
    });
    it('restart notice only when a restart is pending, worded for each direction', () => {
        expect(gamingVideoRestartCopy(true, false)).toBeNull();
        expect(gamingVideoRestartCopy(true, true)).toBe('On for calls now. The rest takes effect after restarting Cipherline.');
        expect(gamingVideoRestartCopy(false, true)).toBe('Off for calls now. Restart Cipherline to switch it off completely.');
    });
});
