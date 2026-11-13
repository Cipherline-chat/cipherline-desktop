import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearMarker, parseMarker, readBootId, readMarker, shouldPreannounce, writeMarker } from './keyring-marker';

const BOOT_A = '3f6c1c0e-0f8e-4b8e-9d0d-1a2b3c4d5e6f';
const BOOT_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('shouldPreannounce', () => {
    it('announces when there is no marker (first launch, or the wallet was refused last time)', () => {
        expect(shouldPreannounce(BOOT_A, null)).toBe(true);
    });
    it('announces after a reboot (different boot id)', () => {
        expect(shouldPreannounce(BOOT_B, { bootId: BOOT_A })).toBe(true);
    });
    it('skips only when THIS boot already unlocked the wallet', () => {
        expect(shouldPreannounce(BOOT_A, { bootId: BOOT_A })).toBe(false);
    });
    it('announces when the boot id is unknown (never skip on a guess)', () => {
        expect(shouldPreannounce(null, { bootId: BOOT_A })).toBe(true);
    });
});

describe('boot id and marker parsing', () => {
    it('reads and validates the kernel boot id', () => {
        expect(readBootId(() => `${BOOT_A.toUpperCase()}\n`)).toBe(BOOT_A);
        expect(readBootId(() => { throw new Error('ENOENT'); })).toBeNull();
        expect(readBootId(() => 'not a boot id; rm -rf /')).toBeNull();
        expect(readBootId(() => '')).toBeNull();
    });

    it('parseMarker accepts only { bootId: <uuid-ish> }', () => {
        expect(parseMarker(JSON.stringify({ bootId: BOOT_A }))).toEqual({ bootId: BOOT_A });
        for (const bad of [null, '', 'x', '[]', '{}', '{"bootId":1}', '{"bootId":"../../etc"}', 'null']) expect(parseMarker(bad)).toBeNull();
    });
});

describe('marker file', () => {
    it('round-trips, holds nothing but the boot id, and can be cleared', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-marker-'));
        try {
            expect(readMarker(dir)).toBeNull();
            writeMarker(dir, BOOT_A);
            expect(readMarker(dir)).toEqual({ bootId: BOOT_A });
            expect(fs.readFileSync(path.join(dir, 'keyring-unlocked.json'), 'utf8')).toBe(JSON.stringify({ bootId: BOOT_A }));
            clearMarker(dir);
            expect(readMarker(dir)).toBeNull();
            clearMarker(dir); // idempotent
            writeMarker(dir, null); // no boot id, nothing written
            expect(fs.readdirSync(dir)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('IO failures are swallowed (a marker is an optimisation, never a failure)', () => {
        const boom = () => { throw new Error('EACCES'); };
        expect(readMarker('/nonexistent-dir-xyz')).toBeNull();
        expect(() => writeMarker('/x', BOOT_A, { writeFileSync: boom })).not.toThrow();
        expect(() => clearMarker('/x', { rmSync: boom })).not.toThrow();
    });
});
