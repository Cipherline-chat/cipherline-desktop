/**
 * updater-state.ts — the update lifecycle, kept separate from `electron-updater`
 * wiring so it can be unit-tested without a packaged app or a real network.
 *
 * ── Policy: updates complete IN THE APP ─────────────────────────────────────
 * The owner's rule (2026-10-09): the update must ALWAYS happen in the app. A
 * browser download is never the user's path on Windows or macOS.
 *
 * This file used to do the opposite. Any `error` after `update-available`
 * moved to a `manual` phase whose only action opened the installer URL in the
 * OS browser, on the theory that an error mid-update meant "self-install is
 * impossible on this machine". That theory was wrong for Windows: most of the
 * errors NsisUpdater can raise there are transient (a dropped connection on a
 * ~130 MB download from an origin with no CDN, an antivirus scanner holding
 * the freshly written installer, the PowerShell Authenticode check exceeding
 * electron-updater's hard-coded 20 s while Defender scans that same file). One
 * blip handed every affected tester a browser link — the 1.0.21-staging.157
 * report. So now:
 *
 *   • A failure while an update is in flight is RETRIED automatically, with
 *     backoff (RETRY_DELAYS_MS), and the UI stays in-app (`retrying`, with a
 *     "retry now" action). main.ts clears electron-updater's `pending/` cache
 *     before each retry, so a retry is always a fresh, full download.
 *   • When the retry budget is spent the state is `failed` — still in-app, with
 *     a Retry button — never a link.
 *   • A REAL signature failure (`ERR_UPDATER_INVALID_SIGNATURE`: the installer
 *     was checked and is not signed by Cipherline LLC; or, on macOS, Squirrel
 *     rejecting the code signature) is a security signal: no automatic retry,
 *     straight to `failed` with stage `verify` — "couldn't be verified" — and a
 *     user-initiated Retry that downloads and verifies again from scratch.
 *     "The check could not RUN" (timeout, PowerShell noise) is NOT that signal
 *     and is retried like any other transient error; see authenticode-verify.ts.
 *   • A rejected update MANIFEST (`ERR_UPDATER_MANIFEST_SIGNATURE`, its
 *     detached Ed25519 signature missing-while-required / malformed / wrong —
 *     signed-update-provider.ts) is the same signal one step earlier: nothing
 *     was downloaded. It goes to `failed`/`verify` from ANY phase but `ready`,
 *     including `idle`, with no automatic retry.
 *
 * ── Why `manual` still exists, on Linux only ────────────────────────────────
 * Windows (NSIS) and macOS (Squirrel.Mac; official builds are signed and
 * notarized) can always replace themselves. A Linux AppImage replaces ITSELF —
 * the file at `$APPIMAGE` — so an AppImage in a location the user cannot
 * write (/opt, a read-only mount, a file owned by root), or a copy run without
 * `$APPIMAGE` pointing at it, can never self-update, and there is no installer
 * that could elevate. After the retry budget is spent, Linux falls back to a
 * same-origin download link; no other platform ever does. (.deb installs go
 * through electron-updater's DebUpdater and the same retry path.)
 *
 * An error with NO update in flight (`idle`: a periodic check that failed on a
 * network blip) stays `idle` — surfacing anything would invent an "update
 * available" out of a wifi hiccup. An error while `ready`/`failed`/`manual`
 * keeps that state: a later background check failing carries no information
 * worth destroying a downloaded update or a Retry button over. (A failure of
 * the INSTALL step itself is reported separately — see onInstallError.)
 */

export type UpdateFailureStage = 'download' | 'verify' | 'install';

export type UpdateState =
    | { phase: 'idle' }
    | { phase: 'available'; version: string }
    | { phase: 'downloading'; version: string; percent: number }
    /** A download/verification failed; another attempt is scheduled at `retryAt`
     *  (epoch ms). `attempt` = failures so far for this version (1-based). */
    | { phase: 'retrying'; version: string; attempt: number; maxAttempts: number; retryAt: number }
    /** Retries exhausted, a signature rejection, or a failed install. In-app, with Retry. */
    | { phase: 'failed'; version: string; stage: UpdateFailureStage }
    | { phase: 'ready'; version: string }
    /** Linux only — see the module doc. */
    | { phase: 'manual'; version: string; downloadUrl: string };

/** Minimal shape of electron-updater's UpdateInfo this module actually reads —
 *  kept narrow (rather than importing the real type) so this file has zero
 *  runtime dependency on `electron-updater` and can be tested in plain Node. */
export interface UpdateFileInfo {
    /** Relative to the publish base URL (e.g. "Cipherline-1.2.0-arm64.dmg"). */
    url: string;
}
export interface UpdateInfoLike {
    version: string;
    files: UpdateFileInfo[];
}

export interface ProgressInfoLike {
    percent: number;
}

/**
 * Delay before automatic retry N (index N-1). Three retries: 10 s for a blip,
 * a minute for a flaky connection, five minutes for an outage or a scanner
 * that is still busy. After the last one the state is `failed` (Retry button).
 */
export const RETRY_DELAYS_MS: readonly number[] = Object.freeze([10_000, 60_000, 300_000]);

/** Phases in which an update is being fetched/verified and a failure means "that attempt failed". */
export function isUpdateInFlight(s: UpdateState): s is Extract<UpdateState, { phase: 'available' | 'downloading' | 'retrying' }> {
    return s.phase === 'available' || s.phase === 'downloading' || s.phase === 'retrying';
}

/**
 * Advance the state machine on `update-available`.
 * Always legal — a fresh check superseding a previous one resets progress.
 */
export function onUpdateAvailable(info: UpdateInfoLike): UpdateState {
    return { phase: 'available', version: info.version };
}

/** Advance on `download-progress`. Ignored outside of `available`/`downloading`
 *  (a stray late event after `ready`/`failed` must not resurrect a stale bar). */
export function onDownloadProgress(current: UpdateState, progress: ProgressInfoLike): UpdateState {
    if (current.phase !== 'available' && current.phase !== 'downloading') return current;
    return { phase: 'downloading', version: current.version, percent: Math.max(0, Math.min(100, progress.percent)) };
}

/** Advance on `update-downloaded`. The version comes from the event itself
 *  (not `current`) so this is correct even if progress events were missed. */
export function onUpdateDownloaded(info: UpdateInfoLike): UpdateState {
    return { phase: 'ready', version: info.version };
}

/** `update-not-available` while we thought something was in flight (a retry's
 *  re-check found the release withdrawn, or already installed): stand down. A
 *  downloaded update (`ready`) is left alone. */
export function onUpdateNotAvailable(current: UpdateState): UpdateState {
    if (isUpdateInFlight(current) || current.phase === 'failed' || current.phase === 'manual') return { phase: 'idle' };
    return current;
}

/** What kind of failure an `error` event is. `signature` and `manifest` stop the retries. */
export type UpdateErrorKind = 'signature' | 'manifest' | 'transient';

export interface UpdaterErrorLike {
    code?: unknown;
    message?: unknown;
}

/**
 * Classify an electron-updater `error`.
 *
 * `signature` means the installer was examined and REJECTED — never "the check
 * could not run". On Windows that is exactly NsisUpdater's
 * ERR_UPDATER_INVALID_SIGNATURE (our verifier resolves with a reason only on a
 * definitive verdict; anything it could not complete is a rejection with a
 * different code). On macOS, Squirrel.Mac reports code-signature rejections as
 * plain-message errors, so they are matched by wording there and only there.
 */
export function classifyUpdateError(err: UpdaterErrorLike | null | undefined, platform: NodeJS.Platform): UpdateErrorKind {
    const code = typeof err?.code === 'string' ? err.code : '';
    if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'signature';
    // The update MANIFEST was rejected (signed-update-provider.ts): its .sig is
    // missing while required, malformed, or does not verify. Raised by the
    // CHECK, before anything is downloaded.
    if (code === 'ERR_UPDATER_MANIFEST_SIGNATURE') return 'manifest';
    if (platform === 'darwin') {
        const msg = typeof err?.message === 'string' ? err.message : '';
        if (/code signature|did not pass validation|designated requirement/i.test(msg)) return 'signature';
    }
    return 'transient';
}

export interface UpdateErrorContext {
    kind: UpdateErrorKind;
    /** Failures for the in-flight version INCLUDING this one (1 on the first). */
    failures: number;
    platform: NodeJS.Platform;
    now: number;
    /** Only consulted on Linux, once retries are exhausted. */
    buildDownloadUrl: (version: string) => string | null;
}

export interface UpdateErrorDecision {
    state: UpdateState;
    /** Schedule an automatic retry this many ms from now; null = none. */
    retryInMs: number | null;
}

/**
 * Advance on `error`. See the module doc for the policy. Errors are logged and
 * recorded by the caller; this function only decides the user-facing state and
 * whether to retry.
 */
export function onUpdateError(current: UpdateState, ctx: UpdateErrorContext): UpdateErrorDecision {
    if (ctx.kind === 'manifest') {
        // A rejected update manifest is shown even with nothing in flight: it
        // is a security signal (a tampered or unsigned feed), not a wifi blip,
        // and it is decided at CHECK time, when the state is usually `idle`.
        // The version is unknown — the manifest that would name it is exactly
        // what is not trusted — so it is '' unless an attempt was under way.
        // A downloaded, previously verified update (`ready`) is kept.
        // No automatic retry; the next scheduled check or the user's Retry
        // re-checks, and a verified "nothing new" returns the tile to idle.
        if (current.phase === 'ready') return { state: current, retryInMs: null };
        const version = 'version' in current ? current.version : '';
        return { state: { phase: 'failed', version, stage: 'verify' }, retryInMs: null };
    }
    if (!isUpdateInFlight(current)) {
        // idle stays idle; ready / failed / manual keep what the user already has.
        return { state: current.phase === 'idle' ? { phase: 'idle' } : current, retryInMs: null };
    }
    const version = current.version;
    if (ctx.kind === 'signature') {
        return { state: { phase: 'failed', version, stage: 'verify' }, retryInMs: null };
    }
    const failures = Math.max(1, Math.floor(ctx.failures));
    if (failures <= RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[failures - 1];
        return {
            state: { phase: 'retrying', version, attempt: failures, maxAttempts: RETRY_DELAYS_MS.length, retryAt: ctx.now + delay },
            retryInMs: delay,
        };
    }
    if (ctx.platform === 'linux') {
        const downloadUrl = ctx.buildDownloadUrl(version);
        if (downloadUrl) return { state: { phase: 'manual', version, downloadUrl }, retryInMs: null };
    }
    return { state: { phase: 'failed', version, stage: 'download' }, retryInMs: null };
}

/** The installer could not be launched after "Restart & install". */
export function onInstallError(current: UpdateState): UpdateState {
    const version = 'version' in current ? current.version : '';
    return { phase: 'failed', version, stage: 'install' };
}

/** Base URL every published artifact resolves against — must match the
 *  `publish.url` in package.json's electron-builder config. */
export const UPDATE_BASE_URL = 'https://updates.cipherline.chat';

/**
 * Pick the one artifact in `files` this machine should download by hand, and
 * resolve it to an absolute URL under UPDATE_BASE_URL. Only Linux reaches the
 * manual path today (see the module doc); the other platforms are kept so the
 * function stays a complete, tested answer to "which file is mine".
 *
 * Preference order per platform, most-specific first — an arch mismatch (a
 * manifest missing the running arch entirely, or a build that only publishes
 * one) falls through to "any file of the right kind" rather than yielding no
 * link at all:
 *   darwin: {arch}.dmg → any .dmg → any .zip
 *   linux:  any .AppImage
 *   win32:  any .exe
 *
 * Returns null (never a bare base-URL guess) when nothing plausible is found,
 * so the caller can suppress the manual state entirely rather than show a
 * button that 404s.
 */
export function pickDownloadUrl(
    files: UpdateFileInfo[],
    platform: NodeJS.Platform,
    arch: string,
): string | null {
    if (!files || files.length === 0) return null;

    const byExt = (ext: string) => files.filter(f => f.url.toLowerCase().endsWith(ext));
    const archTag = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;

    let candidates: UpdateFileInfo[] = [];
    if (platform === 'darwin') {
        const dmgs = byExt('.dmg');
        if (archTag) {
            // electron-builder's mac dmg naming: arm64 gets an "-arm64" tag,
            // x64 is the untagged default — matches package.json's mac.target.
            const tagged = dmgs.filter(f => /-arm64\.dmg$/i.test(f.url));
            const untagged = dmgs.filter(f => !/-arm64\.dmg$/i.test(f.url));
            candidates = archTag === 'arm64' ? tagged : untagged;
        }
        if (candidates.length === 0) candidates = dmgs;
        if (candidates.length === 0) candidates = byExt('.zip');
    } else if (platform === 'linux') {
        candidates = byExt('.appimage');
    } else if (platform === 'win32') {
        candidates = byExt('.exe');
    }

    if (candidates.length === 0) return null;
    const pick = candidates[0];
    return `${UPDATE_BASE_URL}/${pick.url}`;
}

// ── electron-updater's download cache ───────────────────────────────────────

/**
 * Read `updaterCacheDirName` out of the app-update.yml electron-builder bakes
 * into resources/. Returns null for anything that is not a plain single path
 * segment, so a hostile or corrupt file can never steer the cache clear below
 * outside the cache root.
 */
export function parseUpdaterCacheDirName(appUpdateYml: string | null | undefined): string | null {
    if (typeof appUpdateYml !== 'string') return null;
    const m = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(appUpdateYml);
    if (!m) return null;
    const name = m[1];
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === '.' || name === '..') return null;
    return name;
}

/**
 * The `pending/` directory electron-updater downloads into, mirroring
 * ElectronAppAdapter.baseCachePath + updaterCacheDirName + "pending"
 * (electron-updater 6.8.x). Deleting it is exactly what electron-updater itself
 * does after a failed download (DownloadedUpdateHelper.clear), so a retry that
 * starts by clearing it can only ever cause a fresh, full download.
 */
export function pendingUpdateCacheDir(
    platform: NodeJS.Platform,
    env: Readonly<Record<string, string | undefined>>,
    homeDir: string,
    dirName: string,
    join: (...parts: string[]) => string,
): string {
    let base: string;
    if (platform === 'win32') base = env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    else if (platform === 'darwin') base = join(homeDir, 'Library', 'Caches');
    else base = env.XDG_CACHE_HOME || join(homeDir, '.cache');
    return join(base, dirName, 'pending');
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

/** Same charset as freeze-monitor.ts's DETAIL_RE (static words, numbers, units). */
const DETAIL_SAFE = /[^a-z0-9 _.:=%,/()+|-]/gi;
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Reduce ALREADY-SCRUBBED text to freeze-monitor's detail charset and length
 *  (≤ `max`, never more than DETAIL_RE's 240), so it is always recorded. */
export function toDiagnosticDetail(scrubbed: string, max = 240): string {
    return scrubbed.replace(DETAIL_SAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.min(240, Math.max(0, max)));
}

/**
 * One line for the Performance log (freeze-monitor events, included in a
 * "Report a problem") describing an updater failure: the code, what happens
 * next, and the start of the message. The message goes through the caller's
 * scrubber first (OS home dir + account name — the installer path lives under
 * the user's profile), then is reduced to freeze-monitor's detail charset, so
 * the result always passes DETAIL_RE and carries no home directory, account
 * name or encoded blob.
 */
export function updaterErrorDetail(
    err: UpdaterErrorLike | null | undefined,
    decision: { state: UpdateState; retryInMs: number | null },
    scrub: (s: string) => string,
): string {
    const code = typeof err?.code === 'string' && CODE_RE.test(err.code) ? err.code : 'none';
    const s = decision.state;
    const next =
        s.phase === 'retrying' ? `retry ${s.attempt}/${s.maxAttempts} in ${Math.round((decision.retryInMs ?? 0) / 1000)}s`
        : s.phase === 'failed' ? `failed ${s.stage}`
        : s.phase;
    const rawMsg = typeof err?.message === 'string' ? err.message : '';
    const head = `code=${code} next=${next}`;
    const room = 240 - head.length - 5;
    const msg = room > 0 ? toDiagnosticDetail(scrub(rawMsg), room) : '';
    return msg ? `${head} msg=${msg}` : head;
}
