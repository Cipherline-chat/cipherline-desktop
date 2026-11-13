import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { useToast } from '../contexts/ToastContext';
import { openExternalLink } from '../utils/openExternalLink';
import { patchErrorMessage } from '../utils/patchErrorMessage';
import { forgetSteamCard } from './useProfileRelations';

/**
 * The VERIFIED Steam flow, shared by every place that offers it (Settings >
 * Profile > Steam block, and the Steam row at the top of the Links editor).
 *
 * `connect` asks the server for a one-time link (10 minutes, single use, bound
 * to this account) and opens it in the system browser through the validated
 * external-link path. You sign in on Steam's own page; the server checks
 * Steam's answer with Steam and only then records your SteamID - this client
 * never sends one. While that happens `waiting` is true and the caller's
 * profile is re-read every few seconds and whenever the window regains focus.
 */

const POLL_MS = 3000;
const WAIT_MAX_MS = 10 * 60 * 1000;

export interface SteamConnectState {
    /** Waiting for the browser sign-in to finish. */
    waiting: boolean;
    /** A request (start / unlink) is in flight. */
    busy: boolean;
    /** The last start/unlink failure, for inline display; cleared on the next attempt. */
    error: string | null;
    connect: () => Promise<void>;
    cancel: () => void;
    unlink: () => Promise<boolean>;
}

export function useSteamConnect(opts: {
    token: string | null;
    userId: string | undefined;
    linked: boolean;
    /** Re-read /auth/me (the caller's refreshProfile). */
    onChanged: () => void | Promise<void>;
}): SteamConnectState {
    const { token, userId, linked, onChanged } = opts;
    const toast = useToast();
    const [waitingSince, setWaitingSince] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const waiting = waitingSince !== null && !linked;

    // Linked while we waited: say so once (a side effect, so it runs after render).
    const waitedRef = useRef(false);
    useEffect(() => { waitedRef.current = waitingSince !== null; }, [waitingSince]);
    useEffect(() => {
        if (!linked || !waitedRef.current) return;
        waitedRef.current = false;
        setWaitingSince(null); // the wait ends when the server says linked
        toast.push({ kind: 'success', title: 'Steam linked', message: 'Your Steam account now shows as verified.' });
    }, [linked, toast]);

    useEffect(() => {
        if (!waiting || waitingSince === null) return;
        const poll = () => {
            if (Date.now() - waitingSince > WAIT_MAX_MS) { setWaitingSince(null); return; }
            void onChanged();
        };
        const t = window.setInterval(poll, POLL_MS);
        window.addEventListener('focus', poll);
        return () => { window.clearInterval(t); window.removeEventListener('focus', poll); };
    }, [waiting, waitingSince, onChanged]);

    const connect = useCallback(async () => {
        if (!token || busy) return;
        setBusy(true); setError(null);
        try {
            const res = await axios.post(`${API_BASE}/steam/link`, {}, { headers: { Authorization: `Bearer ${token}` } });
            const url = typeof res.data?.url === 'string' ? res.data.url : '';
            if (!openExternalLink(url).ok) throw new Error('bad url');
            forgetSteamCard(userId);
            setWaitingSince(Date.now());
        } catch (err) {
            const message = patchErrorMessage(err, 'Steam linking is unavailable right now. Try again in a minute.');
            setError(message);
            toast.push({ kind: 'error', title: 'Could not start', message });
        } finally {
            setBusy(false);
        }
    }, [token, busy, userId, toast]);

    const cancel = useCallback(() => setWaitingSince(null), []);

    const unlink = useCallback(async (): Promise<boolean> => {
        if (!token || busy) return false;
        setBusy(true); setError(null);
        try {
            await axios.delete(`${API_BASE}/steam/link`, { headers: { Authorization: `Bearer ${token}` } });
            forgetSteamCard(userId);
            await onChanged();
            return true;
        } catch (err) {
            const message = patchErrorMessage(err, 'Could not unlink Steam. Try again.');
            setError(message);
            toast.push({ kind: 'error', title: 'Not unlinked', message });
            return false;
        } finally {
            setBusy(false);
        }
    }, [token, busy, userId, onChanged, toast]);

    return { waiting, busy, error, connect, cancel, unlink };
}
