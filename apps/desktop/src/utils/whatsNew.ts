/**
 * "What's new in <version>": the dialog people see on the first launch after
 * the app updates (components/WhatsNewHost.tsx). This is the decision half.
 *
 * Where the notes come from: CHANGELOG.md's `### What's new` subsection for the
 * version, read at BUILD time (changelogParse.ts, vite-plugin-whats-new.ts), so
 * it works offline. Writing them is a release step (docs/stable-release-pipeline.md).
 *
 * When it shows, and when it does not:
 *   - First install (nothing recorded yet) or a new account on this device:
 *     never. The version is recorded silently and the next update is the first
 *     one that can show.
 *   - Same version as last time: never again. The version is recorded at the
 *     moment the dialog opens (not when it is dismissed), so a crash, a quit or
 *     a second window cannot show it twice.
 *   - A downgrade: never.
 *   - A newer version with notes written for exactly that version: show.
 *   - A newer version with no notes: record it silently and show nothing.
 *   - A pre-release (a staging build, `1.0.23-staging.7`) is just another
 *     version string: it shows only when the CHANGELOG has a section for that
 *     exact build, which nobody writes by accident.
 *
 * The recorded version lives in secureLocalStore (per account, encrypted), is
 * classified in services/backupRegistry.ts as excluded (it describes this
 * install, not the account), and never leaves the device.
 */
import whatsNewData from 'virtual:whats-new';
import secureLocalStore from './secureLocalStore';
import { countItems, type ReleaseNotes, type WhatsNewData } from './changelogParse';

export const WHATS_NEW_SEEN_KEY = 'cipherline_whats_new_seen';
/** The public release history. */
export const CHANGELOG_URL = 'https://cipherline.chat/changelog';
/** Open the dialog on demand (Settings -> Advanced). Detail: optional `{ version }`. */
export const OPEN_WHATS_NEW_EVENT = 'cipherline:open-whats-new';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** semver-ish order: -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
    const x = VERSION_RE.exec(a);
    const y = VERSION_RE.exec(b);
    if (!x || !y) return null;
    for (let i = 1; i <= 3; i++) {
        const d = Number(x[i]) - Number(y[i]);
        if (d !== 0) return d < 0 ? -1 : 1;
    }
    const pa = x[4], pb = y[4];
    if (!pa && !pb) return 0;
    if (!pa) return 1;   // a release outranks its own pre-releases
    if (!pb) return -1;
    const A = pa.split('.'), B = pb.split('.');
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
        if (A[i] === undefined) return -1;
        if (B[i] === undefined) return 1;
        const na = /^\d+$/.test(A[i]), nb = /^\d+$/.test(B[i]);
        if (na && nb) { const d = Number(A[i]) - Number(B[i]); if (d !== 0) return d < 0 ? -1 : 1; }
        else if (na !== nb) return na ? -1 : 1;
        else if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
    }
    return 0;
}

export type WhatsNewDecision =
    | { action: 'none' }
    | { action: 'record' }
    | { action: 'show'; notes: ReleaseNotes };

/**
 * @param current  the running app's version
 * @param lastSeen the version recorded last time (null = nothing recorded)
 * @param data     the notes baked in at build time
 */
export function decideWhatsNew(current: string, lastSeen: string | null, data: WhatsNewData = whatsNewData): WhatsNewDecision {
    if (!VERSION_RE.test(current)) return { action: 'none' };
    if (!lastSeen || !VERSION_RE.test(lastSeen)) return { action: 'record' };   // first install
    if (lastSeen === current) return { action: 'none' };
    const order = compareVersions(current, lastSeen);
    if (order === null || order <= 0) return { action: 'record' };               // a downgrade
    const notes = data.releases[current];
    return countItems(notes) > 0 ? { action: 'show', notes } : { action: 'record' };
}

/** The notes to show on demand: this version's, else (dev builds only) the draft. */
export function notesForVersion(version: string, data: WhatsNewData = whatsNewData): ReleaseNotes | null {
    return data.releases[version] ?? data.unreleased ?? null;
}

export function readSeenVersion(): string | null {
    try { return secureLocalStore.getItem(WHATS_NEW_SEEN_KEY) || null; } catch { return null; }
}
export function writeSeenVersion(version: string): void {
    try { secureLocalStore.setItem(WHATS_NEW_SEEN_KEY, version); } catch { /* best effort */ }
}

/** "October 14, 2026" from an ISO date; null when there is none. */
export function formatReleaseDate(iso: string | null, locale?: string): string | null {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const [y, m, d] = iso.split('-').map(Number);
    try {
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    } catch { return iso; }
}
