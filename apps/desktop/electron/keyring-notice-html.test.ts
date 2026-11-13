import { describe, it, expect } from 'vitest';
import { keyringNoticeCopy, keyringNoticeHtml } from './keyring-notice-html';
import { KEYRING_PROMPT_AFTER_MS } from './keyring-prompt';

describe('keyring notice copy', () => {
    it('names KDE Wallet for a KDE desktop', () => {
        const c = keyringNoticeCopy('KDE Wallet');
        expect(c.title).toBe('Your system is asking for your KDE Wallet password');
        expect(c.body).toContain('Cipherline keeps your encryption keys in your KDE Wallet');
        expect(c.body).toContain('Enter your password in that window to continue.');
        expect(c.body).not.toContain('GNOME');
    });

    it('names GNOME Keyring for a GNOME desktop', () => {
        const c = keyringNoticeCopy('GNOME Keyring');
        expect(c.title).toContain('GNOME Keyring');
        expect(c.body).not.toContain('KDE');
    });

    it('anything unrecognised falls back to a generic name, never echoed back', () => {
        const c = keyringNoticeCopy('<script>alert(1)</script>');
        expect(c.title).toBe('Your system is asking for your system wallet password');
        expect(JSON.stringify(c)).not.toContain('script');
    });
});

describe('keyring notice page', () => {
    const html = keyringNoticeHtml('KDE Wallet');

    it('has no script, no network, no external resources (locked-down CSP)', () => {
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/https?:\/\//i);
        expect(html).not.toMatch(/@import|<link|<img|<iframe|<object|<embed|\son[a-z]+\s*=/i);
        expect(html).toContain(`default-src 'none'`);
        expect(html).not.toContain('script-src');
    });

    it('is invisible until the prompt window has passed (pure CSS delay)', () => {
        expect(html).toContain('opacity: 0;');
        expect(html).toContain(`${KEYRING_PROMPT_AFTER_MS}ms forwards`);
    });

    it('carries the notice text', () => {
        expect(html).toContain('Your system is asking for your KDE Wallet password');
        expect(html).toContain('Enter your password in that window to continue.');
    });
});
