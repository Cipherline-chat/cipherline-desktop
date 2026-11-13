import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/** Toasts (an achievement unlock, a badge tier) must never be hidden by a dimming full-screen moment. */
describe('toast stack z-index', () => {
    const toastZ = Number(/fixed bottom-4 right-4 z-\[(\d+)\]/.exec(read('contexts/ToastContext.tsx'))?.[1]);
    const momentZ = Number(/\.mo-root\s*\{[^}]*?z-index:\s*(\d+)/s.exec(read('styles/moments.css'))?.[1]);

    it('reads both numbers', () => {
        expect(Number.isFinite(toastZ)).toBe(true);
        expect(Number.isFinite(momentZ)).toBe(true);
    });
    it('sits above the moment layer', () => {
        expect(toastZ).toBeGreaterThan(momentZ);
    });
    it('but below the system surfaces (screen-share picker 99999, update prompt 100000)', () => {
        expect(toastZ).toBeLessThan(99999);
    });
});
