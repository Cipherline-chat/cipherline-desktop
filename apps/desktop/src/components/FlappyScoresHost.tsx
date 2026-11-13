import { useEffect, useRef } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE } from '../constants';
import { secureLocalStore } from '../utils/secureLocalStore';
import {
    bindFlappyAccount, unbindFlappyAccount,
    type FlappyApi, type FlappyBoard, type FlappyMe, type FlappyScope, type SubmitResult,
} from '../utils/flappyBest';

/**
 * The signed-in app's side of the Firewall leaderboard, mounted once next to
 * EggProgressHost. It renders nothing: it binds the account to
 * utils/flappyBest and hands it the ONLY network code in the feature, four
 * calls under `/v1/games/flappy`:
 *
 *   POST score { score, run_ms }   a new best (debounced, retried, persisted)
 *   GET  me                        your best + opt-in + global rank
 *   GET  leaderboard?scope=        the friends / global board
 *   PUT  opt-in { global_opt_in }  appear on the GLOBAL board (default OFF)
 *
 * Nothing but a score and how long the run took ever leaves the machine; no
 * run history, no timing of when you play. Every call resolves (a failure is
 * `null` / 'retry'), none throws, so a flaky network can never break the game.
 */
export const FlappyScoresHost: React.FC = () => {
    const { token, userId } = useAuth();

    // The calls always read the freshest token (it rotates) without re-binding.
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; });

    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        const headers = () => ({ Authorization: `Bearer ${tokenRef.current ?? ''}` });
        const call = async <T,>(fn: () => Promise<{ data: T }>): Promise<T | null> => {
            if (!tokenRef.current) return null;
            try { return (await fn()).data; } catch { return null; }
        };
        const api: FlappyApi = {
            async submit(score, runMs): Promise<SubmitResult> {
                if (!tokenRef.current) return { kind: 'retry' };
                try {
                    const res = await axios.post<{ best_score: number }>(
                        `${API_BASE}/games/flappy/score`, { score, run_ms: runMs }, { headers: headers(), timeout: 15000 },
                    );
                    const best = Number(res.data?.best_score);
                    return Number.isFinite(best) ? { kind: 'ok', best_score: best } : { kind: 'retry' };
                } catch (e) {
                    // 400 = "not plausible": the server will never take this one. Anything else may succeed later.
                    return axios.isAxiosError(e) && e.response?.status === 400 ? { kind: 'refused' } : { kind: 'retry' };
                }
            },
            me: () => call<FlappyMe>(() => axios.get(`${API_BASE}/games/flappy/me`, { headers: headers(), timeout: 15000 })),
            board: (scope: FlappyScope) => call<FlappyBoard>(() => axios.get(
                `${API_BASE}/games/flappy/leaderboard`, { params: { scope }, headers: headers(), timeout: 15000 },
            )),
            async setOptIn(on) {
                const r = await call<{ global_opt_in: boolean }>(() => axios.put(
                    `${API_BASE}/games/flappy/opt-in`, { global_opt_in: on }, { headers: headers(), timeout: 15000 },
                ));
                return r ? !!r.global_opt_in : null;
            },
        };
        // The per-account namespace must be decrypted before the first read, or a cold read says "no best".
        void Promise.resolve(secureLocalStore.whenAccountReady()).catch(() => undefined).then(() => {
            if (!cancelled) bindFlappyAccount(userId, api);
        });
        return () => { cancelled = true; unbindFlappyAccount(); };
    }, [userId]);

    return null;
};

export default FlappyScoresHost;
