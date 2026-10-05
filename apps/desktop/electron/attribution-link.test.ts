import { describe, it, expect } from 'vitest';
import { parseAttributionClipboard, parseAttributionArgv } from './attribution-link';

describe('parseAttributionClipboard — only ever answers for exactly one of OUR links', () => {
  const ok: Array<[string, unknown]> = [
    ['https://cipherline.chat/ref/ab12cd34', { kind: 'ref', code: 'AB12CD34' }],
    ['https://cipherline.chat/ref/AB12CD34/', { kind: 'ref', code: 'AB12CD34' }],
    ['  https://www.cipherline.chat/ref/AB12CD34\n', { kind: 'ref', code: 'AB12CD34' }],
    ['cipherline://ref/AB12CD34', { kind: 'ref', code: 'AB12CD34' }],
    ['https://cipherline.chat/invite/zKKaUldlWXo', { kind: 'invite', code: 'zKKaUldlWXo' }],
    ['cipherline://invite/zKKaUldlWXo', { kind: 'invite', code: 'zKKaUldlWXo' }],
  ];
  it.each(ok)('%j', (text, expected) => {
    expect(parseAttributionClipboard(text)).toEqual(expected);
  });

  const notOurs: Array<[string, unknown]> = [
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['not a string', 42],
    ['ordinary text', 'remember to buy milk'],
    ['a password', 'correct horse battery staple'],
    ['someone else\'s URL', 'https://example.com/ref/AB12CD34'],
    ['lookalike host', 'https://cipherline.chat.evil.example/ref/AB12CD34'],
    ['userinfo trick', 'https://cipherline.chat@evil.example/ref/AB12CD34'],
    ['plain http (landing pages are https)', 'http://cipherline.chat/ref/AB12CD34'],
    ['our link inside other text', 'look: https://cipherline.chat/ref/AB12CD34 !!'],
    ['two links', 'https://cipherline.chat/ref/AB12CD34 https://cipherline.chat/invite/abcd'],
    ['referral code of the wrong shape', 'https://cipherline.chat/ref/NOTAHEXCODE'],
    ['too-short referral code', 'https://cipherline.chat/ref/AB12'],
    ['unknown route', 'https://cipherline.chat/download'],
    ['path traversal', 'https://cipherline.chat/invite/../admin'],
    ['query smuggling', 'https://cipherline.chat/invite/abcd?x=1'],
    ['a huge clipboard', 'A'.repeat(100_000)],
  ];
  it.each(notOurs)('ignores: %s', (_label, text) => {
    expect(parseAttributionClipboard(text as string)).toBeNull();
  });
});

describe('parseAttributionArgv — an installer/stub hand-over', () => {
  it('reads --referral= and --invite=', () => {
    expect(parseAttributionArgv(['Cipherline.exe', '--fresh-install', '--referral=ab12cd34'])).toEqual({ kind: 'ref', code: 'AB12CD34' });
    expect(parseAttributionArgv(['Cipherline.exe', '--invite=zKKaUldlWXo'])).toEqual({ kind: 'invite', code: 'zKKaUldlWXo' });
  });
  it('ignores everything else', () => {
    expect(parseAttributionArgv([])).toBeNull();
    expect(parseAttributionArgv(['--fresh-install', '--autostart'])).toBeNull();
    expect(parseAttributionArgv(['--referral=nothex!!'])).toBeNull();
    expect(parseAttributionArgv(['--referral=AB12'])).toBeNull();
    expect(parseAttributionArgv(['--invite=../x'])).toBeNull();
    expect(parseAttributionArgv(['--referral'])).toBeNull();
  });
});
