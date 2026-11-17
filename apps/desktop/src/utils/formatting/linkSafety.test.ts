/**
 * Masked-link phishing check (utils/formatting/linkSafety.ts).
 */
import { describe, it, expect } from 'vitest';
import { maskedLinkCheck, hostNamedBy } from './linkSafety';

describe('maskedLinkCheck', () => {
    it('a label that is just words is not deceptive', () => {
        const r = maskedLinkCheck('the release notes', 'https://example.com/notes');
        expect(r).toMatchObject({ deceptive: false, labelHost: null, targetHost: 'example.com', punycode: false });
    });

    it('a label naming the same site (or a parent of the destination) is fine', () => {
        expect(maskedLinkCheck('github.com', 'https://github.com/x').deceptive).toBe(false);
        expect(maskedLinkCheck('https://www.github.com', 'https://github.com/x').deceptive).toBe(false);
        expect(maskedLinkCheck('github.com', 'https://gist.github.com/x').deceptive).toBe(false);
        expect(maskedLinkCheck('see GitHub.com/foo', 'https://github.com/foo').deceptive).toBe(false);
    });

    it('a label naming a DIFFERENT site is deceptive', () => {
        const r = maskedLinkCheck('https://paypal.com/login', 'https://paypa1.example/login');
        expect(r).toMatchObject({ deceptive: true, labelHost: 'paypal.com', targetHost: 'paypa1.example' });
        expect(maskedLinkCheck('github.com', 'https://github.com.evil.io').deceptive).toBe(true);
        expect(maskedLinkCheck('github.com', 'https://evilgithub.com').deceptive).toBe(true);
        expect(maskedLinkCheck('click: www.bank.com', 'https://bank.com.attacker.net').deceptive).toBe(true);
    });

    it('look-alike letters in the label do not match the real host', () => {
        // Cyrillic "а" in "pаypal".
        expect(maskedLinkCheck('pаypal.com', 'https://paypal.com').deceptive).toBe(true);
    });

    it('a punycode destination is flagged', () => {
        expect(maskedLinkCheck('shop', 'https://xn--pypal-4ve.com').punycode).toBe(true);
    });

    it('hostNamedBy ignores very long words (bounded work)', () => {
        expect(hostNamedBy(`${'a.'.repeat(300)}com`)).toBeNull();
        expect(hostNamedBy('docs at example.org.')).toBe('example.org');
    });
});
