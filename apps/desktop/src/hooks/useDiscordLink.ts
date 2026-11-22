import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { openExternalLink } from '../utils/openExternalLink';
import { DISCORD_LINK_CHANGED_EVENT } from '../utils/discordLinkEvents';
import {
    ackDiscordMovedNotice, claimErrorMessage, fetchDiscordLink, setDiscordAutoClaim, startDiscordLink, unlinkDiscord,
    type DiscordLinkStatus,
} from '../utils/discordClaims';

/**
 * Discord sign-in (to claim imported messages), shared by every place that
 * offers it: the "Not on Cipherline yet" card, the claim notice and Settings >
 * Profile > Discord. Modelled on useSteamConnect.
 *
 * `connect` asks the server for a one-time URL (10 minutes, single use, bound
 * to this account), checks it is OUR sign-in page, and opens it in the system
 * browser through the validated external-link path. You approve on Discord's
 * own page; the server exchanges the code itself and records only a scrambled
 * (keyed-hash) form of your Discord account number. This client never sends
 * or sees one. While that happens `waiting` is true and the status is re-read
 * every few seconds and whenever the window regains focus.
 *
 * One store for the whole window, so the card and Settings never disagree.
 */

const POLL_MS = 3000;
const WAIT_MAX_MS = 10 * 60 * 1000;

interface StoreState {
    status: DiscordLinkStatus | null;
    loading: boolean;
    waitingSince: number | null;
    busy: boolean;
    error: string | null;
    /** Bumped each time a link lands while we waited (consumers can react once). */
    linkedTick: number;
}

let state: StoreState = { status: null, loading: false, waitingSince: null, busy: false, error: null, linkedTick: 0 };
const listeners = new Set<() => void>();
let lastToken: string | null = null;
let inflight: Promise<void> | null = null;

function set(patch: Partial<StoreState>) {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
}

async function refresh(token: string): Promise<void> {
    if (inflight && lastToken === token) return inflight;
    lastToken = token;
    set({ loading: state.status === null });
    inflight = (async () => {
        try {
            const status = await fetchDiscordLink(token);
            const landed = state.waitingSince !== null && status.linked;
            set({ status, loading: false, ...(landed ? { waitingSince: null, linkedTick: state.linkedTick + 1 } : {}) });
        } catch (err) {
            // A server without the feature (or the SQL) answers `available: false`;
            // a network failure keeps whatever we knew.
            set({ loading: false, error: state.status ? state.error : claimErrorMessage(err, 'Could not check your Discord link.') });
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/**
 * `discord:link_changed` (phase 3b): the link was moved to or away from this
 * account by a Discord sign-in somewhere else. Re-read the status so Settings,
 * the claim card and the moved-away notice update live. A no-op before the
 * store has a token (the next mount reads the status anyway).
 */
export function refreshDiscordLinkStore(): void {
    if (lastToken) void refresh(lastToken);
}
if (typeof window !== 'undefined') window.addEventListener(DISCORD_LINK_CHANGED_EVENT, refreshDiscordLinkStore);

/** For tests. */
export function _resetDiscordLinkStore(): void {
    state = { status: null, loading: false, waitingSince: null, busy: false, error: null, linkedTick: 0 };
    lastToken = null; inflight = null;
    listeners.forEach(l => l());
}

export interface DiscordLinkHook {
    status: DiscordLinkStatus | null;
    loading: boolean;
    waiting: boolean;
    busy: boolean;
    error: string | null;
    linkedTick: number;
    refresh: () => Promise<void>;
    connect: () => Promise<boolean>;
    cancel: () => void;
    unlink: () => Promise<boolean>;
    setAutoClaim: (on: boolean) => Promise<boolean>;
    /** "OK" on "Your Discord link was moved to another account" (clears it on every device). */
    ackMoved: () => Promise<boolean>;
}

export function useDiscordLink(token: string | null): DiscordLinkHook {
    const s = useSyncExternalStore(
        (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        () => state,
    );
    const waiting = s.waitingSince !== null && !s.status?.linked;

    useEffect(() => {
        if (token && (s.status === null || lastToken !== token)) void refresh(token);
    }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!waiting || !token || s.waitingSince === null) return;
        const since = s.waitingSince;
        const poll = () => {
            if (Date.now() - since > WAIT_MAX_MS) { set({ waitingSince: null }); return; }
            void refresh(token);
        };
        const t = window.setInterval(poll, POLL_MS);
        window.addEventListener('focus', poll);
        return () => { window.clearInterval(t); window.removeEventListener('focus', poll); };
    }, [waiting, token, s.waitingSince]);

    const connect = useCallback(async (): Promise<boolean> => {
        if (!token || state.busy) return false;
        set({ busy: true, error: null });
        try {
            const url = await startDiscordLink(token);
            if (!openExternalLink(url).ok) throw new Error('could not open the browser');
            set({ waitingSince: Date.now() });
            return true;
        } catch (err) {
            set({ error: claimErrorMessage(err, 'Discord sign-in is unavailable right now. Try again in a minute.') });
            return false;
        } finally {
            set({ busy: false });
        }
    }, [token]);

    const cancel = useCallback(() => set({ waitingSince: null }), []);

    const unlink = useCallback(async (): Promise<boolean> => {
        if (!token || state.busy) return false;
        set({ busy: true, error: null });
        try {
            await unlinkDiscord(token);
            await refresh(token);
            return true;
        } catch (err) {
            set({ error: claimErrorMessage(err, 'Could not unlink Discord. Try again.') });
            return false;
        } finally {
            set({ busy: false });
        }
    }, [token]);

    const setAutoClaim = useCallback(async (on: boolean): Promise<boolean> => {
        if (!token || state.busy || !state.status) return false;
        const before = state.status;
        set({ busy: true, error: null, status: { ...before, auto_claim: on } });
        try {
            await setDiscordAutoClaim(token, on);
            return true;
        } catch (err) {
            set({ status: before, error: claimErrorMessage(err, 'Could not save. Try again.') });
            return false;
        } finally {
            set({ busy: false });
        }
    }, [token]);

    const ackMoved = useCallback(async (): Promise<boolean> => {
        if (!token || !state.status?.moved_away_at) return false;
        const before = state.status;
        // Optimistic: the notice closes at once; it comes back only if the server refused.
        set({ status: { ...before, moved_away_at: null } });
        try {
            await ackDiscordMovedNotice(token);
            return true;
        } catch (err) {
            set({ status: before, error: claimErrorMessage(err, 'Could not dismiss that notice. Try again.') });
            return false;
        }
    }, [token]);

    const doRefresh = useCallback(async () => { if (token) await refresh(token); }, [token]);

    return {
        status: s.status, loading: s.loading, waiting, busy: s.busy, error: s.error, linkedTick: s.linkedTick,
        refresh: doRefresh, connect, cancel, unlink, setAutoClaim, ackMoved,
    };
}
