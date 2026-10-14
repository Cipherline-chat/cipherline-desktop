import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
// The real DN parser electron-updater uses — so the publisher-matching rules
// under test are upstream's, not a re-implementation.
import { parseDn } from 'builder-util-runtime';
import {
    createAuthenticodeVerifier,
    authenticodeCommand,
    powershellInvocation,
    evaluateSignatureJson,
    CHECK_UNAVAILABLE_CODE,
    VERIFY_TIMEOUT_MS,
    PROBE_TIMEOUT_MS,
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
 * The first must never come out of a bad signature; the second must never
 * come out of a slow machine.
 */

const FILE = 'C:\\Users\\tester\\AppData\\Local\\desktop-updater\\pending\\temp-Cipherline Setup 1.0.21-staging.157.exe';
const SUBJECT = 'CN=Cipherline LLC, O=Cipherline LLC, L=Spirit Lake, S=Iowa, C=US';
const PUBLISHERS = ['Cipherline LLC']; // what staging.155's app-update.yml carries

const sigJson = (over: Record<string, unknown> = {}) => JSON.stringify({
    Status: 0,
    StatusMessage: 'Signature verified.',
    Path: FILE,
    SignerCertificate: { Subject: SUBJECT, Issuer: 'CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation, C=US', Thumbprint: 'AB' },
    ...over,
});

type Reply = { error?: Error | null; stdout?: string; stderr?: string } | 'hang' | 'throw';

function harness(signature: Reply, probe: Reply = { stdout: '"test"' }) {
    const calls: { file: string; args: string[]; options: unknown }[] = [];
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const onSkipped = vi.fn();
    const deps: VerifierDeps = {
        execFile: (file, args, options, cb: ExecCallback) => {
            calls.push({ file, args, options });
            const command = args[args.length - 1];
            const reply = command.includes('Get-AuthenticodeSignature') ? signature : probe;
            if (reply === 'hang') return;
            if (reply === 'throw') throw new Error('spawn cmd.exe ENOENT');
            queueMicrotask(() => cb(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? ''));
        },
        parseDn,
        normalizePath: path.win32.normalize,
        log,
        onSkipped,
        setTimer: (fn, ms) => {
            const t = { fn, ms, cleared: false };
            timers.push(t);
            return t;
        },
        clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    };
    return { verify: createAuthenticodeVerifier(deps), calls, timers, log, onSkipped };
}

function timeoutError(): Error {
    const e = new Error('Command failed: set "PSModulePath=" & chcp 65001 >NUL & powershell.exe ...') as Error & { killed: boolean; signal: string };
    e.killed = true;
    e.signal = 'SIGTERM';
    return e;
}

describe('the PowerShell invocation is upstream\'s, with a realistic timeout', () => {
    it('same command line as electron-updater (PSModulePath reset, UTF-8, non-interactive)', () => {
        const [exe, args] = powershellInvocation('X');
        expect(exe).toBe('set "PSModulePath=" & chcp 65001 >NUL & powershell.exe');
        expect(args).toEqual(['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', 'X']);
    });

    it('escapes single quotes in the path (it is spliced into a single-quoted literal)', () => {
        const cmd = authenticodeCommand("C:\\a';calc;'b.exe");
        expect(cmd).toBe(`"Get-AuthenticodeSignature -LiteralPath 'C:\\a'';calc;''b.exe' | ConvertTo-Json -Compress"`);
    });

    it('runs with a 120 s timeout (upstream: 20 s), hidden, via the shell', async () => {
        const h = harness({ stdout: sigJson() });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toBeNull();
        expect(VERIFY_TIMEOUT_MS).toBe(120_000);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].options).toEqual({ shell: true, timeout: VERIFY_TIMEOUT_MS, windowsHide: true });
        expect(h.calls[0].args.at(-1)).toContain(FILE.replace(/'/g, "''"));
    });
});

describe('verdicts', () => {
    it('Valid + signer CN = "Cipherline LLC" -> accepted (the staging.155/157 shape)', async () => {
        await expect(harness({ stdout: sigJson() }).verify(PUBLISHERS, FILE)).resolves.toBeNull();
    });

    it('a definitive Valid verdict is used even when PowerShell also wrote to stderr', async () => {
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

describe('"could not check" is retryable, never a signature verdict', () => {
    it('a timeout (upstream\'s failure mode on a slow / scanning machine) rejects with CHECK_UNAVAILABLE', async () => {
        const h = harness({ error: timeoutError() });
        await expect(h.verify(PUBLISHERS, FILE)).rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE, message: expect.stringContaining('(timed out)') });
        // The probe ran with its own bounded timeout.
        expect(h.calls[1].args.at(-1)).toBe('ConvertTo-Json test');
        expect((h.calls[1].options as { timeout: number }).timeout).toBe(PROBE_TIMEOUT_MS);
    });

    it('stderr with no usable stdout rejects with CHECK_UNAVAILABLE (upstream would reject too)', async () => {
        await expect(harness({ stderr: 'Get-AuthenticodeSignature : boom' }).verify(PUBLISHERS, FILE))
            .rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });

    it('non-JSON output rejects with CHECK_UNAVAILABLE', async () => {
        await expect(harness({ stdout: 'Preparing modules for first use.' }).verify(PUBLISHERS, FILE))
            .rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });

    it('a verdict about a DIFFERENT file is not a verdict about ours', async () => {
        await expect(harness({ stdout: sigJson({ Path: 'C:\\elsewhere\\other.exe' }) }).verify(PUBLISHERS, FILE))
            .rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });

    it('PowerShell that never returns settles at the hard ceiling instead of hanging the update forever', async () => {
        const h = harness('hang');
        const p = h.verify(PUBLISHERS, FILE);
        await Promise.resolve();
        const ceiling = h.timers.find(t => t.ms === VERIFY_TIMEOUT_MS + HARD_CEILING_SLACK_MS);
        expect(ceiling).toBeTruthy();
        ceiling!.fn();
        await expect(p).rejects.toMatchObject({ code: CHECK_UNAVAILABLE_CODE });
    });
});

describe('fail-open parity with electron-updater when PowerShell cannot run at all', () => {
    it('signature check AND the ConvertTo-Json probe both fail -> skipped (null), loudly', async () => {
        const h = harness({ error: new Error('spawn failed') }, { error: new Error('powershell blocked by policy') });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toBeNull();
        expect(h.onSkipped).toHaveBeenCalledWith(expect.stringContaining('PowerShell unusable'));
        expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping signature validation'));
    });

    it('a synchronous spawn throw is handled the same way (no unhandled exception)', async () => {
        const h = harness('throw', 'throw');
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toBeNull();
        expect(h.onSkipped).toHaveBeenCalled();
    });

    it('is NOT used to skip a check that DID run and said "invalid"', async () => {
        const h = harness({ stdout: sigJson({ Status: 2 }) }, { error: new Error('irrelevant') });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toEqual(expect.any(String));
        expect(h.onSkipped).not.toHaveBeenCalled();
        expect(h.calls).toHaveLength(1); // no probe after a verdict
    });
});
