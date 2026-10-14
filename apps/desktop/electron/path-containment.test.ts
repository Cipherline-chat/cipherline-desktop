import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isPathInside } from './path-containment';

describe('isPathInside (posix)', () => {
  const base = '/app/dist';
  const posix = { pathApi: path.posix };

  it('accepts children and nested children', () => {
    expect(isPathInside(base, '/app/dist/index.html', posix)).toBe(true);
    expect(isPathInside(base, '/app/dist/assets/a/b.js', posix)).toBe(true);
  });

  it('rejects a sibling directory that merely shares the base-name prefix', () => {
    expect(isPathInside(base, '/app/dist-evil/x', posix)).toBe(false);
    expect(isPathInside(base, '/app/distribution', posix)).toBe(false);
    // Negative control: the old `startsWith(base)` check accepted exactly these.
    expect('/app/dist-evil/x'.startsWith(base)).toBe(true);
  });

  it('rejects .. traversal, including ones that re-enter via a sibling', () => {
    expect(isPathInside(base, '/app/dist/../secret', posix)).toBe(false);
    expect(isPathInside(base, '/app/dist/a/../../secret', posix)).toBe(false);
    expect(isPathInside(base, '/app/dist/../dist-evil/x', posix)).toBe(false);
    expect(isPathInside(base, '/etc/passwd', posix)).toBe(false);
    expect(isPathInside(base, '/', posix)).toBe(false);
  });

  it('accepts a .. segment that stays inside', () => {
    expect(isPathInside(base, '/app/dist/a/../b.js', posix)).toBe(true);
  });

  it('treats the base itself as outside unless allowEqual', () => {
    expect(isPathInside(base, '/app/dist', posix)).toBe(false);
    expect(isPathInside(base, '/app/dist/', posix)).toBe(false);
    expect(isPathInside(base, '/app/dist', { ...posix, allowEqual: true })).toBe(true);
    expect(isPathInside(base, '/app/dist/', { ...posix, allowEqual: true })).toBe(true);
    // allowEqual must not widen anything else
    expect(isPathInside(base, '/app/dist-evil', { ...posix, allowEqual: true })).toBe(false);
  });

  it('tolerates a trailing separator on the base', () => {
    expect(isPathInside('/app/dist/', '/app/dist/x', posix)).toBe(true);
    expect(isPathInside('/app/dist/', '/app/dist-evil/x', posix)).toBe(false);
  });
});

describe('isPathInside (win32)', () => {
  const win = { pathApi: path.win32 };
  const base = 'C:\\Users\\u\\AppData\\Roaming\\Cipherline';

  it('accepts children and is case-insensitive like NTFS', () => {
    expect(isPathInside(base, base + '\\custom-sounds\\a.wav', win)).toBe(true);
    expect(isPathInside(base.toLowerCase(), base + '\\x', win)).toBe(true);
  });

  it('rejects another drive, UNC roots, sibling prefixes and traversal', () => {
    expect(isPathInside(base, 'D:\\Users\\u\\AppData\\Roaming\\Cipherline\\x', win)).toBe(false);
    expect(isPathInside(base, '\\\\evil\\share\\x', win)).toBe(false);
    expect(isPathInside(base, base + '-evil\\x', win)).toBe(false);
    expect(isPathInside(base, base + '\\..\\Other\\x', win)).toBe(false);
  });
});

describe('isPathInside (host platform default)', () => {
  it('uses the real path module by default', () => {
    const base = path.resolve('some', 'base');
    expect(isPathInside(base, path.join(base, 'child'))).toBe(true);
    expect(isPathInside(base, base + '-evil')).toBe(false);
    expect(isPathInside(base, path.join(base, '..', 'x'))).toBe(false);
  });
});

describe('the inline check in the static server (electron/main.ts) agrees with isPathInside', () => {
  const MAIN = readFileSync(join(__dirname, 'main.ts'), 'utf8');

  // The exact expression main.ts uses, replayed against an explicit path module.
  const inlineAllows = (p: typeof path.posix, base: string, target: string) => {
    const rel = p.relative(base, target);
    return !(rel.startsWith('..') || p.isAbsolute(rel));
  };

  it('main.ts contains that expression, and no prefix check on the dist dir', () => {
    expect(MAIN).toContain("relToDist.startsWith('..') || path.isAbsolute(relToDist)");
    expect(MAIN).toContain('path.relative(distDir, requested)');
    const code = MAIN.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/\.startsWith\(distDir\)/);
  });

  it('same verdicts as isPathInside(allowEqual) on posix and win32 tables', () => {
    const posix: Array<[string, string]> = [
      ['/app/dist', '/app/dist'], ['/app/dist', '/app/dist/index.html'], ['/app/dist', '/app/dist/a/../b'],
      ['/app/dist', '/app/dist-evil/x'], ['/app/dist', '/app/dist/../x'], ['/app/dist', '/etc/passwd'],
      ['/app/dist', '/app/distribution'], ['/app/dist', '/'],
    ];
    for (const [b, t] of posix) {
      expect(inlineAllows(path.posix, b, t), `${b} ${t}`).toBe(isPathInside(b, t, { allowEqual: true, pathApi: path.posix }));
    }
    const win: Array<[string, string]> = [
      ['C:\\app\\dist', 'C:\\app\\dist\\index.html'], ['C:\\app\\dist', 'C:\\app\\dist-evil\\x'],
      ['C:\\app\\dist', 'D:\\app\\dist\\x'], ['C:\\app\\dist', 'C:\\app\\dist\\..\\x'],
      ['C:\\app\\dist', '\\\\evil\\share\\x'], ['C:\\app\\dist', 'c:\\APP\\DIST\\x'],
    ];
    for (const [b, t] of win) {
      expect(inlineAllows(path.win32 as typeof path.posix, b, t), `${b} ${t}`).toBe(isPathInside(b, t, { allowEqual: true, pathApi: path.win32 }));
    }
  });
});

describe('no ad-hoc prefix containment checks remain in electron/', () => {
  it('no non-test electron source compares a resolved path with startsWith(<dir>[ + sep])', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(__dirname)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      readFileSync(join(__dirname, f), 'utf8').split('\n').forEach((line, i) => {
        if (/\b(?:resolved|resolvedN|abs|target|filePath|absPath)\w*\.startsWith\(\s*(?:path\.resolve|norm\(|dirN|distDir|tempReal|[a-zA-Z]*Dir\b)/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
