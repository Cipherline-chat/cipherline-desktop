// @vitest-environment jsdom
/**
 * The "set up backups" nudges must update in place. Before, they read
 * secureLocalStore once per render and stayed on screen after backups were
 * configured or a backup completed — until the dashboard remounted.
 * These mount a real hook under React and drive the same writes the app does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

const { stampLastBackup, notifyBackupStateChanged } = await import('../services/driveBackup');
const { writeBackupCfg, hasBackupSetUp } = await import('./useBackupAutoSchedule');
const { BACKUP_RESTORED_EVENT } = await import('../services/backupRegistry');
const { useBackupNudge, useBackupStateVersion, BACKUP_TILE_EXIT_MS } = await import('./useBackupState');
const { computeBackupNudge } = await import('../utils/backupNudge');
const { getLastBackupMs } = await import('../services/driveBackup');

const UID = 'u1';
let mounts = 0;
let root: Root | null = null;
let host: HTMLDivElement;

/** Mirrors HomePanel's wiring: the live view-model → the tile element. */
const Tile: React.FC<{ muted?: boolean }> = ({ muted = false }) => {
    React.useEffect(() => { mounts++; }, []);
    const v = useBackupNudge(UID, muted);
    if (!v.tile) return React.createElement('div', { 'data-none': '1' });
    return React.createElement('section', { 'data-tile': v.tile.title, 'data-leaving': v.leaving ? '1' : '0' });
};

/** The OLD behaviour: derive once, never subscribe. Negative control. */
const ReadOnceTile: React.FC = () => {
    const n = React.useMemo(() => computeBackupNudge(getLastBackupMs(UID)), []);
    return React.createElement('div', { 'data-old': n ? n.title : 'none' });
};

/** The onboarding checklist's backup row: live version → hasBackupSetUp. */
const ChecklistRow: React.FC = () => {
    useBackupStateVersion();
    const done = hasBackupSetUp(UID);
    return React.createElement('div', { 'data-done': done ? '1' : '0' });
};

const mount = (el: React.ReactElement) => {
    host = document.createElement('div');
    root = createRoot(host);
    act(() => { root!.render(el); });
};
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tile = () => host.querySelector('[data-tile]') as HTMLElement | null;

const stubMotion = (reduce: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
};

beforeEach(() => { store.clear(); mounts = 0; stubMotion(false); });
afterEach(() => { act(() => { root?.unmount(); }); root = null; vi.useRealTimers(); });

describe('Home backup tile is live', () => {
    it('shows "no backup yet" when nothing is configured', () => {
        mount(React.createElement(Tile));
        expect(tile()?.dataset.tile).toBe('You have no backup yet');
    });

    it('configuring automatic backups hides it immediately, without a remount', async () => {
        vi.useFakeTimers();
        mount(React.createElement(Tile));
        expect(tile()).not.toBeNull();
        await act(async () => { writeBackupCfg(UID, { enabled: true, driveEnabled: true } as never); });
        await flush();
        expect(tile()?.dataset.leaving).toBe('1');          // fading out…
        await act(async () => { vi.advanceTimersByTime(BACKUP_TILE_EXIT_MS + 10); });
        expect(tile()).toBeNull();                          // …and gone
        expect(mounts).toBe(1);                             // same component instance throughout
    });

    it('a completed backup hides it immediately, without a remount', async () => {
        vi.useFakeTimers();
        mount(React.createElement(Tile));
        expect(tile()).not.toBeNull();
        await act(async () => { stampLastBackup(UID, new Date().toISOString()); });
        await flush();
        expect(tile()?.dataset.leaving).toBe('1');
        await act(async () => { vi.advanceTimersByTime(BACKUP_TILE_EXIT_MS + 10); });
        expect(tile()).toBeNull();
        expect(mounts).toBe(1);
    });

    it('a failed backup does NOT hide it (nothing was stamped)', async () => {
        vi.useFakeTimers();
        mount(React.createElement(Tile));
        await act(async () => { notifyBackupStateChanged(); });   // what runBackup emits on start / failure
        await flush();
        await act(async () => { vi.advanceTimersByTime(BACKUP_TILE_EXIT_MS * 3); });
        expect(tile()?.dataset.tile).toBe('You have no backup yet');
        expect(tile()?.dataset.leaving).toBe('0');
    });

    it('a stalled schedule (missing passphrase) keeps an actionable tile after the config is saved', async () => {
        mount(React.createElement(Tile));
        store.set(`cipherline_backup_blocked_${UID}`, 'no-passphrase');
        await act(async () => { writeBackupCfg(UID, { enabled: true, driveEnabled: true } as never); });
        await flush();
        expect(tile()?.dataset.tile).toBe("Automatic backups aren't running");
    });

    it('a restore re-evaluates the tile too', async () => {
        mount(React.createElement(Tile));
        store.set(`cipherline_backup_last_ts_${UID}`, String(Date.now()));
        await act(async () => { window.dispatchEvent(new CustomEvent(BACKUP_RESTORED_EVENT, { detail: { userId: UID } })); });
        expect(tile()?.dataset.leaving).toBe('1');
    });

    it('under reduced motion the tile leaves at once, with no exit state', async () => {
        stubMotion(true);
        mount(React.createElement(Tile));
        await act(async () => { stampLastBackup(UID, new Date().toISOString()); });
        await flush();
        expect(tile()).toBeNull();
    });

    it('muting hides it and a later event does not resurrect it', async () => {
        mount(React.createElement(Tile, { muted: true }));
        expect(tile()).toBeNull();
        await act(async () => { notifyBackupStateChanged(); });
        await flush();
        expect(tile()).toBeNull();
    });

    it('re-shows if the state regresses (new nudge after hiding)', async () => {
        vi.useFakeTimers();
        mount(React.createElement(Tile));
        await act(async () => { stampLastBackup(UID, new Date().toISOString()); });
        await flush();
        await act(async () => { vi.advanceTimersByTime(BACKUP_TILE_EXIT_MS + 10); });
        expect(tile()).toBeNull();
        store.set(`cipherline_backup_last_ts_${UID}`, String(Date.now() - 40 * 86_400_000));
        store.set(`cipherline_drive_last_backup_${UID}`, new Date(Date.now() - 40 * 86_400_000).toISOString());
        await act(async () => { notifyBackupStateChanged(); });
        await flush();
        expect(tile()?.dataset.leaving).toBe('0');
        expect(tile()?.dataset.tile).toMatch(/40 days ago/);
    });

    it('control: the old read-once derivation stays visible after the same writes', async () => {
        mount(React.createElement(ReadOnceTile));
        expect(host.querySelector('[data-old]')?.getAttribute('data-old')).toBe('You have no backup yet');
        await act(async () => { writeBackupCfg(UID, { enabled: true, driveEnabled: true } as never); stampLastBackup(UID, new Date().toISOString()); });
        await flush();
        expect(host.querySelector('[data-old]')?.getAttribute('data-old')).toBe('You have no backup yet');
    });
});

describe('other backup nudges are live', () => {
    it('the onboarding checklist row flips when backups are configured', async () => {
        mount(React.createElement(ChecklistRow));
        expect(host.querySelector('[data-done]')?.getAttribute('data-done')).toBe('0');
        await act(async () => { writeBackupCfg(UID, { enabled: true, driveEnabled: true } as never); });
        await flush();
        expect(host.querySelector('[data-done]')?.getAttribute('data-done')).toBe('1');
    });

    it('the onboarding checklist row flips when an (automatic) backup completes', async () => {
        mount(React.createElement(ChecklistRow));
        await act(async () => { stampLastBackup(UID, new Date().toISOString()); });
        await flush();
        expect(host.querySelector('[data-done]')?.getAttribute('data-done')).toBe('1');
    });

    it('control: a failed run leaves the checklist row undone', async () => {
        mount(React.createElement(ChecklistRow));
        await act(async () => { notifyBackupStateChanged(); });
        await flush();
        expect(host.querySelector('[data-done]')?.getAttribute('data-done')).toBe('0');
    });
});
