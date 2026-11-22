/**
 * usePersonalEmojiSync - drives My Emojis library sync.
 * usePersonalStickerSync - the same for My stickers (2026-11-22): the same
 * hook body over the sticker library, slot and env.
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
import { useOwnSlotNudge } from './useOwnSlotNudge';
import { personalEmojis, personalStickers, type PersonalEmojis } from '../utils/personalEmoji/service';
import { ANTI_ENTROPY_MIN_GAP_MS, type SlotView } from '../utils/ownSlotSync';
import { EMOJI_LIBRARY_SLOT, emojiRepublishReason, publishEmojis, pullEmojis, type EmojiSyncEnv } from '../services/personalEmojiSyncService';
import { createEmojiSyncEnv, getEmojiSlotView, setEmojiSlotView } from '../services/personalEmojiSyncEnv';
import { createStickerSyncEnv, getStickerSlotView, setStickerSlotView, STICKER_LIBRARY_SLOT } from '../services/personalStickerSyncEnv';
import { resetStickerSession } from '../utils/stickers/serverStickers';
import { ownEntranceSound } from '../utils/customEntranceSound/ownStore';
import { receivedSounds } from '../utils/customEntranceSound/receivedCache';
import type { EmojiLibState } from '../utils/personalEmoji/library';
import type { OwnSlotAuth } from '../services/ownSlotEnv';
import { PERSONAL_BLOB_MAX_BYTES, PERSONAL_EMOJI_MAX_BYTES } from '../utils/personalEmoji/token';

const PUBLISH_DEBOUNCE_MS = 4_000;
const FOCUS_MIN_GAP_MS = 60_000;

export interface EmojiSyncAuth {
    userId?: string | null;
    deviceId?: string | null;
    token?: string | null;
}

interface LibrarySyncConfig {
    label: string;
    /** Own-device slot name: an `own_slot:changed` nudge naming it triggers one pull. */
    slot: string;
    lib: () => PersonalEmojis;
    createEnv: (auth: OwnSlotAuth) => EmojiSyncEnv;
    getView: (uid: string) => SlotView<EmojiLibState> | null;
    setView: (uid: string, view: SlotView<EmojiLibState> | null) => void;
    maxBytes: number;
    /** Extra sources whose LOCAL changes schedule a publish. */
    extraSubscriptions?: (onChange: (origin: 'local' | 'sync') => void) => (() => void)[];
    /** Called when the signed-in account changes on this device. */
    onAccountSwitch?: () => void;
}

function createLibrarySync(cfg: LibrarySyncConfig) {
    const shared = {
        inFlight: false,
        dirty: false,
        lastAntiEntropyAt: 0,
        lastRunAt: 0,
        unpublishable: new Set<string>(),
        user: null as string | null,
    };

    return function useLibrarySync(auth: EmojiSyncAuth): void {
        const { userId, deviceId, token } = auth;
        const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
        const ready = !!userId && !!deviceId && !!token;

        useEffect(() => {
            if (!userId || shared.user === userId) return;
            // A different account must not see the previous one's decrypted images.
            if (shared.user) cfg.onAccountSwitch?.();
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
                const env = cfg.createEnv({ userId: userId!, deviceId: deviceId!, token: token! });
                let pulled = false;
                try {
                    const res = await pullEmojis(env, cfg.getView(userId!));
                    if (res.view !== undefined) cfg.setView(userId!, res.view);
                    if (res.incomplete.length) console.warn(`[${cfg.label}] some images could not be materialised`, res.incomplete);
                    pulled = true;
                } catch (e) { console.warn(`[${cfg.label}] pull failed`, e); }

                let antiEntropy = false;
                if (pulled && !publish && !shared.dirty && Date.now() - shared.lastAntiEntropyAt >= ANTI_ENTROPY_MIN_GAP_MS) {
                    try {
                        const reason = emojiRepublishReason(
                            cfg.getView(userId!), env.loadLocalState(),
                            env.listOwnDeviceIds ? await env.listOwnDeviceIds() : null, deviceId!, shared.unpublishable,
                            cfg.maxBytes,
                        );
                        antiEntropy = reason !== 'none';
                    } catch (e) { console.warn(`[${cfg.label}] anti-entropy check failed`, e); }
                }

                if (publish || shared.dirty || antiEntropy) {
                    try {
                        if (antiEntropy) shared.lastAntiEntropyAt = Date.now();
                        const res = await publishEmojis(env, deviceId!);
                        shared.unpublishable = new Set(res.skipped);
                        if (res.published) {
                            shared.dirty = false;
                            if (res.view) cfg.setView(userId!, res.view);
                        }
                    } catch (e) { console.warn(`[${cfg.label}] publish failed`, e); }
                }
            } finally {
                shared.inFlight = false;
            }
        }, [ready, userId, deviceId, token]);

        // Pull at start.
        useEffect(() => { if (ready) void run(false); }, [ready, run]);

        // Real time: another device wrote this slot (own_slot:changed) -> one coalesced pull.
        useOwnSlotNudge(cfg.slot, ready, () => { void run(false); });

        // Pull when the window regains focus (rate-limited).
        useEffect(() => {
            if (!ready) return;
            const onFocus = () => { if (Date.now() - shared.lastRunAt >= FOCUS_MIN_GAP_MS) void run(false); };
            window.addEventListener('focus', onFocus);
            return () => window.removeEventListener('focus', onFocus);
        }, [ready, run]);

        // A LOCAL edit schedules an upload. A change a merged pull made is not one.
        useEffect(() => {
            if (!ready) return;
            const onChange = (origin: 'local' | 'sync') => {
                if (origin === 'sync') return;
                shared.dirty = true;
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => { void run(true); }, PUBLISH_DEBOUNCE_MS);
            };
            const offs = [cfg.lib().subscribe(onChange), ...(cfg.extraSubscriptions?.(onChange) ?? [])];
            return () => { offs.forEach(off => off()); if (timer.current) clearTimeout(timer.current); };
        }, [ready, run]);
    };
}

export const usePersonalEmojiSync = createLibrarySync({
    label: 'emojiSync',
    slot: EMOJI_LIBRARY_SLOT,
    lib: personalEmojis,
    createEnv: createEmojiSyncEnv,
    getView: getEmojiSlotView,
    setView: setEmojiSlotView,
    maxBytes: PERSONAL_EMOJI_MAX_BYTES,
    // Your custom entrance sound rides in the same snapshot, so setting,
    // replacing or removing it on this device counts as a local edit too.
    extraSubscriptions: onChange => [ownEntranceSound().subscribe(onChange)],
    onAccountSwitch: () => {
        // The store is shared with My stickers, so this clears both.
        personalEmojis().store.resetSession();
        // ...nor its own custom entrance sound, nor the ones it received in calls.
        ownEntranceSound().resetSession();
        receivedSounds.clear();
    },
});

export const usePersonalStickerSync = createLibrarySync({
    label: 'stickerSync',
    slot: STICKER_LIBRARY_SLOT,
    lib: personalStickers,
    createEnv: createStickerSyncEnv,
    getView: getStickerSlotView,
    setView: setStickerSlotView,
    // Another account's server sticker lists (key material included) must not linger.
    onAccountSwitch: () => resetStickerSession(),
    maxBytes: PERSONAL_BLOB_MAX_BYTES,
});
