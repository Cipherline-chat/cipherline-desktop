/**
 * "Listening to <track> — <artist>" and "Watching <title> · <channel>": the
 * client model and the store (one entry per person: they are doing one or
 * the other).
 *
 * Where it comes from: THIS machine's OS media session (electron/
 * media-session.ts), read only while you have switched sharing on
 * (Settings > Connections; before that, only "is a music app playing?" to offer
 * the switch: electron/music-detect.ts). The API relays a small text record to your
 * ACCEPTED FRIENDS only (apps/api/src/integrations/listening.ts). Covers: for
 * the Spotify app, your own cover END-TO-END ENCRYPTED for friends
 * (coverPublisher.ts); otherwise the catalogue cover the server picks
 * (listeningArt.ts) or the platform logo.
 *
 * The store holds what each friend (and you) is listening to / watching, fed
 * by the `friend:listening` / `friend:watching` WS events and the GET
 * /v1/friends/listening seed (`listening` and `watching` maps), and
 * drops an entry on its own at `ends_at` (the track's end on the server
 * clock, corrected by the skew measured from the record itself).
 */
import { useSyncExternalStore } from 'react';

/** Mirrors LISTEN_COVER_ID_RE in apps/api/src/integrations/listening-cover.ts (activityCover.ts's COVER_ID_RE). */
const COVER_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Mirrors LISTEN_SOURCES in apps/api/src/integrations/listening.ts (listening.test.ts reads that file). */
export const LISTEN_SOURCES = [
    'spotify', 'apple_music', 'youtube_music', 'tidal', 'deezer', 'amazon_music', 'soundcloud', 'browser', 'other',
] as const;
export type ListenSource = (typeof LISTEN_SOURCES)[number];
export const isListenSource = (v: unknown): v is ListenSource => typeof v === 'string' && (LISTEN_SOURCES as readonly string[]).includes(v);

/** Mirrors WATCH_SOURCES in apps/api/src/integrations/listening.ts. */
export const WATCH_SOURCES = [
    'youtube', 'netflix', 'prime_video', 'disney_plus', 'hulu', 'crunchyroll', 'twitch', 'plex', 'jellyfin', 'browser', 'other',
] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];
export const isWatchSource = (v: unknown): v is WatchSource => typeof v === 'string' && (WATCH_SOURCES as readonly string[]).includes(v);

export type ActivityKind = 'listening' | 'watching';
export type ActivitySource = ListenSource | WatchSource;
export const isSourceOf = (kind: ActivityKind, v: unknown): v is ActivitySource => (kind === 'watching' ? isWatchSource(v) : isListenSource(v));

export const SOURCE_LABEL: Record<ActivitySource, string | null> = {
    spotify: 'Spotify', apple_music: 'Apple Music', youtube_music: 'YouTube Music', tidal: 'TIDAL', deezer: 'Deezer',
    amazon_music: 'Amazon Music', soundcloud: 'SoundCloud', browser: null, other: null,
    youtube: 'YouTube', netflix: 'Netflix', prime_video: 'Prime Video', disney_plus: 'Disney+', hulu: 'Hulu',
    crunchyroll: 'Crunchyroll', twitch: 'Twitch', plex: 'Plex', jellyfin: 'Jellyfin',
};

/** "Listening to" / "Watching": the words before the title. */
export const ACTIVITY_LABEL: Record<ActivityKind, string> = { listening: 'Listening to', watching: 'Watching' };

export interface Listening {
    /** Music or a video (records from before "Watching" are music). */
    kind: ActivityKind;
    source: ActivitySource;
    /** The song, or the video's title. */
    track: string;
    /** The artist, or (watching) the channel / app name. */
    artist: string;
    album: string | null;
    /** Epoch ms, LOCAL clock (corrected on receipt). */
    startedAt: number;
    durationMs: number | null;
    endsAt: number;
    /** Your own cover, read on this device. Never set for anyone else. */
    art?: string | null;
    /**
     * Friends only: the cover the SERVER picked for this track (an opaque ref,
     * fetched through GET /v1/friends/:id/listening/art - utils/integrations/
     * listeningArt.ts). null = the music note.
     */
    artRef?: string | null;
    /**
     * The item's own id (MEDIA_ID_RE), when the sharer's player reported one:
     * the viewer turns it into the exact song / video link (activityLinks.ts).
     * Never a URL.
     */
    mediaId?: string | null;
    /**
     * Friends only, Spotify music only: the id of the sharer's own cover,
     * END-TO-END ENCRYPTED (activityCover.ts), fetched and decrypted on THIS
     * device by profile views only (friendCover.ts). Absent = none.
     */
    coverId?: string | null;
}

/**
 * Mirrors MEDIA_ID_RE in apps/api/src/integrations/listening.ts (and
 * electron/media-session.ts): a Spotify track id or a YouTube video id.
 */
export const MEDIA_ID_RE = /^(?:spotify:track:[A-Za-z0-9]{22}|youtube:[A-Za-z0-9_-]{11})$/;

/**
 * Mirrors mediaIdFits in apps/api/src/integrations/listening.ts: a Spotify
 * track only on Spotify music; a YouTube video on YouTube (watching), YouTube
 * Music (listening) or a browser tab.
 */
export function mediaIdFits(kind: ActivityKind, source: unknown, id: unknown): id is string {
    if (typeof id !== 'string' || id.length > 40 || !MEDIA_ID_RE.test(id)) return false;
    if (id.startsWith('spotify:track:')) return kind === 'listening' && source === 'spotify';
    return kind === 'watching' ? source === 'youtube' || source === 'browser' : source === 'youtube_music' || source === 'browser';
}

/** Mirrors LISTEN_ART_REF_RE in apps/api/src/integrations/listening-art.ts (watching.test.ts reads that file). */
export const LISTEN_ART_REF_RE = /^(?:spotify:i:ab67616d0000(?:b273|1e02|4851)[0-9a-f]{24}|mb:rg:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const isListenArtRef = (v: unknown): v is string => typeof v === 'string' && v.length <= 60 && LISTEN_ART_REF_RE.test(v);

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max);
    return s || null;
};

/**
 * A wire record (server clock) -> Listening (local clock), or null. `skewMs` =
 * local now - server now; unknown = 0. `kind` is what the CHANNEL it arrived
 * on says (friend:listening / the seed's `listening` map vs friend:watching /
 * `watching`); a record whose own `kind` disagrees is dropped. The wire is
 * untrusted: anything odd is dropped, and `art` is never read from it.
 */
export function readListening(raw: unknown, skewMs = 0, kind: ActivityKind = 'listening'): Listening | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const track = text(o.track, 120);
    const artist = text(o.artist, 200);
    const started = typeof o.started_at === 'number' && Number.isFinite(o.started_at) ? o.started_at : null;
    const ends = typeof o.ends_at === 'number' && Number.isFinite(o.ends_at) ? o.ends_at : null;
    const own = o.kind === undefined || o.kind === null ? 'listening' : o.kind;
    if (own !== kind || !track || !artist || !isSourceOf(kind, o.source) || started === null || ends === null) return null;
    const dur = typeof o.duration_ms === 'number' && Number.isInteger(o.duration_ms) && o.duration_ms > 0 && o.duration_ms < 24 * 3600_000 ? o.duration_ms : null;
    return {
        kind, source: o.source, track, artist, album: kind === 'watching' ? null : text(o.album, 120),
        startedAt: started + skewMs, durationMs: dur, endsAt: ends + skewMs,
        ...(kind === 'listening' && isListenArtRef(o.art_ref) ? { artRef: o.art_ref } : {}),
        ...(mediaIdFits(kind, o.source, o.media_id) ? { mediaId: o.media_id } : {}),
        ...(kind === 'listening' && o.source === 'spotify' && typeof o.cover_id === 'string' && COVER_ID_RE.test(o.cover_id) ? { coverId: o.cover_id } : {}),
    };
}

/**
 * The line under the title. Listening: "Massive Attack — Mezzanine" /
 * "Massive Attack". Watching: the channel, plus the app when it is a named
 * service and not already the channel ("Kurzgesagt · YouTube", "Netflix").
 */
export const listeningDetail = (l: Pick<Listening, 'artist' | 'album'> & Partial<Pick<Listening, 'kind' | 'source'>>): string => {
    if (l.kind === 'watching') {
        const app = l.source ? SOURCE_LABEL[l.source] : null;
        return app && app !== l.artist ? `${l.artist} · ${app}` : l.artist;
    }
    return l.album && l.album !== l.artist ? `${l.artist} — ${l.album}` : l.artist;
};

/** The tooltip: "Listening to Teardrop — Massive Attack — Mezzanine" / "Watching A video — A channel". */
export const activityTip = (l: Listening): string => `${ACTIVITY_LABEL[l.kind]} ${l.track} — ${listeningDetail(l)}`;

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
    /** Everyone's record (yours included), as one immutable map: a new map on every
     *  change, so it is a valid useSyncExternalStore snapshot. Entries can be past
     *  `endsAt` for up to the expiry timer's tick; read them through `get` semantics. */
    all: (): ReadonlyMap<string, Listening> => state,
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

/**
 * A `friend:listening` (kind 'listening') or `friend:watching` (kind
 * 'watching') WS event -> the store. Malformed events are ignored. A null
 * clears the entry only when it is of THAT kind: on a switch the server sends
 * the "stopped" for one kind and the new record for the other as two events,
 * and their order must not matter.
 */
function applyEvent(data: unknown, selfId: string | null, kind: ActivityKind): void {
    const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    if (!d || typeof d.user_id !== 'string' || !UUID_RE.test(d.user_id)) return;
    // Your own record is driven by THIS device's publisher (it carries your cover);
    // another device of yours replaces it only while this one is not playing.
    if (d.user_id === selfId && listeningStore.get(d.user_id)?.art) return;
    const field = kind === 'watching' ? d.watching : d.listening;
    const next = field === null ? null : readListening(field, skewFrom(d.now), kind);
    // A null (or a record this client cannot read) ends only an entry of the same kind.
    if (next) listeningStore.set(d.user_id, next);
    else if (listeningStore.get(d.user_id)?.kind === kind) listeningStore.set(d.user_id, null);
}

export const applyListeningEvent = (data: unknown, selfId: string | null): void => applyEvent(data, selfId, 'listening');
export const applyWatchingEvent = (data: unknown, selfId: string | null): void => applyEvent(data, selfId, 'watching');

/**
 * The GET /v1/friends/listening seed -> the store (friends only; your own
 * entry is kept). Music is under `listening`, videos under `watching` (an API
 * from before "Watching" sends only `listening`).
 */
export function applyListeningSeed(data: unknown, selfId: string | null): void {
    const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const asMap = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
    const listening = asMap(d?.listening);
    if (!d || !listening) return;
    const skew = skewFrom(d.now);
    const out: Record<string, Listening> = {};
    const maps: Array<[ActivityKind, Record<string, unknown> | null]> = [['listening', listening], ['watching', asMap(d.watching)]];
    for (const [kind, m] of maps) {
        for (const [id, raw] of Object.entries(m ?? {})) {
            if (!UUID_RE.test(id) || out[id]) continue;
            const l = readListening(raw, skew, kind);
            if (l) out[id] = l;
        }
    }
    listeningStore.replaceAll(out, selfId);
}
