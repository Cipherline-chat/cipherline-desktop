/**
 * One shared view of the host's near session. Every near screen (first screen, Add a device, the transfer
 * banner) reads the SAME snapshot, because the host runs one session at a time. Events carry a `seq`; one that is
 * older than what was applied is dropped (the host re-sends nothing out of order, but IPC is not ordered).
 */
import type { NearSnapshot } from '../types/near';

export interface NearStoreApi {
    nearGetState?: () => Promise<NearSnapshot>;
    onNearState?: (cb: (s: NearSnapshot) => void) => (() => void);
}

export interface NearStore {
    getSnapshot(): NearSnapshot | null;
    subscribe(l: () => void): () => void;
    /** Drop the stored snapshot (a screen that starts a fresh session after a terminal one). */
    clear(): void;
    dispose(): void;
}

/** Shape check only (the page never trusts a host event blindly, it also must not crash on a malformed one). */
export function isSnapshotLike(s: unknown): s is NearSnapshot {
    return !!s && typeof s === 'object' && typeof (s as NearSnapshot).seq === 'number' && typeof (s as NearSnapshot).state === 'string';
}

export function createNearStore(api: NearStoreApi | undefined | null): NearStore {
    let snap: NearSnapshot | null = null;
    const listeners = new Set<() => void>();
    let off: (() => void) | undefined;
    let disposed = false;
    const apply = (s: unknown) => {
        if (disposed || !isSnapshotLike(s)) return;
        if (snap && s.seq < snap.seq) return;
        snap = s;
        listeners.forEach(l => l());
    };
    try { off = api?.onNearState?.(apply); } catch { off = undefined; }
    void (async () => { try { apply(await api?.nearGetState?.()); } catch { /* not available */ } })();
    return {
        getSnapshot: () => snap,
        subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
        clear() { snap = null; listeners.forEach(l => l()); },
        dispose() { disposed = true; try { off?.(); } catch { /* ignore */ } listeners.clear(); },
    };
}

let shared: NearStore | null = null;
/** The app-wide store, created on first use against `window.electronAPI`. */
export function getNearStore(): NearStore {
    if (!shared) shared = createNearStore(typeof window !== 'undefined' ? window.electronAPI : undefined);
    return shared;
}
/** Test seam. */
export function setNearStoreForTest(s: NearStore | null): void { shared?.dispose(); shared = s; }
