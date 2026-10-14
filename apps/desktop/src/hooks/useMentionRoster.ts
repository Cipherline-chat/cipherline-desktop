import { useMemo } from 'react';
import { useServerRoster } from './useServerRoster';
import { deriveMentionRoster, EMPTY_MENTION_VIEW, type MentionRosterView } from '../utils/mentionRoster';

/**
 * The @mention candidates for a server, derived from the LIVE shared roster
 * (the same store the member list renders from), so a join / leave / kick /
 * ban / role change shows up in the picker without reopening the server.
 * Recomputed only when the roster's identity changes — and that changes only
 * when its content does (see serverRosterCache's structural sharing).
 */
export function useMentionRoster(
    serverId: string | null | undefined,
    viewerUserId: string | null | undefined,
): MentionRosterView {
    const roster = useServerRoster(serverId);
    return useMemo(
        () => (serverId ? deriveMentionRoster(roster, viewerUserId) : EMPTY_MENTION_VIEW),
        [serverId, roster, viewerUserId],
    );
}
