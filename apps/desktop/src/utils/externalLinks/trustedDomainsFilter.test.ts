import { describe, it, expect } from 'vitest';
import { filterTrustedRows, trustedRows } from './trustedDomainsFilter';

const ROWS = trustedRows(['github.com', 'gist.github.com', 'example.co.uk', 'xn--mnchen-3ya.de', 'xn--fiqs8s.cn', '192.168.1.20', 'docs.google.com']);
const names = (q: string) => filterTrustedRows(ROWS, q).map(r => r.domain);

describe('Trusted websites search', () => {
    it('empty / whitespace query shows everything', () => {
        expect(names('')).toHaveLength(ROWS.length);
        expect(names('   ')).toHaveLength(ROWS.length);
    });
    it('matches anywhere in the domain, case-insensitively', () => {
        expect(names('hub')).toEqual(['github.com', 'gist.github.com']);
        expect(names('GITHUB.COM')).toEqual(['github.com', 'gist.github.com']);
        expect(names('.co.uk')).toEqual(['example.co.uk']);
        expect(names('168.1')).toEqual(['192.168.1.20']);
        expect(names('oogl')).toEqual(['docs.google.com']);
    });
    it('IDN-aware: the Unicode name, a piece of it, its upper case and the punycode all match', () => {
        expect(names('münchen')).toEqual(['xn--mnchen-3ya.de']);
        expect(names('ÜNCH')).toEqual(['xn--mnchen-3ya.de']);
        expect(names('münchen.de')).toEqual(['xn--mnchen-3ya.de']);
        expect(names('xn--mnchen')).toEqual(['xn--mnchen-3ya.de']);
        expect(names('中国')).toEqual(['xn--fiqs8s.cn']);
    });
    it('no match → empty', () => {
        expect(names('zzz-nothing')).toEqual([]);
    });
    it('rows carry the shown (Unicode) form', () => {
        expect(ROWS.find(r => r.domain === 'xn--mnchen-3ya.de')?.shown).toBe('münchen.de');
    });
});
