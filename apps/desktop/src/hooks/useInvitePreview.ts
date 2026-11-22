import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../utils/apiPath';
import type { ServerInfo } from './useServers';
import { RETRY_DELAYS_MS, resolveRetryDelayMs } from '../utils/invitePreviewRetry';
import { inviteLookup } from '../utils/invitePreviewCache';

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
 *
 * Later: honoring Retry-After is what made a channel full of invites "take
 * forever" (the sixth card waited out the rest of the minute). A signed-in
 * caller now gets 60/min on this route, and a card that remounts (scrolling,
 * switching channels and back) reuses a recent answer instead of spending the
 * budget again (utils/invitePreviewCache.ts).
 *
 * Later still (2026-11-21): scrolling a long list of invite cards still turned
 * them all "unavailable". Every card retried its own 429s, all at the instant
 * the window reopened, and gave up after three. The lookup is now one shared
 * queue (utils/invitePreviewCache.ts: dedupe, 4 at a time, a 429 pauses every
 * lookup until Retry-After and is retried there, answers kept 5 minutes), and
 * this hook only maps its answer: `gone` → 'invalid' (the only "expired"),
 * `throttled` / `failed` → 'error' (a Retry button, never "expired"). A card
 * may pass `enabled: false` until it is near the viewport, so cards nobody has
 * scrolled to do not spend the budget.
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

/** The preview GET: bearer token (per-account throttle bucket, see 1. above)
 *  and a timeout, so a request that never answers cannot leave a card loading forever. */
export const INVITE_PREVIEW_TIMEOUT_MS = 15_000;

export function useInvitePreview(code: string, token: string | null, servers: ServerInfo[], opts: { enabled?: boolean } = {}) {
    const enabled = opts.enabled ?? true;
    const [preview, setPreview] = useState<InvitePreview | null>(() => {
        const hit = inviteLookup.peek<InvitePreview>(code);
        return hit?.kind === 'valid' ? hit.data : null;
    });
    const [state, setState] = useState<InvitePreviewState>(() => {
        const hit = inviteLookup.peek<InvitePreview>(code);
        return hit?.kind === 'valid' ? 'valid' : hit?.kind === 'gone' ? 'invalid' : 'loading';
    });
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const attemptRef = useRef(0);
    // Flips true on cleanup (code/token change, or unmount) so a lookup or
    // scheduled retry belonging to a previous `code`/`token` can never apply
    // its result after the fact.
    const cancelledRef = useRef(false);
    // A scheduled retry calls back into `load` through a ref (kept fresh
    // below) rather than a direct self-reference.
    const loadRef = useRef<(fresh?: boolean) => Promise<void>>(async () => {});

    const load = useCallback(async (fresh = false) => {
        cancelledRef.current = false;
        const result = await inviteLookup.lookup<InvitePreview>(code, async () => {
            const res = await axios.get(apiUrl`/invites/${code}/preview`, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                timeout: INVITE_PREVIEW_TIMEOUT_MS,
            });
            return res.data;
        }, fresh);
        if (cancelledRef.current) return;
        if (result.kind === 'valid') {
            attemptRef.current = 0;
            setPreview(result.data);
            setState('valid'); // membership reconciled by the effect below, not refetched
            return;
        }
        if (result.kind === 'gone') {
            setState('invalid');
            return;
        }
        // Rate limited even after the shared lookup waited it out: show
        // "couldn't load" with a Retry, never "expired".
        if (result.kind === 'throttled') {
            setState('error');
            return;
        }
        // Network / 5xx: a few quiet retries before offering the button.
        const attempt = attemptRef.current++;
        if (attempt >= RETRY_DELAYS_MS.length) {
            setState('error');
            return;
        }
        const delay = resolveRetryDelayMs(undefined, attempt);
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
            if (!cancelledRef.current) void loadRef.current();
        }, delay);
    }, [code, token]);

    useEffect(() => { loadRef.current = load; }, [load]);

    useEffect(() => {
        if (!enabled) return;
        attemptRef.current = 0;
        const hit = inviteLookup.peek<InvitePreview>(code);
        if (hit?.kind === 'valid') { setPreview(hit.data); setState('valid'); }
        else { setPreview(null); setState(hit?.kind === 'gone' ? 'invalid' : 'loading'); }
        void load();
        return () => {
            cancelledRef.current = true;
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        };
    }, [load, enabled, code]);

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

    /** Manual retry (the "Retry" button) — resets the attempt counter so it
     * gets the full backoff budget again, and asks the server afresh. */
    const reload = useCallback(() => {
        attemptRef.current = 0;
        cancelledRef.current = false;
        setState('loading');
        void load(true);
    }, [load]);

    return { preview, state, reload };
}
