/**
 * usePersonalEmojiSync - drives My Emojis library sync.
 *
 * Mounted once (Dashboard). Not a background poller: it pulls at start and on
 * window focus (cheap - a `slot meta` probe, the blob is downloaded only when
 * it changed), and publishes a few seconds after a LOCAL edit. The prekey
 * bundle a publish needs claims one-time prekeys, so nothing here runs on a
 * timer. Same shape as useGifLibrarySync, same anti-entropy rules.
 *
 * Best-effort: a failure is logged and swallowed; the local library never waits
 * on the network.
 */
import { useCallback, useEffect, useRef } from 'react';
import { personalEmojis } from '../utils/personalEmoji/service';
import { ANTI_ENTROPY_MIN_GAP_MS } from '../utils/ownSlotSync';
import { emojiRepublishReason, publishEmojis, pullEmojis } from '../services/personalEmojiSyncService';
import { createEmojiSyncEnv, getEmojiSlotView, setEmojiSlotView } from '../services/personalEmojiSyncEnv';
import { ownEntranceSound } from '../utils/customEntranceSound/ownStore';
import { receivedSounds } from '../utils/customEntranceSound/receivedCache';

const PUBLISH_DEBOUNCE_MS = 4_000;
const FOCUS_MIN_GAP_MS = 60_000;

export interface EmojiSyncAuth {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

const shared = {
    inFlight: false,
    dirty: false,
    lastAntiEntropyAt: 0,
    lastRunAt: 0,
    unpublishable: new Set<string>(),
    user: null as string | null,
};

export function usePersonalEmojiSync(auth: EmojiSyncAuth): void {
    const { userId, deviceId, token } = auth;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ready = !!userId && !!deviceId && !!token;

    useEffect(() => {
        if (!userId || shared.user === userId) return;
        // A different account must not see the previous one's decrypted images.
        if (shared.user) {
            personalEmojis().store.resetSession();
            // ...nor its own custom entrance sound, nor the ones it received in calls.
            ownEntranceSound().resetSession();
            receivedSounds.clear();
        }
        shared.user = userId;
        shared.dirty = false;
        shared.lastAntiEntropyAt = 0;
        shared.unpublishable = new Set();
    }, [userId]);

    const run = useCallback(async (publish: boolean) => {
        if (!ready || shared.inFlight) return;
        shared.inFlight = true;
        shared.lastRunAt = Date.now();
        try {
            const env = createEmojiSyncEnv({ userId: userId!, deviceId: deviceId!, token: token! });
            let pulled = false;
            try {
                const res = await pullEmojis(env, getEmojiSlotView(userId!));
                if (res.view !== undefined) setEmojiSlotView(userId!, res.view);
                if (res.incomplete.length) console.warn('[emojiSync] some emojis could not be materialised', res.incomplete);
                pulled = true;
            } catch (e) { console.warn('[emojiSync] pull failed', e); }

            let antiEntropy = false;
            if (pulled && !publish && !shared.dirty && Date.now() - shared.lastAntiEntropyAt >= ANTI_ENTROPY_MIN_GAP_MS) {
                try {
                    const reason = emojiRepublishReason(
                        getEmojiSlotView(userId!), env.loadLocalState(),
                        env.listOwnDeviceIds ? await env.listOwnDeviceIds() : null, deviceId!, shared.unpublishable,
                    );
                    antiEntropy = reason !== 'none';
                } catch (e) { console.warn('[emojiSync] anti-entropy check failed', e); }
            }

            if (publish || shared.dirty || antiEntropy) {
                try {
                    if (antiEntropy) shared.lastAntiEntropyAt = Date.now();
                    const res = await publishEmojis(env, deviceId!);
                    shared.unpublishable = new Set(res.skipped);
                    if (res.published) {
                        shared.dirty = false;
                        if (res.view) setEmojiSlotView(userId!, res.view);
                    }
                } catch (e) { console.warn('[emojiSync] publish failed', e); }
            }
        } finally {
            shared.inFlight = false;
        }
    }, [ready, userId, deviceId, token]);

    // Pull at start.
    useEffect(() => { if (ready) void run(false); }, [ready, run]);

    // Pull when the window regains focus (rate-limited).
    useEffect(() => {
        if (!ready) return;
        const onFocus = () => { if (Date.now() - shared.lastRunAt >= FOCUS_MIN_GAP_MS) void run(false); };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [ready, run]);

    // A LOCAL edit schedules an upload. A change a merged pull made is not one.
    // Your custom entrance sound rides in the same snapshot, so setting,
    // replacing or removing it on this device counts as a local edit too.
    useEffect(() => {
        if (!ready) return;
        const onChange = (origin: 'local' | 'sync') => {
            if (origin === 'sync') return;
            shared.dirty = true;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => { void run(true); }, PUBLISH_DEBOUNCE_MS);
        };
        const off = personalEmojis().subscribe(onChange);
        const offSound = ownEntranceSound().subscribe(onChange);
        return () => { off(); offSound(); if (timer.current) clearTimeout(timer.current); };
    }, [ready, run]);
}
