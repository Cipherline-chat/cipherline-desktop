/**
 * useAnnouncements — fetches admin-authored announcement banners.
 *
 * Fetch triggers, deliberately NOT a timer:
 *   - Boot (whenever a token becomes available / changes — covers login and
 *     account switch).
 *   - Every WS reconnect after the first, via `wsConnectCount` (the same
 *     signal Dashboard.tsx already uses for its post-reconnect resync) —
 *     skips the initial 0→1 transition since the boot effect covers that.
 *   - Live push: the gateway broadcasts a content-free `announcements:changed`
 *     over the socket whenever an admin publishes/edits/deletes a banner
 *     (`apps/api/src/gateway/gateway.gateway.ts`, relayed from Redis by the
 *     admin dashboard). `useRealtime.ts` re-dispatches it as the
 *     `ANNOUNCEMENTS_CHANGED_EVENT` window CustomEvent defined below rather
 *     than threading a new field through its return value / Dashboard.tsx's
 *     props — this hook is mounted inside `AnnouncementBanners`, an unrelated
 *     part of the tree from `useRealtime`'s single call site, and a window
 *     event is the established way this codebase bridges that (see
 *     `useSeasonalEffects`/`useGifSettings`). Deliberately content-free on
 *     the wire (per CLAUDE.md's server-lean framing) — it only ever triggers
 *     a refetch, never carries banner data itself, so the authoritative,
 *     per-user-filtered list always comes from the GET.
 *
 * The reconnect resync above is a self-heal path for a missed push, not the
 * primary mechanism (CLAUDE.md calls out timer-polling as the wrong shape
 * for presence-like data — the `voicePresence` reconcile is the model this
 * follows: push is the live path, a periodic/edge-triggered fallback only
 * covers a dropped event).
 *
 * Fails completely silently BY DESIGN: an announcement is the least
 * important thing on screen, so a slow, erroring, or unreachable
 * `/v1/announcements` must never block or degrade app startup. On failure
 * this simply keeps whatever was last fetched (empty on a fresh boot).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import type { BannerView } from '../utils/announcements';

/** Window CustomEvent name `useRealtime.ts` dispatches on the WS
 *  `announcements:changed` push. See the docblock above for why a window
 *  event rather than a hook-return field. */
export const ANNOUNCEMENTS_CHANGED_EVENT = 'cipherline:announcements-changed';

/**
 * Subscribe `onChanged` to the live-push window event, returning an
 * unsubscribe function — extracted out of the `useEffect` below (which is
 * now a one-line call to this) purely so the wiring is directly testable
 * without a React renderer. Same "pull the WS-dispatch decision out into a
 * plain function" approach this file's sibling `useRealtime.ts` already
 * uses for `isMyHistoryDelivery` / `shouldHandleHistoryRequest` — this repo
 * has no jsdom/`@testing-library/react`, so a hook's effect body is
 * otherwise unreachable from a test.
 */
export function subscribeToAnnouncementsChanged(onChanged: () => void): () => void {
    const handler = () => onChanged();
    window.addEventListener(ANNOUNCEMENTS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(ANNOUNCEMENTS_CHANGED_EVENT, handler);
}

export function useAnnouncements(token: string | null, wsConnectCount: number): BannerView[] {
    const [banners, setBanners] = useState<BannerView[]>([]);
    const inFlightRef = useRef(false);
    const prevWsConnectCount = useRef(0);

    const fetchAnnouncements = useCallback(async () => {
        if (!token || inFlightRef.current) return;
        inFlightRef.current = true;
        try {
            const res = await axios.get<{ banners: BannerView[] }>(`${API_BASE}/announcements`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const list = res.data?.banners;
            setBanners(Array.isArray(list) ? list : []);
        } catch {
            // Silent by design — see docblock. Whatever we had stays as-is.
        } finally {
            inFlightRef.current = false;
        }
    }, [token]);

    // Boot / token change. Also actively clears on logout (token → null) so
    // a signed-out (or switched) account never keeps rendering the previous
    // account's banners.
    useEffect(() => {
        if (!token) { setBanners([]); return; }
        void fetchAnnouncements();
    }, [token, fetchAnnouncements]);

    // Reconnect resync — same prevWsConnectCount pattern as Dashboard.tsx's
    // "make everything live again" effect: skip the first connection (boot's
    // effect above already covers it), refetch on every one after that.
    useEffect(() => {
        if (wsConnectCount === 0) return;
        if (prevWsConnectCount.current === 0) {
            prevWsConnectCount.current = wsConnectCount;
            return;
        }
        prevWsConnectCount.current = wsConnectCount;
        void fetchAnnouncements();
    }, [wsConnectCount, fetchAnnouncements]);

    // Live push — refetch whenever useRealtime.ts sees `announcements:changed`
    // on the socket. Content-free by design (see docblock): this only ever
    // triggers the same authoritative GET, never resurrects a dismissal —
    // dismissed-id bookkeeping lives entirely client-side in secureLocalStore
    // (AnnouncementBanners' `dismissedIds`/`parseDismissedIds`/`filterDismissed`)
    // and is untouched by this hook, which only ever returns the server's
    // list of currently-eligible banners for the filter to run against.
    useEffect(() => subscribeToAnnouncementsChanged(() => void fetchAnnouncements()), [fetchAnnouncements]);

    return banners;
}
