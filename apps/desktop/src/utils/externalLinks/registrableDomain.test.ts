import { describe, it, expect } from 'vitest';
import { registrableDomain } from './registrableDomain';

describe('registrableDomain (Public Suffix List via psl)', () => {
    it.each([
        ['example.com', 'example.com'],
        ['www.example.com', 'example.com'],
        ['a.b.c.example.com', 'example.com'],
        ['www.bbc.co.uk', 'bbc.co.uk'],
        ['shop.example.com.au', 'example.com.au'],
        ['www.foo.kawasaki.jp', 'www.foo.kawasaki.jp'], // *.kawasaki.jp wildcard rule
        ['city.kawasaki.jp', 'city.kawasaki.jp'],     // !city.kawasaki.jp exception
        ['alice.github.io', 'alice.github.io'],       // PRIVATE suffix: each user is a site
        ['x.alice.github.io', 'alice.github.io'],
        ['cipherline.chat', 'cipherline.chat'],
        ['api.cipherline.chat', 'cipherline.chat'],
        ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
        ['www.xn--80ak6aa92e.com', 'xn--80ak6aa92e.com'],
    ])('%s → %s', (host, domain) => {
        expect(registrableDomain(host)).toEqual({ domain, trustable: true, exactOnly: false });
    });

    it.each(['github.io', 'co.uk', 'com', 'blogspot.com', 'foo.kawasaki.jp'])('a public suffix itself (%s) can never be offered for trust', (host) => {
        const r = registrableDomain(host);
        expect(r.trustable).toBe(false);
        expect(r.domain).toBe(host);
    });

    it('IP literals and single-label hosts are exact-only (psl alone would call 192.168.1.1 "1.1")', () => {
        expect(registrableDomain('192.168.1.1')).toEqual({ domain: '192.168.1.1', trustable: true, exactOnly: true });
        expect(registrableDomain('[::1]')).toEqual({ domain: '[::1]', trustable: true, exactOnly: true });
        expect(registrableDomain('localhost')).toEqual({ domain: 'localhost', trustable: true, exactOnly: true });
    });

    it('empty input is not trustable', () => {
        expect(registrableDomain('').trustable).toBe(false);
    });
});
