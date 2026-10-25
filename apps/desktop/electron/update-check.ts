/**
 * update-check — ONE way to ask electron-updater "is there an update?" that
 * cannot leave a rejected promise behind.
 *
 * With `autoDownload` on, `checkForUpdates()` resolves with a `downloadPromise`
 * (the download it has already started) that electron-updater itself never
 * handles. A network blip mid-download (`net::ERR_HTTP2_PROTOCOL_ERROR`,
 * `net::ERR_CONNECTION_RESET`, …) rejects it AFTER the failure has been
 * delivered to the `error` listener, and with no handler attached Node reports
 * an `unhandledRejection` — which the crash reporter recorded as a crash
 * (1.0.20: "Cipherline closed unexpectedly", user 1998a718). Every check in the
 * app goes through here; updater.wiring.test.ts pins that main.ts has no other
 * `checkForUpdates()` call, and update-check.test.ts pins the behaviour.
 *
 * No `electron` import: unit-testable.
 */

export interface DownloadingResult {
    downloadPromise?: Promise<unknown> | null;
}

export interface HandledCheckDeps<R extends DownloadingResult> {
    /** A reason the check must not run at all (e.g. the manifest verifier is missing); null = go. */
    blocked(): Error | null;
    /** Deliver an error the way electron-updater's own failures arrive (the `error` listener decides what the UI shows). */
    emitError(err: Error): void;
    /** `autoUpdater.checkForUpdates()`. May reject (a failed manifest fetch, a rejected signature). */
    check(): Promise<R | null | undefined>;
    /** The auto-download rejected. Already reported by the `error` listener; this is the extra breadcrumb. */
    onDownloadRejected(e: unknown): void;
}

export function createHandledUpdateCheck<R extends DownloadingResult>(
    deps: HandledCheckDeps<R>,
): () => Promise<R | null | undefined> {
    return async () => {
        const blocked = deps.blocked();
        if (blocked) {
            deps.emitError(blocked);
            throw blocked;
        }
        const result = await deps.check();
        // Attached in the same tick the check resolves, before Node looks for
        // unhandled rejections. The handler must never throw (it would itself
        // become an unhandled rejection).
        result?.downloadPromise?.catch((e: unknown) => {
            try { deps.onDownloadRejected(e); } catch { /* diagnostics only */ }
        });
        return result;
    };
}
