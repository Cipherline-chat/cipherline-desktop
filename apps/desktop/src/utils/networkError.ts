/**
 * networkError — telling a flaky NETWORK from a bug, for the renderer.
 *
 * The renderer twin of electron/net-error.ts (main-process, branch
 * claude/main-net-unhandled-fix). Same rule, different error family: the main
 * process sees Chromium `net::ERR_*` strings from Electron's net stack; the
 * renderer sees axios errors, which report a failed transport as
 *
 *     AxiosError { message: 'Network Error', code: 'ERR_NETWORK', response: undefined }
 *     AxiosError { message: 'timeout of 8000ms exceeded', code: 'ECONNABORTED' }
 *
 * (the xhr adapter builds them in `request.onerror` / `request.ontimeout`, which
 * is the `w.onerror` frame beta diagnostics showed).
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * An axios error that carries NO HTTP response and whose `code` is one of the
 * transport codes below is a connectivity failure, not a bug: the app is alive
 * and the network will come back (typically: the first seconds after a wake,
 * while Wi-Fi is still reconnecting). It is a non-fatal diagnostic. Anything
 * else — a TypeError, a thrown string, an axios error that DID get a response
 * (a 500 is the server's answer, and an unhandled one is still a missed catch
 * worth seeing) — is a real bug and is reported as before. The match is
 * deliberately narrow, mirroring net-error.ts:
 *   - it must be an axios error (`isAxiosError` / name 'AxiosError'): an
 *     arbitrary error whose message merely says "Network Error" is not waved
 *     through;
 *   - programming-error classes (TypeError, RangeError, ReferenceError,
 *     SyntaxError, EvalError, URIError) are never network errors, even when
 *     someone set a network `code` on them;
 *   - `ERR_CANCELED` is NOT included: a deliberate abort is the caller's own
 *     doing and a rejection it left unhandled is a missed catch.
 */

/** axios `code`s that mean "the request never got an HTTP answer". */
export const NETWORK_AXIOS_CODES: ReadonlySet<string> = new Set([
    'ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK_CHANGED',
]);

const PROGRAMMING_ERROR_NAMES: ReadonlySet<string> = new Set([
    'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
]);

function nameOf(e: unknown): string {
    const n = (e as { name?: unknown } | null | undefined)?.name;
    return typeof n === 'string' ? n : '';
}

/** Looks like an axios error (instance flag, or the class name for a cloned/serialised one). */
function isAxiosShaped(e: unknown): boolean {
    if (!e || typeof e !== 'object') return false;
    return (e as { isAxiosError?: unknown }).isAxiosError === true || nameOf(e) === 'AxiosError';
}

/**
 * The transport `code` (`ERR_NETWORK`, `ECONNABORTED`, …) carried by a thrown
 * value, or null when it is not a connectivity failure. Only the static code
 * is returned — never the URL, which axios error messages and `config` carry.
 */
export function networkErrorCode(e: unknown): string | null {
    if (PROGRAMMING_ERROR_NAMES.has(nameOf(e))) return null;
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) return null;
    if (!isAxiosShaped(e)) return null;
    const err = e as { response?: unknown; code?: unknown };
    if (err.response !== undefined && err.response !== null) return null;
    const code = typeof err.code === 'string' ? err.code : '';
    return NETWORK_AXIOS_CODES.has(code) ? code : null;
}

/** True for an axios transport failure (see the module doc for what that excludes). */
export function isNetworkClassError(e: unknown): boolean {
    return networkErrorCode(e) !== null;
}

/**
 * Why a failed request failed, as a code-chosen enum for beta `detail`:
 *   'network' — no HTTP answer (connectivity);
 *   'http'    — the server answered with an error status;
 *   'local'   — not an axios failure at all (our own code threw).
 */
export function failureCauseOf(e: unknown): 'network' | 'http' | 'local' {
    if (isNetworkClassError(e)) return 'network';
    const status = (e as { response?: { status?: unknown } } | null | undefined)?.response?.status;
    if (typeof status === 'number') return 'http';
    return 'local';
}
