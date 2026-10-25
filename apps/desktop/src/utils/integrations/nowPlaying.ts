/**
 * The renderer side of "what is this machine playing" (electron/
 * media-session.ts via preload `getNowPlaying`), plus the decision logic of
 * the publisher: what to send the API, and when.
 *
 * Kept free of React and axios so the rules are unit-testable.
 */
import { isListenSource, type ListenSource } from './listening';

export interface NowPlaying {
    source: ListenSource;
    title: string;
    artist: string;
    album: string | null;
    durationMs: number | null;
    positionMs: number | null;
    /** data:image cover for YOUR view only. */
    art: string | null;
}

export type NowPlayingRead = { supported: false } | { supported: true; playing: NowPlaying | null };

type Bridge = {
    getNowPlaying?: (opts: { includeBrowser: boolean }) => Promise<unknown>;
    mediaStop?: () => void;
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

/** The IPC answer, re-validated (main is trusted, but a shape change must not crash the renderer). */
export function readNowPlaying(raw: unknown): NowPlayingRead {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!o || o.supported !== true) return { supported: false };
    const p = o.playing && typeof o.playing === 'object' ? (o.playing as Record<string, unknown>) : null;
    if (!p) return { supported: true, playing: null };
    const title = str(p.title, 120);
    const artist = str(p.artist, 200);
    if (!title || !artist || !isListenSource(p.source)) return { supported: true, playing: null };
    const art = typeof p.art === 'string' && /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.art) ? p.art : null;
    return {
        supported: true,
        playing: { source: p.source, title, artist, album: str(p.album, 120), durationMs: ms(p.durationMs), positionMs: ms(p.positionMs), art },
    };
}

export async function getNowPlaying(includeBrowser: boolean): Promise<NowPlayingRead> {
    const b = bridge();
    if (!b?.getNowPlaying) return { supported: false };
    try { return readNowPlaying(await b.getNowPlaying({ includeBrowser })); } catch { return { supported: true, playing: null }; }
}

export function stopNowPlaying(): void {
    try { bridge()?.mediaStop?.(); } catch { /* older main */ }
}

// ── Publisher decisions ─────────────────────────────────────────────────────

/** Mirrors LISTEN_REFRESH_S on the API: re-assert a playing track this often. */
export const LISTEN_REFRESH_MS = 60_000;
/** Poll cadence: focused, and in use but in the background. Paused when idle / hidden. */
export const POLL_FOCUSED_MS = 10_000;
export const POLL_BACKGROUND_MS = 30_000;
/** A position jump bigger than this (vs. the expected one) is a seek worth re-sending. */
export const SEEK_MS = 20_000;

export interface PublishBody {
    track: string;
    artist: string;
    album?: string;
    source: ListenSource;
    duration_ms?: number;
    progress_ms?: number;
}

export function toPublishBody(p: NowPlaying): PublishBody {
    return {
        track: p.title,
        artist: p.artist,
        ...(p.album ? { album: p.album } : {}),
        source: p.source,
        ...(p.durationMs !== null ? { duration_ms: p.durationMs } : {}),
        ...(p.positionMs !== null ? { progress_ms: p.durationMs !== null ? Math.min(p.positionMs, p.durationMs) : p.positionMs } : {}),
    };
}

export const trackKey = (p: Pick<NowPlaying, 'source' | 'title' | 'artist' | 'album'>) => `${p.source}\u0001${p.title}\u0001${p.artist}\u0001${p.album ?? ''}`;

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
): PublishAction {
    if (!playing) return last ? { kind: 'delete' } : { kind: 'none' };
    const key = trackKey(playing);
    if (!last || last.key !== key) return { kind: 'put', body: toPublishBody(playing) };
    if (now - last.sentAt >= LISTEN_REFRESH_MS) return { kind: 'put', body: toPublishBody(playing) };
    if (playing.positionMs !== null && last.positionMs !== null) {
        const expected = last.positionMs + (now - last.sentAt);
        if (Math.abs(playing.positionMs - expected) > SEEK_MS) return { kind: 'put', body: toPublishBody(playing) };
    }
    return { kind: 'none' };
}
