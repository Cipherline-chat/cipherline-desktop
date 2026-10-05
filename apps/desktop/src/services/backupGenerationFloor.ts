/**
 * backupGenerationFloor — the out-of-file anchor that closes v4's documented
 * rollback residual, as far as it can be closed.
 *
 * ── What residual, and why nothing in the file can close it ─────────────────
 *
 * v4 seals the index pointer in two AES-GCM commit slots (see the header of
 * `utils/backupContainer.ts`). That makes a KEYLESS rollback impossible: you
 * cannot repoint the header at an older index without forging AES-GCM. Two
 * things survive, and both are about which SEALED bytes are present rather
 * than about forging any:
 *
 *   1. Destroying the newer of the two commit slots makes the reader fall
 *      back exactly one generation.
 *   2. Writing back the 88 bytes of commit slots kept from an earlier run
 *      reaches whatever THAT header committed — arbitrarily far back, since
 *      an in-place update never erases a superseded index. (Same for
 *      replacing the whole file with an older copy: an old Drive revision, a
 *      filesystem snapshot.)
 *
 * Every candidate the attacker is choosing between is a real, correctly
 * sealed state of this very vault. A single mutable file therefore carries no
 * evidence that distinguishes them — "how new should this be" is not a fact
 * about the bytes. The only place that fact can live is somewhere the
 * attacker's write access to the backup does not reach: this device.
 *
 * ── What is remembered, and what it means ──────────────────────────────────
 *
 * Per (account, destination label) we remember a MARK of the container this
 * device last successfully wrote and verified at that destination: the
 * index's `generation` and its `createdAt`. Both come from inside the sealed,
 * authenticated index, so a file presented at restore time cannot claim a
 * generation or a timestamp it was not written with — only present an older
 * honestly-sealed one, which is precisely what we are detecting.
 *
 * The mark is LAST-WRITE, not a high-water mark. That is a deliberate
 * decision; see `recordBackupFloor`.
 *
 * ── Advisory, never blocking ───────────────────────────────────────────────
 *
 * A stale mark produces a WARNING and nothing else. The overwhelmingly likely
 * cause of a backup that is older than the last one this device wrote is that
 * the user deliberately went back to an earlier Drive revision — the runbook
 * tells them to do exactly that. Blocking a legitimate restore loses real user
 * data to defend against an attacker who, by construction, already had write
 * access to the backup and could simply have deleted it. So: say what was
 * observed, and let the user proceed in one click.
 *
 * Correspondingly, EVERY failure of this module is silent. No floor recorded,
 * a floor for a different destination, a locked or unreadable keystore, an
 * account whose records are still cold — all mean "no basis for an opinion",
 * which is not the same as "something is wrong". A warning that fires when it
 * should not is worse than no warning at all: it teaches the user to click
 * through the one that matters.
 *
 * ── Why it lives in secureLocalStore, under its own key ────────────────────
 *
 * `secureLocalStore` is AES-256-GCM at rest with a per-account HKDF subkey
 * wrapped by the OS keystore, so the mark is integrity-protected (an attacker
 * who can rewrite the backup file cannot silently lower the floor) and
 * account-scoped (it cannot leak across accounts on a shared device).
 *
 * It gets its OWN key rather than riding along in the fingerprint map. The
 * fingerprint map is a write-skip optimisation: losing or resetting it costs
 * one redundant upload, so it is free to change shape or be cleared whenever
 * that optimisation changes. The floor is a security record with the opposite
 * failure cost. Keeping them separate means a future change to the skip logic
 * cannot quietly reset the floor as a side effect.
 *
 * It is classified `include: false` in `backupRegistry.ts`, and MUST stay
 * that way: a floor carried inside the backup would be restored along with an
 * old file and would authorise its own rollback.
 */

import secureLocalStore from '../utils/secureLocalStore';

export type BackupDestinationLabel = 'local' | 'drive';

/** Per-destination floor: what this device last wrote there. */
const FLOOR_KEY = (uid: string) => `cipherline_backup_gen_floor_${uid}`;

/**
 * Clock skew absorbed before a timestamp is called "older".
 *
 * Sized to swallow ordinary device-clock drift, an NTP correction, and two
 * devices writing to the same shared destination minutes apart — none of
 * which are attacks — while swallowing no interesting rollback: a Drive
 * revision worth going back to is hours or days old, and a container
 * generation worth going back to is at least one backup interval old.
 */
export const FLOOR_CLOCK_SKEW_MS = 5 * 60_000;

/** The authenticated facts a container index states about itself. */
export interface ContainerMark {
    generation: number;
    /** ISO-8601, from inside the sealed index. */
    createdAt: string;
}

export interface BackupFloor extends ContainerMark {
    /**
     * Which file the mark is about (`<dir>/<name>` or `<driveFolderId>/<name>`).
     * A mark only means something for the destination it was recorded at, so a
     * mismatch is "no opinion", never a warning.
     */
    target: string;
}

export type StaleReason = 'older-timestamp' | 'older-generation';

export interface BackupStaleWarning {
    reason: StaleReason;
    /** Ready-to-show copy; see `describeStale`. */
    title: string;
    message: string;
    observed: ContainerMark;
    floor: BackupFloor;
}

type FloorMap = Partial<Record<BackupDestinationLabel, BackupFloor>>;

/** The one place a destination's file identity is spelled, so the write side
 *  and the restore side cannot drift apart and silently stop matching. A
 *  trailing separator on a configured folder is normalised away for the same
 *  reason — `C:\dir\` and `C:\dir` are the same destination, and a mismatch
 *  here costs a real warning rather than producing a false one. */
export function backupTarget(container: string, fileName: string): string {
    return `${container.replace(/[\\/]+$/, '')}/${fileName}`;
}

function parseTime(iso: string | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

function isMark(v: unknown): v is ContainerMark {
    const m = v as ContainerMark | null;
    return !!m && typeof m.generation === 'number' && typeof m.createdAt === 'string';
}

/**
 * PURE. Decide whether `observed` is older than `floor`, or null for "no
 * opinion" (no floor, or nothing says it is older).
 *
 * The timestamp is consulted first and can settle it in BOTH directions,
 * because it is the only axis that is monotone across the whole life of a
 * destination. `generation` is not: it restarts at 1 on every fresh write —
 * which is every compaction locally, and EVERY RUN on Drive, which cannot
 * update a file in place and so re-uploads a brand new generation-1 container
 * each time. Generation therefore only distinguishes states within one
 * in-place update streak.
 *
 * So an authenticated `createdAt` that is decisively NEWER than the floor is
 * positive evidence of freshness and silences the generation axis outright.
 * Without that, a compaction (or any run where recording the floor failed)
 * would leave a lower generation behind a newer file and warn for no reason.
 * An attacker replaying old sealed bytes cannot manufacture a newer
 * `createdAt`: it lives inside the AES-GCM-sealed index.
 */
export function compareToFloor(floor: BackupFloor | null | undefined, observed: ContainerMark): StaleReason | null {
    if (!floor || !isMark(floor) || !isMark(observed)) return null;

    const seen = parseTime(observed.createdAt);
    const mark = parseTime(floor.createdAt);
    if (seen !== null && mark !== null) {
        if (seen < mark - FLOOR_CLOCK_SKEW_MS) return 'older-timestamp';
        if (seen > mark + FLOOR_CLOCK_SKEW_MS) return null; // demonstrably newer
    }
    return observed.generation < floor.generation ? 'older-generation' : null;
}

function when(iso: string): string {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return 'an unknown date';
    try {
        return new Date(ms).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
    } catch { return new Date(ms).toISOString(); }
}

/**
 * Turn a comparison into copy for a real person.
 *
 * It reports WHAT WAS OBSERVED and stops there. It does not accuse anyone of
 * anything, because the likely explanation is the innocent one: the user went
 * back to an earlier version on purpose. Naming that explanation first is
 * both honest and the thing that keeps the warning readable instead of scary.
 */
export function describeStale(reason: StaleReason, observed: ContainerMark, floor: BackupFloor): BackupStaleWarning {
    const detail = reason === 'older-timestamp'
        ? `The backup you're restoring was saved on ${when(observed.createdAt)}. The last backup this device saved here was ${when(floor.createdAt)}.`
        : `The backup you're restoring is an earlier version than the last one this device saved here (version ${observed.generation}, not ${floor.generation}).`;
    return {
        reason,
        observed: { generation: observed.generation, createdAt: observed.createdAt },
        floor,
        title: 'This backup is older than the last one',
        message: `${detail} If you went back to an earlier version on purpose, that's expected — carry on. Otherwise, restoring replaces this device's data with the older copy.`,
    };
}

function readFloors(userId: string): FloorMap {
    try {
        const raw = secureLocalStore.getItem(FLOOR_KEY(userId));
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed as FloorMap : {};
    } catch { return {}; }
}

/** Test/diagnostic read. Never throws; `{}` means "nothing remembered". */
export function getBackupFloors(userId: string): FloorMap {
    if (!userId) return {};
    return readFloors(userId);
}

/**
 * Remember the container this device just wrote and verified at `target`.
 *
 * LAST-WRITE, NOT A HIGH-WATER MARK — the one design decision here worth
 * arguing about. `max(previous, justWritten)` is tempting and is wrong:
 *
 *   • It makes a legitimate older-revision restore warn FOREVER. Restore an
 *     older Drive revision, back up again, and the file is honestly at a
 *     lower generation (or, locally, at generation 6 where the mark says 12)
 *     for every run until it climbs back. A permanent false alarm is exactly
 *     the failure mode that makes this feature worse than useless.
 *   • The same is true with no user error at all: a local compaction and
 *     every single Drive upload write generation 1, so a high-water mark
 *     would flag routine, healthy backups.
 *   • It buys nothing. The extra case it would catch is "roll the file back,
 *     then let this device back up again" — but that next backup rewrites the
 *     destination from the LIVE vault, so the rolled-back state is already
 *     gone and the warning would be about an event that repaired itself. The
 *     window where a rollback actually costs the user something is the window
 *     between the tamper and the next write, and the last-write mark covers
 *     precisely that window.
 *
 * So the mark answers one narrow, defensible question: "is this file older
 * than the last one I wrote here?" — not "is this the newest that ever
 * existed", which this device has no way to know.
 *
 * A destination that was SKIPPED this run (its file already held this exact
 * vault) is not written and must not be re-marked here: nothing new was
 * authored, and the previous mark is still the truth.
 */
export function recordBackupFloor(
    userId: string, label: BackupDestinationLabel, target: string, mark: ContainerMark,
): void {
    if (!userId || !target || !isMark(mark)) return;
    try {
        const map = readFloors(userId);
        map[label] = { target, generation: mark.generation, createdAt: mark.createdAt };
        secureLocalStore.setItem(FLOOR_KEY(userId), JSON.stringify(map));
    } catch { /* a locked or unavailable keystore must never fail a backup */ }
}

/**
 * Compare a container about to be restored against what this device last
 * wrote at that destination.
 *
 * Returns null — silently, with no warning of any kind — when there is no
 * basis for an opinion:
 *   • no floor recorded at all (a NEW DEVICE, which is the most common
 *     restore there is; a "we couldn't verify this" notice here would train
 *     users to dismiss the warning that matters),
 *   • a floor recorded against a different file,
 *   • a locked, cleared or still-cold keystore.
 * An absent floor is not evidence of an attack.
 */
export async function checkBackupFloor(
    userId: string, label: BackupDestinationLabel, target: string, observed: ContainerMark,
): Promise<BackupStaleWarning | null> {
    if (!userId || !target) return null;
    try {
        // Per-account records are cold right after an explicit sign-in until
        // the store rebinds; waiting lets a real floor be found instead of
        // silently reading null. It resolves immediately when nothing is in
        // flight, and never rejects.
        await secureLocalStore.whenAccountReady();
        const floor = readFloors(userId)[label];
        if (!floor || floor.target !== target) return null;
        const reason = compareToFloor(floor, observed);
        return reason ? describeStale(reason, observed, floor) : null;
    } catch { return null; }
}
