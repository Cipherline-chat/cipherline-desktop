import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../constants';
import {
    APP_SUSPENDED_EVENT,
    dispatchResumed,
    dispatchUpgradeRequired,
    isBelowFloor,
    nextPollDelayMs,
    toNotice,
    type ClientStatus,
    type SuspendedNotice,
} from '../utils/clientControl';
import { fetchClientStatus } from '../utils/clientStatusFetch';
import { betaReporter } from '../utils/betaDiagnostics/reporter';
import { AppSuspendedScreen } from './AppSuspendedScreen';

/** How long the "We're back!" beat shows before the screen gets out of the way. */
const BACK_BEAT_MS = 900;

export interface ClientControlGateProps {
    /** Test seam. */
    fetchStatus?: () => Promise<ClientStatus | null>;
    appVersion?: string;
}

/**
 * Owns the client side of the admin kill switch, and the boot/reconnect half
 * of the version floor. Mounted once at the App root (outside AppInner), so
 * it is live before sign-in, during the loading screen and in the dashboard.
 *
 * SHOWS the shutdown screen on any of:
 *   - `cipherline:app-suspended` — from a 503 APP_SUSPENDED (httpBootstrap),
 *     the gateway's `app:suspended` event or its 4503 close (useRealtime);
 *   - GET /v1/client-status reporting a shutdown — checked at boot and on
 *     every WebSocket (re)connect.
 * DISMISSES it only when /v1/client-status says the shutdown is gone: polls
 * 30 s → backing off ×1.5 → 2 min (jittered), plus a manual "Check again".
 * A failed check changes nothing (unknown ≠ lifted). On lift it shows a brief
 * "We're back!" and fires `cipherline:app-resumed`, which makes useRealtime
 * redial at once — and the reconnect drives Dashboard's normal full resync.
 *
 * FLOOR: the same status check compares APP_VERSION with the effective
 * desktop floor and fires `cipherline:upgrade-required` when below, so the
 * update screen appears at boot even before any request has been refused.
 *
 * Never signs out, never clears anything.
 */
export function ClientControlGate({ fetchStatus = fetchClientStatus, appVersion = APP_VERSION }: ClientControlGateProps) {
    const [notice, setNotice] = useState<SuspendedNotice | null>(null);
    const [back, setBack] = useState(false);
    const [checking, setChecking] = useState(false);
    const [nextCheckAt, setNextCheckAt] = useState<number | null>(null);

    const suspendedRef = useRef(false);
    const attemptRef = useRef(0);
    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const inFlight = useRef(false);
    const mounted = useRef(true);

    const clearPoll = () => {
        if (pollTimer.current) clearTimeout(pollTimer.current);
        pollTimer.current = null;
    };

    const resume = useCallback(() => {
        if (!suspendedRef.current) return;
        suspendedRef.current = false;
        clearPoll();
        setNextCheckAt(null);
        setBack(true);
        backTimer.current = setTimeout(() => {
            if (!mounted.current) return;
            setBack(false);
            setNotice(null);
        }, BACK_BEAT_MS);
        dispatchResumed();
    }, []);

    // Declared via ref so suspend → schedule → check → schedule can recurse
    // without a dependency cycle between callbacks.
    const checkRef = useRef<() => Promise<void>>(async () => undefined);

    const schedule = useCallback(() => {
        clearPoll();
        if (!suspendedRef.current) return;
        const delay = nextPollDelayMs(attemptRef.current++);
        setNextCheckAt(Date.now() + delay);
        pollTimer.current = setTimeout(() => { void checkRef.current(); }, delay);
    }, []);

    const suspend = useCallback((n: SuspendedNotice | undefined) => {
        if (backTimer.current) { clearTimeout(backTimer.current); backTimer.current = null; }
        setBack(false);
        // Keep the richer notice we already have when the signal carried none
        // (a bare 4503 close follows the `app:suspended` event that had it).
        setNotice((cur) => n ?? cur ?? toNotice(null));
        if (!suspendedRef.current) {
            suspendedRef.current = true;
            attemptRef.current = 0;
            schedule();
            // A content-less signal: fetch the real notice now.
            if (!n) void checkRef.current();
        }
    }, [schedule]);

    const apply = useCallback((s: ClientStatus) => {
        // Closed-beta diagnostics: the server half of the gate (a failed check
        // never gets here, so "unknown" keeps whatever was last known).
        betaReporter.setServerEnabled(s.betaDiagnostics);
        if (s.shutdown) suspend(s.shutdown);
        else resume();
        if (isBelowFloor(appVersion, s.minVersionDesktop)) dispatchUpgradeRequired(s.minVersionDesktop);
    }, [suspend, resume, appVersion]);

    // Refreshed after every render (effects run in order, so this is current
    // before the subscription effect below first calls it).
    useEffect(() => {
        checkRef.current = async () => {
            if (inFlight.current) return;
            inFlight.current = true;
            if (suspendedRef.current) { setChecking(true); setNextCheckAt(null); }
            try {
                const s = await fetchStatus();
                if (!mounted.current) return;
                if (s) apply(s);
            } finally {
                inFlight.current = false;
                if (mounted.current) {
                    setChecking(false);
                    if (suspendedRef.current) schedule();
                }
            }
        };
    });

    useEffect(() => {
        mounted.current = true;
        const onSuspended = (e: Event) => suspend((e as CustomEvent).detail as SuspendedNotice | undefined);
        const onReconnected = () => { void checkRef.current(); };
        window.addEventListener(APP_SUSPENDED_EVENT, onSuspended);
        window.addEventListener('cipherline:ws-connected', onReconnected);
        void checkRef.current(); // boot check
        return () => {
            mounted.current = false;
            window.removeEventListener(APP_SUSPENDED_EVENT, onSuspended);
            window.removeEventListener('cipherline:ws-connected', onReconnected);
            clearPoll();
            if (backTimer.current) clearTimeout(backTimer.current);
        };
    }, [suspend]);

    const checkAgain = useCallback(() => {
        clearPoll();
        void checkRef.current();
    }, []);

    if (!notice) return null;
    return (
        <AppSuspendedScreen
            notice={notice}
            nextCheckAt={nextCheckAt}
            checking={checking}
            back={back}
            onCheckAgain={checkAgain}
        />
    );
}

export default ClientControlGate;
