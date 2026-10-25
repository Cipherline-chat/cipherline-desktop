import { useSyncExternalStore } from 'react';
import { secureLocalStore } from './secureLocalStore';

/**
 * YOUR listener settings for other people's entrance sounds: the global
 * "Play entrance sounds" switch (default on) and the people you muted.
 * Stored on this device only, under one per-account key in secureLocalStore
 * (encrypted at rest; included in the encrypted backup - see
 * services/backupRegistry.ts). Nothing here is sent anywhere.
 */

export interface EntrancePrefs { enabled: boolean; muted: string[] }

export const ENTRANCE_PREFS_KEY_PREFIX = 'cipherline_entrance_prefs_';
/** A hand-edited or runaway list cannot grow without bound. */
export const MAX_MUTED = 500;

export const entrancePrefsKey = (userId: string): string => `${ENTRANCE_PREFS_KEY_PREFIX}${userId}`;

export const DEFAULT_ENTRANCE_PREFS: EntrancePrefs = Object.freeze({ enabled: true, muted: [] }) as EntrancePrefs;

/** Stored JSON -> well-formed prefs. Garbage reads as the defaults. */
export function parseEntrancePrefs(raw: string | null | undefined): EntrancePrefs {
    if (!raw) return DEFAULT_ENTRANCE_PREFS;
    try {
        const o = JSON.parse(raw) as { enabled?: unknown; muted?: unknown };
        const muted = Array.isArray(o.muted)
            ? [...new Set(o.muted.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, MAX_MUTED)
            : [];
        return { enabled: o.enabled !== false, muted };
    } catch {
        return DEFAULT_ENTRANCE_PREFS;
    }
}

export function withMuted(p: EntrancePrefs, userId: string, mute: boolean): EntrancePrefs {
    const has = p.muted.includes(userId);
    if (mute === has) return p;
    return { ...p, muted: mute ? [...p.muted, userId].slice(-MAX_MUTED) : p.muted.filter(x => x !== userId) };
}

// ── account-bound store ─────────────────────────────────────────────────────

let account: string | null = null;
let current: EntrancePrefs = DEFAULT_ENTRANCE_PREFS;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Load this account's prefs (call after secureLocalStore.whenAccountReady()). */
export function bindEntrancePrefs(userId: string | null): void {
    account = userId;
    current = userId ? parseEntrancePrefs(secureLocalStore.getItem(entrancePrefsKey(userId))) : DEFAULT_ENTRANCE_PREFS;
    emit();
}

export function getEntrancePrefs(): EntrancePrefs { return current; }

function set(next: EntrancePrefs): void {
    if (next === current) return;
    current = next;
    // Literal key head on purpose: backupRegistry.test.ts finds new keys by scanning for it.
    if (account) secureLocalStore.setItem(`cipherline_entrance_prefs_${account}`, JSON.stringify(next));
    emit();
}

export function setEntranceSoundsEnabled(enabled: boolean): void { set({ ...current, enabled }); }
export function setEntranceMuted(userId: string, mute: boolean): void { set(withMuted(current, userId, mute)); }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useEntrancePrefs(): EntrancePrefs {
    return useSyncExternalStore(subscribe, getEntrancePrefs, getEntrancePrefs);
}

/** Is this person muted for entrance sounds? Re-renders on change. */
export function useEntranceMuted(userId: string | null | undefined): boolean {
    const p = useEntrancePrefs();
    return !!userId && p.muted.includes(userId);
}
