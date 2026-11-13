/**
 * Your "Listening to" settings on THIS device (Settings > Connections):
 * whether to share at all (OFF by default), whether a browser counts, and
 * whether videos are shared too ("Watching", its OWN opt-in, off by default:
 * agreeing to share music is not agreeing to share what you watch). Stored per account in secureLocalStore
 * and restored with a backup (services/backupRegistry.ts), so restoring onto
 * another computer turns sharing on there too.
 *
 * The stored share value says more than `share` does: null = never set, '0' =
 * this person turned it off themselves, '1' = on. Only the switch writes it, and
 * only with an explicit value, so listeningAsk.ts can treat '0' as an answer.
 */
import { useSyncExternalStore } from 'react';
import secureLocalStore from '../secureLocalStore';
import { BACKUP_RESTORED_EVENT } from '../../services/backupRegistry';

export const listeningShareKey = (uid: string) => `cipherline_listening_share_${uid}`;
export const listeningBrowserKey = (uid: string) => `cipherline_listening_browser_${uid}`;
export const listeningWatchingKey = (uid: string) => `cipherline_listening_watching_${uid}`;

export interface ListeningPrefs { share: boolean; includeBrowser: boolean; includeWatching: boolean }

const OFF: ListeningPrefs = { share: false, includeBrowser: false, includeWatching: false };
const subs = new Set<() => void>();
const cache = new Map<string, ListeningPrefs>();
const waited = new Set<string>();

export function getListeningPrefs(uid: string | null | undefined): ListeningPrefs {
    if (!uid) return OFF;
    let p = cache.get(uid);
    if (!p) {
        // Before the account's records load every read says "off", whatever is
        // stored. Remembering that kept a switch that was on showing off until the
        // next restart, so wait and read again (once: a uid that is not the active
        // account stays off rather than looping).
        if (!secureLocalStore.isAccountReady(uid)) {
            if (!waited.has(uid)) {
                waited.add(uid);
                void secureLocalStore.whenAccountReady().catch(() => undefined).then(() => { for (const s of subs) s(); });
            }
            return OFF;
        }
        p = {
            share: secureLocalStore.getItem(listeningShareKey(uid)) === '1',
            includeBrowser: secureLocalStore.getItem(listeningBrowserKey(uid)) === '1',
            includeWatching: secureLocalStore.getItem(listeningWatchingKey(uid)) === '1',
        };
        cache.set(uid, p);
    }
    return p;
}

export function setListeningPrefs(uid: string, patch: Partial<ListeningPrefs>): void {
    const next = { ...getListeningPrefs(uid), ...patch };
    // Literal keys at the call site: services/backupRegistry.test.ts scans for them.
    if (patch.share !== undefined) secureLocalStore.setItem(`cipherline_listening_share_${uid}`, next.share ? '1' : '0');
    if (patch.includeBrowser !== undefined) secureLocalStore.setItem(`cipherline_listening_browser_${uid}`, next.includeBrowser ? '1' : '0');
    if (patch.includeWatching !== undefined) secureLocalStore.setItem(`cipherline_listening_watching_${uid}`, next.includeWatching ? '1' : '0');
    cache.set(uid, next);
    for (const s of subs) s();
}

/** Forget the parsed copy (account switch: the store re-binds per account). */
export function resetListeningPrefsCache(): void { cache.clear(); waited.clear(); for (const s of subs) s(); }

// A live restore rewrites the stored values underneath the parsed copy.
if (typeof window !== 'undefined') window.addEventListener(BACKUP_RESTORED_EVENT, () => resetListeningPrefsCache());

export function useListeningPrefs(uid: string | null | undefined): ListeningPrefs {
    return useSyncExternalStore(
        (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
        () => getListeningPrefs(uid),
    );
}
