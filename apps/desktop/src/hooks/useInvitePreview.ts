import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import type { ServerInfo } from './useServers';
import { RETRY_DELAYS_MS, isPermanentInviteFailure, resolveRetryDelayMs } from '../utils/invitePreviewRetry';

/**
 * Shared invite-preview fetch, used by both the in-chat invite card
 * (ServerInviteEmbed) and the deep-link modal (JoinServerModal's
 * InvitePreviewModal). Extracted after the same bug was found duplicated in
 * both: a valid, unexpired invite intermittently rendering as "Invite
 * unavailable".
 *
 * Root cause was three compounding issues, all fixed here in one place:
 *
 *  1. GET /invites/:code/preview carries a deliberately tight anti-
 *     enumeration throttle (5 req/min — see invites.controller.ts). Neither
 *     caller sent its Authorization header on this GET (only on the later
 *     accept/join POST), so UserThrottlerGuard fell back to IP-keyed
 *     buckets — exactly the failure mode its own docstring warns against:
 *     every user behind the same NAT/office network/VPN egress, and every
 *     invite card any of them has open, shared one 5-per-minute budget.
 *     Sending the bearer token here moves the bucket to per-user JWT
 *     keying, matching the guard's documented intent. The endpoint stays
 *     public (no AuthGuard) for genuinely unauthenticated callers.
 *
 *  2. The fetch re-ran whenever the caller's `servers` array changed
 *     identity — and useServers.setServers() hands back a brand-new array
 *     on every loadServers() call, which fires reactively from ~10 places
 *     (WS events: reconnect, permissions changed, owner-grace, member
 *     joined, etc). In a channel with several invite cards visible, ambient
 *     WS traffic alone could refetch already-resolved invites fast enough
 *     to burn the whole per-minute budget with zero user action. The
 *     "already a member" transition doesn't need a refetch at all — it's
 *     answerable from data already in hand — so this hook only fetches on
 *     `code`/`token` change and recomputes membership locally.
 *
 *  3. Any non-404/400 response (429 chief among them, but also 401/5xx/
 *     network) was treated as generically "unavailable", identical to a
 *     truly dead invite, with no retry — so a single transient throttle
 *     hit permanently stuck a valid invite in the dead-looking state until
 *     something incidentally remounted the component. This hook
 *     distinguishes PERMANENT invalidity (404/400 — the server said no)
 *     from TRANSIENT failure (429/5xx/network — we just couldn't tell) and
 *     retries the latter automatically, honoring the throttler's
 *     `Retry-After` header on a 429 rather than guessing.
 */

export interface InvitePreview {
    server_id: string;
    server_name: string;
    server_description: string | null;
    server_icon: string | null;
    server_icon_key_b64: string | null;
    server_icon_nonce_b64: string | null;
    member_count: number;
    expires_at: string | null;
    uses?: number;
    max_uses?: number | null;
}

export type InvitePreviewState = 'loading' | 'valid' | 'joined' | 'invalid' | 'error';

export function useInvitePreview(code: string, token: string | null, servers: ServerInfo[]) {
    const [preview, setPreview] = useState<InvitePreview | null>(null);
    const [state, setState] = useState<InvitePreviewState>('loading');
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const attemptRef = useRef(0);
    // Flips true on cleanup (code/token change, or unmount) so a fetch or
    // scheduled retry belonging to a previous `code`/`token` can never apply
    // its result after the fact — without this, switching invite cards
    // mid-fetch (or an in-flight retry outliving a fast unmount) could
    // clobber the current card's state with a stale response.
    const cancelledRef = useRef(false);
    // A scheduled retry calls back into `load` — routed through a ref
    // (kept fresh below) rather than a direct self-reference so `load`
    // isn't recursively self-referential in its own closure.
    const loadRef = useRef<() => Promise<void>>(async () => {});

    const load = useCallback(async () => {
        cancelledRef.current = false;
        try {
            const res = await axios.get(`${API_BASE}/invites/${code}/preview`, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            });
            if (cancelledRef.current) return;
            attemptRef.current = 0;
            const data: InvitePreview = res.data;
            setPreview(data);
            setState('valid'); // membership reconciled by the effect below, not refetched
        } catch (e: any) {
            if (cancelledRef.current) return;
            const status = e?.response?.status;
            if (isPermanentInviteFailure(status)) {
                setState('invalid');
                return;
            }
            const attempt = attemptRef.current++;
            if (attempt >= RETRY_DELAYS_MS.length) {
                setState('error');
                return;
            }
            const delay = resolveRetryDelayMs(e?.response?.headers?.['retry-after'], attempt);
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
                if (!cancelledRef.current) void loadRef.current();
            }, delay);
        }
    }, [code, token]);

    useEffect(() => { loadRef.current = load; }, [load]);

    useEffect(() => {
        attemptRef.current = 0;
        setState('loading');
        void load();
        return () => {
            cancelledRef.current = true;
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        };
    }, [load]);

    // "Already a member" is derived locally, never triggers a refetch — the
    // whole point of this hook is that ambient server-list churn (WS events
    // refreshing useServers) must not re-hit the throttled preview endpoint.
    useEffect(() => {
        if (!preview) return;
        setState(prev => {
            if (prev !== 'valid' && prev !== 'joined') return prev;
            return servers.some(s => s.server_id === preview.server_id) ? 'joined' : 'valid';
        });
    }, [servers, preview]);

    /** Manual retry (e.g. a "Retry" button once auto-retries are exhausted)
     * — resets the attempt counter so it gets the full backoff budget
     * again, not whatever was left over. */
    const reload = useCallback(() => {
        attemptRef.current = 0;
        cancelledRef.current = false;
        setState('loading');
        void load();
    }, [load]);

    return { preview, state, reload };
}
