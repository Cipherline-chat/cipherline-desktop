/**
 * Your "Listening to" settings on THIS device (Settings > Connections):
 * whether to share at all (OFF by default) and whether music playing in a
 * browser counts. Stored per account in secureLocalStore and deliberately
 * left out of backups (services/backupRegistry.ts): reading this machine's
 * media session is a per-device decision, a restore must not switch it on.
 */
import { useSyncExternalStore } from 'react';
import secureLocalStore from '../secureLocalStore';

export const listeningShareKey = (uid: string) => `cipherline_listening_share_${uid}`;
export const listeningBrowserKey = (uid: string) => `cipherline_listening_browser_${uid}`;

export interface ListeningPrefs { share: boolean; includeBrowser: boolean }

const OFF: ListeningPrefs = { share: false, includeBrowser: false };
const subs = new Set<() => void>();
const cache = new Map<string, ListeningPrefs>();

export function getListeningPrefs(uid: string | null | undefined): ListeningPrefs {
    if (!uid) return OFF;
    let p = cache.get(uid);
    if (!p) {
        p = {
            share: secureLocalStore.getItem(listeningShareKey(uid)) === '1',
            includeBrowser: secureLocalStore.getItem(listeningBrowserKey(uid)) === '1',
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
    cache.set(uid, next);
    for (const s of subs) s();
}

/** Forget the parsed copy (account switch: the store re-binds per account). */
export function resetListeningPrefsCache(): void { cache.clear(); for (const s of subs) s(); }

export function useListeningPrefs(uid: string | null | undefined): ListeningPrefs {
    return useSyncExternalStore(
        (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
        () => getListeningPrefs(uid),
    );
}
