import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Decrypted media kept warm for fast chat switching must not outlive the
 * session. Every way AuthContext ends one goes through dropSessionMedia(): the
 * explicit/WS-revoked logout() AND the "refresh token rejected" forced
 * re-login (which used to skip the clear). No second, parallel clear call.
 */
const src = readFileSync(join(__dirname, 'AuthContext.tsx'), 'utf8');

describe('AuthContext sign-out clears session media exactly once per exit path', () => {
    it('logout() and the rejected-refresh path each call dropSessionMedia, before clearing the stored session', () => {
        expect([...src.matchAll(/dropSessionMedia\(\);/g)].length).toBe(2);
        const logout = src.slice(src.indexOf('const logout = ('));
        expect(logout.indexOf('dropSessionMedia();')).toBeGreaterThan(-1);
        expect(logout.indexOf('dropSessionMedia();')).toBeLessThan(logout.indexOf("removeItem('cipherline_token')"));
        const refresh = src.slice(src.indexOf('Server said the refresh token is invalid'));
        expect(refresh.indexOf('dropSessionMedia();')).toBeLessThan(refresh.indexOf("removeItem('cipherline_token')"));
    });

    it('does not call the individual caches (one owner: utils/sessionMedia)', () => {
        expect(src).not.toMatch(/clearDecryptedMediaCache|clearRemoteImageCache|clearDecryptedAttachmentCache/);
    });
});
