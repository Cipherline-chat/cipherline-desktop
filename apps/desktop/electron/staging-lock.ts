/**
 * Staging lock — a password gate on pre-release ("staging") access.
 *
 * Two things are gated, and they share ONE remembered "unlocked" state per
 * device:
 *   1. Switching the update channel to Staging (Settings → Advanced). The
 *      `updater:set-channel` handler in main.ts refuses `'staging'` while
 *      locked — see `decideSetChannel` below.
 *   2. Running a staging build at all. A packaged build whose version carries
 *      `-staging` (e.g. 1.0.17-staging.135) shows a full-screen unlock screen
 *      before anything else in the renderer mounts.
 * The password is asked for at (1) — the moment Staging is picked, BEFORE the
 * channel changes or anything downloads. Once this device has passed the
 * check it stays unlocked — toggling the channel Stable ⇄ Staging and the
 * staging build that then downloads and launches never re-prompt — until the
 * user picks "Lock staging access again" or the password is rotated.
 *
 * ── The remembered unlock (one marker, shared by every build) ────────────
 * Kept in the main-process SecureStore (electron/storage.ts: AES-256-GCM
 * under the safeStorage-wrapped device master key) under
 * `STAGING_UNLOCK_STORE_KEY`. The store lives in the user-data folder, which
 * is the SAME folder for stable and staging builds (one productName / app
 * name, `app.setName('Cipherline')`, no per-channel `setPath('userData')`) —
 * the existing `updateChannel` preference already relies on exactly that to
 * survive a stable → staging update. So the stable build that asked for the
 * password writes the marker, and the staging build it installs reads it.
 *
 * The marker is bound to the verifier: it records a fingerprint of
 * STAGING_VERIFIER (salt + hash + cost), not a bare `true`. Rotating the
 * password changes the verifier, so every marker written for the old one
 * stops being accepted and those devices are asked again.
 *
 * Not reachable by the renderer: the key is not in RENDERER_SECURE_KEYS
 * (secure-store-policy.ts), so neither a compromised renderer nor a restored
 * backup can write it; it is in SECURE_STORE_EXCLUDED (backupRegistry.ts) so
 * a backup never carries it to another machine either.
 *
 * Older builds kept a plaintext `staging-unlock.json` (UNLOCK_FILENAME) with
 * no binding. It is still READ, once, so testers who already unlocked are not
 * re-prompted — but only while the shipped verifier is still the one those
 * files were written under (LEGACY_FILE_VERIFIER_FINGERPRINT) — and is then
 * migrated into the store and deleted.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────
 * This is a DETERRENT against casual use, not a security boundary — the same
 * standing as client attestation (CLAUDE.md): the check runs client-side in
 * an open-source binary, so anyone willing to patch the binary skips it.
 *   - The staging installers and their update manifests (staging.yml /
 *     staging-mac.yml) are publicly downloadable by URL. Anyone who knows the
 *     URL scheme can fetch a staging binary without ever seeing this gate.
 *   - The remembered unlock records only that this device passed the check.
 *     It is encrypted at rest so it cannot be forged by editing a file, but
 *     anyone who can run code as this user can still write it.
 *   - The verifier below ships in an open-source binary, so the password's
 *     strength (20 random characters) is the only thing standing between the
 *     verifier and an offline guess — which is why the KDF is scrypt with a
 *     real cost, not a fast hash. The password itself is never logged, never
 *     stored (only the verifier fingerprint is), and never sent anywhere: the
 *     check is entirely local.
 * A real gate would need an authenticated update server (staging manifests
 * and binaries served only to signed-in testers). That is out of scope here.
 *
 * ── Where it does NOT apply ──────────────────────────────────────────────
 * Unpackaged/dev builds (`!app.isPackaged`), stable builds' normal use, and
 * the CI smoke test (`CIPHERLINE_SMOKE_TEST`, which must paint the real app).
 * An unpackaged build can opt IN to a preview of the whole flow with
 * `CIPHERLINE_STAGING_LOCK_PREVIEW=1`; a packaged build ignores that variable
 * (same MED-3 rule as main.ts: the environment may never relax OR reshape a
 * real install's security decisions).
 *
 * Deliberately free of any `electron` import so every decision is unit
 * testable (staging-lock.test.ts); main.ts supplies the paths, version,
 * clock and environment, and owns the in-memory state.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ── Password verification ───────────────────────────────────────────────

/** A salted scrypt verifier. `salt` and `hash` are lowercase hex. */
export interface ScryptVerifier {
    alg: 'scrypt';
    N: number;
    r: number;
    p: number;
    len: number;
    salt: string;
    hash: string;
}

/**
 * The verifier for the staging password. Public by design (it is in the
 * open-source repo); the password itself appears nowhere in source, tests or
 * logs. Rotate by generating a new salt + hash for a new password and
 * replacing these values. Rotation re-locks every device by itself: the
 * remembered unlock is bound to `verifierFingerprint(STAGING_VERIFIER)`, and
 * legacy unbound files are honoured only under LEGACY_FILE_VERIFIER_FINGERPRINT
 * (this exact verifier) — leave that constant alone when rotating.
 */
export const STAGING_VERIFIER: Readonly<ScryptVerifier> = Object.freeze({
    alg: 'scrypt',
    N: 32768,
    r: 8,
    p: 1,
    len: 32,
    salt: '84b5ce4cf340552875b8359c88cb9f44',
    hash: '20a5898347f7e52361a334b6a235a28cfca52433acbaa9a9287d059dc8cb1346',
});

/** Longest input accepted at all — a password field, not a file upload. */
export const MAX_PASSWORD_LENGTH = 256;

/** True for an argument main should even consider: a string ≤ 256 chars. */
export function isAcceptablePasswordInput(pw: unknown): pw is string {
    return typeof pw === 'string' && pw.length <= MAX_PASSWORD_LENGTH;
}

const HEX_RE = /^(?:[0-9a-f]{2})+$/;

/**
 * Constant-time check of `pw` against `params`.
 *
 * - Input is NFKC-normalized first, so a password typed with a different but
 *   equivalent Unicode composition (e.g. a precomposed vs combining accent,
 *   full-width digits) verifies the same.
 * - Never throws: bad input or a malformed verifier is simply `false`.
 * - `maxmem` is set explicitly: scrypt needs 128·N·r bytes, and at N=32768,
 *   r=8 that is exactly Node's 32 MiB default ceiling, which it rejects.
 */
export function verifyPassword(pw: unknown, params: Readonly<ScryptVerifier>): boolean {
    if (!isAcceptablePasswordInput(pw) || pw.length === 0) return false;
    if (params.alg !== 'scrypt' || !HEX_RE.test(params.salt) || !HEX_RE.test(params.hash)) return false;
    const expected = Buffer.from(params.hash, 'hex');
    if (expected.length !== params.len) return false;
    let derived: Buffer;
    try {
        derived = crypto.scryptSync(pw.normalize('NFKC'), Buffer.from(params.salt, 'hex'), params.len, {
            N: params.N,
            r: params.r,
            p: params.p,
            maxmem: 128 * params.N * params.r * 2,
        });
    } catch {
        return false;
    }
    try {
        // Lengths are equal by construction (len checked above), which is the
        // one precondition timingSafeEqual throws on.
        return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    } finally {
        derived.fill(0);
    }
}

// ── Brute-force friction ────────────────────────────────────────────────

/** Consecutive failures allowed before any delay. */
export const FREE_ATTEMPTS = 5;
export const BASE_DELAY_MS = 30_000;
export const MAX_DELAY_MS = 15 * 60_000;

/** Delay imposed after the `failures`-th consecutive failure (0 if none). */
export function delayAfterFailures(failures: number): number {
    if (failures < FREE_ATTEMPTS) return 0;
    const steps = failures - FREE_ATTEMPTS; // 5th failure → 30 s, 6th → 60 s, …
    // Cap the exponent too, so a huge count cannot overflow to Infinity/NaN.
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(steps, 20));
}

export interface AttemptLimiter {
    /** Milliseconds until another attempt is allowed (0 = allowed now). */
    retryAfterMs(): number;
    recordFailure(): void;
    recordSuccess(): void;
}

/**
 * In-memory, per-process attempt limiter. Deliberately not persisted: a
 * restart resets it, which costs an attacker a relaunch per 5 guesses — on
 * top of ~100 ms of scrypt per guess. It is friction, not a lockout. It
 * records counts and times only, never what was typed.
 */
export function createAttemptLimiter(now: () => number = Date.now): AttemptLimiter {
    let failures = 0;
    let lockedUntil = 0;
    return {
        retryAfterMs: () => Math.max(0, lockedUntil - now()),
        recordFailure: () => {
            failures += 1;
            const d = delayAfterFailures(failures);
            if (d > 0) lockedUntil = now() + d;
        },
        recordSuccess: () => {
            failures = 0;
            lockedUntil = 0;
        },
    };
}

// ── Remembered unlock: the SecureStore marker ───────────────────────────

/** SecureStore key of the remembered unlock (main-process only). */
export const STAGING_UNLOCK_STORE_KEY = 'staging_unlock';
/** Separate key for the unpackaged preview, so previewing in dev never
 *  pre-unlocks (or re-locks) the real install that shares the store. */
export const PREVIEW_UNLOCK_STORE_KEY = 'staging_unlock_dev_preview';
/** Bump to invalidate every remembered unlock regardless of the verifier. */
export const UNLOCK_MARKER_VERSION = 2;
/** Anything bigger is not a marker we wrote — ignore it unparsed. */
export const UNLOCK_MARKER_MAX_CHARS = 512;

/**
 * A stable fingerprint of a verifier — every field that decides which
 * password it accepts, domain-separated. Not secret (the verifier is public);
 * it exists so a remembered unlock names the password it was granted for.
 */
export function verifierFingerprint(v: Readonly<ScryptVerifier>): string {
    return crypto
        .createHash('sha256')
        .update(`cipherline-staging-verifier/v1|${v.alg}|${v.N}|${v.r}|${v.p}|${v.len}|${v.salt}|${v.hash}`)
        .digest('hex');
}

/** The marker value written on a successful unlock. */
export function serializeUnlockMarker(verifier: Readonly<ScryptVerifier>, nowMs: number): string {
    return JSON.stringify({ v: UNLOCK_MARKER_VERSION, verifier: verifierFingerprint(verifier), unlockedAt: nowMs });
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * True only for exactly the shape `serializeUnlockMarker` writes, AND only
 * when it was written for `verifier` — a marker from before a password
 * rotation is rejected. Never throws.
 */
export function isValidUnlockMarker(raw: string | null | undefined, verifier: Readonly<ScryptVerifier>): boolean {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > UNLOCK_MARKER_MAX_CHARS) return false;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return false; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    if (o.v !== UNLOCK_MARKER_VERSION) return false;
    if (typeof o.unlockedAt !== 'number' || !Number.isFinite(o.unlockedAt) || o.unlockedAt <= 0) return false;
    if (typeof o.verifier !== 'string' || !FINGERPRINT_RE.test(o.verifier)) return false;
    // Not secret, but compare in constant time anyway — it costs nothing and
    // keeps every comparison in this module the same kind.
    const got = Buffer.from(o.verifier, 'hex');
    const want = Buffer.from(verifierFingerprint(verifier), 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Fingerprint of the verifier in force while builds wrote the legacy,
 * UNBOUND `staging-unlock.json` (every build from b72fa005 until the
 * SecureStore marker). A legacy file says "unlocked" without saying for which
 * password, so it is honoured only while the shipped verifier is still this
 * one. Do NOT update this when rotating the password — that is precisely what
 * retires the legacy files.
 */
export const LEGACY_FILE_VERIFIER_FINGERPRINT = '8aacc9794fd4df73a28247e2bbad07309d9b4221383824829d820fcaf73484ca';

export type RememberedUnlockSource = 'not-enforced' | 'marker' | 'legacy-file' | 'none';

/**
 * Startup decision: is this device remembered as unlocked, and from where?
 *
 * - `marker`      — a valid SecureStore marker for the current verifier.
 * - `legacy-file` — no valid marker, but a well-formed legacy file AND the
 *                   verifier is still the one legacy files were written for.
 *                   The caller migrates it into the store and deletes the file.
 * - `none`        — locked: no marker, a stale marker (password rotated), a
 *                   tampered one, or an unreadable store with no usable file.
 *
 * Pure. The launch-time lock screen shows exactly when this says `none` on a
 * staging build, so a device that never unlocked (e.g. someone who grabbed
 * the staging installer directly) is still asked.
 */
export function resolveRememberedUnlock(opts: {
    enforced: boolean;
    marker: string | null | undefined;
    legacyFileValid: boolean;
    verifier: Readonly<ScryptVerifier>;
}): { unlocked: boolean; source: RememberedUnlockSource } {
    if (!opts.enforced) return { unlocked: true, source: 'not-enforced' };
    if (isValidUnlockMarker(opts.marker, opts.verifier)) return { unlocked: true, source: 'marker' };
    if (opts.legacyFileValid && verifierFingerprint(opts.verifier) === LEGACY_FILE_VERIFIER_FINGERPRINT) {
        return { unlocked: true, source: 'legacy-file' };
    }
    return { unlocked: false, source: 'none' };
}

// ── Legacy remembered unlock (userData/staging-unlock.json) ─────────────
// Read-and-migrate only; nothing writes these any more except the tests.

export const UNLOCK_FILENAME = 'staging-unlock.json';
/** Separate file for the unpackaged preview, so previewing in dev never
 *  pre-unlocks (or re-locks) the real install that shares the userData dir. */
export const PREVIEW_UNLOCK_FILENAME = 'staging-unlock.dev-preview.json';
/** The (only) legacy file version. */
export const UNLOCK_FILE_VERSION = 1;
/** Anything bigger is not a file we wrote — ignore it unread. */
export const UNLOCK_FILE_MAX_BYTES = 1024;

/** True only for exactly the shape `serializeUnlockFile` writes. */
export function parseUnlockFile(raw: string | null | undefined): boolean {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > UNLOCK_FILE_MAX_BYTES) return false;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return false; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    return o.v === UNLOCK_FILE_VERSION
        && o.unlocked === true
        && typeof o.unlockedAt === 'number'
        && Number.isFinite(o.unlockedAt)
        && o.unlockedAt > 0;
}

export function serializeUnlockFile(nowMs: number): string {
    return JSON.stringify({ v: UNLOCK_FILE_VERSION, unlocked: true, unlockedAt: nowMs });
}

/** Synchronous, defensive: any problem at all reads as LOCKED. Never throws. */
export function readUnlockFileSync(filePath: string): boolean {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile() || st.size > UNLOCK_FILE_MAX_BYTES) return false;
        return parseUnlockFile(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return false;
    }
}

/** Atomic (tmp + rename). Throws on I/O failure — the caller decides. */
export function writeUnlockFileAtomic(filePath: string, nowMs: number): void {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, serializeUnlockFile(nowMs), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

/** Removes the remembered unlock. Missing file is fine; never throws. */
export function removeUnlockFile(filePath: string): boolean {
    try {
        fs.rmSync(filePath, { force: true });
        return true;
    } catch {
        return false;
    }
}

// ── Where the lock applies ──────────────────────────────────────────────

/** A version string from a staging build (`1.0.17-staging.135`). */
export function isStagingVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+-staging(?:\.|$)/.test(version);
}

export interface StagingLockMode {
    /** The lock exists at all in this process (channel gate + status). */
    enforced: boolean;
    /** Show the full-screen unlock screen until unlocked. */
    isStagingBuild: boolean;
    /** Unpackaged preview — uses PREVIEW_UNLOCK_FILENAME. */
    preview: boolean;
}

/**
 * - Smoke test: never (CI must paint the real app; this also guarantees no
 *   startup file I/O for it — see the smoke-test SecureStore trap).
 * - Packaged: always enforced; the launch screen only for a staging version.
 * - Unpackaged: off, unless the preview env var is set, in which case it
 *   behaves like a packaged STAGING build (so the whole flow can be seen on
 *   `npm run dev:windows`). A packaged build ignores the preview variable.
 */
export function resolveStagingLockMode(opts: {
    packaged: boolean;
    smokeTest: boolean;
    version: string;
    previewEnv?: string;
}): StagingLockMode {
    if (opts.smokeTest) return { enforced: false, isStagingBuild: false, preview: false };
    if (opts.packaged) return { enforced: true, isStagingBuild: isStagingVersion(opts.version), preview: false };
    const preview = opts.previewEnv === '1' || opts.previewEnv === 'true';
    return { enforced: preview, isStagingBuild: preview, preview };
}

// ── The channel-switch policy ───────────────────────────────────────────

/** Thrown by `updater:set-channel`; the renderer maps it to the prompt. */
export const STAGING_LOCKED_ERROR = 'STAGING_LOCKED';

/**
 * Switching TO staging needs an unlocked device (when the lock is enforced).
 * Switching to stable is always allowed — it narrows what this machine will
 * install, so gating it would only make the safe direction harder.
 */
export function decideSetChannel(opts: {
    requested: 'latest' | 'staging';
    enforced: boolean;
    unlocked: boolean;
}): 'allow' | 'refuse-locked' {
    if (opts.requested === 'staging' && opts.enforced && !opts.unlocked) return 'refuse-locked';
    return 'allow';
}

// ── IPC shapes (mirrored by hand in src/env.d.ts) ───────────────────────

export interface StagingLockStatus {
    enforced: boolean;
    isStagingBuild: boolean;
    unlocked: boolean;
    retryAfterMs: number;
}

export interface StagingUnlockResult {
    ok: boolean;
    retryAfterMs: number;
}
