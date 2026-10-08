import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useNotificationPrefsSafe } from '../../contexts/NotificationContext';
import { useToast } from '../../contexts/ToastContext';
import secureLocalStore from '../../utils/secureLocalStore';
import { createScrubber } from '../../utils/diagnostics/scrub';
import { setCaptureScrubber } from '../../utils/diagnostics/recentErrors';
import { registerSensitiveTermsSource } from '../../utils/diagnostics/sensitiveTerms';
import { snapshotUserNames, snapshotDeviceNames } from '../../utils/peerIdentityCache';
import { parsePendingCrashesReply, newestCrash, type PendingCrashEntry } from '../../utils/diagnostics/ipc';
import { closeReportProblem, openReportProblem, useReportRequest } from '../../utils/diagnostics/reportRequest';
import { buildFromPrepared, prepareReportInputs, type LiveContext } from '../../utils/diagnostics/collect';
import { sendDiagnosticReport } from '../../utils/diagnostics/send';
import {
    appendAutoSendLog, getAutoSendEnabled, planAutoSend, readAutoSendLog, writeAutoSendLog,
} from '../../utils/diagnostics/autoSend';
import { ReportProblemModal } from './ReportProblemModal';
import { CrashPrompt } from './CrashPrompt';

/** Wait this long after sign-in before touching crash records — startup first. */
const BOOT_DELAY_MS = 4_000;

/**
 * Mounted once (App.tsx, signed-in only). Owns:
 *   • the Report-a-problem modal for whatever openReportProblem() asked for;
 *   • the boot-time crash check: pending crash records from main →
 *       auto-send ON  → send the same scrubbed body silently (planAutoSend:
 *                       signed in, ≤ 3 a day, once per signature) + a toast;
 *       auto-send OFF → the "closed unexpectedly" prompt for unseen records;
 *   • the scrubber terms that belong to the signed-in user (recent-error
 *     capture + the report builder).
 *
 * "Not now" marks the records SEEN (main keeps them, capped at 5): the prompt
 * does not nag again for the same crash, but a later manual "Crash" report
 * still attaches it, and the same crash happening AGAIN re-arms the prompt.
 */
export const ReportProblemHost: React.FC = () => {
    const { token, userId, user, isAuthenticated } = useAuth();
    const { isPaid, canPublishVideo, maxUploadBytes } = useSubscription();
    const notif = useNotificationPrefsSafe();
    const toast = useToast();
    const request = useReportRequest();
    const [prompt, setPrompt] = useState<{ entry: PendingCrashEntry; unseen: string[] } | null>(null);
    const checkedFor = useRef<string | null>(null);

    const live: LiveContext = useMemo(() => ({
        user: user ? { username: user.username, email: user.email } : null,
        entitlement: { isPaid, canPublishVideo, maxUploadBytes },
        notificationPrefs: notif?.prefs ?? null,
    }), [user, isPaid, canPublishVideo, maxUploadBytes, notif?.prefs]);
    const liveRef = useRef(live);
    const tokenRef = useRef(token);
    useEffect(() => { liveRef.current = live; tokenRef.current = token; });

    // The signed-in user's own names: scrub them from recent-error capture
    // from now on, and offer them to every report.
    useEffect(() => {
        const own = [user?.username, user?.email].filter((s): s is string => !!s);
        setCaptureScrubber(createScrubber({ sensitiveTerms: own }));
        return registerSensitiveTermsSource('auth-user', () => (user ? [{ username: user.username, email: user.email }] : []));
    }, [user]);

    // Every peer username this session has resolved (server members included,
    // not just friends) — names only, harvested when a report is built.
    useEffect(() => registerSensitiveTermsSource('peer-identities', () =>
        [...Object.values(snapshotUserNames()), ...Object.values(snapshotDeviceNames())].map(name => ({ name }))), []);

    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

    const autoSend = useCallback(async (uid: string, tok: string, pending: PendingCrashEntry[]) => {
        const plan = planAutoSend({ enabled: true, signedIn: true, pending, log: readAutoSendLog(uid), now: Date.now() });
        if (plan.duplicates.length) await api?.diagClearPendingCrashes?.(plan.duplicates.map(p => p.signature)).catch(() => {});
        if (!plan.send.length) return;
        const prepared = await prepareReportInputs(liveRef.current);
        let sent = 0;
        for (const entry of plan.send) {
            const { body } = buildFromPrepared(prepared, { category: 'crash', trigger: 'auto_crash', crash: entry.crash });
            const r = await sendDiagnosticReport(body, tok);
            if (!r.ok) break; // offline / rate-limited: keep them pending for next time
            sent++;
            writeAutoSendLog(uid, appendAutoSendLog(readAutoSendLog(uid), entry.signature, Date.now()));
            await api?.diagClearPendingCrashes?.([entry.signature]).catch(() => {});
        }
        if (sent > 0) {
            toast.push({
                kind: 'info',
                title: sent > 1 ? 'Crash reports sent' : 'Crash report sent',
                message: 'Cipherline closed unexpectedly last time, so a crash report was sent automatically. You can turn this off in Settings → Advanced.',
                durationMs: 7000,
            });
        }
    }, [api, toast]);

    const autoSendRef = useRef(autoSend);
    useEffect(() => { autoSendRef.current = autoSend; });

    // Boot-time crash check, once per signed-in account per app session. Only
    // identity is a dependency: a token refresh or a re-render must not cancel
    // the pending check (the latest token / callbacks are read through refs).
    useEffect(() => {
        if (!isAuthenticated || !userId || !api?.diagGetPendingCrashes) return;
        if (checkedFor.current === userId) return;
        let cancelled = false;
        const t = setTimeout(async () => {
            if (cancelled) return;
            checkedFor.current = userId;
            try {
                // Per-account records (the auto-send toggle) are cold until the
                // account's store is ready — reading early would read "off".
                await secureLocalStore.whenAccountReady();
                const pending = parsePendingCrashesReply(await api.diagGetPendingCrashes!());
                if (cancelled || pending.length === 0) return;
                const tok = tokenRef.current;
                if (getAutoSendEnabled(userId)) { if (tok) await autoSendRef.current(userId, tok, pending); return; }
                const unseen = pending.filter(p => !p.seen);
                const newest = newestCrash(unseen);
                if (newest) setPrompt({ entry: newest, unseen: unseen.map(p => p.signature) });
            } catch { /* diagnostics must never break the app */ }
        }, BOOT_DELAY_MS);
        return () => { cancelled = true; clearTimeout(t); };
    }, [isAuthenticated, userId, api]);

    const markSeen = useCallback((sigs: string[]) => { void api?.diagMarkCrashesSeen?.(sigs).catch(() => {}); }, [api]);

    const onReview = useCallback(() => {
        if (!prompt) return;
        markSeen(prompt.unseen);
        setPrompt(null);
        openReportProblem({ category: 'crash', trigger: 'crash_prompt', step: 'preview' });
    }, [prompt, markSeen]);

    const onNotNow = useCallback(() => {
        if (!prompt) return;
        markSeen(prompt.unseen);
        setPrompt(null);
    }, [prompt, markSeen]);

    const onCrashSent = useCallback((sig: string) => { void api?.diagClearPendingCrashes?.([sig]).catch(() => {}); }, [api]);

    return (
        <>
            {prompt && !request && <CrashPrompt count={prompt.entry.count} onReview={onReview} onNotNow={onNotNow} />}
            {request && (
                <ReportProblemModal
                    key={request.nonce}
                    request={request}
                    token={token}
                    username={user?.username ?? null}
                    live={live}
                    onClose={closeReportProblem}
                    onCrashSent={onCrashSent}
                />
            )}
        </>
    );
};

export default ReportProblemHost;
