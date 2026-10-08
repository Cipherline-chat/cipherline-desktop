import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
let locked = false;
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => { if (locked) throw new Error('locked'); return store.get(k) ?? null; },
        setItem: (k: string, v: string) => { if (locked) throw new Error('locked'); store.set(k, v); },
    },
}));

import {
    getCameraQualityTier, setCameraQualityTier, getCameraCodecPref, setCameraCodecPref, subscribeCameraQualityPrefs,
    getIncomingVideoMode, setIncomingVideoMode,
} from './cameraQualityPrefs';

beforeEach(() => { store.clear(); locked = false; });

describe('cameraQualityPrefs', () => {
    it('defaults: Auto tier, Auto encoder', () => {
        expect(getCameraQualityTier()).toBe('auto');
        expect(getCameraCodecPref()).toBe('auto');
    });

    it('persists under the keys backupRegistry classifies (device-local)', () => {
        setCameraQualityTier('720p');
        setCameraCodecPref('vp8');
        expect(store.get('cipherline_camera_quality')).toBe('720p');
        expect(store.get('cipherline_camera_codec')).toBe('vp8');
        expect(getCameraQualityTier()).toBe('720p');
        expect(getCameraCodecPref()).toBe('vp8');
    });

    it('a stored junk value reads as Auto', () => {
        store.set('cipherline_camera_quality', '8k');
        store.set('cipherline_camera_codec', 'av1');
        expect(getCameraQualityTier()).toBe('auto');
        expect(getCameraCodecPref()).toBe('auto');
    });

    it('notifies subscribers (a live call re-tunes the camera from this)', () => {
        const fn = vi.fn();
        const off = subscribeCameraQualityPrefs(fn);
        setCameraQualityTier('1080p');
        setCameraCodecPref('h264');
        expect(fn).toHaveBeenCalledTimes(2);
        off();
        setCameraQualityTier('480p');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('a locked store never throws (reads Auto; a write still notifies)', () => {
        locked = true;
        const fn = vi.fn();
        const off = subscribeCameraQualityPrefs(fn);
        expect(() => setCameraQualityTier('720p')).not.toThrow();
        expect(getCameraQualityTier()).toBe('auto');
        expect(fn).toHaveBeenCalledTimes(1);
        off();
    });

    it('Incoming video quality: default Auto, persists under its registered key, junk reads Auto, notifies', () => {
        expect(getIncomingVideoMode()).toBe('auto');
        const fn = vi.fn();
        const off = subscribeCameraQualityPrefs(fn);
        setIncomingVideoMode('datasaver');
        expect(store.get('cipherline_incoming_video')).toBe('datasaver');
        expect(getIncomingVideoMode()).toBe('datasaver');
        expect(fn).toHaveBeenCalledTimes(1);
        store.set('cipherline_incoming_video', 'ultra');
        expect(getIncomingVideoMode()).toBe('auto');
        off();
    });

    it('a throwing subscriber does not stop the others', () => {
        const good = vi.fn();
        const offA = subscribeCameraQualityPrefs(() => { throw new Error('x'); });
        const offB = subscribeCameraQualityPrefs(good);
        setCameraQualityTier('720p');
        expect(good).toHaveBeenCalledTimes(1);
        offA(); offB();
    });
});
