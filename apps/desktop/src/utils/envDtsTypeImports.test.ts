import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * The website build typechecks apps/desktop/src/env.d.ts (apps/website/tsconfig.json "include"), so every
 * module env.d.ts names via `import('./...')` is compiled in a tree WITHOUT the desktop's dependencies
 * (no livekit-client, no electron). Those modules must therefore import nothing at runtime: only
 * `import type` (or no imports at all). This broke the website Docker build once (nativeSharePipeline.ts).
 */
const SRC = join(__dirname, '..');
const envDts = readFileSync(join(SRC, 'env.d.ts'), 'utf8');
const targets = [...new Set([...envDts.matchAll(/import\('(\.\/[^']+)'\)/g)].map(m => m[1]))];

function resolve(rel: string): string {
    for (const ext of ['.ts', '.tsx', '.d.ts', '/index.ts']) {
        try { readFileSync(join(SRC, rel + ext)); return join(SRC, rel + ext); } catch { /* next */ }
    }
    throw new Error(`env.d.ts imports ${rel}, which does not resolve`);
}

describe('env.d.ts only reaches import-free type modules (the website build compiles them)', () => {
    it('finds the modules env.d.ts imports', () => {
        expect(targets.length).toBeGreaterThan(0);
        expect(targets).toContain('./utils/nativeShareApi');
    });
    for (const rel of targets) {
        it(`${rel} has no runtime imports`, () => {
            const file = resolve(rel);
            const src = readFileSync(file, 'utf8');
            const runtime = src.split('\n').filter(l => /^\s*(import|export)\s.*\sfrom\s+['"]/.test(l) && !/^\s*(import|export)\s+type\s/.test(l));
            expect(runtime, `${dirname(file)}: runtime import(s) would pull desktop-only packages into the website build`).toEqual([]);
        });
    }
});
