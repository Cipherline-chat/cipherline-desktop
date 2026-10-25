import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    emitKeysBeat, onKeysBeat, setOwnCallMedia, getOwnCallMedia, onOwnCallMedia, OWN_MEDIA_OFF,
    beginKeysActivity, keysActivityOn, onKeysActivity, isNightDiveNow, __resetKeysBeats,
} from './keysBeats';

beforeEach(() => __resetKeysBeats());

describe('beats', () => {
    it('subscribe, receive the bare kind, unsubscribe', () => {
        const cb = vi.fn();
        const off = onKeysBeat(cb);
        emitKeysBeat('message');
        emitKeysBeat('home');
        off();
        emitKeysBeat('message');
        expect(cb.mock.calls).toEqual([['message'], ['home']]);
    });
    it('a throwing listener never breaks the sender or the other listeners', () => {
        const ok = vi.fn();
        const off1 = onKeysBeat(() => { throw new Error('boom'); });
        const off2 = onKeysBeat(ok);
        expect(() => emitKeysBeat('message')).not.toThrow();
        expect(ok).toHaveBeenCalledOnce();
        off1(); off2();
    });
});

describe('call media', () => {
    it('remembers the latest, emits only on change, coerces to booleans', () => {
        const cb = vi.fn();
        const off = onOwnCallMedia(cb);
        setOwnCallMedia({ speaking: true, sharing: false, video: false });
        setOwnCallMedia({ speaking: true, sharing: false, video: false });
        expect(cb).toHaveBeenCalledTimes(1);
        expect(getOwnCallMedia()).toEqual({ speaking: true, sharing: false, video: false });
        setOwnCallMedia(OWN_MEDIA_OFF);
        expect(cb).toHaveBeenCalledTimes(2);
        off();
    });
});

describe('activities are refcounted', () => {
    it('two uploads = still carrying until both end; ending twice is harmless', () => {
        const flips = vi.fn();
        const off = onKeysActivity(flips);
        const a = beginKeysActivity('transfer');
        const b = beginKeysActivity('transfer');
        expect(keysActivityOn('transfer')).toBe(true);
        a(); a();
        expect(keysActivityOn('transfer')).toBe(true);
        b();
        expect(keysActivityOn('transfer')).toBe(false);
        expect(flips.mock.calls).toEqual([['transfer'], ['transfer']]);
        expect(keysActivityOn('backup')).toBe(false);
        off();
    });
});

describe('night dive', () => {
    it('reads <html data-depth="night">, and is false without a document', () => {
        const doc = { documentElement: { getAttribute: (k: string) => (k === 'data-depth' ? 'night' : null) } } as unknown as Document;
        expect(isNightDiveNow(doc)).toBe(true);
        expect(isNightDiveNow(undefined)).toBe(false);
    });
});
