import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isRingHex, type ThemeLike } from './callPersonalizationStyle';
import { isEntranceSoundValue } from './entranceSounds';

/**
 * Other people's call cosmetics (speaking-ring colour, entrance sound, profile
 * theme) keyed by user id, for the call UI.
 *
 * One batched read feeds every surface: a component that shows someone calls
 * `useCallPersonalization(uid)`, which registers the id; ids registered in the
 * same ~60 ms window go out as ONE `GET /v1/personalization?ids=` (<= 50 per
 * request). Each id is cached for CACHE_TTL_MS (a stale one is re-read the
 * next time a component mounts for it) and an id with all-default values is
 * cached as such, so a 30-row voice list costs one request, not 30.
 *
 * Per-id subscriptions (same shape as callSpeakingStore): a change re-renders
 * only the rows showing THAT person.
 *
 * No network code here: CallPersonalizationHost injects the transport, which
 * keeps this testable in vitest's node environment. Cosmetic data, so every
 * failure is silent and falls back to defaults.
 */

export interface CallPersonalization {
    ring_color: string | null;
    entrance_sound: string | null;
    theme: ThemeLike | null;
}

export interface PersonalizationTransport {
    /** Batch read; resolves `{ [user_id]: entry }` (absent = all defaults). */
    read: (ids: string[]) => Promise<Record<string, Partial<CallPersonalization>>>;
    /** Save the caller's own settings; resolves the stored result. */
    save: (patch: { ring_color?: string | null; entrance_sound?: string | null }) =>
        Promise<{ ring_color: string | null; entrance_sound: string | null }>;
}

export const CACHE_TTL_MS = 5 * 60_000;
export const BATCH_WINDOW_MS = 60;
export const MAX_IDS_PER_REQUEST = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULTS: CallPersonalization = Object.freeze({ ring_color: null, entrance_sound: null, theme: null });

interface Slot { value: CallPersonalization; fetchedAt: number }

const slots = new Map<string, Slot>();
const listeners = new Map<string, Set<() => void>>();
const queued = new Set<string>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let transport: PersonalizationTransport | null = null;
let now: () => number = () => Date.now();

function notify(id: string): void { listeners.get(id)?.forEach(l => l()); }

/** Whatever a server (or a newer/older build) sent -> a value safe to render. */
export function sanitizeEntry(raw: Partial<CallPersonalization> | null | undefined): CallPersonalization {
    if (!raw || typeof raw !== 'object') return DEFAULTS;
    const t = raw.theme;
    return {
        ring_color: isRingHex(raw.ring_color) ? raw.ring_color : null,
        entrance_sound: isEntranceSoundValue(raw.entrance_sound) ? raw.entrance_sound : null,
        theme: t && typeof t === 'object' && isRingHex(t.primary) ? { primary: t.primary, accent: isRingHex(t.accent) ? t.accent : null } : null,
    };
}

export function getCallPersonalization(uid: string): CallPersonalization {
    return slots.get(uid)?.value ?? DEFAULTS;
}

function isFresh(uid: string, maxAgeMs: number): boolean {
    const s = slots.get(uid);
    return !!s && now() - s.fetchedAt < maxAgeMs;
}

function flush(): void {
    timer = null;
    const t = transport;
    if (!t) return; // not bound yet (signed out); the next request retries
    const ids = [...queued];
    queued.clear();
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        chunk.forEach(id => inFlight.add(id));
        void t.read(chunk).then(res => {
            const at = now();
            for (const id of chunk) {
                const prev = slots.get(id)?.value;
                const next = sanitizeEntry(res?.[id]);
                slots.set(id, { value: next, fetchedAt: at });
                if (!prev || prev.ring_color !== next.ring_color || prev.entrance_sound !== next.entrance_sound
                    || prev.theme?.primary !== next.theme?.primary) notify(id);
            }
        }).catch(() => { /* cosmetic: keep whatever we had */ }).finally(() => {
            chunk.forEach(id => inFlight.delete(id));
        });
    }
}

/**
 * Ask for these users' cosmetics (no-op for fresh / in-flight / malformed
 * ids). Batched; returns nothing - read the store or subscribe.
 */
export function requestCallPersonalization(ids: readonly string[], maxAgeMs: number = CACHE_TTL_MS): void {
    for (const id of ids) {
        if (!UUID.test(id) || inFlight.has(id) || isFresh(id, maxAgeMs)) continue;
        queued.add(id);
    }
    if (queued.size > 0 && !timer) timer = setTimeout(flush, BATCH_WINDOW_MS);
}

/**
 * For the entrance sound: resolve with this person's CURRENT cosmetics, at
 * most `maxAgeMs` old (a joiner may have just changed their sound). Falls back
 * to the cached value on any failure.
 */
export async function freshCallPersonalization(uid: string, maxAgeMs = 30_000): Promise<CallPersonalization> {
    const t = transport;
    if (!t || !UUID.test(uid)) return getCallPersonalization(uid);
    if (!isFresh(uid, maxAgeMs)) {
        try {
            const res = await t.read([uid]);
            slots.set(uid, { value: sanitizeEntry(res?.[uid]), fetchedAt: now() });
            notify(uid);
        } catch { /* keep cached */ }
    }
    return getCallPersonalization(uid);
}

/** Apply the caller's own values locally (after a save, or the boot read). */
export function setOwnCallPersonalization(uid: string, patch: Partial<Pick<CallPersonalization, 'ring_color' | 'entrance_sound'>>): void {
    const prev = getCallPersonalization(uid);
    slots.set(uid, { value: sanitizeEntry({ ...prev, ...patch }), fetchedAt: now() });
    notify(uid);
}

/**
 * Save the caller's own ring colour / entrance sound. Optimistic; on failure
 * the previous value is restored and the rejection is rethrown so the picker
 * can say so.
 */
export async function saveOwnCallPersonalization(
    uid: string,
    patch: { ring_color?: string | null; entrance_sound?: string | null },
): Promise<void> {
    const t = transport;
    if (!t) throw new Error('offline');
    const before = getCallPersonalization(uid);
    setOwnCallPersonalization(uid, patch);
    try {
        const saved = await t.save(patch);
        setOwnCallPersonalization(uid, saved);
    } catch (err) {
        slots.set(uid, { value: before, fetchedAt: now() });
        notify(uid);
        throw err;
    }
}

export function bindCallPersonalizationTransport(t: PersonalizationTransport | null): void {
    transport = t;
    if (!t) clearCallPersonalization();
}

export function clearCallPersonalization(): void {
    const ids = [...slots.keys()];
    slots.clear(); queued.clear(); inFlight.clear();
    if (timer) { clearTimeout(timer); timer = null; }
    ids.forEach(notify);
}

function subscribe(uid: string, l: () => void): () => void {
    let set = listeners.get(uid);
    if (!set) { set = new Set(); listeners.set(uid, set); }
    set.add(l);
    return () => {
        const s = listeners.get(uid);
        if (!s) return;
        s.delete(l);
        if (s.size === 0) listeners.delete(uid);
    };
}

/**
 * One person's call cosmetics. Registers the id for the batched read on
 * mount. The returned object is referentially stable until the value changes.
 */
export function useCallPersonalization(uid: string | null | undefined): CallPersonalization {
    const id = uid ?? '';
    const sub = useCallback((l: () => void) => subscribe(id, l), [id]);
    const value = useSyncExternalStore(sub, () => getCallPersonalization(id), () => DEFAULTS);
    useEffect(() => { if (id) requestCallPersonalization([id]); }, [id]);
    return value;
}

/** Test hooks. */
export function __setPersonalizationClockForTests(fn: (() => number) | null): void { now = fn ?? (() => Date.now()); }
export function __flushPersonalizationForTests(): void { if (timer) { clearTimeout(timer); } flush(); }
export function __personalizationListenerCount(): number {
    let n = 0; listeners.forEach(s => { n += s.size; }); return n;
}
