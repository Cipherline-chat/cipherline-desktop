import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ServerEmoji } from './useServerEmojis';
import {
    assetRefsVersion, bindAssetRefAccount, noteDisplayed, peekAssetRef, refFromEmoji,
    requestResolve, subscribeAssetRefs,
} from '../utils/serverAssetRefs';

/**
 * Resolve a custom-emoji token id to the row to draw, NEVER letting "not in the
 * server's current list" mean "deleted" (owner 2026-11-26: once an emoji has been
 * sent, the message keeps showing it forever).
 *
 *   1. the server's live list                 -> draw it (and remember the ref on this device)
 *   2. this device's ref archive              -> draw it (a deleted / retired emoji, or a list that
 *                                                has not arrived)
 *   3. neither, list loaded -> ask the server BY ID (retired emojis included); until it answers the
 *      id counts as pending (glyph state 'loading', see emojiGlyphState), and only an authoritative
 *      "no such id" ever reaches 'unavailable'.
 *
 * The returned function changes identity whenever the archive learns something, so memoised
 * message renderers that depend on it repaint.
 */
export function useEmojiResolver(
    serverId: string | null,
    token: string | null,
    userId: string | null,
    liveById: ReadonlyMap<string, ServerEmoji>,
    listLoading: boolean,
): (id: string) => ServerEmoji | undefined {
    useEffect(() => { void bindAssetRefAccount(userId); }, [userId]);
    const v = useSyncExternalStore(subscribeAssetRefs, assetRefsVersion);

    return useCallback((id: string): ServerEmoji | undefined => {
        const live = liveById.get(id);
        if (live) { noteDisplayed(refFromEmoji(live)); return live; }
        const ref = peekAssetRef(id);
        if (ref && ref.kind === 'emoji') {
            return {
                emoji_id: ref.id, server_id: ref.server_id, name: ref.name, attachment_id: ref.attachment_id,
                key_b64: ref.key_b64, nonce_b64: ref.nonce_b64, animated: ref.animated, created_by: null, created_at: '',
            };
        }
        if (serverId && token && !listLoading) requestResolve('emoji', serverId, id, token);
        return undefined;
        // `v` is the archive version: a new fact must produce a new function identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [liveById, serverId, token, listLoading, v]);
}
