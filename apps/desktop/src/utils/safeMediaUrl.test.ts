import { describe, it, expect } from 'vitest';
import { safeImageSrc, safeBlobUrl } from './safeMediaUrl';

const ALLOWED: string[] = [
  'blob:http://127.0.0.1:41233/5b0c8c3e-7c7a-4b0a-9a35-0f2f8f3d2b11',
  'blob:null/5b0c8c3e-7c7a-4b0a-9a35-0f2f8f3d2b11',
  'data:image/png;base64,iVBORw0KGgo=',
  'data:image/jpeg;base64,/9j/4AAQ',
  'data:image/gif;base64,R0lGODlh',
  'data:image/webp;base64,UklGR',
  'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
  'DATA:IMAGE/PNG;base64,AAAA',
  'https://static.klipy.com/ii/abc/def/x.gif',
  'https://static1.klipy.com/ii/abc/def/x.webp?w=300',
  'https://static2.klipy.com/a.gif',
  'https://media.cipherline.chat/avatars/abc',
];

const BLOCKED: Array<[string, string]> = [
  ['js scheme', 'javascript:alert(1)'],
  ['js scheme mixed case', 'JaVaScRiPt:alert(1)'],
  ['js scheme leading space', ' javascript:alert(1)'],
  ['vbscript', 'vbscript:msgbox(1)'],
  ['file', 'file:///etc/passwd'],
  ['plain http klipy', 'http://static.klipy.com/a.gif'],
  ['plain http cipherline', 'http://media.cipherline.chat/a'],
  ['data html', 'data:text/html;base64,PHNjcmlwdD4='],
  ['data html in image-looking', 'data:text/html,<img src=x onerror=alert(1)>'],
  ['data application', 'data:application/javascript,alert(1)'],
  ['bare data', 'data:,hello'],
  ['data image with markup', 'data:image/png;base64,AA" onerror="alert(1)'],
  ['data image with whitespace', 'data:image/png;base64,AA AA'],
  ['data image slash trick', 'data:image/../text/html,x'],
  ['blob with quote', 'blob:http://x/"onerror=1'],
  ['blob with whitespace', 'blob:http://x/a b'],
  ['unknown https host', 'https://evil.example/a.gif'],
  ['klipy suffix trick', 'https://static.klipy.com.evil.net/a.gif'],
  ['klipy as path', 'https://evil.net/static.klipy.com/a.gif'],
  ['klipy userinfo', 'https://static.klipy.com@evil.net/a.gif'],
  ['klipy port', 'https://static.klipy.com:8443/a.gif'],
  ['klipy backslash', 'https://static.klipy.com\\@evil.net/a.gif'],
  ['klipy apex (not a media host)', 'https://klipy.com/a.gif'],
  ['klipy api host (not media)', 'https://api.klipy.com/a.gif'],
  ['cipherline api host', 'https://api.cipherline.chat/v1/x'],
  ['cipherline lookalike', 'https://media.cipherline.chat.evil.net/a'],
  ['cipherline userinfo', 'https://media.cipherline.chat@evil.net/a'],
  ['cipherline port', 'https://media.cipherline.chat:8443/a'],
  ['protocol relative', '//evil.example/a.gif'],
  ['relative path', '/assets/x.png'],
  ['bare word', 'avatar.png'],
  ['empty', ''],
];

describe('safeImageSrc allowed matrix', () => {
  it.each(ALLOWED)('allows %s and returns its normalised (parsed) form', (u) => {
    expect(safeImageSrc(u)).toBe(new URL(u).href);
  });

  it('canonical inputs come back byte-identical', () => {
    for (const u of ALLOWED.filter(x => !x.startsWith('DATA:'))) expect(safeImageSrc(u)).toBe(u);
  });

  it('blob: via safeBlobUrl; nothing else passes it', () => {
    expect(safeBlobUrl('blob:http://127.0.0.1:1/abc')).toBe('blob:http://127.0.0.1:1/abc');
    expect(safeBlobUrl('data:image/png;base64,AAAA')).toBeUndefined();
    expect(safeBlobUrl('https://static.klipy.com/a.gif')).toBeUndefined();
    expect(safeBlobUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeBlobUrl(undefined)).toBeUndefined();
    expect(safeBlobUrl('blob:')).toBeUndefined();
  });
});

describe('safeImageSrc blocked matrix', () => {
  it.each(BLOCKED)('blocks %s', (_name, u) => {
    expect(safeImageSrc(u)).toBeUndefined();
  });

  it('blocks non-strings', () => {
    expect(safeImageSrc(null)).toBeUndefined();
    expect(safeImageSrc(undefined)).toBeUndefined();
    expect(safeImageSrc(42 as unknown as string)).toBeUndefined();
    expect(safeImageSrc({ toString: () => 'blob:x' } as unknown as string)).toBeUndefined();
  });

  it('blocks control characters smuggled into otherwise-allowed prefixes', () => {
    expect(safeImageSrc('blob:http://x/a\nb')).toBeUndefined();
    expect(safeImageSrc('https://static.klipy.com/a\u0000.gif')).toBeUndefined();
    expect(safeImageSrc('java\tscript:alert(1)')).toBeUndefined();
  });
});

// Negative controls live in the blocked matrix above: the 'suffix trick', 'userinfo',
// 'port' and 'data html' rows are exactly the inputs a plain prefix / substring check
// accepts (e.g. a check that only looks at how the string begins), and every one of
// them must come back undefined here.
