import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
// The real DN parser electron-updater uses — so the publisher-matching rules
// under test are upstream's, not a re-implementation.
import { parseDn } from 'builder-util-runtime';
import {
    createAuthenticodeVerifier,
    helperInvocation,
    evaluateSignatureJson,
    CHECK_UNAVAILABLE_CODE,
    HELPER_UNAVAILABLE_CODE,
    classifyHelperFailure,
    VERIFY_TIMEOUT_MS,
    HARD_CEILING_SLACK_MS,
    type ExecCallback,
    type VerifierDeps,
} from './authenticode-verify';

/**
 * The verifier decides between three outcomes, and confusing any two of them
 * is the bug class this file guards:
 *   • signed by Cipherline LLC            → resolve(null)     (install)
 *   • definitively NOT acceptable          → resolve(reason)   (ERR_UPDATER_INVALID_SIGNATURE: stop, "couldn't be verified")
 *   • the check could not produce a verdict → reject(UNAVAILABLE) (retry)
 * The first must never come out of a bad signature OR a missing/crashed checker; the second must never
 * come out of a slow machine.
 */

const FILE = 'C:\\Users\\tester\\AppData\\Local\\desktop-updater\\pending\\temp-Cipherline Setup 1.0.21-staging.157.exe';
const SUBJECT = 'CN=Cipherline LLC, O=Cipherline LLC, L=Spirit Lake, S=Iowa, C=US';
const PUBLISHERS = ['Cipherline LLC']; // what staging.155's app-update.yml carries
const HELPER = 'C:\\Program Files\\Cipherline\\resources\\win-helper.exe';

const sigJson = (over: Record<string, unknown> = {}) => JSON.stringify({
    Status: 0,
    StatusMessage: 'Signature verified.',
    Path: FILE,
    SignerCertificate: { Subject: SUBJECT, Issuer: 'CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation, C=US', Thumbprint: 'AB' },
    ...over,
});

type Reply = { error?: Error | null; stdout?: string; stderr?: string } | 'hang' | 'throw';

function harness(signature: Reply, helper: string | null = HELPER) {
    const calls: { file: string; args: string[]; options: unknown }[] = [];
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const deps: VerifierDeps = {
        execFile: (file, args, options, cb: ExecCallback) => {
            calls.push({ file, args, options });
            if (signature === 'hang') return;
            if (signature === 'throw') throw new Error('spawn win-helper.exe ENOENT');
            queueMicrotask(() => cb(signature.error ?? null, signature.stdout ?? '', signature.stderr ?? ''));
        },
        helperPath: () => helper,
        parseDn,
        normalizePath: path.win32.normalize,
        log,
        setTimer: (fn, ms) => {
            const t = { fn, ms, cleared: false };
            timers.push(t);
            return t;
        },
        clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    };
    return { verify: createAuthenticodeVerifier(deps), calls, timers, log };
}

function timeoutError(): Error {
    const e = new Error('Command failed: win-helper.exe verify ...') as Error & { killed: boolean; signal: string };
    e.killed = true;
    e.signal = 'SIGTERM';
    return e;
}

describe('the helper invocation: our own signed binary, plain argv, NO shell and NO script host', () => {
    it('runs `win-helper.exe verify <file>` and passes the environment through untouched', () => {
        const inv = helperInvocation(HELPER, FILE, { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
        expect(inv.exe).toBe(HELPER);
        expect(inv.args).toEqual(['verify', FILE]);
        expect(inv.env).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
        expect(`${inv.exe} ${inv.args.join(' ')}`).not.toMatch(/powershell|pwsh|cmd\.exe|-EncodedCommand/i);
    });

    it('a hostile file name from the update feed is only ever an argv element', () => {
        const hostile = 'C:\\u\\x\u2019; Start-Process calc; \u2018.exe';
        const inv = helperInvocation(HELPER, hostile);
        expect(inv.args).toEqual(['verify', hostile]);
        expect(inv.exe).toBe(HELPER);
    });

    it('runs with a 120 s timeout (upstream: 20 s), hidden, with NO shell', async () => {
        const h = harness({ stdout: sigJson() });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toBeNull();
        expect(VERIFY_TIMEOUT_MS).toBe(120_000);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].file).toBe(HELPER);
        expect(h.calls[0].args).toEqual(['verify', FILE]);
        const opts = h.calls[0].options as { shell?: unknown; timeout: number; windowsHide: boolean };
        expect(opts.shell).toBeUndefined();
        expect(opts.timeout).toBe(VERIFY_TIMEOUT_MS);
        expect(opts.windowsHide).toBe(true);
    });

    it('a verdict whose JSON has a BOM and escaped backslashes still parses and matches', () => {
        const json = JSON.stringify({ Status: 0, Path: FILE, SignerCertificate: { Subject: SUBJECT } });
        const v = evaluateSignatureJson('\uFEFF' + json, PUBLISHERS, FILE, { parseDn, normalizePath: path.win32.normalize });
        expect(v.kind).toBe('valid');
    });
});

describe('verdicts', () => {
    it('Valid + signer CN = "Cipherline LLC" -> accepted (the staging.155/157 shape)', async () => {
        await expect(harness({ stdout: sigJson() }).verify(PUBLISHERS, FILE)).resolves.toBeNull();
    });

    it('a definitive Valid verdict is used even when the helper also wrote to stderr', async () => {
        const h = harness({ stdout: sigJson(), stderr: 'WARNING: something unrelated' });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toBeNull();
        expect(h.log.warn).toHaveBeenCalled();
    });

    it('a full-DN publisherName must match every RDN it names', async () => {
        await expect(harness({ stdout: sigJson() }).verify(['CN=Cipherline LLC, O=Cipherline LLC, C=US'], FILE)).resolves.toBeNull();
        await expect(harness({ stdout: sigJson() }).verify(['CN=Cipherline LLC, O=Someone Else'], FILE)).resolves.toMatch(/publisherNames/);
    });

    it('signed by someone else -> rejected with a reason (stops retries)', async () => {
        const other = sigJson({ SignerCertificate: { Subject: 'CN=Evil Corp, O=Evil Corp, C=US' } });
        const reason = await harness({ stdout: other }).verify(PUBLISHERS, FILE);
        expect(reason).toMatch(/publisherNames: Cipherline LLC/);
        expect(reason).toMatch(/Evil Corp/);
    });

    it.each([
        [1, 'UnknownError'],
        [2, 'NotSigned'],
        [3, 'HashMismatch'],
        [4, 'NotTrusted'],
    ])('Status %i (%s) -> rejected with a reason, never accepted, even when the signer name matches', async (status) => {
        const reason = await harness({ stdout: sigJson({ Status: status, StatusMessage: 'x' }) }).verify(PUBLISHERS, FILE);
        expect(typeof reason).toBe('string');
        expect(reason).toContain(`"Status":${status}`);
    });

    it('no signer certificate at all -> rejected', async () => {
        const reason = await harness({ stdout: sigJson({ Status: 2, SignerCertificate: null }) }).verify(PUBLISHERS, FILE);
        expect(typeof reason).toBe('string');
    });

    it('evaluateSignatureJson treats a missing Status as no verdict, not as valid', () => {
        const v = evaluateSignatureJson(JSON.stringify({ Path: FILE, SignerCertificate: { Subject: SUBJECT } }), PUBLISHERS, FILE, { parseDn, normalizePath: path.win32.normalize });
        expect(v.kind).toBe('no-verdict');
    });
});

describe('"could not check" is retryable and FAILS CLOSED, never a signature verdict and never an acceptance', () => {
    it('a timeout (upstream\'s failure mode on a slow / scanning machine) rejects with CHECK_UNAVAILABLE', async () => {
        const h = harness({ error: timeoutError() });
        await expect(h.verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: HELPER_UNAVAILABLE_CODE, reason: 'timeout' });
        expect(h.calls).toHaveLength(1); // no second "is it usable" probe, and no skip
    });

    it('stderr with no stdout at all means the checker gave no answer (helper unavailable, no_output)', async () => {
        await expect(harness({ stderr: 'boom' }).verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: HELPER_UNAVAILABLE_CODE, reason: 'no_output' });
    });

    it('non-JSON output rejects with CHECK_UNAVAILABLE', async () => {
        await expect(harness({ stdout: 'Preparing modules for first use.' }).verify(PUBLISHERS, FILE))
            .rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });

    it('a verdict about a DIFFERENT file is not a verdict about ours', async () => {
        await expect(harness({ stdout: sigJson({ Path: 'C:\\elsewhere\\other.exe' }) }).verify(PUBLISHERS, FILE))
            .rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });

    it('a helper that never returns settles at the hard ceiling instead of hanging the update forever', async () => {
        const h = harness('hang');
        const p = h.verify(PUBLISHERS, FILE);
        await Promise.resolve();
        const ceiling = h.timers.find(t => t.ms === VERIFY_TIMEOUT_MS + HARD_CEILING_SLACK_MS);
        expect(ceiling).toBeTruthy();
        ceiling!.fn();
        await expect(p).rejects.toMatchObject({ code: HELPER_UNAVAILABLE_CODE, reason: 'timeout' });
    });

    it('REGRESSION GUARD: the old "PowerShell unusable -> skip the check" escape hatch is gone', async () => {
        // A helper that cannot be spawned (blocked by policy / deleted) must reject, not wave the installer through.
        const h = harness('throw');
        await expect(h.verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: HELPER_UNAVAILABLE_CODE });
        // ... and so must a build that has no helper at all.
        const none = harness({ stdout: sigJson() }, null);
        await expect(none.verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: HELPER_UNAVAILABLE_CODE, reason: 'missing' });
        expect(none.calls).toHaveLength(0);
    });

    it('is NOT confused with a check that DID run and said "invalid"', async () => {
        const h = harness({ stdout: sigJson({ Status: 2 }) });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toEqual(expect.any(String));
        expect(h.calls).toHaveLength(1);
    });
});

describe('helper unavailable: reason codes, told apart from a bad signature and from unusable output', () => {
    const errWith = (props: Record<string, unknown>) => Object.assign(new Error('spawn failed'), props);

    it.each([
        ['ENOENT (deleted / quarantined)', { error: errWith({ code: 'ENOENT' }) }, 'missing'],
        ['EACCES (blocked)', { error: errWith({ code: 'EACCES' }) }, 'blocked'],
        ['EPERM (blocked by policy)', { error: errWith({ code: 'EPERM' }) }, 'blocked'],
        ['UNKNOWN (security software)', { error: errWith({ code: 'UNKNOWN' }) }, 'blocked'],
        ['killed (timed out)', { error: errWith({ killed: true, signal: 'SIGTERM' }) }, 'timeout'],
        ['non-zero exit (crash)', { error: errWith({ code: 3221225477 }) }, 'crash'],
    ] as const)('%s -> reason %s, update refused with HELPER_UNAVAILABLE', async (_n, reply, reason) => {
        const h = harness(reply);
        const e = await h.verify(PUBLISHERS, FILE).then(() => null, (x) => x as { code: string; reason: string; message: string });
        expect(e).toMatchObject({ code: HELPER_UNAVAILABLE_CODE, reason });
        // the log line names the reason, never a path
        expect(h.log.warn).toHaveBeenCalledWith(`Update signature check could not run: win-helper.exe ${reason}`);
        expect(e!.message).not.toContain('Users');
    });

    it('a missing helper path is "missing" and nothing is spawned', async () => {
        const h = harness({ stdout: sigJson() }, null);
        await expect(h.verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: HELPER_UNAVAILABLE_CODE, reason: 'missing' });
        expect(h.calls).toHaveLength(0);
    });

    it('output that arrived but is unusable stays the generic CHECK_UNAVAILABLE (a different problem)', async () => {
        await expect(harness({ stdout: 'not json' }).verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });

    it('A BAD SIGNATURE STILL REFUSES WITH THE OLD MESSAGE: resolves with the reason, never the helper error', async () => {
        const reason = await harness({ stdout: sigJson({ Status: 4, StatusMessage: 'not trusted' }) }).verify(PUBLISHERS, FILE);
        expect(reason).toContain('publisherNames: Cipherline LLC, raw info:');
        expect(reason).toContain('"Status":4');
        // even if the helper also exited non-zero / wrote to stderr, a verdict on stdout wins
        const noisy = await harness({ stdout: sigJson({ Status: 2 }), stderr: 'x', error: errWith({ code: 1 }) }).verify(PUBLISHERS, FILE);
        expect(typeof noisy).toBe('string');
    });

    it('classifyHelperFailure: a usable stdout is never a helper failure; success has no reason', () => {
        expect(classifyHelperFailure({ error: null, stdout: sigJson() }, true)).toBeNull();
        expect(classifyHelperFailure({ error: null, stdout: '' }, true)).toBe('no_output');
        expect(classifyHelperFailure({ error: null, stdout: sigJson() }, false)).toBe('missing');
    });
});
