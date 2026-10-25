import { useSyncExternalStore } from 'react';
import { secureLocalStore } from './secureLocalStore';
import { normalizeHex } from './colourMath';

/**
 * The colour picker's "Recent" row: the last few colours the user committed,
 * most recent first, deduplicated, lowercase `#rrggbb`.
 *
 * Persisted as a JSON array in secureLocalStore (the renderer never touches
 * raw localStorage). Device-local UI nicety, classified `include: false` in
 * services/backupRegistry.ts. A locked / unavailable store never throws: the
 * list simply lives in memory for the session. External-store shaped so two
 * open pickers (and the Settings preview) stay in sync.
 */
const STORE_KEY = 'cipherline_recent_colours';
export const MAX_RECENT = 8;

const EMPTY: readonly string[] = Object.freeze([]);

/** Lenient parse of the stored blob; a corrupt one degrades to empty. */
export function parseRecent(raw: string | null | undefined): readonly string[] {
    if (!raw) return EMPTY;
    try {
        const v: unknown = JSON.parse(raw);
        if (!Array.isArray(v)) return EMPTY;
        const out: string[] = [];
        for (const item of v) {
            const hex = typeof item === 'string' ? normalizeHex(item) : null;
            if (hex && !out.includes(hex)) out.push(hex);
            if (out.length >= MAX_RECENT) break;
        }
        return out;
    } catch {
        return EMPTY;
    }
}

let lastRaw: string | null = null;
let lastList: readonly string[] = EMPTY;
/** Set when a write failed (locked store): keep serving the in-memory list. */
let pinned = false;
const listeners = new Set<() => void>();

function readRaw(): string | null {
    try { return secureLocalStore.getItem(STORE_KEY); } catch { return null; }
}

/** Stable-reference snapshot: the same array until the stored value changes. */
export function getRecentColours(): readonly string[] {
    if (pinned) return lastList;
    const raw = readRaw();
    if (raw !== lastRaw) {
        lastRaw = raw;
        lastList = parseRecent(raw);
    }
    return lastList;
}

export function subscribeRecentColours(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Records a committed colour at the front. Invalid input is ignored. */
export function pushRecentColour(hex: string): void {
    const n = normalizeHex(hex);
    if (!n) return;
    const next = [n, ...getRecentColours().filter(c => c !== n)].slice(0, MAX_RECENT);
    const json = JSON.stringify(next);
    try {
        secureLocalStore.setItem('cipherline_recent_colours', json);
        pinned = false;
    } catch {
        pinned = true;
    }
    lastRaw = json;
    lastList = next;
    listeners.forEach(l => l());
}

/** Test seam: forget the cached snapshot and any pinned in-memory list. */
export function __resetRecentColoursForTests(): void {
    lastRaw = null;
    lastList = EMPTY;
    pinned = false;
    listeners.forEach(l => l());
}

export function useRecentColours(): readonly string[] {
    return useSyncExternalStore(subscribeRecentColours, getRecentColours, () => EMPTY);
}
