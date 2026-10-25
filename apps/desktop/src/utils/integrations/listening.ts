/**
 * "Listening to <track> — <artist>": the client model and the store.
 *
 * Where it comes from: THIS machine's OS media session (electron/
 * media-session.ts), read only while you have switched sharing on
 * (Settings > Connections). The API relays a small text record to your
 * ACCEPTED FRIENDS only (apps/api/src/integrations/listening.ts); no cover art
 * leaves your device - you see your own cover, friends see the music icon.
 *
 * The store holds what each friend (and you) is listening to, fed by the
 * `friend:listening` WS event and the GET /v1/friends/listening seed, and
 * drops an entry on its own at `ends_at` (the track's end on the server
 * clock, corrected by the skew measured from the record itself).
 */
import { useSyncExternalStore } from 'react';

/** Mirrors LISTEN_SOURCES in apps/api/src/integrations/listening.ts (listening.test.ts reads that file). */
export const LISTEN_SOURCES = [
    'spotify', 'apple_music', 'youtube_music', 'tidal', 'deezer', 'amazon_music', 'soundcloud', 'browser', 'other',
] as const;
export type ListenSource = (typeof LISTEN_SOURCES)[number];
export const isListenSource = (v: unknown): v is ListenSource => typeof v === 'string' && (LISTEN_SOURCES as readonly string[]).includes(v);

export const SOURCE_LABEL: Record<ListenSource, string | null> = {
    spotify: 'Spotify', apple_music: 'Apple Music', youtube_music: 'YouTube Music', tidal: 'TIDAL', deezer: 'Deezer',
    amazon_music: 'Amazon Music', soundcloud: 'SoundCloud', browser: null, other: null,
};

export interface Listening {
    source: ListenSource;
    track: string;
    artist: string;
    album: string | null;
    /** Epoch ms, LOCAL clock (corrected on receipt). */
    startedAt: number;
    durationMs: number | null;
    endsAt: number;
    /** Your own cover, read on this device. Never set for anyone else. */
    art?: string | null;
}

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max);
    return s || null;
};

/**
 * A wire record (server clock) -> Listening (local clock), or null. `skewMs` =
 * local now - server now; unknown = 0. The wire is untrusted: anything odd is
 * dropped, and `art` is never read from it.
 */
export function readListening(raw: unknown, skewMs = 0): Listening | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const track = text(o.track, 120);
    const artist = text(o.artist, 200);
    const started = typeof o.started_at === 'number' && Number.isFinite(o.started_at) ? o.started_at : null;
    const ends = typeof o.ends_at === 'number' && Number.isFinite(o.ends_at) ? o.ends_at : null;
    if (!track || !artist || !isListenSource(o.source) || started === null || ends === null) return null;
    const dur = typeof o.duration_ms === 'number' && Number.isInteger(o.duration_ms) && o.duration_ms > 0 && o.duration_ms < 24 * 3600_000 ? o.duration_ms : null;
    return { source: o.source, track, artist, album: text(o.album, 120), startedAt: started + skewMs, durationMs: dur, endsAt: ends + skewMs };
}

/** "Massive Attack — Mezzanine" / "Massive Attack". */
export const listeningDetail = (l: Pick<Listening, 'artist' | 'album'>): string => (l.album && l.album !== l.artist ? `${l.artist} — ${l.album}` : l.artist);

// ── The store ───────────────────────────────────────────────────────────────

type Map_ = ReadonlyMap<string, Listening>;
let state: Map_ = new Map();
const subs = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let now: () => number = () => Date.now();

function emit() { for (const s of subs) s(); }

function scheduleExpiry() {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    let next = Infinity;
    for (const l of state.values()) next = Math.min(next, l.endsAt);
    if (next === Infinity) return;
    expiryTimer = setTimeout(() => {
        const t = now();
        const kept = [...state].filter(([, l]) => l.endsAt > t);
        if (kept.length !== state.size) { state = new Map(kept); emit(); }
        scheduleExpiry();
    }, Math.max(250, next - now()));
}

export const listeningStore = {
    get: (userId: string): Listening | null => {
        const l = state.get(userId);
        return l && l.endsAt > now() ? l : null;
    },
    set(userId: string, l: Listening | null): void {
        const prev = state.get(userId) ?? null;
        if (!l && !prev) return;
        const next = new Map(state);
        if (l && l.endsAt > now()) next.set(userId, l); else next.delete(userId);
        state = next;
        scheduleExpiry();
        emit();
    },
    /** Replace every FRIEND entry from a seed, keeping `keep` (your own). */
    replaceAll(entries: Record<string, Listening>, keep: string | null): void {
        const next = new Map<string, Listening>();
        if (keep && state.has(keep)) next.set(keep, state.get(keep)!);
        for (const [id, l] of Object.entries(entries)) if (id !== keep && l.endsAt > now()) next.set(id, l);
        state = next;
        scheduleExpiry();
        emit();
    },
    clear(): void { state = new Map(); scheduleExpiry(); emit(); },
    subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; },
    /** Test seam. */
    __setNow(fn: () => number) { now = fn; },
};

/** What `userId` is listening to now (null = nothing / not a friend / not shared). */
export function useListening(userId: string | null | undefined): Listening | null {
    return useSyncExternalStore(
        listeningStore.subscribe,
        () => (userId ? listeningStore.get(userId) : null),
        () => null,
    );
}

/** Local now - server now, from a payload's `now` (0 when absent or absurd). */
export const skewFrom = (serverNow: unknown, localNow = Date.now()): number =>
    typeof serverNow === 'number' && Number.isFinite(serverNow) && Math.abs(localNow - serverNow) < 24 * 3600_000 ? localNow - serverNow : 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `friend:listening` WS event -> the store. Malformed events are ignored. */
export function applyListeningEvent(data: unknown, selfId: string | null): void {
    const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    if (!d || typeof d.user_id !== 'string' || !UUID_RE.test(d.user_id)) return;
    // Your own record is driven by THIS device's publisher (it carries your cover);
    // another device of yours replaces it only while this one is not playing.
    if (d.user_id === selfId && listeningStore.get(d.user_id)?.art) return;
    listeningStore.set(d.user_id, d.listening === null ? null : readListening(d.listening, skewFrom(d.now)));
}

/** The GET /v1/friends/listening seed -> the store (friends only; your own entry is kept). */
export function applyListeningSeed(data: unknown, selfId: string | null): void {
    const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const map = d?.listening && typeof d.listening === 'object' ? (d.listening as Record<string, unknown>) : null;
    if (!d || !map) return;
    const skew = skewFrom(d.now);
    const out: Record<string, Listening> = {};
    for (const [id, raw] of Object.entries(map)) {
        if (!UUID_RE.test(id)) continue;
        const l = readListening(raw, skew);
        if (l) out[id] = l;
    }
    listeningStore.replaceAll(out, selfId);
}
