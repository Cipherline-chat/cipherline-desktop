/**
 * authenticode-verify.ts — the Windows update-signature check, installed as
 * NsisUpdater.verifyUpdateCodeSignature (a supported electron-updater hook).
 *
 * ── Why we replace electron-updater's default ────────────────────────────────
 * The default (electron-updater 6.8.x windowsExecutableCodeSignatureVerifier)
 * runs `Get-AuthenticodeSignature` in a fresh PowerShell with a HARD-CODED 20 s
 * timeout. On a tester's machine that one call has to cold-start PowerShell and
 * hash a ~130 MB installer that was written a moment earlier — which is exactly
 * when Defender (or any real-time scanner) is busy scanning it. Over 20 s, the
 * default rejects with a generic "Command failed" error; any byte on stderr
 * does the same. Before 2026-10-09 every such rejection sent the user to a
 * browser download (see updater-state.ts), and a retry alone would not help:
 * electron-updater deletes the file after a failed check, so each retry
 * re-downloads and the scanner re-scans a brand-new file.
 *
 * ── Why no PowerShell any more (2026-11) ─────────────────────────────────────
 * The check used to start `powershell.exe -EncodedCommand <base64>`. A hidden,
 * base64-encoded PowerShell child is the textbook obfuscated-script pattern
 * (MITRE T1059.001 / T1027) that behavioural security engines and Defender's ASR
 * rules block, and one tester's suite flagged the app for it. The check is now
 * `win-helper.exe verify <file>`: our own signed Rust helper calls WinVerifyTrust
 * (the API Get-AuthenticodeSignature uses underneath) and prints the same JSON
 * shape, so evaluateSignatureJson and every verdict rule below are unchanged.
 *
 * The operational envelope is the same as before:
 *   • timeout 120 s instead of 20 s (plus a hard ceiling in case a child
 *     outlives the kill and holds the pipes);
 *   • a definitive verdict on stdout is used even if the helper also wrote
 *     noise to stderr (the default throws the verdict away);
 *   • "the check could not run" REJECTS with ERR_UPDATER_SIGNATURE_CHECK_UNAVAILABLE
 *     — retryable — and is never confused with "the signature is wrong",
 *     which RESOLVES with a reason (NsisUpdater turns that into
 *     ERR_UPDATER_INVALID_SIGNATURE, which stops retries; updater-state.ts).
 *
 * Verdict rules kept identical to upstream (do not loosen them):
 *   • Status must be 0 (Valid) — no UnknownError, NotTrusted, HashMismatch …
 *   • the reported Path must be the file we asked about (when present);
 *   • the signer must match one of app-update.yml's publisherNames: a full DN
 *     must match every RDN it names; a bare name must equal the signer's CN.
 *     (`parseDn` is electron-updater's own, from builder-util-runtime.)
 *
 * FAILS CLOSED. Upstream skipped the check when PowerShell could not run at all
 * ("the machine has no usable PowerShell"). That escape hatch is gone with
 * PowerShell: if the helper is missing, blocked or does not answer, the update is
 * REJECTED as "check unavailable" (retryable), never accepted unchecked.
 *
 * No `electron` import and every side effect injected, so it is unit-testable
 * on any OS (electron/authenticode-verify.test.ts).
 */

export const VERIFY_TIMEOUT_MS = 120_000;
/** Settle anyway this long after the timeout, if the pipes never close. */
export const HARD_CEILING_SLACK_MS = 10_000;

export const CHECK_UNAVAILABLE_CODE = 'ERR_UPDATER_SIGNATURE_CHECK_UNAVAILABLE';
/**
 * The checker itself (win-helper.exe) could not run or did not answer: missing, blocked (security software, policy), crashed or
 * timed out. Distinct from CHECK_UNAVAILABLE_CODE (it ran but its output was unusable) and from a bad signature (a verdict).
 * The update is NOT applied; updater-state.ts shows an actionable message and stops the silent retry loop (the user's Retry and
 * the next scheduled check run it again).
 */
export const HELPER_UNAVAILABLE_CODE = 'ERR_UPDATER_SIGNATURE_HELPER_UNAVAILABLE';

/** Privacy-safe reason words (no paths, no messages) for the diagnostics log. */
export type HelperFailureReason = 'missing' | 'blocked' | 'timeout' | 'crash' | 'no_output';

export type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
export type ExecFileLike = (
    file: string,
    args: string[],
    options: { timeout: number; windowsHide: true; env: Record<string, string> },
    cb: ExecCallback,
) => void;

export interface VerifierLog {
    info(msg: string): void;
    warn(msg: string): void;
}

export interface VerifierDeps {
    execFile: ExecFileLike;
    /** builder-util-runtime's parseDn: RFC 2253 DN → Map<attr, value>. */
    parseDn: (dn: string) => Map<string, string>;
    /** path.win32.normalize in production. */
    normalizePath: (p: string) => string;
    log: VerifierLog;
    /** Absolute path of win-helper.exe (the signed Rust helper), or null when it is not there. */
    helperPath: () => string | null;
    /** The environment the helper inherits (process.env in production). */
    baseEnv?: Record<string, string | undefined>;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
    clearTimer?: (t: unknown) => void;
}

/**
 * Direct spawn of the helper, NO shell: `win-helper.exe verify <file>`. The file name is plain argv data (the helper never
 * parses it as anything but a path), so a hostile name from the update feed cannot become code.
 */
export function helperInvocation(
    helper: string,
    file: string,
    baseEnv: Record<string, string | undefined> = {},
): { exe: string; args: string[]; env: Record<string, string> } {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;
    return { exe: helper, args: ['verify', file], env };
}

export type Verdict =
    | { kind: 'valid' }
    /** The check ran and the file is NOT acceptable — a security verdict. */
    | { kind: 'invalid'; reason: string }
    /** Nothing usable came back. */
    | { kind: 'no-verdict'; why: string };

interface SignatureJson {
    Status?: unknown;
    StatusMessage?: unknown;
    Path?: unknown;
    SignerCertificate?: { Subject?: unknown; Issuer?: unknown; NotBefore?: unknown; NotAfter?: unknown; Thumbprint?: unknown } | null;
}

/** Pure: turn the signature JSON (Get-AuthenticodeSignature's shape, written by win-helper) into a verdict. */
export function evaluateSignatureJson(
    stdout: string,
    publisherNames: readonly string[],
    file: string,
    deps: Pick<VerifierDeps, 'parseDn' | 'normalizePath'>,
): Verdict {
    let data: SignatureJson;
    try {
        data = JSON.parse(stdout.replace(/^﻿/, '')) as SignatureJson;
    } catch {
        return { kind: 'no-verdict', why: 'output was not JSON' };
    }
    if (!data || typeof data !== 'object' || typeof data.Status !== 'number') {
        return { kind: 'no-verdict', why: 'output had no numeric Status' };
    }
    const subjectRaw = typeof data.SignerCertificate?.Subject === 'string' ? data.SignerCertificate.Subject : '';
    const summary = () => {
        const cert = data.SignerCertificate ?? {};
        return `publisherNames: ${publisherNames.join(' | ')}, raw info: ${JSON.stringify({
            Status: data.Status,
            StatusMessage: data.StatusMessage,
            Subject: cert.Subject,
            Issuer: cert.Issuer,
            NotBefore: cert.NotBefore,
            NotAfter: cert.NotAfter,
            Thumbprint: cert.Thumbprint,
        })}`;
    };
    if (data.Status !== 0) return { kind: 'invalid', reason: summary() };

    if (typeof data.Path === 'string' && data.Path) {
        // A different file than the one we asked about is not a verdict on OURS.
        if (deps.normalizePath(data.Path) !== deps.normalizePath(file)) {
            return { kind: 'no-verdict', why: 'reported Path differs from the downloaded file' };
        }
    }

    const subject = deps.parseDn(subjectRaw);
    for (const name of publisherNames) {
        const dn = deps.parseDn(name);
        let match = false;
        if (dn.size) {
            match = Array.from(dn.keys()).every(key => dn.get(key) === subject.get(key));
        } else if (name === subject.get('CN')) {
            match = true;
        }
        if (match) return { kind: 'valid' };
    }
    return { kind: 'invalid', reason: summary() };
}

/** Why the helper gave no answer, from how its spawn ended. A fixed word, never the error text. */
export function classifyHelperFailure(run: { error: Error | null; stdout: string }, helperPresent: boolean): HelperFailureReason | null {
    if (!helperPresent) return 'missing';
    const err = run.error as (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null;
    if (err) {
        if (err.killed || err.signal || /did not finish/.test(err.message)) return 'timeout';
        if (err.code === 'ENOENT') return 'missing';
        // Security software typically answers a launch with EACCES / EPERM / UNKNOWN (or a quarantine, then ENOENT).
        if (typeof err.code === 'string') return 'blocked';
        if (typeof err.code === 'number') return 'crash';
        return /not installed/.test(err.message) ? 'missing' : 'crash';
    }
    return run.stdout.trim() ? null : 'no_output';
}

function helperUnavailable(reason: HelperFailureReason, took: number): Error {
    const e = new Error(`Could not check the update's signature: win-helper.exe unavailable (${reason}) after ${took} ms`) as Error & { code: string; reason: HelperFailureReason };
    e.code = HELPER_UNAVAILABLE_CODE;
    e.reason = reason;
    return e;
}

function unavailable(message: string): Error {
    const e = new Error(`Could not check the update's signature: ${message}`) as Error & { code: string };
    e.code = CHECK_UNAVAILABLE_CODE;
    return e;
}

/** Run the helper once; never rejects, always settles (hard ceiling). */
function runHelper(filePath: string, timeout: number, deps: VerifierDeps): Promise<{ error: Error | null; stdout: string; stderr: string }> {
    const setT = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearT = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    return new Promise(resolve => {
        let settled = false;
        const ceiling = setT(() => {
            if (settled) return;
            settled = true;
            resolve({ error: new Error(`the signature checker did not finish within ${Math.round((timeout + HARD_CEILING_SLACK_MS) / 1000)}s`), stdout: '', stderr: '' });
        }, timeout + HARD_CEILING_SLACK_MS);
        (ceiling as { unref?: () => void } | null)?.unref?.();
        try {
            const helper = deps.helperPath();
            if (!helper) throw new Error('the signature checker (win-helper.exe) is not installed');
            const { exe, args, env } = helperInvocation(helper, filePath, deps.baseEnv);
            deps.execFile(exe, args, { timeout, windowsHide: true, env }, (error, stdout, stderr) => {
                if (settled) return;
                settled = true;
                clearT(ceiling);
                resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            });
        } catch (e) {
            if (settled) return;
            settled = true;
            clearT(ceiling);
            resolve({ error: e instanceof Error ? e : new Error(String(e)), stdout: '', stderr: '' });
        }
    });
}

/**
 * Build the function NsisUpdater calls after downloading: resolves null when
 * the installer is signed by one of `publisherNames`, resolves a reason string
 * when it is definitively not (→ ERR_UPDATER_INVALID_SIGNATURE), and rejects
 * with CHECK_UNAVAILABLE_CODE when the check could not produce a verdict.
 */
export function createAuthenticodeVerifier(deps: VerifierDeps): (publisherNames: string[], file: string) => Promise<string | null> {
    return async (publisherNames, file) => {
        const started = Date.now();
        deps.log.info(`Verifying update signature (timeout ${VERIFY_TIMEOUT_MS / 1000}s)`);
        const run = await runHelper(file, VERIFY_TIMEOUT_MS, deps);
        const took = Date.now() - started;
        if (run.stderr.trim()) deps.log.warn(`The signature checker wrote to stderr: ${run.stderr.trim().slice(0, 500)}`);

        // A definitive verdict on stdout wins, whatever else happened.
        const verdict = run.stdout.trim() ? evaluateSignatureJson(run.stdout.trim(), publisherNames, file, deps) : { kind: 'no-verdict' as const, why: 'no output' };
        if (verdict.kind === 'valid') {
            deps.log.info(`Update signature valid (${took} ms)`);
            return null;
        }
        if (verdict.kind === 'invalid') {
            deps.log.warn(`Update signature REJECTED (${took} ms): ${verdict.reason}`);
            return verdict.reason;
        }

        // No verdict: the check could not run. Rejected (retryable) - NEVER accepted unchecked. A checker that is missing, blocked,
        // crashed or timed out is told apart (it gets an actionable message); output that merely was not usable stays generic.
        const why = classifyHelperFailure(run, deps.helperPath() !== null);
        if (why) {
            deps.log.warn(`Update signature check could not run: win-helper.exe ${why}`);
            throw helperUnavailable(why, took);
        }
        const detail = run.error
            ? `${run.error.message.slice(0, 300)}${(run.error as { killed?: boolean }).killed ? ' (timed out)' : ''}`
            : run.stderr.trim()
                ? `stderr: ${run.stderr.trim().slice(0, 300)}`
                : verdict.why;
        throw unavailable(`${detail} after ${took} ms`);
    };
}
