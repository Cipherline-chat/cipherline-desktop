/**
 * IPC sender-trust policy.
 *
 * This is the ONE place that decides whether a message arriving on an
 * `ipcMain` channel actually came from our own renderer, and the one place
 * that records which channels (if any) are allowed to skip that decision.
 *
 * WHY THIS MODULE EXISTS (MED-4/5, and the HIGH-2 it was written to prevent
 * recurring): the sender check used to be a line every handler author had to
 * remember to copy — `if (!isTrustedSender(event)) throw ...`. Seventy-seven
 * handlers had it. `updater:set-channel` did not, and the omission was
 * invisible in review precisely because it looked like every other handler.
 * A missing guard must not be a silent no-op, so `installIpcSenderGuard()`
 * in main.ts wraps `ipcMain.handle`/`ipcMain.on` and applies the check to
 * EVERY registration by construction. Skipping it now requires adding the
 * channel to `UNGUARDED_IPC_CHANNELS` below — a visible, reviewable edit in
 * a file whose entire purpose is this policy.
 *
 * Deliberately free of any `electron` import so the decision logic is unit
 * testable (see ipc-guard.test.ts) — the electron-facing installation lives
 * in main.ts.
 */

/**
 * Channels exempt from the sender check.
 *
 * EMPTY, and verified empty. Every `ipcMain.handle` / `ipcMain.on` channel in
 * this app is invoked by the main renderer through `electron/preload.ts`, so
 * every one of them can be — and is — origin-checked. The only other window
 * that loads a preload is the annotation overlay
 * (`electron/annotation-overlay-preload.ts`), and it is receive-only: it calls
 * `ipcRenderer.on` and never `invoke`/`send`, so it originates no IPC and
 * needs no exemption. The installer splash loads inline HTML with no preload
 * at all.
 *
 * Criteria for ever adding one (all three must hold, and say which in the
 * comment on the entry):
 *   1. The channel is genuinely invoked from a window whose origin is not the
 *      app origin — not merely "it felt harmless".
 *   2. It takes no attacker-influenced argument that reaches privileged state
 *      (filesystem, keys, network, updater, shell).
 *   3. It cannot change anything that persists past the current launch.
 *
 * `updater:set-channel` fails (2) and (3) — which is the whole point.
 */
export const UNGUARDED_IPC_CHANNELS: ReadonlySet<string> = new Set<string>();

/** False only for a channel explicitly listed in `UNGUARDED_IPC_CHANNELS`. */
export function channelRequiresSenderCheck(channel: string): boolean {
    return !UNGUARDED_IPC_CHANNELS.has(channel);
}

/**
 * True when `senderUrl` is our own renderer.
 *
 * In dev the renderer is served by the Vite dev server, so the sender must
 * match that origin exactly. In a packaged build it is served by the main
 * process's own loopback HTTP server on a FIXED port (main.ts's
 * `CIPHERLINE_PROD_PORT` — there is no fallback port, the app refuses to
 * start if it cannot bind), so we can and do pin scheme + host + port.
 *
 * The old check was `senderUrl.startsWith('http://127.0.0.1:')`, which a
 * userinfo-bearing URL slips straight past: `http://127.0.0.1:pw@evil.com/`
 * has that prefix and a host of `evil.com`. Parsing and comparing the
 * components closes that.
 *
 * `devServerUrl` must already be the dev/prod decision made in main.ts
 * (undefined in a packaged build regardless of the environment — see MED-3);
 * this function never reads `process.env` itself.
 */
export function isTrustedSenderUrl(
    senderUrl: string | null | undefined,
    devServerUrl: string | undefined,
    prodLoopbackPort: number,
): boolean {
    if (!senderUrl) return false;
    let actual: URL;
    try { actual = new URL(senderUrl); } catch { return false; }

    if (devServerUrl) {
        let expected: URL;
        try { expected = new URL(devServerUrl); } catch { return false; }
        return actual.protocol === expected.protocol
            && actual.hostname === expected.hostname
            && actual.port === expected.port;
    }

    return actual.protocol === 'http:'
        && actual.hostname === '127.0.0.1'
        && actual.port === String(prodLoopbackPort);
}
