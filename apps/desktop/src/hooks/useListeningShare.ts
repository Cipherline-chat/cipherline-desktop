import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { applyListeningSeed, listeningStore, type Listening } from '../utils/integrations/listening';
import { useListeningPrefs } from '../utils/integrations/listeningPrefs';
import { setListeningArtToken } from '../utils/integrations/listeningArt';
import {
    decidePublish, EVENT_REFRESH_MS, getNowPlaying, POLL_FALLBACK_MS, putListening, stopNowPlaying, trackKey, watchNowPlaying,
    type NowPlaying, type NowPlayingRead,
} from '../utils/integrations/nowPlaying';
import { confirmCover, coverPublisherDeps, prepareCover, resetCoverPublisher } from '../utils/integrations/coverPublisher';

/**
 * "Listening to ..." - mounted once (Dashboard). Two jobs:
 *
 * 1. FRIENDS: seed what your friends are listening to on every (re)connect
 *    (GET /v1/friends/listening); live changes arrive as `friend:listening`
 *    (useRealtime -> applyListeningEvent). Always on: seeing friends' status
 *    needs no opt-in, sharing yours does.
 *
 * 2. YOU (only with Settings > Connections > "Share what I'm listening to"
 *    on): the MAIN process reads this machine's media session on its own
 *    schedule (electron/media-watch.ts: every ~12 s, focused or not, minimised
 *    or in the tray) and pushes each read that matters here; this tells the
 *    API only what changed (decidePublish: a new track, a seek, a refresh
 *    about once a minute, or "stopped"). Sharing continues for as long as
 *    something is actually PLAYING - idle or not: watching a video means not
 *    touching the mouse, and an idle rule used to withdraw "Watching" exactly
 *    then - and is withdrawn when nothing plays, when you switch it off, sign
 *    out, or quit the app. A main process from before that schedule (an older
 *    build) is polled from here instead, at the same cadence.
 *
 *    Videos ("Watching ...") are read and shared only with the separate
 *    "Also share what I'm watching" switch on. An API from before "Watching"
 *    answers a video publish with a 400 that names `kind`: from then on videos
 *    are treated as nothing playing for this session - never re-sent as music
 *    - while music keeps working. A 400 about anything else (one video's
 *    text) does NOT switch videos off.
 *
 *    Spotify on macOS / Linux also gives the album-cover id (`art_id`) so the
 *    API can show friends that cover. An API from before friends' covers
 *    rejects the field (400): the same body is sent again without it, and it
 *    is left out for the rest of the session.
 *
 *    `media_id` (the song / video's own id, when the player reports one)
 *    gets the same treatment: refused with 400 -> sent again without it
 *    (before `art_id` is given up), and left out for the rest of the session.
 *
 * 3. FRIENDS' COVERS: hands the token to utils/integrations/listeningArt.ts,
 *    which fetches them through our API - for profile views only.
 *
 * 4. YOUR SPOTIFY COVER, END-TO-END ENCRYPTED for friends: before a publish,
 *    utils/integrations/coverPublisher.ts uploads the cover (Spotify only,
 *    only when it changed) and the body names it as `cover_id`. An API from
 *    before encrypted covers answers the upload with 404 (nothing more is
 *    tried this session) and a refused `cover_id` is shed like `media_id`.
 */
export function useListeningShare(opts: { token: string | null; userId: string | null; wsConnectCount: number }): void {
    const { token, userId, wsConnectCount } = opts;
    const prefs = useListeningPrefs(userId);

    // 1. Friends' seed on each (re)connect.
    useEffect(() => {
        if (!token || !userId || wsConnectCount === 0) return;
        let cancelled = false;
        axios.get(`${API_BASE}/friends/listening`, { headers: { Authorization: `Bearer ${token}` } })
            .then((res) => { if (!cancelled) applyListeningSeed(res.data, userId); })
            .catch(() => { /* an older API (404) or a blip: live events still arrive */ });
        return () => { cancelled = true; };
    }, [token, userId, wsConnectCount]);

    // Sign-out / account switch: nobody's listening state survives it.
    useEffect(() => () => listeningStore.clear(), [userId]);

    // 3. Friends' covers load with this account's token (and are forgotten without it).
    useEffect(() => {
        setListeningArtToken(token && userId ? token : null);
        return () => setListeningArtToken(null);
    }, [token, userId]);

    // 2. Your own status.
    const lastSent = useRef<{ key: string; sentAt: number; positionMs: number | null } | null>(null);
    const apiGone = useRef(false);
    /** The API refused a video publish over `kind` (it predates "Watching"): stop offering it videos. */
    const watchingRefused = useRef(false);
    /**
     * The same, as state (for the token it happened under): the subscription is
     * redone without videos, so the main process stops reading them.
     */
    const [watchBlockedFor, setWatchBlockedFor] = useState<string | null>(null);
    const watchBlocked = !!token && watchBlockedFor === token;
    /** The API refused `art_id` (it predates friends' covers): stop sending it. */
    const artIdRefused = useRef(false);
    /** The API refused `media_id` (it predates friends' item links): stop sending it. */
    const mediaIdRefused = useRef(false);
    /** The API refused `cover_id` (it predates encrypted covers): stop sending it. */
    const coverIdRefused = useRef(false);
    useEffect(() => { watchingRefused.current = false; artIdRefused.current = false; mediaIdRefused.current = false; coverIdRefused.current = false; resetCoverPublisher(); }, [token]);
    useEffect(() => {
        if (!token || !userId || !prefs.share) return;
        let stopped = false;
        const headers = { Authorization: `Bearer ${token}` };
        const want = { includeBrowser: prefs.includeBrowser, includeWatching: prefs.includeWatching && !watchBlocked };
        const del = () => axios.delete(`${API_BASE}/me/listening`, { headers }).catch(() => undefined);
        const coverDeps = coverPublisherDeps(token);

        const withdraw = async () => {
            listeningStore.set(userId, null);
            if (!lastSent.current) return;
            lastSent.current = null;
            await del();
        };

        const showOwn = (p: NowPlaying, now: number) => {
            const l: Listening = {
                kind: p.kind, source: p.source, track: p.title, artist: p.artist, album: p.album,
                startedAt: now - (p.positionMs ?? 0), durationMs: p.durationMs,
                endsAt: now + Math.min((p.durationMs ?? 20 * 60_000) - (p.positionMs ?? 0), 20 * 60_000) + 15_000,
                art: p.art,
                ...(p.mediaId ? { mediaId: p.mediaId } : {}),
            };
            listeningStore.set(userId, l);
        };

        /** One read (pushed by the main process, or polled from an older one) -> your own status + the API. */
        const handle = async (r: NowPlayingRead) => {
            if (stopped || !r.supported) return;
            const now = Date.now();
            // Belt and braces: a video is never shown or sent without the opt-in, or once the server refused one.
            const playing = r.playing?.kind === 'watching' && (!want.includeWatching || watchingRefused.current) ? null : r.playing;
            if (playing) showOwn(playing, now); else listeningStore.set(userId, null);
            const action = apiGone.current ? { kind: 'none' as const } : decidePublish(playing, lastSent.current, now, EVENT_REFRESH_MS);
            if (action.kind === 'put' && playing) {
                // Spotify only: the cover goes up end-to-end encrypted first; the record then names it.
                const coverId = coverIdRefused.current ? null : await prepareCover(playing, userId, coverDeps);
                if (stopped) return;
                const flags = { artIdRefused: artIdRefused.current, watchingRefused: watchingRefused.current, mediaIdRefused: mediaIdRefused.current, coverIdRefused: coverIdRefused.current };
                let answer: unknown = null;
                const res = await putListening(
                    (body) => axios.put(`${API_BASE}/me/listening`, body, { headers }).then((r) => { answer = r.data; return r; }),
                    coverId ? { ...action.body, cover_id: coverId } : action.body, flags,
                );
                artIdRefused.current = flags.artIdRefused;
                mediaIdRefused.current = flags.mediaIdRefused;
                coverIdRefused.current = flags.coverIdRefused;
                // Switched off / signed out while that PUT was on its way: take it back (the cleanup's withdraw may have run before it landed).
                if (stopped) { if (res.ok) await del(); return; }
                if (res.ok) confirmCover(flags.coverIdRefused ? null : coverId, answer, Date.now());
                if (res.ok) lastSent.current = { key: trackKey(playing), sentAt: now, positionMs: playing.positionMs };
                else if (res.status === 404) apiGone.current = true;
                // An API from before "Watching": hide the video, withdraw anything still showing, stop reading videos.
                if (flags.watchingRefused && !watchingRefused.current) {
                    watchingRefused.current = true;
                    await withdraw();
                    setWatchBlockedFor(token);
                }
            } else if (action.kind === 'delete') {
                await withdraw();
            }
        };

        // Reads are handled one at a time, in order.
        let chain: Promise<void> = Promise.resolve();
        const enqueue = (r: NowPlayingRead) => {
            chain = chain.then(() => (stopped ? undefined : handle(r))).catch(() => undefined);
        };

        // The main process keeps the schedule; an older one cannot, so poll it from here (same cadence, no idle cut-off).
        const unwatch = watchNowPlaying(want, enqueue);
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (!unwatch) {
            const tick = async () => {
                if (stopped) return;
                const r = await getNowPlaying(want);
                if (stopped) return;
                enqueue(r);
                await chain;
                if (!stopped) timer = setTimeout(() => void tick(), r.supported ? POLL_FALLBACK_MS : 5 * 60_000);
            };
            void tick();
        }

        // Quitting the app: take the status down now rather than leaving it to the server's expiry.
        const unQuit = window.electronAPI?.onBeforeQuit?.(() => { void withdraw(); });

        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            unQuit?.();
            if (unwatch) unwatch(); else stopNowPlaying();
            void withdraw();
            resetCoverPublisher();
        };
    }, [token, userId, prefs.share, prefs.includeBrowser, prefs.includeWatching, watchBlocked]);
}
