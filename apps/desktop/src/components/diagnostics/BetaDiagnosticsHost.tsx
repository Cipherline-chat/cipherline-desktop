import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import axios from 'axios';
import { APP_VERSION, BUILD_COMMIT } from '../../constants';
import { apiUrl } from '../../utils/apiPath';
import { useAuth } from '../../contexts/AuthContext';
import { useHydration } from '../../contexts/HydrationContext';
import { betaReporter, classifyBetaSend, reportBeta, type BetaRoute } from '../../utils/betaDiagnostics/reporter';
import { installBetaBridges } from '../../utils/betaDiagnostics/bridges';
import { setBetaCallUser } from '../../utils/betaDiagnostics/callSession';
import {
    getBetaDiagEnabled, getBetaNoticeSeen, markBetaNoticeSeen, setBetaDiagEnabled, subscribeBetaDiagSetting,
} from '../../utils/betaDiagnostics/settings';
import {
    WsChurnCounter, jsHeapUsedBytes, keyWaitTracker, memoryHighCheck, STARTUP_SLOW_MS,
} from '../../utils/betaDiagnostics/detectors';
import { buildProfile, localeLang, mediaDeviceCounts, networkTypeOf, readWebglRenderer } from '../../utils/betaDiagnostics/profile';
import { setBetaScrubber, setBetaSensitiveTerms } from '../../utils/betaDiagnostics/sanitize';
import { wasAuthScreenShown } from '../../utils/betaDiagnostics/startup';
import { parseSystemInfoReply } from '../../utils/diagnostics/ipc';
import { createScrubber } from '../../utils/diagnostics/scrub';
import { collectSensitiveTerms } from '../../utils/diagnostics/sensitiveTerms';
import { BetaDiagnosticsNotice } from './BetaDiagnosticsNotice';
import { CallRatingCard } from './CallRatingCard';

/**
 * The closed-beta diagnostics host. Mounted once for the signed-in app
 * (App.tsx). Renders the one-time notice and the call rating card; otherwise
 * it only wires things up:
 *
 *   - the reporter's transport (axios → POST /v1/diagnostics/beta/<route>,
 *     JWT + x-device-id; the global interceptors add version + attestation),
 *     the signed-in state and the local toggle;
 *   - the bridges from existing diagnostics (bridges.ts);
 *   - the app-health detectors that need a live window: memory (every
 *     MEMORY_POLL_MS), WebSocket churn ('cipherline:ws-disconnected'), the
 *     updater ('failed' state), startup time;
 *   - the device profile, once per app session (again if a device count
 *     changes) — plus gpu_fallback when the GPU is not accelerating;
 *   - a best-effort flush when the app quits.
 *
 * The server half of the gate (`beta_diagnostics` in /v1/client-status) is
 * fed in by ClientControlGate. None of this does any work while inactive.
 */

const MEMORY_POLL_MS = 60_000;
const SCRUBBER_REFRESH_MS = 5 * 60_000;
const PROFILE_DEVICE_DEBOUNCE_MS = 5_000;

const subscribeState = (cb: () => void) => betaReporter.subscribe(cb);
const readActive = () => betaReporter.getState().active;
const readServer = () => betaReporter.getState().serverEnabled;

export const BetaDiagnosticsHost: React.FC = () => {
    const { token, userId, deviceId } = useAuth();
    const { ready: hydrated, settled } = useHydration();
    const active = useSyncExternalStore(subscribeState, readActive, () => false);
    const serverEnabled = useSyncExternalStore(subscribeState, readServer, () => false);
    const localEnabled = useSyncExternalStore(subscribeBetaDiagSetting, () => getBetaDiagEnabled(userId), () => false);
    const noticeSeen = useSyncExternalStore(subscribeBetaDiagSetting, () => getBetaNoticeSeen(userId), () => true);
    const auth = useRef({ token, deviceId });
    useEffect(() => { auth.current = { token, deviceId }; }, [token, deviceId]);

    // Transport + bridges, once.
    useEffect(() => {
        betaReporter.configure({
            appVersion: APP_VERSION,
            transport: async (route: BetaRoute, body: object) => {
                const { token: t, deviceId: d } = auth.current;
                if (!t) return { ok: false, retry: true };
                try {
                    const res = await axios.post(apiUrl`/diagnostics/beta/${route}`, body, {
                        headers: { Authorization: `Bearer ${t}`, ...(d ? { 'x-device-id': d } : {}) },
                        timeout: 15_000,
                    });
                    return classifyBetaSend(res.status);
                } catch (err) {
                    return classifyBetaSend((err as { response?: { status?: number } })?.response?.status);
                }
            },
        });
        const uninstall = installBetaBridges();
        return () => { uninstall(); betaReporter.configure({ transport: null }); };
    }, []);

    // Gate: signed in + the local toggle.
    useEffect(() => {
        betaReporter.setSignedIn(!!token && !!userId);
        setBetaCallUser(userId ?? null);
    }, [token, userId]);
    useEffect(() => { betaReporter.setLocalEnabled(localEnabled); }, [localEnabled]);
    useEffect(() => () => {
        betaReporter.setSignedIn(false);
        setBetaCallUser(null);
        keyWaitTracker.clear();
    }, []);

    // Error-message scrubber that knows this account's names (rebuilt periodically while active).
    const homeDirRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!active) return;
        const rebuild = () => {
            try {
                const terms = collectSensitiveTerms();
                setBetaSensitiveTerms(terms);
                setBetaScrubber(createScrubber({
                    sensitiveTerms: terms,
                    homeDir: homeDirRef.current,
                    maxLength: 300,
                }));
            } catch { /* keep the previous one */ }
        };
        rebuild();
        const iv = setInterval(rebuild, SCRUBBER_REFRESH_MS);
        return () => clearInterval(iv);
    }, [active]);

    // Device profile (+ gpu_fallback), once per session; again on a device-count change.
    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        let gpuReported = false;
        const send = async () => {
            try {
                const raw = await window.electronAPI?.diagGetSystemInfo?.().catch(() => null) ?? null;
                const { system, scrub } = parseSystemInfoReply(raw, APP_VERSION, BUILD_COMMIT);
                if (scrub.homeDir) homeDirRef.current = scrub.homeDir;
                const counts = await mediaDeviceCounts();
                if (cancelled) return;
                const profile = buildProfile(system, {
                    webglRenderer: readWebglRenderer(),
                    ...counts,
                    networkType: networkTypeOf((navigator as unknown as { connection?: { type?: unknown } }).connection),
                    localeLang: localeLang(navigator.language),
                    devicePixelRatio: window.devicePixelRatio || 1,
                });
                betaReporter.sendProfile(profile);
                if (!profile.gpu_accel && !gpuReported) {
                    gpuReported = true;
                    reportBeta('gpu_fallback', {
                        stage: 'software_rendering',
                        hw_accel_setting: system.hardware_acceleration,
                        compositing: system.gpu.feature_status?.gpu_compositing,
                    });
                }
            } catch { /* diagnostics only */ }
        };
        void send();
        const onDeviceChange = () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => { void send(); }, PROFILE_DEVICE_DEBOUNCE_MS);
        };
        try { navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange); } catch { /* none */ }
        return () => {
            cancelled = true;
            if (debounce) clearTimeout(debounce);
            try { navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange); } catch { /* none */ }
        };
    }, [active]);

    // Memory + WebSocket churn + updater failures.
    useEffect(() => {
        if (!active) return;
        const churn = new WsChurnCounter();
        const onWsDown = () => {
            const n = churn.noteDrop(Date.now());
            if (n !== null) reportBeta('ws_churn', { reconnects_10m: n });
        };
        window.addEventListener('cipherline:ws-disconnected', onWsDown);
        let memHigh = false;
        const mem = setInterval(() => {
            const mb = memoryHighCheck(jsHeapUsedBytes);
            if (mb !== null && !memHigh) reportBeta('memory_high', { mb, scope: 'js_heap' });
            memHigh = mb !== null;
        }, MEMORY_POLL_MS);
        let lastFailed: string | null = null;
        const offUpdate = window.electronAPI?.onUpdateState?.((s) => {
            if (s.phase === 'failed') {
                const key = `${s.version}:${s.stage}`;
                if (key !== lastFailed) { lastFailed = key; reportBeta('update_failed', { stage: s.stage }); }
            }
        });
        // Best-effort flush when the app quits / the window goes away.
        const flush = () => { void betaReporter.flush(); };
        const offQuit = window.electronAPI?.onBeforeQuit?.(flush);
        window.addEventListener('pagehide', flush);
        return () => {
            window.removeEventListener('cipherline:ws-disconnected', onWsDown);
            clearInterval(mem);
            offUpdate?.();
            offQuit?.();
            window.removeEventListener('pagehide', flush);
        };
    }, [active]);

    // Startup time: navigation → the signed-in app is ready (hydration gate lifted).
    // Only for a launch that went straight in — a sign-in screen in between
    // would measure the person typing, not the app.
    const startupMs = useRef<number | null>(null);
    const gateTimedOut = useRef(false);
    useEffect(() => {
        if (!hydrated || startupMs.current !== null) return;
        startupMs.current = Math.round(performance.now());
        gateTimedOut.current = !Object.values(settled ?? {}).every(Boolean);
    }, [hydrated, settled]);
    const startupReported = useRef(false);
    useEffect(() => {
        if (!active || !hydrated || startupReported.current || startupMs.current === null) return;
        startupReported.current = true;
        if (wasAuthScreenShown()) return;
        if (startupMs.current >= STARTUP_SLOW_MS) reportBeta('startup_slow', { ms: startupMs.current, gate_timeout: gateTimedOut.current });
    }, [active, hydrated]);

    const showNotice = serverEnabled && localEnabled && !!userId && !noticeSeen;
    return (
        <>
            {showNotice && (
                <BetaDiagnosticsNotice
                    onAcknowledge={() => markBetaNoticeSeen(userId)}
                    onTurnOff={() => { setBetaDiagEnabled(userId, false); markBetaNoticeSeen(userId); }}
                />
            )}
            <CallRatingCard />
        </>
    );
};

export default BetaDiagnosticsHost;
