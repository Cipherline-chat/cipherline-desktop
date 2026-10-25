import axios from 'axios';
import { APP_VERSION } from '../constants';
import { dispatchSuspended, dispatchUpgradeRequired, isSuspendedResponse, toNotice } from './clientControl';

/**
 * Side-effect module. Imported once from `main.tsx` before any component
 * renders so every axios call — including the ones scattered across
 * components — inherits the version header + 426 handler.
 *
 * We do NOT refactor every call site to a shared client: `axios.defaults`
 * + a global interceptor covers 100% of existing usage with zero churn.
 */

// Every request out of the renderer advertises our build version so the
// server's VersionGuard can force-upgrade old clients.
axios.defaults.headers.common['X-Cipherline-Version'] = APP_VERSION;

// Stamp the official-build attestation header on every request. The secret
// lives in the Electron main process; we ask it to sign over IPC. In dev / web
// (no signer or no secret) this returns null and the header is omitted — the
// server only enforces attestation when CLIENT_ATTEST_SECRETS is configured.
axios.interceptors.request.use(async (config) => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
        const token = await (window as any).electronAPI?.attestSign?.();
        if (token) config.headers['X-Cipherline-Attest'] = token;
    } catch { /* no signer available — proceed unattested */ }
    return config;
});

// Catch HTTP 426 Upgrade Required globally and broadcast a window event.
// <UpgradeRequiredOverlay /> listens and renders a blocking screen.
//
// Same for the admin kill switch: a 503 whose body says `code: APP_SUSPENDED`
// (and ONLY that — a bare 503 from a proxy or a rolling deploy is just an
// error) broadcasts the notice; <ClientControlGate /> shows the blocking
// "shut down" screen and polls for the switch to lift. Nothing here ever
// signs out or clears anything: a shutdown is temporary by definition.
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error?.response?.status as number | undefined;
        if (status === 426) {
            const minVersion = error.response?.data?.min_version as string | undefined;
            dispatchUpgradeRequired(minVersion);
        } else if (isSuspendedResponse(status, error?.response?.data)) {
            dispatchSuspended(toNotice(error.response.data));
        }
        return Promise.reject(error);
    },
);

export { };
