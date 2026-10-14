/**
 * Live backup state for anything that nudges the user to "set up backups".
 *
 * The Home tile and the onboarding checklist both used to derive their state
 * from secureLocalStore when they rendered and nothing told them it had
 * changed, so they stayed on screen after the user configured backups or ran
 * one — until the dashboard happened to remount. Every backup-state write now
 * fires BACKUP_STATE_EVENT (services/driveBackup.ts), and a restore fires
 * BACKUP_RESTORED_EVENT; these hooks re-render on both and re-read.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BACKUP_STATE_EVENT, getLastBackupMs } from '../services/driveBackup';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import { isAutoBackupConfigured, readBackupBlocked } from './useBackupAutoSchedule';
import { computeBackupNudge, type BackupNudge, type BackupBlockedReason } from '../utils/backupNudge';

// One shared window subscription for every consumer, and a monotonically
// increasing version as the store snapshot (stable between events, so
// useSyncExternalStore never loops).
let version = 0;
const listeners = new Set<() => void>();
const onBackupEvent = () => {
    version++;
    for (const l of [...listeners]) l();
};

function subscribe(listener: () => void): () => void {
    if (listeners.size === 0) {
        window.addEventListener(BACKUP_STATE_EVENT, onBackupEvent);
        window.addEventListener(BACKUP_RESTORED_EVENT, onBackupEvent);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            window.removeEventListener(BACKUP_STATE_EVENT, onBackupEvent);
            window.removeEventListener(BACKUP_RESTORED_EVENT, onBackupEvent);
        }
    };
}
const getVersion = () => version;

/** Re-renders the caller on every backup-state change. Call it, then read
 *  whatever backup state you need straight from the store during render. */
export function useBackupStateVersion(): number {
    return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export interface BackupStateSnapshot {
    lastBackupMs: number | null;
    /** Automatic backups on, pointed at a real destination. */
    configured: boolean;
    blocked: BackupBlockedReason | null;
}

/** Current backup state, re-read whenever it changes. */
export function useBackupState(userId: string | null | undefined): BackupStateSnapshot {
    useBackupStateVersion();
    if (!userId) return { lastBackupMs: null, configured: false, blocked: null };
    return { lastBackupMs: getLastBackupMs(userId), configured: isAutoBackupConfigured(userId), blocked: readBackupBlocked(userId) };
}

/** Time the tile's exit animation takes (home-deck.css `hd-tile-out`). */
export const BACKUP_TILE_EXIT_MS = 240;

function prefersReducedMotion(): boolean {
    try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { return false; }
}

export interface BackupNudgeView {
    /** The nudge to paint, if any — held for the exit animation after the
     *  underlying condition clears. Also what the deck's alert count should
     *  key off, so the leaving tile isn't resized mid-fade. */
    tile: BackupNudge | null;
    /** True while the tile is animating out (render it inert, with the exit class). */
    leaving: boolean;
}

/**
 * The Home backup tile's view-model: current nudge, live, with a short exit
 * hold so it fades out instead of popping. Reduced motion skips the hold.
 */
export function useBackupNudge(userId: string | null | undefined, muted: boolean): BackupNudgeView {
    const snap = useBackupState(userId);
    const nudge = muted ? null : computeBackupNudge(snap.lastBackupMs, { configured: snap.configured, blocked: snap.blocked });

    // computeBackupNudge returns a fresh object every call, so track identity
    // by content. The state is adjusted during render (React's documented
    // pattern for derived state) so the very first frame after the condition
    // clears is already the exit frame — no flash of the tile in its old form.
    const key = nudge ? `${nudge.chip}|${nudge.title}` : null;
    const [prevKey, setPrevKey] = useState<string | null>(key);
    const [held, setHeld] = useState<BackupNudge | null>(nudge);
    const [exiting, setExiting] = useState(false);
    if (key !== prevKey) {
        setPrevKey(key);
        if (nudge) {
            setHeld(nudge);
            setExiting(false);
        } else if (held && !prefersReducedMotion()) {
            setExiting(true);
        } else {
            setHeld(null);
            setExiting(false);
        }
    }

    useEffect(() => {
        if (!exiting) return;
        const t = setTimeout(() => { setExiting(false); setHeld(null); }, BACKUP_TILE_EXIT_MS);
        return () => clearTimeout(t);
    }, [exiting]);

    if (nudge) return { tile: nudge, leaving: false };
    if (exiting && held) return { tile: held, leaving: true };
    return { tile: null, leaving: false };
}
