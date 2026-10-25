/**
 * F9 — a NEW backup passphrase must meet the registration bar (zxcvbn >= 3);
 * a passphrase already saved on this device keeps working, and restore never
 * checks strength. Uses the real zxcvbn.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zxcvbn from 'zxcvbn';
import { judgeBackupPassphrase, MIN_BACKUP_PASSPHRASE_SCORE } from './backupPassphrasePolicy';

describe('judgeBackupPassphrase', () => {
    it.each(['password', 'hunter2', 'cipherline1', 'qwertyuiop', 'aaaaaaaaaaaa', 'alice2026'])('refuses a weak new passphrase: %s', (pw) => {
        const v = judgeBackupPassphrase(pw, null, zxcvbn, ['alice']);
        expect(v.ok).toBe(false);
        expect(v.score).toBeLessThan(MIN_BACKUP_PASSPHRASE_SCORE);
        expect(v.message).toMatch(/stronger passphrase/);
    });
    it('treats the account name as guessable', () => {
        expect(judgeBackupPassphrase('dawsonkraai', null, zxcvbn, ['dawsonkraai']).ok).toBe(false);
    });
    it('accepts a strong new passphrase', () => {
        const v = judgeBackupPassphrase('correct horse battery staple orbit', null, zxcvbn);
        expect(v).toMatchObject({ ok: true, existing: false });
        expect(v.score).toBeGreaterThanOrEqual(3);
    });
    it('keeps an EXISTING saved passphrase working, however weak (compat)', () => {
        expect(judgeBackupPassphrase('hunter2', 'hunter2', zxcvbn)).toEqual({ ok: true, existing: true, score: null, message: null });
    });
    it('changing away from a saved passphrase is a new choice and is checked', () => {
        expect(judgeBackupPassphrase('hunter3', 'hunter2', zxcvbn).ok).toBe(false);
    });
    it('empty is refused', () => {
        expect(judgeBackupPassphrase('', null, zxcvbn).ok).toBe(false);
    });
});

describe('F9 wiring — BackupSection', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'BackupSection.tsx'), 'utf8');
    it('both paths that save a passphrase check it first', () => {
        const now = src.slice(src.indexOf('const onBackupNow = useCallback'), src.indexOf('const handleToggleAuto = useCallback'));
        expect(now.indexOf('await checkNewPassphrase()')).toBeGreaterThan(-1);
        expect(now.indexOf('await checkNewPassphrase()')).toBeLessThan(now.indexOf('setCachedPassword(password)'));
        const auto = src.slice(src.indexOf('const handleToggleAuto = useCallback'), src.indexOf('const startRestore = useCallback'));
        expect(auto.indexOf('await checkNewPassphrase()')).toBeGreaterThan(-1);
        expect(auto.indexOf('await checkNewPassphrase()')).toBeLessThan(auto.indexOf('setCachedPassword(password)'));
    });
    it('restore never consults the strength rule', () => {
        const restore = src.slice(src.indexOf('const doRestore = useCallback'), src.indexOf('const doRestore = useCallback') + 3000);
        expect(restore).not.toContain('checkNewPassphrase');
        expect(restore).not.toContain('judgeBackupPassphrase');
    });
});
