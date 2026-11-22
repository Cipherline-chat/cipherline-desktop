import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return { default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); }, __mem: mem } };
});

import secureLocalStore from './secureLocalStore';
import { loadMicDeviceGain, saveMicDeviceGain, MIC_DEVICE_GAIN_KEY, MAX_MIC_GAINS } from './micDeviceGain';

const mem = () => (secureLocalStore as unknown as { __mem: Map<string, string> }).__mem;
beforeEach(() => mem().clear());

describe('per-microphone gain store', () => {
    it('round-trips a gain per capture deviceId', () => {
        expect(loadMicDeviceGain('mic-a')).toBeNull();
        saveMicDeviceGain('mic-a', 17.46);
        saveMicDeviceGain('mic-b', -3);
        expect(loadMicDeviceGain('mic-a')).toBe(17.5);
        expect(loadMicDeviceGain('mic-b')).toBe(-3);
        expect(loadMicDeviceGain('mic-c')).toBeNull();
    });

    it('ignores an unknown deviceId and implausible numbers; never throws on a broken store', () => {
        saveMicDeviceGain('', 5); saveMicDeviceGain(undefined, 5); saveMicDeviceGain('m', NaN); saveMicDeviceGain('m', Infinity); saveMicDeviceGain('m', 999);
        expect(mem().has(MIC_DEVICE_GAIN_KEY)).toBe(false);
        expect(loadMicDeviceGain(undefined)).toBeNull();
        mem().set(MIC_DEVICE_GAIN_KEY, '{not json');
        expect(loadMicDeviceGain('m')).toBeNull();
        mem().set(MIC_DEVICE_GAIN_KEY, JSON.stringify({ v: 1, gains: { m: { db: 'x', at: 1 }, n: { db: 500, at: 1 }, ok: { db: 4, at: 1 } } }));
        expect(loadMicDeviceGain('m')).toBeNull();
        expect(loadMicDeviceGain('n')).toBeNull();
        expect(loadMicDeviceGain('ok')).toBe(4);
    });

    it('keeps the most recently saved microphones only', () => {
        for (let i = 0; i < MAX_MIC_GAINS + 5; i++) saveMicDeviceGain(`mic-${i}`, 1, 1000 + i);
        expect(loadMicDeviceGain('mic-0')).toBeNull();
        expect(loadMicDeviceGain('mic-4')).toBeNull();
        expect(loadMicDeviceGain('mic-5')).toBe(1);
        expect(loadMicDeviceGain(`mic-${MAX_MIC_GAINS + 4}`)).toBe(1);
    });

    it('stores a number per device id: no labels, no audio', () => {
        saveMicDeviceGain('opaque-device-id', 9);
        expect(mem().get(MIC_DEVICE_GAIN_KEY)).toMatch(/^\{"v":1,"gains":\{"opaque-device-id":\{"db":9,"at":\d+\}\}\}$/);
    });
});
