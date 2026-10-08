/**
 * The scrubber exists twice in the desktop app because the main process may
 * not import from src/ (tsconfig.electron.json pins rootDir to ./electron —
 * see the rootDir trap in CLAUDE.md). The two copies must be byte-identical:
 * a crash record scrubbed in main and a report scrubbed in the renderer have
 * to obey the same rules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('scrubber copies', () => {
    it('electron/diagnostics-scrub.ts is identical to src/utils/diagnostics/scrub.ts', () => {
        const renderer = readFileSync(join(__dirname, 'scrub.ts'), 'utf8');
        const main = readFileSync(join(__dirname, '../../../electron/diagnostics-scrub.ts'), 'utf8');
        expect(main).toBe(renderer);
    });
});
