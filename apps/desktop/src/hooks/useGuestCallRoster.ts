import { useEffect, useRef } from 'react';
import { refreshRoster } from '../utils/serverRosterCache';
import { guestRosterIdentities, type GuestCallIdentity, type GuestCallRef } from '../utils/guestCallRoster';

export interface GuestCallRosterPorts {
    /** The active guest call; null for any ordinary call, or no call. */
    guest: GuestCallRef | null;
    /** The server the guest call belongs to, for the member-list name lookup. */
    serverId: string | null;
    token: string | null;
    /** Participants of the guest call nobody has a name for yet. */
    unresolvedIds: readonly string[];
    load(guest: GuestCallRef, isCurrent: () => boolean): Promise<void> | void;
    drop(guest: GuestCallRef): void;
    onIdentities(identities: GuestCallIdentity[]): void;
}

/**
 * Keeps a moved-in guest's call row alive for exactly as long as they are in
 * that call, and names the people in it. See utils/guestCallRoster.ts for why.
 *
 * Keyed on the call alone: `load` and `drop` change with the access token, and
 * a token refresh must not blank the roster of a call the user is still in.
 */
export function useGuestCallRoster(ports: GuestCallRosterPorts): void {
    const latest = useRef(ports);
    useEffect(() => { latest.current = ports; });

    const callId = ports.guest?.callId ?? null;
    const huddleId = ports.guest?.huddleId ?? null;
    useEffect(() => {
        if (!callId || !huddleId) return;
        const guest = { callId, huddleId };
        let current = true;
        void latest.current.load(guest, () => current);
        return () => {
            current = false;
            latest.current.drop(guest);
        };
    }, [callId, huddleId]);

    const { serverId, token } = ports;
    const unresolvedKey = callId ? [...ports.unresolvedIds].sort().join(',') : '';
    const attemptedKey = useRef('');
    useEffect(() => {
        if (!unresolvedKey) { attemptedKey.current = ''; return; }
        // Once per distinct set: someone the member list cannot name stays
        // "Member" rather than turning into a request loop.
        if (!serverId || !token || attemptedKey.current === unresolvedKey) return;
        attemptedKey.current = unresolvedKey;
        // `prefetch`: nobody is viewing this server's member list because of
        // this, so it must not push out a list the user did open.
        refreshRoster(serverId, token, { prefetch: true })
            .then(roster => {
                if (!roster) return;
                const identities = guestRosterIdentities(unresolvedKey.split(','), roster.members);
                if (identities.length > 0) latest.current.onIdentities(identities);
            })
            .catch(e => console.warn('[GuestCall] could not load names for the call roster:', (e as Error)?.message ?? e));
    }, [unresolvedKey, serverId, token]);
}
