import { describe, it, expect } from 'vitest';
import * as tls from 'tls';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { devUploadTrustedCas, type CaSource } from './dev-upload-tls';

describe('devUploadTrustedCas', () => {
  it('is Node defaults plus the system store, de-duplicated', () => {
    const fake = (t: CaSource) => (t === 'default' ? ['A', 'B'] : ['B', 'C']);
    expect(devUploadTrustedCas(fake)).toEqual(['A', 'B', 'C']);
  });

  it('falls back to Node defaults when the system store cannot be read', () => {
    const fake = (t: CaSource) => {
      if (t === 'system') throw new Error('unsupported');
      return ['A'];
    };
    expect(devUploadTrustedCas(fake)).toEqual(['A']);
  });

  it('on the real runtime, contains every Node default root (never an empty or narrowed store)', () => {
    const cas = devUploadTrustedCas();
    const defaults = tls.getCACertificates('default');
    expect(defaults.length).toBeGreaterThan(0);
    for (const pem of defaults) expect(cas).toContain(pem);
  });
});

describe('certificate verification is never disabled in the Electron main process', () => {
  // Was `new https.Agent({ rejectUnauthorized: false })` on the dev upload path
  // (CodeQL js/disabling-certificate-validation). Pin that it does not come back
  // anywhere under electron/.
  const dir = __dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('scans the electron sources (positive control)', () => {
    expect(sources).toContain('main.ts');
    expect(readFileSync(join(dir, 'main.ts'), 'utf8')).toContain('devUploadTrustedCas()');
  });

  it('no source sets rejectUnauthorized to false or NODE_TLS_REJECT_UNAUTHORIZED', () => {
    for (const f of sources) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/rejectUnauthorized\s*:\s*false/);
      expect(src, f).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
      expect(src, f).not.toMatch(/setCertificateVerifyProc/);
    }
  });
});
