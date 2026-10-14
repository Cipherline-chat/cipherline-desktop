import { describe, it, expect } from 'vitest';
import { KLIPY_MEDIA_HOSTS, KLIPY_MEDIA_URL_RE, isKlipyMediaUrl } from '@cipherline/shared';

/**
 * KLIPY_MEDIA_URL_RE is a regex LITERAL (nothing is interpolated into it, so it
 * needs no escaping). The price is that it duplicates KLIPY_MEDIA_HOSTS; this
 * file is what keeps the two from drifting.
 */
describe('KLIPY_MEDIA_URL_RE vs KLIPY_MEDIA_HOSTS', () => {
  it('accepts every listed media host', () => {
    for (const h of KLIPY_MEDIA_HOSTS) {
      expect(isKlipyMediaUrl(`https://${h}/gifs/a.gif`)).toBe(true);
      expect(isKlipyMediaUrl(`https://${h}/gifs/a.webp?w=300&h=200`)).toBe(true);
    }
  });

  it('accepts nothing but the listed hosts: no sibling numbering, no wildcard, no extra label', () => {
    const listed = new Set<string>(KLIPY_MEDIA_HOSTS);
    const near: string[] = ['static3.klipy.com', 'static10.klipy.com', 'statics.klipy.com', 'staticXklipy.com',
      'static.klipyXcom', 'staticXklipyXcom', 'static..klipy.com', 'klipy.com', 'api.klipy.com', 'a.static.klipy.com',
      'static.klipy.com.evil.net', 'xstatic.klipy.com', 'static.klipy.co', 'static.klipy.com\\.evil.net'];
    for (let i = 0; i <= 9; i++) near.push(`static${i}.klipy.com`);
    for (const h of near) {
      if (listed.has(h)) continue;
      expect(isKlipyMediaUrl(`https://${h}/a.gif`), h).toBe(false);
    }
  });

  it('is anchored to https and to the host-then-slash shape', () => {
    expect(KLIPY_MEDIA_URL_RE.test('http://static.klipy.com/a.gif')).toBe(false);
    expect(KLIPY_MEDIA_URL_RE.test('https://static.klipy.com')).toBe(false);          // needs the slash
    expect(KLIPY_MEDIA_URL_RE.test('https://static.klipy.com:8443/a.gif')).toBe(false);
    expect(KLIPY_MEDIA_URL_RE.test('https://static.klipy.com@evil.net/a.gif')).toBe(false);
    expect(KLIPY_MEDIA_URL_RE.test('https://evil.net/https://static.klipy.com/a.gif')).toBe(false);
    expect(KLIPY_MEDIA_URL_RE.test('xhttps://static.klipy.com/a.gif')).toBe(false);
    expect(KLIPY_MEDIA_URL_RE.test('https://static.klipy.com/a.gif#frag')).toBe(false);
    expect(KLIPY_MEDIA_URL_RE.test('https://static.klipy.com/a b.gif')).toBe(false);
  });
});
