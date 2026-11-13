/**
 * The renderer side of "what is this machine playing" (electron/
 * media-session.ts via preload `getNowPlaying`), plus the decision logic of
 * the publisher: what to send the API, and when.
 *
 * Kept free of React and axios so the rules are unit-testable.
 */
import { isSourceOf, mediaIdFits, type ActivityKind, type ActivitySource } from './listening';

export interface NowPlaying {
    /** Music, or a video (only ever returned when you asked for videos too). */
    kind: ActivityKind;
    source: ActivitySource;
    title: string;
    /** The artist, or (watching) the channel / app name. */
    artist: string;
    album: string | null;
    durationMs: number | null;
    positionMs: number | null;
    /** data:image cover for YOUR view only. */
    art: string | null;
    /** The app it was read from ("foobar2000", "Chrome"), for your own Settings line only. Never published. */
    player: string | null;
    /**
     * A Spotify album-cover image id (macOS / Linux Spotify only). Published
     * as `art_id` so the API can show friends that cover - fetched by the API,
     * never by a friend, and never a URL or bytes from this device.
     */
    artId?: string | null;
    /**
     * The item's own id (`spotify:track:<id>` / `youtube:<id>`, MEDIA_ID_RE),
     * when the player reported one (Spotify on macOS / Linux, a YouTube tab in
     * Firefox on Linux). Published as `media_id` so friends can open it.
     */
    mediaId?: string | null;
    /** Windows: what became of the cover (Settings' "cover:" diagnosis). Absent elsewhere. */
    cover?: CoverDiag;
}

/** Mirrors COVER_ERRORS in electron/media-session.ts. */
export const COVER_ERRORS = ['none', 'open_timeout', 'read_failed', 'too_big', 'empty', 'bad_image'] as const;
export type CoverError = (typeof COVER_ERRORS)[number];
export type CoverDiag = { ok: true; w?: number; h?: number } | { ok: false; why: CoverError };

/** Mirrors SPOTIFY_COVER_ID_RE in apps/api/src/integrations/listening-art.ts. */
export const SPOTIFY_COVER_ID_RE = /^ab67616d0000(?:b273|1e02|4851)[0-9a-f]{24}$/;

/** Why a supported read came back empty (electron/media-session.ts MediaIssue). */
export type NowPlayingIssue =
    | { kind: 'mac_permission'; app: 'Spotify' | 'Music' }
    | { kind: 'mac_waiting'; app: 'Spotify' | 'Music' }
    | { kind: 'win_unavailable' }
    | { kind: 'helper_failed' }
    /** Something plays, but a switch keeps it out ("Include my browser" / "Also share what I'm watching"). */
    | { kind: 'excluded'; why: 'browser' | 'watching'; player: string | null };
export type UnsupportedReason = 'platform' | 'no_powershell' | 'no_dbus' | 'old_app';

export type NowPlayingRead =
    | { supported: false; reason: UnsupportedReason }
    | { supported: true; playing: NowPlaying | null; issue: NowPlayingIssue | null };

/** What to read: browsers and videos each need their own opt-in. */
export interface NowPlayingOpts { includeBrowser: boolean; includeWatching: boolean }

type Bridge = {
    getNowPlaying?: (opts: NowPlayingOpts) => Promise<unknown>;
    mediaStop?: () => void;
    /** Main-process schedule (electron/media-watch.ts); absent in a main process from before it. */
    watchNowPlaying?: (opts: NowPlayingOpts | null) => void;
    onNowPlayingChanged?: (cb: (read: unknown) => void) => () => void;
};
const bridge = (): Bridge | null =>
    (typeof window !== 'undefined' ? ((window as unknown as { electronAPI?: Bridge }).electronAPI ?? null) : null);

/** Whether this build can read the OS media session at all (an older main process cannot). */
export const canReadNowPlaying = (): boolean => typeof bridge()?.getNowPlaying === 'function';

const str = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max);
    return s || null;
};
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 24 * 3600_000 ? Math.round(v) : null);

const MAC_APPS = ['Spotify', 'Music'] as const;
const REASONS: readonly UnsupportedReason[] = ['platform', 'no_powershell', 'no_dbus'];

function readIssue(v: unknown): NowPlayingIssue | null {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    if (!o) return null;
    if ((o.kind === 'mac_permission' || o.kind === 'mac_waiting') && (MAC_APPS as readonly unknown[]).includes(o.app)) {
        return { kind: o.kind, app: o.app as 'Spotify' | 'Music' };
    }
    if (o.kind === 'win_unavailable' || o.kind === 'helper_failed') return { kind: o.kind };
    if (o.kind === 'excluded' && (o.why === 'browser' || o.why === 'watching')) return { kind: 'excluded', why: o.why, player: str(o.player, 40) };
    return null;
}

const dim = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65_535 ? v : null);

function readCover(v: unknown): CoverDiag | null {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    if (!o) return null;
    if (o.ok === true) {
        const w = dim(o.w);
        const h = dim(o.h);
        return w && h ? { ok: true, w, h } : { ok: true };
    }
    return o.ok === false && (COVER_ERRORS as readonly unknown[]).includes(o.why) ? { ok: false, why: o.why as CoverError } : null;
}

/** The IPC answer, re-validated (main is trusted, but a shape change must not crash the renderer). */
export function readNowPlaying(raw: unknown): NowPlayingRead {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!o || o.supported !== true) {
        const reason = o && (REASONS as readonly unknown[]).includes(o.reason) ? (o.reason as UnsupportedReason) : 'platform';
        return { supported: false, reason };
    }
    const issue = readIssue(o.issue);
    const p = o.playing && typeof o.playing === 'object' ? (o.playing as Record<string, unknown>) : null;
    if (!p) return { supported: true, playing: null, issue };
    const title = str(p.title, 120);
    const artist = str(p.artist, 200);
    // An older main process sends no kind: that is music.
    const kind: ActivityKind | null = p.kind === undefined || p.kind === 'listening' ? 'listening' : p.kind === 'watching' ? 'watching' : null;
    if (!kind || !title || !artist || !isSourceOf(kind, p.source)) return { supported: true, playing: null, issue };
    const art = typeof p.art === 'string' && /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.art) ? p.art : null;
    const cover = readCover(p.cover);
    return {
        supported: true,
        playing: {
            kind, source: p.source, title, artist, album: kind === 'watching' ? null : str(p.album, 120),
            durationMs: ms(p.durationMs), positionMs: ms(p.positionMs), art, player: str(p.player, 40),
            ...(kind === 'listening' && typeof p.artId === 'string' && SPOTIFY_COVER_ID_RE.test(p.artId) ? { artId: p.artId } : {}),
            ...(mediaIdFits(kind, p.source, p.mediaId) ? { mediaId: p.mediaId } : {}),
            ...(cover ? { cover } : {}),
        },
        issue: null,
    };
}

/**
 * Read what is playing. A video comes back only with `includeWatching`; the
 * check is repeated here (main already applies it) so a video can never be
 * shown or shared without that opt-in, whatever the main process does.
 */
export async function getNowPlaying(opts: NowPlayingOpts): Promise<NowPlayingRead> {
    const b = bridge();
    if (!b?.getNowPlaying) return { supported: false, reason: 'old_app' };
    let r: NowPlayingRead;
    try { r = readNowPlaying(await b.getNowPlaying({ includeBrowser: opts.includeBrowser === true, includeWatching: opts.includeWatching === true })); } catch { return { supported: true, playing: null, issue: null }; }
    if (r.supported && r.playing?.kind === 'watching' && !opts.includeWatching) return { ...r, playing: null };
    return r;
}

/** Whether the main process keeps the polling schedule itself (electron/media-watch.ts). */
export const canWatchNowPlaying = (): boolean => {
    const b = bridge();
    return typeof b?.watchNowPlaying === 'function' && typeof b?.onNowPlayingChanged === 'function';
};

/**
 * Sharing on: ask the MAIN process to read the media session on its own
 * schedule (every ~12 s, with the window in the background, minimised or in
 * the tray too) and call `onRead` with each read that matters (a new track or
 * video, a cover, a stop, a seek, and a keep-alive about every 50 s while
 * something plays). Each read is re-validated like getNowPlaying's, videos
 * dropped without `includeWatching`. Returns the unsubscribe (which also
 * stops the schedule), or null when this main process cannot do it (an older
 * build: the caller polls getNowPlaying itself).
 */
export function watchNowPlaying(opts: NowPlayingOpts, onRead: (r: NowPlayingRead) => void): (() => void) | null {
    const b = bridge();
    if (!b?.watchNowPlaying || !b.onNowPlayingChanged) return null;
    const want: NowPlayingOpts = { includeBrowser: opts.includeBrowser === true, includeWatching: opts.includeWatching === true };
    let live = true;
    const off = b.onNowPlayingChanged((raw) => {
        if (!live) return;
        const r = readNowPlaying(raw);
        onRead(r.supported && r.playing?.kind === 'watching' && !want.includeWatching ? { ...r, playing: null } : r);
    });
    try { b.watchNowPlaying(want); } catch { /* the next configure retries */ }
    return () => {
        live = false;
        try { off(); } catch { /* gone */ }
        try { b.watchNowPlaying?.(null); } catch { /* gone */ }
    };
}

/**
 * The one-line status Settings > Connections shows for a read (plain text).
 * `kind` drives the styling: playing / idle / blocked (a fixable problem) / unsupported.
 */
export function nowPlayingStatus(r: NowPlayingRead | null, sourceLabel: (p: NowPlaying) => string): { kind: 'playing' | 'idle' | 'blocked' | 'unsupported' | 'checking'; text: string } {
    if (!r) return { kind: 'checking', text: 'Checking what is playing\u2026' };
    if (!r.supported) {
        const why = r.reason === 'old_app' ? 'update Cipherline to use this.'
            : r.reason === 'no_powershell' ? 'Windows PowerShell is missing or blocked on this PC, and it is how Cipherline reads Windows\u2019 media controls.'
            : r.reason === 'no_dbus' ? 'no D-Bus session bus was found, so media players (MPRIS) cannot be read.'
            : 'this system has no media controls Cipherline can read.';
        return { kind: 'unsupported', text: `Not supported here: ${why}` };
    }
    if (r.playing) {
        const cover = coverText(r.playing.cover);
        return r.playing.kind === 'watching'
            ? { kind: 'playing', text: `Detected: ${sourceLabel(r.playing)} \u2014 watching ${r.playing.title} (${r.playing.artist})${cover}` }
            : { kind: 'playing', text: `Detected: ${sourceLabel(r.playing)} \u2014 ${r.playing.title} by ${r.playing.artist}${cover}` };
    }
    const i = r.issue;
    if (i?.kind === 'excluded') {
        const where = i.player ? ` in ${i.player}` : '';
        return i.why === 'browser'
            ? { kind: 'blocked', text: `Something is playing${where || ' in your browser'}, but \u201cInclude my browser\u201d is off, so it is not shared. Turn it on to share YouTube and other sites.` }
            : { kind: 'blocked', text: `A video is playing${where}, but \u201cAlso share what I\u2019m watching\u201d is off, so it is not shared.` };
    }
    if (i?.kind === 'mac_permission') {
        return { kind: 'blocked', text: `${i.app} is open, but macOS has not allowed Cipherline to read it. Turn on ${i.app} under Cipherline in System Settings > Privacy & Security > Automation.` };
    }
    if (i?.kind === 'mac_waiting') return { kind: 'blocked', text: `macOS is asking whether Cipherline may read ${i.app}. Choose Allow in that dialog.` };
    if (i?.kind === 'win_unavailable') return { kind: 'blocked', text: 'Windows\u2019 media controls are not responding right now. If this lasts, restart Cipherline.' };
    if (i?.kind === 'helper_failed') return { kind: 'blocked', text: 'Could not read Windows\u2019 media controls (the reader stopped answering, possibly blocked by security software). Cipherline keeps retrying.' };
    return { kind: 'idle', text: 'Nothing playing. Start a song in Spotify, Apple Music, TIDAL or another player and it shows here within a few seconds.' };
}

/** " · cover: yes (640×360)" / " · cover: none from app" / " · cover: couldn't read (open_timeout)", or "" when unknown. */
export function coverText(c: CoverDiag | undefined): string {
    if (!c) return '';
    if (c.ok) return c.w && c.h ? ` · cover: yes (${c.w}×${c.h})` : ' · cover: yes';
    return c.why === 'none' ? ' · cover: none from app' : ` · cover: couldn’t read (${c.why})`;
}

export function stopNowPlaying(): void {
    try { bridge()?.mediaStop?.(); } catch { /* older main */ }
}

// ── Publisher decisions ─────────────────────────────────────────────────────

/** Mirrors LISTEN_REFRESH_S on the API: re-assert a playing track this often. */
export const LISTEN_REFRESH_MS = 60_000;
/**
 * Only with a main process from before electron/media-watch.ts: the renderer
 * polls itself, at this one cadence whatever the window does (the window has
 * backgroundThrottling off), and never stops for idleness.
 */
export const POLL_FALLBACK_MS = 12_000;
/**
 * The refresh as the publisher applies it to the main process's events: a
 * keep-alive arrives about every 50 s while something plays, so anything at
 * least this old is re-asserted then (the API keeps a record ~150 s).
 */
export const EVENT_REFRESH_MS = 40_000;
/** A position jump bigger than this (vs. the expected one) is a seek worth re-sending. */
export const SEEK_MS = 20_000;

export interface PublishBody {
    track: string;
    artist: string;
    album?: string;
    source: ActivitySource;
    duration_ms?: number;
    progress_ms?: number;
    /**
     * Sent ONLY for a video. A music body stays exactly what an API from before
     * "Watching" accepts (its validation rejects unknown fields with a 400).
     */
    kind?: 'watching';
    /** A Spotify album-cover id, music only, and only when there is one (an older API refuses the field: see useListeningShare). */
    art_id?: string;
    /** The item's own id (MEDIA_ID_RE), only when there is one (an older API refuses the field: see putListening). */
    media_id?: string;
    /**
     * The END-TO-END ENCRYPTED cover uploaded just before (coverPublisher.ts),
     * Spotify only; added by the publisher hook, never by toPublishBody. An
     * older API refuses the field: see putListening.
     */
    cover_id?: string;
}

export function toPublishBody(p: NowPlaying): PublishBody {
    return {
        ...(p.kind === 'watching' ? { kind: 'watching' as const } : {}),
        track: p.title,
        artist: p.artist,
        ...(p.album && p.kind !== 'watching' ? { album: p.album } : {}),
        source: p.source,
        ...(p.durationMs !== null ? { duration_ms: p.durationMs } : {}),
        ...(p.positionMs !== null ? { progress_ms: p.durationMs !== null ? Math.min(p.positionMs, p.durationMs) : p.positionMs } : {}),
        ...(p.kind !== 'watching' && p.artId && SPOTIFY_COVER_ID_RE.test(p.artId) ? { art_id: p.artId } : {}),
        ...(mediaIdFits(p.kind, p.source, p.mediaId) ? { media_id: p.mediaId } : {}),
    };
}

export const trackKey = (p: Pick<NowPlaying, 'kind' | 'source' | 'title' | 'artist' | 'album'>) => `${p.kind}\u0001${p.source}\u0001${p.title}\u0001${p.artist}\u0001${p.album ?? ''}`;

export type PublishAction = { kind: 'put'; body: PublishBody } | { kind: 'delete' } | { kind: 'none' };

/**
 * What to tell the API after a read. `last` is what was last SENT (null =
 * nothing showing). PUT on a new track, a seek, or when the refresh is due;
 * DELETE once when music stops; otherwise nothing (the server fans out only
 * real changes, and this keeps the request count at ~1 a minute while playing).
 */
export function decidePublish(
    playing: NowPlaying | null,
    last: { key: string; sentAt: number; positionMs: number | null } | null,
    now: number,
    refreshMs: number = LISTEN_REFRESH_MS,
): PublishAction {
    if (!playing) return last ? { kind: 'delete' } : { kind: 'none' };
    const key = trackKey(playing);
    if (!last || last.key !== key) return { kind: 'put', body: toPublishBody(playing) };
    if (now - last.sentAt >= refreshMs) return { kind: 'put', body: toPublishBody(playing) };
    if (playing.positionMs !== null && last.positionMs !== null) {
        const expected = last.positionMs + (now - last.sentAt);
        if (Math.abs(playing.positionMs - expected) > SEEK_MS) return { kind: 'put', body: toPublishBody(playing) };
    }
    return { kind: 'none' };
}

/**
 * One PUT /v1/me/listening, compatible with an OLDER API in both directions
 * (its validation 400s any field it does not know). Optional fields are shed
 * newest first:
 *  - a body with `cover_id` refused with 400 is sent again without it, and
 *    `flags.coverIdRefused` is set so it is never sent again this session
 *    (friends then see the catalogue cover);
 *  - a body with `media_id` refused with 400 is sent again without it, and
 *    `flags.mediaIdRefused` is set so it is never sent again this session
 *    (friends then get a search link instead of the exact item);
 *  - a body with `art_id` still refused with 400 is sent again without that
 *    too, and `flags.artIdRefused` is set the same way;
 *  - a video body (`kind: 'watching'`) still refused with 400 sets
 *    `flags.watchingRefused`: the caller stops sharing videos (it never
 *    re-sends a video as music).
 * `send` throws an axios-shaped error (`response.status`) on failure.
 */
export async function putListening(
    send: (body: PublishBody) => Promise<unknown>,
    body: PublishBody,
    flags: { artIdRefused: boolean; watchingRefused: boolean; mediaIdRefused?: boolean; coverIdRefused?: boolean },
): Promise<{ ok: true } | { ok: false; status: number | null }> {
    const statusOf = (e: unknown): number | null => (e as { response?: { status?: number } })?.response?.status ?? null;
    // Each attempt drops one more optional field the API may not know (newest first).
    const { cover_id: coverId, media_id: mediaId, art_id: artId, ...plain } = body;
    const steps: Array<{ body: PublishBody; field: 'cover_id' | 'media_id' | 'art_id' | null; refuse: (() => void) | null }> = [];
    const withArt = !!artId && !flags.artIdRefused;
    const withMedia = !!mediaId && !flags.mediaIdRefused;
    const withCover = !!coverId && !flags.coverIdRefused;
    const noMedia: PublishBody = withArt ? { ...plain, art_id: artId } : plain;
    const noCover: PublishBody = withMedia ? { ...noMedia, media_id: mediaId } : noMedia;
    if (withCover) steps.push({ body: { ...noCover, cover_id: coverId }, field: 'cover_id', refuse: () => { flags.coverIdRefused = true; } });
    if (withMedia) steps.push({ body: noCover, field: 'media_id', refuse: () => { flags.mediaIdRefused = true; } });
    if (withArt) steps.push({ body: noMedia, field: 'art_id', refuse: () => { flags.artIdRefused = true; } });
    steps.push({ body: plain, field: null, refuse: null });
    let status: number | null = null;
    let named: Set<string> | null = null;
    for (let i = 0; i < steps.length; i += 1) {
        try {
            await send(steps[i].body);
            return { ok: true };
        } catch (e) {
            status = statusOf(e);
            named = status === 400 ? fieldsNamedIn(e) : null;
            const { refuse, field } = steps[i];
            if (status !== 400 || !refuse || !field) break;
            // The 400 names fields, and not this one: it is about something else (do not give the field up for it).
            if (named && !named.has(field)) break;
            refuse();
        }
    }
    // Only a refusal that is about `kind` (or that says nothing we can read: an API that
    // predates "Watching" says "property kind should not exist") switches videos off for
    // the session. A 400 over one video's text must not latch watching off for good.
    if (status === 400 && body.kind === 'watching' && (!named || named.has('kind'))) flags.watchingRefused = true;
    return { ok: false, status };
}

const PUBLISH_FIELDS = ['kind', 'art_id', 'media_id', 'cover_id', 'track', 'artist', 'album', 'source', 'duration_ms', 'progress_ms'] as const;

/**
 * The body fields a NestJS validation 400 names (`message`: a string or a
 * list like ["property kind should not exist"]), or null when it names none we
 * know (an unknown error shape: the caller falls back to the old rule).
 */
export function fieldsNamedIn(e: unknown): Set<string> | null {
    const msg = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
    const parts = Array.isArray(msg) ? msg.filter((m): m is string => typeof m === 'string') : typeof msg === 'string' ? [msg] : [];
    const out = new Set<string>();
    for (const m of parts) {
        for (const f of PUBLISH_FIELDS) if (new RegExp(`(^|[^a-z_])${f}([^a-z_]|$)`).test(m)) out.add(f);
    }
    return out.size ? out : null;
}
