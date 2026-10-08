import { useEffect, useSyncExternalStore } from 'react';
import {
    memberFilterFor,
    peekChannelViewers,
    refreshChannelViewers,
    subscribeChannelViewers,
    touchChannelViewers,
    type MemberFilter,
} from '../utils/channelViewerCache';

/**
 * Which members the server sidebar should list while `channel` is open: all
 * of them, only those who can see a restricted channel, or (for a restricted
 * channel never seen before) nothing yet — see `memberFilterFor`.
 *
 * Reads the cache synchronously, so revisiting a channel paints its filtered
 * list in the same render; a stale or old answer is revalidated in the
 * background and replaces the list only if it changed. Public channels
 * (`view_scope: 'all'`) never touch the network.
 */
export function useChannelMemberFilter(
    serverId: string,
    channel: { channel_id: string; server_id: string; view_scope?: 'all' | 'restricted' } | null | undefined,
    token: string | null | undefined,
): MemberFilter {
    const channelId = channel?.channel_id ?? null;
    const entry = useSyncExternalStore(
        subscribeChannelViewers,
        () => peekChannelViewers(channelId),
        () => null,
    );
    const restricted = !!channel && channel.server_id === serverId && channel.view_scope === 'restricted';
    // Only a flip TO stale (an invalidation) re-runs the effect; a failed
    // first fetch does not retry in a loop — the next open retries it.
    const stale = entry?.stale === true;

    useEffect(() => {
        if (!restricted || !channelId || !token) return;
        touchChannelViewers(channelId);
        // Errors are absorbed by the cache (a failed first fetch degrades to
        // the full roster); nothing to surface here.
        refreshChannelViewers(serverId, channelId, token).catch(() => undefined);
    }, [restricted, serverId, channelId, token, stale]);

    return memberFilterFor(serverId, channel, entry);
}
