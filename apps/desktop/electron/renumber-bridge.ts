/**
 * One-way bridge across the launch renumbering (1.0.x → 0.1.x).
 *
 * The desktop line was numbered 1.0.0 … 1.0.24 during the closed beta and is
 * renumbered to 0.1.0 for the public launch. electron-updater only installs a
 * HIGHER version unless `allowDowngrade` is on, and we pin that off on purpose
 * (main.ts: a compromised update origin must not be able to push an older,
 * known-vulnerable build). Left alone, every installed 1.0.x client would
 * therefore sit on 1.0.x forever and never see 0.1.0.
 *
 * This lets exactly one kind of "downgrade" through: a client on the OLD 1.x
 * line moving to the NEW line (0.1.0 or later, below 1.0.0). Everything else
 * keeps the normal rule. In particular:
 *   - once a client is on 0.x, `current` no longer has major 1, so this is
 *     inert and an older 0.x manifest is refused exactly as before;
 *   - a 1.x client is never offered 0.0.x, nor an older 1.x;
 *   - the manifest still has to pass the signed-manifest check
 *     (signed-update-provider.ts) before electron-updater ever gets here.
 *
 * Remove once no 1.x installs remain (the admin announcement targeted at
 * 1.0.0-0 … 1.99.99 tells stragglers to reinstall).
 */

interface Parsed { major: number; minor: number; patch: number }

const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: string): Parsed | null {
    const m = VERSION_RE.exec(v.trim());
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True when `latest` is the renumbered line and `current` is the old 1.x line. */
export function isRenumberHop(current: string, latest: string): boolean {
    const c = parse(current);
    const l = parse(latest);
    if (!c || !l) return false;
    return c.major === 1 && l.major === 0 && l.minor >= 1;
}

/** The slice of electron-updater's AppUpdater this touches. `isUpdateAvailable` is private in its typings. */
export interface BridgeableUpdater { allowDowngrade: boolean }

type IsUpdateAvailable = (info: { version?: unknown }) => Promise<boolean>;

/**
 * Wrap the updater's own `isUpdateAvailable` so a renumber hop is evaluated with
 * `allowDowngrade` on for that one call (its other checks — same version,
 * isUpdateSupported, staged rollout — still run). Any other version is passed
 * through untouched with the flag as configured.
 */
export function installRenumberBridge(
    updater: BridgeableUpdater,
    currentVersion: () => string,
    log: (msg: string) => void = () => {},
): boolean {
    const target = updater as unknown as { isUpdateAvailable?: IsUpdateAvailable };
    const original = target.isUpdateAvailable;
    if (typeof original !== 'function') {
        log('[Main/Updater] renumber bridge not installed: isUpdateAvailable missing');
        return false;
    }
    target.isUpdateAvailable = async function bridged(info) {
        const latest = typeof info?.version === 'string' ? info.version : '';
        if (!isRenumberHop(currentVersion(), latest)) return original.call(updater, info);
        const prev = updater.allowDowngrade;
        updater.allowDowngrade = true;
        try {
            const ok = await original.call(updater, info);
            if (ok) log(`[Main/Updater] renumber hop ${currentVersion()} -> ${latest}`);
            return ok;
        } finally {
            updater.allowDowngrade = prev;
        }
    };
    return true;
}
