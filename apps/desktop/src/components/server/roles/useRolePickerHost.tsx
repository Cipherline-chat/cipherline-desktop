/**
 * Dashboard-side wiring for RolePickerContext: holds which member's picker
 * popover (the profile card "+") is open and renders it, and hands in-menu
 * flyouts (MemberRolesFlyout) the session they load and toggle with. Kept out of Dashboard.tsx so
 * that file only gains a provider and one node.
 */
import React, { useCallback, useMemo, useState } from 'react';
import type { OpenRolePickerArgs, RolePickerApi, RolePickerSession } from '../../../contexts/RolePickerContext';
import { getRoster } from '../../../utils/serverRosterCache';
import { actorHighestPosition, canOfferRolePicker } from './rolePickerModel';
import { MemberRolePicker } from './MemberRolePicker';

export interface RolePickerHostArgs {
    token: string | null | undefined;
    myUserId: string | null | undefined;
    servers: ReadonlyArray<{ server_id: string; owner_user_id: string }>;
    myPermissions: Readonly<Record<string, bigint>>;
}

export function useRolePickerHost({ token, myUserId, servers, myPermissions }: RolePickerHostArgs): {
    api: RolePickerApi;
    node: React.ReactNode;
} {
    const [args, setArgs] = useState<OpenRolePickerArgs | null>(null);

    const ownerOf = useCallback(
        (serverId: string) => servers.find(s => s.server_id === serverId)?.owner_user_id ?? null,
        [servers],
    );

    const canAssignRoles = useCallback((serverId: string | null | undefined) => {
        if (!serverId || !myUserId) return false;
        return canOfferRolePicker({
            perms: myPermissions[serverId],
            actorUserId: myUserId,
            ownerUserId: ownerOf(serverId),
            roster: getRoster(serverId),
        });
    }, [myPermissions, myUserId, ownerOf]);

    const actorHighest = useCallback((serverId: string | null | undefined) => {
        if (!serverId) return -1;
        const roster = getRoster(serverId);
        if (!roster) return ownerOf(serverId) === myUserId ? Number.POSITIVE_INFINITY : -1;
        return actorHighestPosition(myUserId, ownerOf(serverId), roster.members, roster.roles);
    }, [myUserId, ownerOf]);

    const session = useCallback((serverId: string): RolePickerSession | null => {
        if (!token || !myUserId) return null;
        return { token, myUserId, ownerUserId: ownerOf(serverId), perms: myPermissions[serverId] ?? 0n };
    }, [token, myUserId, ownerOf, myPermissions]);

    const open = useCallback((next: OpenRolePickerArgs) => setArgs(next), []);
    const close = useCallback(() => setArgs(null), []);

    const openFor = args ? { serverId: args.serverId, userId: args.userId } : null;
    const api = useMemo<RolePickerApi>(
        () => ({ open, session, canAssignRoles, actorHighest, openFor }),
        // openFor is rebuilt from args; key the memo on args itself.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [open, session, canAssignRoles, actorHighest, args],
    );

    const node = args && token && myUserId ? (
        <MemberRolePicker
            key={`${args.serverId}:${args.userId}`}
            args={args}
            token={token}
            myUserId={myUserId}
            ownerUserId={ownerOf(args.serverId)}
            perms={myPermissions[args.serverId] ?? 0n}
            onClose={close}
        />
    ) : null;

    return { api, node };
}
