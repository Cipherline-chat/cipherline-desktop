import { useEffect, useRef } from 'react';
import { MOMENT_INVITE_EVENT, type MomentInviteDetail } from '../utils/moments';

/**
 * A moment's "Invite friends" button (the @everyone-into-an-empty-server
 * echo) asks for the invite dialog of the server the @everyone was sent in.
 * `open(serverId)` gets that server id (or null when the request carried
 * none, meaning "the server that is open"). Dashboard opens its real
 * ServerInviteModal with it; the moments harness uses this same hook.
 */
export function useMomentInviteRequest(open: (serverId: string | null) => void): void {
    const cb = useRef(open);
    useEffect(() => { cb.current = open; });
    useEffect(() => {
        const on = (e: Event) => {
            const sid = (e as CustomEvent<Partial<MomentInviteDetail> | null>).detail?.serverId;
            cb.current(typeof sid === 'string' && sid ? sid : null);
        };
        window.addEventListener(MOMENT_INVITE_EVENT, on);
        return () => window.removeEventListener(MOMENT_INVITE_EVENT, on);
    }, []);
}
