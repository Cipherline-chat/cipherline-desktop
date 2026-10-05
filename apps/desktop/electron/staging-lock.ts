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
 * Once this device has passed the check it stays unlocked — toggling the
 * channel Stable ⇄ Staging and relaunching a staging build never re-prompt —
 * until the user picks "Lock staging access again".
 *
 * ── What this is NOT ─────────────────────────────────────────────────────
 * This is a DETERRENT against casual use, not a security boundary:
 *   - The staging installers and their update manifests (staging.yml /
 *     staging-mac.yml) are publicly downloadable by URL. Anyone who knows the
 *     URL scheme can fetch a staging binary without ever seeing this gate.
 *   - The remembered unlock is a plain JSON file in the user-data folder
 *     (`staging-unlock.json`). It records only that this device passed the
 *     check; it is not a secret, and anyone with file access can forge it.
 *   - The verifier below ships in an open-source binary, so the password's
 *     strength (20 random characters) is the only thing standing between the
 *     verifier and an offline guess — which is why the KDF is scrypt with a
 *     real cost, not a fast hash.
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
 * replacing these values — devices that already unlocked stay unlocked
 * (their remembered state is not tied to the password), so a rotation that
 * must also re-lock existing testers needs `UNLOCK_FILE_VERSION` bumped.
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

// ── Remembered unlock (userData/staging-unlock.json) ────────────────────

export const UNLOCK_FILENAME = 'staging-unlock.json';
/** Separate file for the unpackaged preview, so previewing in dev never
 *  pre-unlocks (or re-locks) the real install that shares the userData dir. */
export const PREVIEW_UNLOCK_FILENAME = 'staging-unlock.dev-preview.json';
/** Bump to invalidate every existing remembered unlock (forces a re-prompt). */
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
