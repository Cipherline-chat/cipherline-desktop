import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * useZxcvbn must seed its state with a LAZY initializer. `impl` is the zxcvbn
 * function itself, and `useState(fn)` calls `fn()` — so `useState(impl)`
 * ran zxcvbn(undefined) (TypeError in dictionary_match) on every mount after
 * zxcvbn had loaded once in the session, crashing the app to the router error
 * boundary when Settings → Profile mounted ChangePasswordModal after a
 * sign-in. This app's vitest runs without a DOM, so the hook is pinned at the
 * source level (the same approach as the *Wiring.test.ts files).
 */
describe('useZxcvbn state initializer', () => {
    const src = readFileSync(join(__dirname, 'passwordStrength.ts'), 'utf8');
    it('wraps the loaded function in a lazy initializer', () => {
        expect(src).toContain('useState<Zxcvbn | null>(() => impl)');
        expect(src).not.toMatch(/useState<Zxcvbn \| null>\(impl\)/);
    });
    it('stores the loaded function with an updater, never calls it', () => {
        expect(src).toContain('setZ(() => fn)');
    });
});
