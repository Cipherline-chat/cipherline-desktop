import { describe, it, expect } from 'vitest';
import { describeExternalLink, type HttpsLinkModel, type MailtoLinkModel } from './describeLink';

const https = (url: string, label?: string) => describeExternalLink(new URL(url), { label }) as HttpsLinkModel;
const mailto = (url: string, label?: string) => describeExternalLink(new URL(url), { label }) as MailtoLinkModel;

describe('describeExternalLink — https', () => {
    it('splits the full URL so the registrable domain can be bolded', () => {
        const m = https('https://user:pw@shop.www.bbc.co.uk:8443/a/b?q=1#frag');
        expect(m.kind).toBe('https');
        expect(m.parts).toEqual({
            scheme: 'https://',
            userinfo: 'user:pw',
            subdomain: 'shop.www.',
            site: 'bbc.co.uk',
            port: ':8443',
            rest: '/a/b?q=1#frag',
        });
        expect(m.trusted).toBe(false);
        expect(m.trustDomain).toBe('bbc.co.uk');
    });

    it('the host is the URL parser’s: `cipherline.chat@evil.com` goes to evil.com and is NOT trusted', () => {
        const m = https('https://cipherline.chat@evil.com/');
        expect(m.parts.site).toBe('evil.com');
        expect(m.parts.userinfo).toBe('cipherline.chat');
        expect(m.trusted).toBe(false);
    });

    it.each([
        ['https://cipherline.chat/', true],
        ['https://www.cipherline.chat/download', true],
        ['https://api.cipherline.chat/v1', true],
        ['https://cipherline.chat.evil.io/', false],
        ['https://evilcipherline.chat/', false],
        ['https://cipherline.chat.evil.io/', false],
    ])('built-in trust is cipherline.chat and its subdomains only: %s → %s', (url, trusted) => {
        const m = https(url);
        expect(m.trusted).toBe(trusted);
        expect(m.builtIn).toBe(trusted);
        if (trusted) expect(m.trustDomain).toBeNull(); // nothing to offer
    });

    it('offers the registrable domain for trust, never a public suffix', () => {
        expect(https('https://alice.github.io/x').trustDomain).toBe('alice.github.io');
        expect(https('https://github.io/').trustDomain).toBeNull();
        expect(https('https://www.example.co.uk/').trustDomain).toBe('example.co.uk');
    });

    it('a confusable IDN is shown as punycode and flagged', () => {
        const m = https('https://аpple.com/login');
        expect(m.spoofed).toBe(true);
        expect(m.parts.site).toBe('xn--pple-43d.com');
        expect(m.host.verdict).toBe('mixed-script');
        expect(m.trustDomain).toBeNull(); // never offer to trust a look-alike
    });

    it('an honest IDN is shown in Unicode, with the bold part in Unicode too', () => {
        const m = https('https://www.münchen.de/');
        expect(m.spoofed).toBe(false);
        expect(m.parts.subdomain).toBe('www.');
        expect(m.parts.site).toBe('münchen.de');
        expect(m.trustDomain).toBe('xn--mnchen-3ya.de');
        expect(m.trustDomainShown).toBe('münchen.de');
        expect(m.href).toBe('https://www.xn--mnchen-3ya.de/');
    });
});

describe('describeExternalLink — masked-link mismatch', () => {
    it('label naming another site is a mismatch, and never offers trust', () => {
        const m = https('https://paypa1.example/login', 'https://paypal.com');
        expect(m.mismatch).toEqual({ says: 'paypal.com', goesTo: 'paypa1.example' });
        expect(m.trustDomain).toBeNull();
        expect(m.trusted).toBe(false);
    });

    it('a mismatch to a TRUSTED destination still needs the dialog', () => {
        const m = https('https://cipherline.chat/x', 'paypal.com');
        expect(m.builtIn).toBe(true);
        expect(m.mismatch).not.toBeNull();
        expect(m.trusted).toBe(false);
    });

    it.each([
        ['github.com', 'https://gist.github.com/x'],         // parent of the destination: fine
        ['https://www.example.com/a', 'https://example.com/b'],
        ['click here', 'https://evil.example/'],              // no host named: nothing to contradict
        ['', 'https://evil.example/'],
    ])('no mismatch: label %j → %s', (label, url) => {
        expect(https(url, label).mismatch).toBeNull();
    });

    it('a look-alike parent is a mismatch: github.com → github.com.evil.io', () => {
        expect(https('https://github.com.evil.io/', 'github.com')!.mismatch).toEqual({ says: 'github.com', goesTo: 'evil.io' });
    });

    it('a Cyrillic look-alike label against the Latin site is a mismatch, shown honestly', () => {
        const m = https('https://apple.com/', 'аpple.com');
        expect(m.mismatch?.says).toBe('xn--pple-43d.com');
        expect(m.mismatch?.goesTo).toBe('apple.com');
    });
});

describe('describeExternalLink — mailto', () => {
    it('lists recipients from the path and to/cc/bcc, notes pre-filled text', () => {
        const m = mailto('mailto:a@example.com,b@example.com?cc=c@example.com&subject=Hi&body=Text');
        expect(m.recipients.map(r => r.address)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
        expect(m.prefills).toBe(true);
        expect(m.trustDomain).toBe('example.com');
        expect(m.trusted).toBe(false);
    });

    it('recipients on two sites: no single domain to offer', () => {
        expect(mailto('mailto:a@example.com?cc=b@other.org').trustDomain).toBeNull();
    });

    it('mail to cipherline.chat is built-in trusted', () => {
        const m = mailto('mailto:support@cipherline.chat');
        expect(m.trusted).toBe(true);
        expect(m.builtIn).toBe(true);
    });

    it('a label that is a different email address is a mismatch', () => {
        const m = mailto('mailto:help@evil.example', 'support@paypal.com');
        expect(m.mismatch).toEqual({ says: 'paypal.com', goesTo: 'evil.example' });
        expect(m.trusted).toBe(false);
    });

    it('a matching email label is not a mismatch', () => {
        expect(mailto('mailto:support@cipherline.chat', 'support@cipherline.chat').mismatch).toBeNull();
    });

    it('a confusable recipient domain is flagged and shown as punycode', () => {
        const m = mailto('mailto:billing@аpple.com');
        expect(m.spoofed).toBe(true);
        expect(m.recipients[0].address).toBe('billing@xn--pple-43d.com');
        expect(m.trustDomain).toBeNull();
    });
});
