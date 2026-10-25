/**
 * net-error — telling a flaky NETWORK from a bug, for the main process.
 *
 * ── Why this exists (crash report, user 1998a718, Windows, 1.0.20) ──────────
 *   kind: main_exception, reason: unhandled-rejection, process_type: browser
 *   Error: net::ERR_HTTP2_PROTOCOL_ERROR
 *       at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init)
 *
 * Electron's `net` module (what electron-updater downloads with) rejects with a
 * Chromium net-stack error when the connection misbehaves: an HTTP/2 stream
 * reset by the CDN, a dropped Wi-Fi, a proxy hiccup. In 1.0.20 the update
 * check's auto-download promise (`checkForUpdates()` -> `downloadPromise`) was
 * never given a handler, so one such blip became a main-process
 * `unhandledRejection`, which the crash reporter stored as a CRASH and the next
 * launch reported as "Cipherline closed unexpectedly". 1.0.22 closed that hole
 * at the source (main.ts `checkForUpdatesHandled`); this module is the second
 * line of defence for every other path that can leak one (a future `net.fetch`,
 * a floating `loadURL()`, a library's own forgotten promise).
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A `net::ERR_*` (or Electron's `loadURL` flavour, `ERR_X (-N) loading '…'`)
 * that reaches the global handler is NOT a crash: the app is alive and the
 * network will come back. It is logged as a diagnostic event
 * (`net:unhandled-rejection code=ERR_…`, visible in Settings -> Advanced ->
 * Performance log and in "Report a problem") and nothing else happens. Anything
 * else — a TypeError, a bare Error('boom'), a string — is recorded as a crash
 * exactly as before. The match is deliberately narrow:
 *   - the message must START with the Chromium error name, so an arbitrary
 *     error that merely mentions one in passing is not waved through;
 *   - programming-error classes (TypeError, RangeError, ReferenceError,
 *     SyntaxError, EvalError, AssertionError) are never network errors, even
 *     if someone put `net::ERR_…` in the message;
 *   - the `code` property is NOT used: Node's own `ERR_INVALID_ARG_TYPE` and
 *     the updater's `ERR_UPDATER_*` also start with `ERR_` and are not network
 *     failures.
 *
 * No `electron` import (unit-testable); must not import from src/ (the rootDir
 * trap in CLAUDE.md).
 */

/** `net::ERR_HTTP2_PROTOCOL_ERROR`, optionally behind an `Error: ` prefix. */
const NET_ERR_RE = /^(?:[A-Za-z]*Error: )?net::(ERR_[A-Z0-9_]{2,60})(?![A-Z0-9_])/;
/** `webContents.loadURL()` / `loadFile()` rejections: `ERR_CONNECTION_REFUSED (-102) loading 'http://…'`. */
const LOAD_ERR_RE = /^(?:[A-Za-z]*Error: )?(ERR_[A-Z0-9_]{2,60}) \(-\d{1,4}\) loading '/;

/** Names of errors that mean "the code is wrong", never "the network is". */
const PROGRAMMING_ERROR_NAMES: ReadonlySet<string> = new Set([
    'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AssertionError',
]);

function messageOf(e: unknown): string | null {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
        const m = (e as { message?: unknown }).message;
        if (typeof m === 'string') return m;
    }
    return null;
}

function nameOf(e: unknown): string {
    if (e && typeof e === 'object') {
        const n = (e as { name?: unknown }).name;
        if (typeof n === 'string') return n;
    }
    return '';
}

/**
 * The Chromium net-error name (`ERR_HTTP2_PROTOCOL_ERROR`) carried by a thrown
 * value, or null when it is not a network failure. Only the static name is
 * returned — never the URL that may follow it.
 */
export function networkErrorCode(e: unknown): string | null {
    if (PROGRAMMING_ERROR_NAMES.has(nameOf(e))) return null;
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return null;
    const msg = messageOf(e)?.trimStart();
    if (!msg) return null;
    return NET_ERR_RE.exec(msg)?.[1] ?? LOAD_ERR_RE.exec(msg)?.[1] ?? null;
}

/** True for a Chromium network-stack failure (see the module doc for what that excludes). */
export function isNetworkClassError(e: unknown): boolean {
    return networkErrorCode(e) !== null;
}

/**
 * electron-updater `error` code for the Performance log's `updater:check`
 * line: the error's own `.code` when it is a plain ERR_*-style token, else the
 * network error name (`net::ERR_…` carries no `.code`, so it used to read
 * `code=none`), else 'none'.
 */
export function updaterErrorCode(e: unknown): string {
    const c = (e as { code?: unknown } | null)?.code;
    if (typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(c)) return c;
    return networkErrorCode(e) ?? 'none';
}

export type MainErrorOrigin = 'uncaughtException' | 'unhandledRejection';

export interface MainErrorDeps {
    /** The existing fatal path: store a pending crash record (main.ts `recordCrash`). */
    record(thrown: unknown, origin: MainErrorOrigin): void;
    /** A diagnostic event for the Performance log (freezeMonitor.event). Must not throw. */
    event(name: string, ms: number, detail: string): void;
    /** Console output; `warn` for a non-fatal network error, `error` for a real one. */
    log(level: 'warn' | 'error', line: string, thrown: unknown): void;
}

/**
 * The handler behind `process.on('unhandledRejection' | 'uncaughtException')`.
 * A network-class error is logged as a diagnostic event and is NOT a crash;
 * everything else is logged and recorded as a crash exactly as before.
 * Never throws (a crash handler that throws turns one crash into two).
 */
export function createMainErrorHandler(origin: MainErrorOrigin, deps: MainErrorDeps): (thrown: unknown) => void {
    return (thrown) => {
        try {
            const code = networkErrorCode(thrown);
            if (code) {
                deps.log('warn', `[Main] ${origin} (network, non-fatal) ${code}`, thrown);
                const name = origin === 'unhandledRejection' ? 'net:unhandled-rejection' : 'net:uncaught-exception';
                deps.event(name, 0, `code=${code}`);
                return;
            }
            deps.log('error', `[Main] ${origin}:`, thrown);
            deps.record(thrown, origin);
        } catch (e) {
            try { console.error('[Main] error handler failed:', e); } catch { /* nothing left to do */ }
        }
    };
}
