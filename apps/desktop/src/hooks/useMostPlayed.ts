import { useEffect, useState } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { apiUrl } from '../utils/apiPath';
import { getTracker } from '../utils/achievements/tracker';
import type { PlayedGame } from '../utils/achievements/mostPlayed';

const cache = new Map<string, { at: number; games: PlayedGame[] }>();
const FRESH_MS = 60_000;

/**
 * `GET /v1/users/:id/most-played` — the rolling-week top 3, summed across the
 * user's devices. The server answers ONLY for yourself and accepted friends;
 * for anyone else (or an opted-out user) the answer is the same empty list, so
 * the panel cannot tell the two apart and neither can this hook.
 *
 * For YOUR OWN card the local tally is shown instantly, whatever the opt-in:
 * it is your own data on your own screen.
 */
export function useMostPlayed(userId: string | null | undefined, isSelf: boolean): {
    games: PlayedGame[];
    loading: boolean;
} {
    const { token } = useAuth();
    const [fetched, setFetched] = useState<{ id: string; games: PlayedGame[] } | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!userId || !token) return;
        const hit = cache.get(userId);
        if (hit && Date.now() - hit.at < FRESH_MS) return; // rendered straight from the cache below
        let cancelled = false;
        setLoading(true);
        axios.get(apiUrl`/users/${userId}/most-played`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })
            .then(res => {
                if (cancelled) return;
                const raw = Array.isArray(res.data?.games) ? res.data.games : [];
                const list: PlayedGame[] = raw
                    .filter((g: { game?: unknown; minutes?: unknown }) => typeof g?.game === 'string' && typeof g?.minutes === 'number' && g.minutes > 0)
                    .slice(0, 3);
                cache.set(userId, { at: Date.now(), games: list });
                setFetched({ id: userId, games: list });
            })
            .catch(() => { /* empty state */ })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [userId, token]);

    const games = (fetched && fetched.id === userId ? fetched.games : null) ?? (userId ? cache.get(userId)?.games ?? [] : []);
    if (isSelf) {
        const local = getTracker()?.top() ?? [];
        if (local.length > 0) return { games: local, loading: false };
    }
    return { games, loading };
}
