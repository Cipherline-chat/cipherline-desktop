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
 * This is the same check with the same verdict rules — only the operational
 * envelope changes:
 *   • timeout 120 s instead of 20 s (plus a hard ceiling in case the shell's
 *     grandchild PowerShell outlives the killed cmd.exe and holds the pipes);
 *   • a definitive verdict on stdout is used even if PowerShell also wrote
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
 *   • if PowerShell cannot run AT ALL (even `ConvertTo-Json` fails), upstream
 *     skips the check with a warning — on the theory that the machine has no
 *     usable PowerShell. That fail-open is preserved as-is (parity, not a
 *     loosening), logged loudly and recorded as a diagnostic event.
 *
 * No `electron` import and every side effect injected, so it is unit-testable
 * on any OS (src/utils/authenticodeVerify.test.ts).
 */

export const VERIFY_TIMEOUT_MS = 120_000;
/** Ceiling for the "can PowerShell run at all" probe. */
export const PROBE_TIMEOUT_MS = 30_000;
/** Settle anyway this long after the timeout, if the pipes never close. */
export const HARD_CEILING_SLACK_MS = 10_000;

export const CHECK_UNAVAILABLE_CODE = 'ERR_UPDATER_SIGNATURE_CHECK_UNAVAILABLE';

export type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
export type ExecFileLike = (
    file: string,
    args: string[],
    options: { shell: true; timeout: number; windowsHide: true },
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
    /** Called when the check is skipped because PowerShell is unusable (fail-open parity). */
    onSkipped?: (why: string) => void;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
    clearTimer?: (t: unknown) => void;
}

/** Same command line as electron-updater's preparePowerShellExec (incl. the
 *  PSModulePath reset and UTF-8 code page — see its linked issues). */
export function powershellInvocation(command: string): [string, string[]] {
    return [
        'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe',
        ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command],
    ];
}

/** Single quotes doubled: the path is spliced into a single-quoted PS literal. */
export function authenticodeCommand(file: string): string {
    const escaped = file.replace(/'/g, "''");
    return `"Get-AuthenticodeSignature -LiteralPath '${escaped}' | ConvertTo-Json -Compress"`;
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

/** Pure: turn Get-AuthenticodeSignature's JSON into a verdict. */
export function evaluateSignatureJson(
    stdout: string,
    publisherNames: readonly string[],
    file: string,
    deps: Pick<VerifierDeps, 'parseDn' | 'normalizePath'>,
): Verdict {
    let data: SignatureJson;
    try {
        data = JSON.parse(stdout) as SignatureJson;
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

function unavailable(message: string): Error {
    const e = new Error(`Could not check the update's signature: ${message}`) as Error & { code: string };
    e.code = CHECK_UNAVAILABLE_CODE;
    return e;
}

/** Run one PowerShell command; never rejects, always settles (hard ceiling). */
function runPowerShell(command: string, timeout: number, deps: VerifierDeps): Promise<{ error: Error | null; stdout: string; stderr: string }> {
    const setT = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearT = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    return new Promise(resolve => {
        let settled = false;
        const ceiling = setT(() => {
            if (settled) return;
            settled = true;
            resolve({ error: new Error(`PowerShell did not finish within ${Math.round((timeout + HARD_CEILING_SLACK_MS) / 1000)}s`), stdout: '', stderr: '' });
        }, timeout + HARD_CEILING_SLACK_MS);
        (ceiling as { unref?: () => void } | null)?.unref?.();
        const [exe, args] = powershellInvocation(command);
        try {
            deps.execFile(exe, args, { shell: true, timeout, windowsHide: true }, (error, stdout, stderr) => {
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
        const run = await runPowerShell(authenticodeCommand(file), VERIFY_TIMEOUT_MS, deps);
        const took = Date.now() - started;
        if (run.stderr.trim()) deps.log.warn(`Get-AuthenticodeSignature wrote to stderr: ${run.stderr.trim().slice(0, 500)}`);

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

        // No verdict. Is PowerShell usable at all? (Upstream's fail-open rule.)
        const probe = await runPowerShell('ConvertTo-Json test', PROBE_TIMEOUT_MS, deps);
        if (probe.error) {
            const why = `PowerShell unusable (${probe.error.message.slice(0, 200)})`;
            deps.log.warn(`Cannot execute ConvertTo-Json: ${why}. Skipping signature validation, as electron-updater does.`);
            deps.onSkipped?.(why);
            return null;
        }
        const detail = run.error
            ? `${run.error.message.slice(0, 300)}${(run.error as { killed?: boolean }).killed ? ' (timed out)' : ''}`
            : run.stderr.trim()
                ? `stderr: ${run.stderr.trim().slice(0, 300)}`
                : verdict.why;
        throw unavailable(`${detail} after ${took} ms`);
    };
}
