import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decideSmokeTestMode, SMOKE_TEST_ARG } from './smoke-mode';

const EXE = ['C:\\Program Files\\Cipherline\\Cipherline.exe'];

describe('smoke-mode (E-7)', () => {
    it('packaged: the env var alone (e.g. a persistent user env var) does NOT enter smoke mode', () => {
        expect(decideSmokeTestMode({ CIPHERLINE_SMOKE_TEST: '1' }, EXE, true)).toBe(false);
        expect(decideSmokeTestMode({ CIPHERLINE_SMOKE_TEST: '1' }, [...EXE, 'cipherline://invite/abc'], true)).toBe(false);
    });

    it('packaged: the harness argument without a separate profile is not enough either', () => {
        expect(decideSmokeTestMode({ CIPHERLINE_SMOKE_TEST: '1' }, [...EXE, SMOKE_TEST_ARG], true)).toBe(false);
        expect(decideSmokeTestMode({ CIPHERLINE_SMOKE_TEST: '1' }, [...EXE, '--user-data-dir=C:\\t'], true)).toBe(false);
    });

    it('packaged: the argument with no env var is not smoke mode', () => {
        expect(decideSmokeTestMode({}, [...EXE, SMOKE_TEST_ARG, '--user-data-dir=C:\\t'], true)).toBe(false);
    });

    it('packaged: what scripts/smoke-test.mjs launches IS smoke mode (positive control)', () => {
        expect(decideSmokeTestMode({ CIPHERLINE_SMOKE_TEST: '1' }, [...EXE, SMOKE_TEST_ARG, '--user-data-dir=C:\\t\\cl-smoke-1'], true)).toBe(true);
    });

    it('unpackaged (dev): env var alone still works', () => {
        expect(decideSmokeTestMode({ CIPHERLINE_SMOKE_TEST: '1' }, ['electron', '.'], false)).toBe(true);
        expect(decideSmokeTestMode({}, ['electron', '.'], false)).toBe(false);
    });

    it('the harness passes exactly the argument main expects, plus a profile dir, on every platform', () => {
        const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-test.mjs'), 'utf8');
        expect(harness).toContain(`const SMOKE_TEST_ARG = '${SMOKE_TEST_ARG}';`);
        expect(harness).toContain('args: [SMOKE_TEST_ARG, `--user-data-dir=${smokeUserDataDir}`]');
        expect(harness).toContain("CIPHERLINE_SMOKE_TEST: '1'");
    });

    it('main.ts and storage.ts both use the shared decision, not the bare env var', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain('const IS_SMOKE_TEST = decideSmokeTestMode(process.env, process.argv, IS_PACKAGED);');
        const storage = fs.readFileSync(path.join(__dirname, 'storage.ts'), 'utf8');
        expect(storage).not.toMatch(/if \(process\.env\.CIPHERLINE_SMOKE_TEST\)/);
        expect(storage).toContain('decideSmokeTestMode(process.env, process.argv, packaged)');
    });
});
