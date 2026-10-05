/**
 * updater-state.ts — the update lifecycle, kept separate from `electron-updater`
 * wiring so it can be unit-tested without a packaged app or a real network.
 *
 * ── Why "manual" exists ──────────────────────────────────────────────────────
 * Auto-update is NOT reliable on every platform this app ships on, and the two
 * broken cases share nothing in common at the code level:
 *
 *   • macOS: `electron-updater`'s MacUpdater delegates to Electron's built-in
 *     Squirrel.Mac, which refuses to apply an update whose code signature
 *     doesn't match the running app's. An unsigned build (which is what this
 *     repo ships today — no CSC_LINK/APPLE_* secrets are configured; see
 *     docs/desktop-code-signing.md) has no signature to match, so it errors.
 *   • Linux: `AppImageUpdater` requires `process.env.APPIMAGE` to be set,
 *     which is only true when the running binary genuinely IS the AppImage
 *     Electron launched from — an extracted, repackaged, or Flatpak-wrapped
 *     copy silently never updates.
 *
 * Rather than special-case each platform (fragile — the failure conditions
 * are runtime facts, not things `process.platform` can predict), this module
 * treats them the same way: if `electron-updater` reports an update is
 * available and then fails before finishing, self-install is impossible on
 * THIS machine for WHATEVER reason, and the only honest move is to hand the
 * user a direct download link instead of a doomed retry loop. This also means
 * the day macOS signing is added (docs/desktop-code-signing.md), the fallback
 * simply stops firing — no code changes required.
 *
 * An error with NO known update in flight (`idle` state) is treated as an
 * ordinary transient failure (a network blip on the periodic check) and does
 * NOT transition to `manual` — there is nothing to offer a manual link FOR
 * yet, and surfacing one would be a false "update available" the moment the
 * user's wifi hiccups.
 */

export type UpdateState =
    | { phase: 'idle' }
    | { phase: 'available'; version: string }
    | { phase: 'downloading'; version: string; percent: number }
    | { phase: 'ready'; version: string }
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
 * Advance the state machine on `update-available`.
 * Always legal — a fresh check superseding a previous one resets progress.
 */
export function onUpdateAvailable(info: UpdateInfoLike): UpdateState {
    return { phase: 'available', version: info.version };
}

/** Advance on `download-progress`. Ignored outside of `available`/`downloading`
 *  (a stray late event after `ready`/`manual` must not resurrect a stale bar). */
export function onDownloadProgress(current: UpdateState, progress: ProgressInfoLike): UpdateState {
    if (current.phase !== 'available' && current.phase !== 'downloading') return current;
    return { phase: 'downloading', version: current.version, percent: Math.max(0, Math.min(100, progress.percent)) };
}

/** Advance on `update-downloaded`. The version comes from the event itself
 *  (not `current`) so this is correct even if progress events were missed. */
export function onUpdateDownloaded(info: UpdateInfoLike): UpdateState {
    return { phase: 'ready', version: info.version };
}

/**
 * Advance on `error`. See the module doc for the reasoning: only a
 * known-in-flight update (available/downloading) degrades to `manual`; an
 * error with nothing in flight is swallowed back to `idle` unconditionally —
 * even a stale `ready`/`manual` state is discarded, since a periodic
 * background check that fails after a manual link was already handed out
 * carries no new information worth destroying that link over. Errors are
 * logged by the caller; this function only decides the user-facing state.
 */
export function onUpdateError(current: UpdateState, buildDownloadUrl: (version: string) => string | null): UpdateState {
    if (current.phase !== 'available' && current.phase !== 'downloading') return { phase: 'idle' };
    const downloadUrl = buildDownloadUrl(current.version);
    if (!downloadUrl) return { phase: 'idle' }; // nothing safe to offer — don't show a dead button
    return { phase: 'manual', version: current.version, downloadUrl };
}

/** Base URL every published artifact resolves against — must match the
 *  `publish.url` in package.json's electron-builder config. */
export const UPDATE_BASE_URL = 'https://updates.cipherline.chat';

/**
 * Pick the one artifact in `files` this machine should download by hand, and
 * resolve it to an absolute URL under UPDATE_BASE_URL.
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
