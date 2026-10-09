// @vitest-environment jsdom
/**
 * The Home backup tile ("You have no backup yet") is computed from
 * secureLocalStore on render. Nothing about configuring backups or a backup
 * finishing re-rendered Home, so the tile stayed up after the user did what it
 * asked. Every backup-state write now fires BACKUP_STATE_EVENT and HomePanel
 * re-renders on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

const { stampLastBackup, BACKUP_STATE_EVENT, getLastBackupMs } = await import('../services/driveBackup');
const { writeBackupCfg } = await import('../hooks/useBackupAutoSchedule');
const { computeBackupNudge } = await import('./backupNudge');

beforeEach(() => store.clear());

const count = (fn: () => void) => {
    let n = 0; const on = () => { n++; };
    window.addEventListener(BACKUP_STATE_EVENT, on);
    try { fn(); } finally { window.removeEventListener(BACKUP_STATE_EVENT, on); }
    return n;
};

describe('backup state changes notify the Home tile', () => {
    it('a completed backup fires the event, and the nudge it recomputes is gone', () => {
        expect(computeBackupNudge(getLastBackupMs('u1'))?.title).toBe('You have no backup yet');
        expect(count(() => stampLastBackup('u1', new Date().toISOString()))).toBe(1);
        expect(computeBackupNudge(getLastBackupMs('u1'))).toBeNull();
    });

    it('saving the backup config fires the event', () => {
        expect(count(() => writeBackupCfg('u1', { enabled: true, driveEnabled: true } as never))).toBe(1);
    });

    it('control: a plain secureLocalStore write (the old path) fires nothing', () => {
        expect(count(() => store.set('cipherline_drive_last_backup_u1', new Date().toISOString()))).toBe(0);
    });

    it('HomePanel re-renders on the event (and on a restore)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../components/HomePanel.tsx'), 'utf8');
        expect(src).toMatch(/addEventListener\(BACKUP_STATE_EVENT, bump\)/);
        expect(src).toMatch(/addEventListener\(BACKUP_RESTORED_EVENT, bump\)/);
        expect(src).toMatch(/removeEventListener\(BACKUP_STATE_EVENT, bump\)/);
    });
});
