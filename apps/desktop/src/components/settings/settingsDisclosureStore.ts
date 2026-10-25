import { useCallback, useSyncExternalStore } from 'react';
import { secureLocalStore } from '../../utils/secureLocalStore';

/**
 * Which Settings disclosure rows ("Advanced audio", "Troubleshooting", …) the
 * user left open, so a section looks the way they left it next time.
 *
 * One small JSON map `{ [disclosureId]: boolean }` in secureLocalStore (the
 * renderer never writes plaintext localStorage). Device-local UI state —
 * classified `include: false` in services/backupRegistry.ts. A missing id
 * means "use the disclosure's own default", so adding a new disclosure never
 * needs a migration, and a corrupt blob degrades to all-defaults.
 */
const STORE_KEY = 'cipherline_settings_disclosures';

type OpenMap = Record<string, boolean>;

let cache: OpenMap | null = null;
const listeners = new Set<() => void>();

function read(): OpenMap {
    if (cache) return cache;
    let parsed: OpenMap = {};
    try {
        const raw = secureLocalStore.getItem(STORE_KEY);
        if (raw) {
            const v: unknown = JSON.parse(raw);
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                for (const [k, b] of Object.entries(v as Record<string, unknown>)) {
                    if (typeof b === 'boolean') parsed[k] = b;
                }
            }
        }
    } catch {
        parsed = {};
    }
    cache = parsed;
    return parsed;
}

/** The remembered open state for `id`, or `fallback` when never toggled. */
export function getDisclosureOpen(id: string, fallback: boolean): boolean {
    const v = read()[id];
    return typeof v === 'boolean' ? v : fallback;
}

export function setDisclosureOpen(id: string, open: boolean): void {
    const next = { ...read(), [id]: open };
    cache = next;
    try {
        secureLocalStore.setItem('cipherline_settings_disclosures', JSON.stringify(next));
    } catch {
        // Locked/unavailable store: the row still toggles for this session.
    }
    listeners.forEach(l => l());
}

function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

/** [open, setOpen] for one disclosure, remembered across opens of Settings. */
export function useDisclosureOpen(id: string, defaultOpen = false): [boolean, (open: boolean) => void] {
    const open = useSyncExternalStore(subscribe, () => getDisclosureOpen(id, defaultOpen));
    const set = useCallback((v: boolean) => setDisclosureOpen(id, v), [id]);
    return [open, set];
}

/** Test seam: forget the in-memory copy so the next read hits the store. */
export function __resetDisclosureCache(): void {
    cache = null;
}
