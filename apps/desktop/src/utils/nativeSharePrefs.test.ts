import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    },
}));

import { getNativeShareEnabled, setNativeShareEnabled, getNativeShareRestoreToken, setNativeShareRestoreToken, nativeRestoreTokenFor } from './nativeSharePrefs';

describe('hardware screen share preference: on unless switched off', () => {
    beforeEach(() => store.clear());
    it('never touched (no stored value) = ON', () => {
        expect(getNativeShareEnabled()).toBe(true);
    });
    it('switched off by the user = OFF, and stays off', () => {
        setNativeShareEnabled(false);
        expect(store.get('cipherline_native_share_hw')).toBe('0');
        expect(getNativeShareEnabled()).toBe(false);
    });
    it('switched back on = ON', () => {
        setNativeShareEnabled(false);
        setNativeShareEnabled(true);
        expect(getNativeShareEnabled()).toBe(true);
    });
    it('an older build\'s explicit "1" is still ON', () => {
        store.set('cipherline_native_share_hw', '1');
        expect(getNativeShareEnabled()).toBe(true);
    });
    it('switching off forgets the remembered capture grant', () => {
        setNativeShareRestoreToken('abc123');
        expect(getNativeShareRestoreToken()).toBe('abc123');
        setNativeShareEnabled(false);
        expect(getNativeShareRestoreToken()).toBeNull();
    });
});

describe('nativeRestoreTokenFor: a new share always shows the chooser', () => {
    it('an internal restart of the same live share keeps the remembered grant', () => {
        expect(nativeRestoreTokenFor(true, 'tok_1')).toBe('tok_1');
        expect(nativeRestoreTokenFor(true, null)).toBeNull();
    });
    it('NEGATIVE: a new share or a change of source never offers the stored token', () => {
        expect(nativeRestoreTokenFor(false, 'tok_1')).toBeNull();
    });
});
