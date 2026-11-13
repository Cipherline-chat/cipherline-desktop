import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
// The real DN parser electron-updater uses — so the publisher-matching rules
// under test are upstream's, not a re-implementation.
import { parseDn } from 'builder-util-runtime';
import {
    createAuthenticodeVerifier,
    powershellInvocation,
    encodePowerShell,
    SIGNATURE_SCRIPT,
    PROBE_SCRIPT,
    UPDATE_FILE_ENV,
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

/** The script PowerShell would run: decode the -EncodedCommand argument. */
const scriptOf = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

type Reply = { error?: Error | null; stdout?: string; stderr?: string } | 'hang' | 'throw';

function harness(signature: Reply, probe: Reply = { stdout: '"test"' }) {
    const calls: { file: string; args: string[]; options: unknown }[] = [];
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const onSkipped = vi.fn();
    const deps: VerifierDeps = {
        execFile: (file, args, options, cb: ExecCallback) => {
            calls.push({ file, args, options });
            const command = scriptOf(args);
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

describe('the PowerShell invocation: upstream\'s flags, a realistic timeout, and NO shell', () => {
    it('same flags as electron-updater, PSModulePath dropped from the child env, no cmd.exe wrapper', () => {
        const inv = powershellInvocation('X', undefined, { PSModulePath: 'C:\\pwsh7', psmodulepath: 'x', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
        expect(inv.exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        expect(inv.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-InputFormat', 'None']);
        expect(inv.args[4]).toBe('-EncodedCommand');
        expect(Buffer.from(inv.args[5], 'base64').toString('utf16le')).toBe('X');
        expect(Object.keys(inv.env).some(k => k.toUpperCase() === 'PSMODULEPATH')).toBe(false);
        expect(inv.env.Path).toBe('C:\\Windows');
        expect(inv.exe).not.toMatch(/cmd|&|set /);
    });

    it('falls back to the bare executable name when SystemRoot is unknown', () => {
        expect(powershellInvocation('X').exe).toBe('powershell.exe');
    });

    it('the file path travels in the environment, never in the script or the argv', () => {
        const hostile = 'C:\\u\\x\u2019; Start-Process calc; \u2018.exe';
        const inv = powershellInvocation(SIGNATURE_SCRIPT, hostile, { SystemRoot: 'C:\\Windows' });
        expect(inv.env[UPDATE_FILE_ENV]).toBe(hostile);
        expect(inv.args.join(' ')).not.toContain('calc');
        expect(Buffer.from(inv.args[5], 'base64').toString('utf16le')).not.toContain('calc');
    });

    it('a caller-supplied env value of the same name cannot override the file path', () => {
        const inv = powershellInvocation(SIGNATURE_SCRIPT, 'C:\\real.exe', { [UPDATE_FILE_ENV.toLowerCase()]: 'C:\\evil.exe', SystemRoot: 'C:\\Windows' });
        expect(inv.env[UPDATE_FILE_ENV]).toBe('C:\\real.exe');
        expect(Object.keys(inv.env).filter(k => k.toUpperCase() === UPDATE_FILE_ENV)).toHaveLength(1);
    });

    it('the signature script is a constant: no interpolation point, reads the path from the environment, ASCII-only output', () => {
        expect(SIGNATURE_SCRIPT).toContain(`-LiteralPath $env:${UPDATE_FILE_ENV}`);
        expect(SIGNATURE_SCRIPT).toContain('Get-AuthenticodeSignature');
        expect(SIGNATURE_SCRIPT).toContain('ConvertTo-Json -Compress');
        expect(SIGNATURE_SCRIPT).toContain('[^\\x00-\\x7F]');
        expect(PROBE_SCRIPT).toBe("'test' | ConvertTo-Json");
        expect(encodePowerShell('a')).toBe('YQA=');
    });

    // Negative control: this is what the OLD code did, and why it was injectable.
    // PowerShell ends a single-quoted literal at U+2018/2019/201A/201B, but the
    // old escape doubled only the ASCII apostrophe.
    it('negative control: the old splice-and-escape scheme let a curly quote end the literal', () => {
        const oldCommand = (file: string) => `Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}' | ConvertTo-Json -Compress`;
        const hostile = 'x\u2019; Start-Process calc; \u2018.exe';
        const cmd = oldCommand(hostile);
        const isQuote = (c: string) => "'\u2018\u2019\u201A\u201B".includes(c);
        const quoteCount = [...cmd].filter(isQuote).length;
        const asciiOnly = [...cmd].filter(c => c === "'").length;
        expect(quoteCount).toBeGreaterThan(asciiOnly + 1); // the payload adds quotes the escaper never saw
        // The new scheme: the hostile name appears nowhere in anything PowerShell parses.
        const inv = powershellInvocation(SIGNATURE_SCRIPT, hostile);
        expect(Buffer.from(inv.args[5], 'base64').toString('utf16le')).not.toContain('Start-Process');
    });

    it('runs with a 120 s timeout (upstream: 20 s), hidden, with NO shell', async () => {
        const h = harness({ stdout: sigJson() }, { stdout: '"test"' });
        await expect(h.verify(PUBLISHERS, FILE)).resolves.toBeNull();
        expect(VERIFY_TIMEOUT_MS).toBe(120_000);
        expect(h.calls).toHaveLength(1);
        const opts = h.calls[0].options as { shell?: unknown; timeout: number; windowsHide: boolean; env: Record<string, string> };
        expect(opts.shell).toBeUndefined();
        expect(opts.timeout).toBe(VERIFY_TIMEOUT_MS);
        expect(opts.windowsHide).toBe(true);
        expect(opts.env[UPDATE_FILE_ENV]).toBe(FILE);
        expect(scriptOf(h.calls[0].args)).toBe(SIGNATURE_SCRIPT);
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
        expect(scriptOf(h.calls[1].args)).toBe(PROBE_SCRIPT);
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
