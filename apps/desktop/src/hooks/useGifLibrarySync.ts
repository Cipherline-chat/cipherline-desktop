/**
 * useGifLibrarySync — drives GIF-library sync from the UI.
 *
 * Deliberately NOT a background poller. The library is only ever looked at
 * when the picker is open, and the blob is multi-MB, so syncing is triggered
 * by intent instead:
 *
 *   • `syncNow()` on picker open — pull, then publish if we have local changes.
 *   • `publishSoon()` after a local add/remove, debounced so importing five
 *     GIFs in a row uploads once rather than five times.
 *
 * That also keeps `prekey_bundle` off any timer: it claims a one-time prekey
 * per device per call, so it must never be polled.
 *
 * Everything here is best-effort. A sync failure is logged and swallowed —
 * the local library keeps working offline, and nothing blocks on the network.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pullLibrary, publishLibraryDetailed, gifRepublishReason } from '../services/gifLibrarySyncService';
import { createGifSyncEnv, getLastSeen, setLastSeen, getGifSlotView, setGifSlotView } from '../services/gifLibrarySyncEnv';
import { GIF_LIBRARY_CHANGED, isSyncOriginChange } from '../utils/gifStorage';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';

const PUBLISH_DEBOUNCE_MS = 4_000;

export interface GifSyncAuthLike {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

/**
 * Sync state shared by EVERY mounted instance of the hook. It is mounted twice:
 * by GifPicker (sync on open) and by Dashboard (sync at start and on focus, so
 * a new device of this account — a phone — can read the library without the
 * desktop user having to open the picker first). Per-instance refs would let
 * the two race: two pulls at once, two publishes of the same change.
 */
const shared = {
    inFlight: { current: false },
    // Set when a local change happened that the server hasn't been told about.
    dirty: { current: false },
    // Anti-entropy bookkeeping (see ownSlotSync.republishReason): when this
    // device last republished WITHOUT a local change, and which GIFs its last
    // publish could not carry (so they don't make the slot look behind forever).
    lastAntiEntropyAt: { current: 0 },
    unpublishable: { current: new Set<string>() },
    user: null as string | null,
};

export function useGifLibrarySync(auth: GifSyncAuthLike) {
    const { userId, deviceId, token } = auth;
    const [syncing, setSyncing] = useState(false);
    const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // A different account must not inherit the previous one's pending state.
    useEffect(() => {
        if (!userId || shared.user === userId) return;
        shared.user = userId;
        shared.dirty.current = false;
        shared.lastAntiEntropyAt.current = 0;
        shared.unpublishable.current = new Set();
    }, [userId]);

    const ready = !!userId && !!deviceId && !!token;

    const runSync = useCallback(async (opts: { publish: boolean }) => {
        if (!ready || shared.inFlight.current) return;
        shared.inFlight.current = true;
        setSyncing(true);
        try {
            const env = createGifSyncEnv({ userId: userId!, deviceId: deviceId!, token: token! });

            // Pull first: publishing without merging would overwrite the slot
            // with a view that never saw the other device's changes.
            let pulled = false;
            try {
                const res = await pullLibrary(env, getLastSeen(userId!));
                // Record the revision the pull actually read, not a fresh probe —
                // a probe could return a NEWER revision than we merged and we'd
                // then skip it forever.
                if (res.seen) setLastSeen(userId!, res.seen);
                if (res.view !== undefined) setGifSlotView(userId!, res.view);
                if (res.incomplete.length > 0) {
                    console.warn('[gifSync] some GIFs could not be materialised', res.incomplete);
                }
                pulled = true;
            } catch (e) {
                console.warn('[gifSync] pull failed', e);
            }

            // Anti-entropy: republish without a local change when the slot is
            // missing what we know, or a device of ours cannot read it (a new
            // phone next to this desktop). Rate-limited, and never after a
            // failed pull — we would be publishing over a slot we did not see.
            let antiEntropy = false;
            if (pulled && !opts.publish && !shared.dirty.current
                && Date.now() - shared.lastAntiEntropyAt.current >= ANTI_ENTROPY_MIN_GAP_MS) {
                try {
                    const reason = gifRepublishReason(
                        getGifSlotView(userId!),
                        env.loadLocalState(),
                        env.listOwnDeviceIds ? await env.listOwnDeviceIds() : null,
                        deviceId!,
                        shared.unpublishable.current,
                    );
                    antiEntropy = reason !== 'none';
                } catch (e) {
                    console.warn('[gifSync] anti-entropy check failed', e);
                }
            }

            if (opts.publish || shared.dirty.current || antiEntropy) {
                try {
                    if (antiEntropy) shared.lastAntiEntropyAt.current = Date.now();
                    const res = await publishLibraryDetailed(env, deviceId!);
                    shared.unpublishable.current = new Set(res.skipped);
                    if (res.published) {
                        shared.dirty.current = false;
                        // Our own upload is the newest revision; record it so the
                        // next check doesn't re-download what we just wrote.
                        if (res.view) {
                            setLastSeen(userId!, res.view.updatedAt);
                            setGifSlotView(userId!, res.view);
                        }
                    }
                } catch (e) {
                    console.warn('[gifSync] publish failed', e);
                }
            }
        } finally {
            shared.inFlight.current = false;
            setSyncing(false);
        }
    }, [ready, userId, deviceId, token]);

    /** Pull + publish. Call when the picker opens. */
    const syncNow = useCallback(() => { void runSync({ publish: false }); }, [runSync]);

    const publishSoon = useCallback(() => {
        shared.dirty.current = true;
        if (publishTimer.current) clearTimeout(publishTimer.current);
        publishTimer.current = setTimeout(() => { void runSync({ publish: true }); }, PUBLISH_DEBOUNCE_MS);
    }, [runSync]);

    // Any LOCAL mutation marks us dirty and schedules an upload. A change a
    // merged pull made is not one (isSyncOriginChange) — anti-entropy already
    // republishes when the slot is missing something we hold.
    useEffect(() => {
        const onChange = (ev: Event) => { if (!isSyncOriginChange(ev)) publishSoon(); };
        window.addEventListener(GIF_LIBRARY_CHANGED, onChange);
        return () => {
            window.removeEventListener(GIF_LIBRARY_CHANGED, onChange);
            if (publishTimer.current) clearTimeout(publishTimer.current);
        };
    }, [publishSoon]);

    return { syncing, syncNow, publishSoon };
}
