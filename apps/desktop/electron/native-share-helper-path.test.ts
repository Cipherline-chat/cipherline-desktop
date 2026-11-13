import { describe, it, expect } from 'vitest';
import { resolveNativeShareHelper, allowNativeShareTestBackend, type HelperPathInput } from './native-share-helper-path';

const base = (o: Partial<HelperPathInput>, present: string[] = []): HelperPathInput => ({
    isPackaged: true, envHelper: undefined, resourcesPath: '/opt/Cipherline/resources', devBuildPath: '/src/native/build/share-encoder-helper',
    userDataPath: '/home/u/.config/Cipherline', exists: (p) => present.includes(p), ...o,
});
const PKG = '/opt/Cipherline/resources/share-encoder-helper';
const USER = '/home/u/.config/Cipherline/native/share-encoder-helper';

describe('native share helper path', () => {
    it('packaged: the resources binary only', () => {
        expect(resolveNativeShareHelper(base({}, [PKG]))).toEqual({ path: PKG, source: 'packaged' });
    });
    it('packaged: the env override is ignored (hijack vector)', () => {
        expect(resolveNativeShareHelper(base({ envHelper: '/tmp/evil' }, [PKG]))?.path).toBe(PKG);
    });
    it('packaged: a binary dropped into userData is ignored, even when the packaged one is missing', () => {
        expect(resolveNativeShareHelper(base({}, [USER]))).toBeNull();
        expect(resolveNativeShareHelper(base({ envHelper: '/tmp/evil' }, [USER]))).toBeNull();
    });
    it('packaged: the in-tree dev build is ignored', () => {
        expect(resolveNativeShareHelper(base({}, ['/src/native/build/share-encoder-helper']))).toBeNull();
    });
    it('unpackaged: env override wins, then resources, dev build, userData', () => {
        expect(resolveNativeShareHelper(base({ isPackaged: false, envHelper: '/lab/helper' }, [PKG]))?.source).toBe('env');
        expect(resolveNativeShareHelper(base({ isPackaged: false, envHelper: 'relative/helper' }, [PKG]))?.source).toBe('packaged');
        expect(resolveNativeShareHelper(base({ isPackaged: false }, ['/src/native/build/share-encoder-helper', USER]))?.source).toBe('dev');
        expect(resolveNativeShareHelper(base({ isPackaged: false }, [USER]))?.source).toBe('userData');
        expect(resolveNativeShareHelper(base({ isPackaged: false }, []))).toBeNull();
    });
    it('the pcm test backend never opens in a packaged build', () => {
        expect(allowNativeShareTestBackend(true, '1')).toBe(false);
        expect(allowNativeShareTestBackend(false, '1')).toBe(true);
        expect(allowNativeShareTestBackend(false, undefined)).toBe(false);
    });
});
