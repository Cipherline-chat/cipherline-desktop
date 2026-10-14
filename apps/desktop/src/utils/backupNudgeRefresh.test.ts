// @vitest-environment jsdom
/**
 * The Home backup tile ("You have no backup yet") used to be computed from
 * secureLocalStore on render. Nothing about configuring backups or a backup
 * finishing re-rendered Home, so the tile stayed up after the user did what it
 * asked. Every backup-state write now fires BACKUP_STATE_EVENT and the tile
 * (hooks/useBackupState) re-reads on it. Behavioural coverage of the tile
 * itself lives in hooks/useBackupState.test.ts.
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

// Notifications are deferred to a microtask (and coalesced) so a config write
// made inside a React state updater can't setState a subscriber mid-render.
const count = async (fn: () => void) => {
    let n = 0; const on = () => { n++; };
    window.addEventListener(BACKUP_STATE_EVENT, on);
    try { fn(); await Promise.resolve(); await Promise.resolve(); } finally { window.removeEventListener(BACKUP_STATE_EVENT, on); }
    return n;
};

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('backup state changes notify the Home tile', () => {
    it('a completed backup fires the event, and the nudge it recomputes is gone', async () => {
        expect(computeBackupNudge(getLastBackupMs('u1'))?.title).toBe('You have no backup yet');
        expect(await count(() => stampLastBackup('u1', new Date().toISOString()))).toBe(1);
        expect(computeBackupNudge(getLastBackupMs('u1'))).toBeNull();
    });

    it('saving the backup config fires the event', async () => {
        expect(await count(() => writeBackupCfg('u1', { enabled: true, driveEnabled: true } as never))).toBe(1);
    });

    it('several writes in one tick coalesce into one event', async () => {
        expect(await count(() => {
            writeBackupCfg('u1', { enabled: true, driveEnabled: true } as never);
            stampLastBackup('u1', new Date().toISOString());
        })).toBe(1);
    });

    it("the event is not delivered synchronously (never inside another component's render)", async () => {
        let n = 0; const on = () => { n++; };
        window.addEventListener(BACKUP_STATE_EVENT, on);
        stampLastBackup('u1', new Date().toISOString());
        const sync = n;
        await Promise.resolve();
        window.removeEventListener(BACKUP_STATE_EVENT, on);
        expect(sync).toBe(0);
        expect(n).toBe(1);
    });

    it('control: a plain secureLocalStore write (the old path) fires nothing', async () => {
        expect(await count(() => store.set('cipherline_drive_last_backup_u1', new Date().toISOString()))).toBe(0);
    });

    it('HomePanel and the onboarding checklist subscribe through the live hooks', () => {
        const home = read('../components/HomePanel.tsx');
        expect(home).toMatch(/useBackupNudge\(userId, backupMuted\)/);
        expect(home).toMatch(/useBackupState\(userId\)/);
        // The read-once computation must not creep back in.
        expect(home).not.toMatch(/computeBackupNudge\(getLastBackupMs/);
        expect(read('../components/OnboardingChecklist.tsx')).toMatch(/useBackupStateVersion\(\)/);
        const hook = read('../hooks/useBackupState.ts');
        expect(hook).toMatch(/addEventListener\(BACKUP_STATE_EVENT, onBackupEvent\)/);
        expect(hook).toMatch(/addEventListener\(BACKUP_RESTORED_EVENT, onBackupEvent\)/);
        expect(hook).toMatch(/removeEventListener\(BACKUP_STATE_EVENT, onBackupEvent\)/);
    });

    it('runBackup announces start and failure as well as completion', () => {
        const src = read('../services/driveBackup.ts');
        expect(src).toMatch(/notifyBackupStateChanged\(\); \/\/ run started/);
        expect(src).toMatch(/notifyBackupStateChanged\(\); \/\/ run finished/);
        expect(src).toMatch(/notifyBackupStateChanged\(\); \/\/ run failed/);
    });
});
