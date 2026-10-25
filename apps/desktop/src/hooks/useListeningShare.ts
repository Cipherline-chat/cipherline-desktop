import { useEffect, useRef } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { applyListeningSeed, listeningStore, type Listening } from '../utils/integrations/listening';
import { useListeningPrefs } from '../utils/integrations/listeningPrefs';
import {
    decidePublish, getNowPlaying, POLL_BACKGROUND_MS, POLL_FOCUSED_MS, stopNowPlaying, trackKey, type NowPlaying,
} from '../utils/integrations/nowPlaying';
import { IDLE_THRESHOLD_SECONDS } from '../utils/idleThreshold';

/**
 * "Listening to ..." - mounted once (Dashboard). Two jobs:
 *
 * 1. FRIENDS: seed what your friends are listening to on every (re)connect
 *    (GET /v1/friends/listening); live changes arrive as `friend:listening`
 *    (useRealtime -> applyListeningEvent). Always on: seeing friends' status
 *    needs no opt-in, sharing yours does.
 *
 * 2. YOU (only with Settings > Connections > "Share what I'm listening to"
 *    on): read this machine's media session (electron/media-session.ts) -
 *    every 10 s while the window is focused, every 30 s while you are at the
 *    computer with it in the background, not at all once you are idle - and
 *    tell the API only what changed (decidePublish: a new track, a seek, a
 *    1-minute refresh, or "stopped"). Switching it off, going idle or signing
 *    out withdraws the status at once.
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

    // 2. Your own status.
    const lastSent = useRef<{ key: string; sentAt: number; positionMs: number | null } | null>(null);
    const apiGone = useRef(false);
    useEffect(() => {
        if (!token || !userId || !prefs.share) return;
        let stopped = false;
        let busy = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const headers = { Authorization: `Bearer ${token}` };

        const withdraw = async () => {
            listeningStore.set(userId, null);
            if (!lastSent.current) return;
            lastSent.current = null;
            await axios.delete(`${API_BASE}/me/listening`, { headers }).catch(() => undefined);
        };

        const showOwn = (p: NowPlaying, now: number) => {
            const l: Listening = {
                source: p.source, track: p.title, artist: p.artist, album: p.album,
                startedAt: now - (p.positionMs ?? 0), durationMs: p.durationMs,
                endsAt: now + Math.min((p.durationMs ?? 20 * 60_000) - (p.positionMs ?? 0), 20 * 60_000) + 15_000,
                art: p.art,
            };
            listeningStore.set(userId, l);
        };

        const attentive = async (): Promise<'focused' | 'background' | 'idle'> => {
            if (document.visibilityState === 'visible' && document.hasFocus()) return 'focused';
            try {
                const idleS = await window.electronAPI?.getSystemIdleTime?.();
                if (typeof idleS === 'number' && idleS >= IDLE_THRESHOLD_SECONDS) return 'idle';
            } catch { /* unknown: treat as background */ }
            return 'background';
        };

        const tick = async () => {
            if (stopped || busy) return;
            busy = true;
            try { await step(); } finally { busy = false; }
        };

        const step = async () => {
            const mode = await attentive();
            let next = mode === 'focused' ? POLL_FOCUSED_MS : POLL_BACKGROUND_MS;
            if (mode === 'idle') {
                await withdraw();
                stopNowPlaying();
            } else {
                const r = await getNowPlaying(prefs.includeBrowser);
                if (stopped) return;
                if (!r.supported) {
                    next = 5 * 60_000; // nothing to read on this machine; look again rarely
                } else {
                    const now = Date.now();
                    if (r.playing) showOwn(r.playing, now); else listeningStore.set(userId, null);
                    const action = apiGone.current ? { kind: 'none' as const } : decidePublish(r.playing, lastSent.current, now);
                    if (action.kind === 'put' && r.playing) {
                        try {
                            await axios.put(`${API_BASE}/me/listening`, action.body, { headers });
                            lastSent.current = { key: trackKey(r.playing), sentAt: now, positionMs: r.playing.positionMs };
                        } catch (e) {
                            if ((e as { response?: { status?: number } })?.response?.status === 404) apiGone.current = true;
                        }
                    } else if (action.kind === 'delete') {
                        await withdraw();
                    }
                }
            }
            if (!stopped) timer = setTimeout(() => void tick(), next);
        };

        // Coming back to the window re-reads at once instead of waiting out a background interval.
        const onFocus = () => { if (busy) return; if (timer) clearTimeout(timer); timer = setTimeout(() => void tick(), 300); };
        window.addEventListener('focus', onFocus);
        void tick();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener('focus', onFocus);
            void withdraw();
            stopNowPlaying();
        };
    }, [token, userId, prefs.share, prefs.includeBrowser]);
}
