// Real-caller checks for win-helper.exe on Windows, run with tsx from apps/desktop:
//   1. electron/win-helper.ts's WinHelperClient (the actual `serve` client the app uses) against real processes.
//   2. Update-signature PARITY: the old Get-AuthenticodeSignature path (electron/authenticode-verify.ts as on origin/main, copied to
//      OLD_VERIFY by the caller) versus `win-helper.exe verify`, file by file, fed through BOTH TS verdict functions.
//
//   env: HELPER (win-helper.exe) FIXTURES (build-fixture.ps1 output) PARITY_DIR (files to verify) OLD_VERIFY (old module)
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const env = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} not set`); return v; };
const HELPER = env('HELPER');
const FIXTURES = env('FIXTURES');
const PARITY_DIR = env('PARITY_DIR');
const OLD_VERIFY = env('OLD_VERIFY');

let fails = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
    if (ok) console.log(`PASS  ${name}`); else { console.log(`FAIL  ${name}  ${detail}`); fails++; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean>, ms = 15000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await f()) return true; await sleep(300); }
    return false;
}

const require_ = createRequire(path.join(process.cwd(), 'package.json'));
const { parseDn } = require_('builder-util-runtime') as { parseDn: (s: string) => Map<string, string> };
const normalizePath = (p: string): string => path.win32.normalize(p);

async function clientChecks(): Promise<void> {
    const { WinHelperClient } = await import(pathToFileURL(path.join(process.cwd(), 'electron', 'win-helper.ts')).href);
    const c = new WinHelperClient(() => HELPER);
    const kids: ReturnType<typeof spawn>[] = [];
    try {
        const names: string[] = await c.processNames();
        check('client: processNames includes node', names.includes('node'), `count=${names.length}`);
        check('client: pidName(process.pid) is node', (await c.pidName(process.pid)) === 'node');
        const p = await c.exePath('node');
        check('client: exePath(node) is process.execPath', !!p && p.toLowerCase() === process.execPath.toLowerCase(), `${p} vs ${process.execPath}`);
        check('client: pidName of an unused pid is null', (await c.pidName(4294000)) === null);
        check('client: not suspended / no minecraft at rest', (await c.isSuspended('clwin')) === false && (await c.minecraftWindowOpen()) === false);

        const start = (exe: string, args: string[]) => { const k = spawn(path.join(FIXTURES, exe), args, { stdio: 'ignore' }); kids.push(k); return k; };
        start('clwin.exe', []);
        start('clnowin.exe', ['--nowin']);
        const mc = start('javaw.exe', ['Minecraft 1.21.4 CI']);
        check('client: hasVisibleWindow(clwin) true once its window shows', await until(async () => {
            const r = await c.request('window', { name: 'clwin' });
            return r?.found === true && r?.window === true;
        }));
        check('client: hasVisibleWindow(clnowin) false (running, no window)', (await c.hasVisibleWindow('clnowin')) === false);
        check('client: hasVisibleWindow of a program that is not running fails open (true)', (await c.hasVisibleWindow('not-running-xyz')) === true);
        check('client: minecraftWindowOpen true with a Minecraft-titled javaw', await until(() => c.minecraftWindowOpen()));
        mc.kill();
        check('client: minecraftWindowOpen false after it closes', await until(async () => !(await c.minecraftWindowOpen()), 10000));
    } finally {
        for (const k of kids) try { k.kill(); } catch { /* gone */ }
        c.stop();
    }
}

interface Out { stdout: string; stderr: string; code: number | null; ms: number }
function run(file: string, args: string[], e: NodeJS.ProcessEnv): Promise<Out> {
    const t0 = Date.now();
    return new Promise((resolve) => {
        execFile(file, args, { timeout: 120_000, windowsHide: true, env: e as Record<string, string>, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
            resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? ((err as { code?: number }).code ?? -1) : 0, ms: Date.now() - t0 });
        });
    });
}

async function parity(): Promise<void> {
    const oldMod = await import(pathToFileURL(path.resolve(OLD_VERIFY)).href);
    const newMod = await import(pathToFileURL(path.join(process.cwd(), 'electron', 'authenticode-verify.ts')).href);
    const fs = await import('node:fs');
    // label -> [publisher names to test, expected verdict kind for the FIRST publisher list]
    const cases: Array<{ label: string; pubs: string[]; expect: 'valid' | 'invalid' }> = [
        { label: 'cipherline-installer', pubs: ['Cipherline LLC'], expect: 'valid' },
        { label: 'cipherline-installer', pubs: ['Someone Else Ltd'], expect: 'invalid' },
        { label: 'cipherline-installer-flipped', pubs: ['Cipherline LLC'], expect: 'invalid' },
        { label: 'notepad', pubs: ['Microsoft Windows'], expect: 'valid' },
        { label: 'helper-unsigned', pubs: ['Cipherline LLC'], expect: 'invalid' },
        { label: 'odd-name-’x’; calc; ‘', pubs: ['Microsoft Windows'], expect: 'valid' },
    ];
    for (const cs of cases) {
        const file = path.join(PARITY_DIR, `${cs.label}.exe`);
        if (!fs.existsSync(file)) { check(`parity ${cs.label}: file present`, false, file); continue; }
        const inv = oldMod.powershellInvocation(oldMod.SIGNATURE_SCRIPT, file, process.env);
        const o = await run(inv.exe, inv.args, inv.env);
        const n = await run(HELPER, ['verify', file], process.env);
        const tag = `parity ${cs.label} [${cs.pubs.join('|')}]`;
        let oj: any = null, nj: any = null;
        try { oj = JSON.parse(o.stdout); } catch { /* reported below */ }
        try { nj = JSON.parse(n.stdout); } catch { /* reported below */ }
        console.log(`      old (PowerShell ${o.ms} ms): Status=${oj?.Status} Subject=${oj?.SignerCertificate?.Subject}`);
        console.log(`      new (win-helper ${n.ms} ms): Status=${nj?.Status} Subject=${nj?.SignerCertificate?.Subject}  ${nj?.StatusMessage}`);
        if (!oj || !nj) { check(`${tag}: both outputs parse`, false, `old=${o.stdout.slice(0, 200)} new=${n.stdout.slice(0, 200)} err=${o.stderr.slice(0, 200)}${n.stderr.slice(0, 200)}`); continue; }
        check(`${tag}: Status equal`, oj.Status === nj.Status, `old=${oj.Status} new=${nj.Status}`);
        const os = oj.SignerCertificate, ns = nj.SignerCertificate;
        if (os) {
            check(`${tag}: signer Subject string identical`, os.Subject === ns?.Subject, `\n old=${os.Subject}\n new=${ns?.Subject}`);
            check(`${tag}: signer Issuer string identical`, os.Issuer === ns?.Issuer, `\n old=${os.Issuer}\n new=${ns?.Issuer}`);
            check(`${tag}: Thumbprint identical`, String(os.Thumbprint).toUpperCase() === String(ns?.Thumbprint).toUpperCase(), `old=${os.Thumbprint} new=${ns?.Thumbprint}`);
        } else {
            check(`${tag}: no signer in either`, !ns || ns.Subject === '' || ns === null, JSON.stringify(ns));
        }
        const deps = { parseDn, normalizePath };
        const ov = oldMod.evaluateSignatureJson(o.stdout.trim(), cs.pubs, file, deps);
        const nv = newMod.evaluateSignatureJson(n.stdout.trim(), cs.pubs, file, deps);
        check(`${tag}: verdict kind identical (old=${ov.kind}, new=${nv.kind})`, ov.kind === nv.kind);
        check(`${tag}: verdict is the expected ${cs.expect}`, nv.kind === cs.expect, `new=${JSON.stringify(nv)}`);
        // The real verifier, end to end (spawns win-helper like electron-updater's hook does).
        const verifier = newMod.createAuthenticodeVerifier({
            execFile: (f: string, a: string[], opt: object, cb: (e: Error | null, so: string, se: string) => void) => { execFile(f, a, opt as never, cb as never); },
            parseDn, normalizePath, log: { info: () => {}, warn: () => {} }, helperPath: () => HELPER, baseEnv: process.env,
        });
        let res: string | null | 'threw' = 'threw';
        try { res = await verifier(cs.pubs, file); } catch (e) { res = `threw:${(e as Error).message}`; }
        check(`${tag}: createAuthenticodeVerifier ${cs.expect === 'valid' ? 'accepts (null)' : 'rejects (reason string)'}`,
            cs.expect === 'valid' ? res === null : typeof res === 'string' && !res.startsWith('threw'), String(res).slice(0, 200));
    }
}

(async () => {
    await clientChecks();
    await parity();
    if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
    console.log('\nall TS checks passed');
})().catch((e) => { console.error(e); process.exit(2); });
