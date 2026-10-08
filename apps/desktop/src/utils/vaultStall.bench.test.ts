import { describe, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import * as vm from 'vm';

/**
 * Main-process vault STALL HARNESS — a measuring tool, not a regression test
 * (the regression tests are keyBundleVault.test.ts, spkCandidateWalk.test.ts
 * and secureStore.smoke.test.ts). Skipped unless CL_VAULT_BENCH=1:
 *
 *   CL_VAULT_BENCH=1 npx vitest run src/utils/vaultStall.bench.test.ts
 *
 * Optional A/B: copy the pre-fix modules to `.bench-baseline/electron/`
 * (storage, signal-identity, channel-keys, e2ee-engine, channel-replay,
 * freeze-monitor, key-protection — e.g. `git show <rev>:apps/desktop/electron/
 * storage.ts`). Each operation then runs OLD and NEW interleaved against
 * identical copies of the same vault, so both see the same machine load.
 *
 * Builds a realistic long-lived SecureStore vault in a temp dir — the REAL
 * SecureStore (real AES-256-GCM per value, real JSON envelope), only
 * `electron` mocked — and times what appeared in the owner's freeze log:
 * crypto:ensure-identity-bundle, crypto:decrypt-message, keys:get-rotation-
 * bundle, securestore:save, plus load and the startup channel-key prune.
 *
 * Columns:
 *   block — the LONGEST stretch the event loop could not turn (a setImmediate
 *           ticker measures the gaps). What the freeze monitor reports.
 *   cpu   — process CPU (user+sys) consumed, all threads. Far less sensitive
 *           than wall time to other processes loading the machine.
 *   total — wall time until the operation settled.
 *
 * safeStorage (DPAPI on Windows) is on none of these paths: only
 * initialize() (one unwrap per launch), recoverWithKey and factoryReset call
 * it. The mock keeps it out of the numbers.
 */

let tmpDir = '';
vi.mock('electron', () => ({
    app: { getPath: () => tmpDir },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(`WRAPPED:${s}`, 'utf8'),
        decryptString: (buf: Buffer) => buf.toString('utf8').slice('WRAPPED:'.length),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}));

const RUN = process.env.CL_VAULT_BENCH === '1';
// Resident-memory column: a real full GC around each measurement point.
if (RUN) v8.setFlagsFromString('--expose-gc');
const heapMB = (): number => { if (RUN) { const gc = vm.runInNewContext('gc') as () => void; gc(); gc(); } return process.memoryUsage().heapUsed / 1048576; };
const BASELINE_DIR = path.resolve(__dirname, '..', '..', '.bench-baseline', 'electron');
const HAVE_BASELINE = fs.existsSync(path.join(BASELINE_DIR, 'storage.ts'));
const DAY = 86_400_000;

const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
function x25519() {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    const j = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    return { privHex: Buffer.from(j.d, 'base64url').toString('hex'), pubB64: Buffer.from(j.x, 'base64url').toString('base64') };
}

interface M { total: number; block: number; cpu: number }
async function measure<T>(fn: () => T | Promise<T>): Promise<M & { result: T }> {
    let last = process.hrtime.bigint();
    let maxGap = 0;
    let stop = false;
    const tick = () => {
        const now = process.hrtime.bigint();
        const gap = Number(now - last) / 1e6;
        if (gap > maxGap) maxGap = gap;
        last = now;
        if (!stop) setImmediate(tick);
    };
    const c0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();
    last = t0;
    setImmediate(tick);
    let result: T;
    try { result = await fn(); } finally { stop = true; }
    const end = process.hrtime.bigint();
    const c = process.cpuUsage(c0);
    const tail = Number(end - last) / 1e6;
    return { total: Number(end - t0) / 1e6, block: Math.max(maxGap, tail), cpu: (c.user + c.system) / 1000, result };
}

interface Shape {
    name: string; heldOtps: number; otpMaxId: number; spks: number; channels: number;
    epochsPerChannel: number; dmReplay: number; chanReplay: number; avatarKeys: number; retired: number;
}
const shapes: Shape[] = [
    { name: 'B long-lived (6 months active, healthy key hygiene)', heldOtps: 400, otpMaxId: 12_000, spks: 3, channels: 60, epochsPerChannel: 30, dmReplay: 50_000, chanReplay: 30_000, avatarKeys: 400, retired: 50 },
    { name: 'C owner-like (top-ups failing since 09-14, SPK churn)', heldOtps: 20_000, otpMaxId: 40_000, spks: 1_000, channels: 60, epochsPerChannel: 30, dmReplay: 50_000, chanReplay: 30_000, avatarKeys: 400, retired: 500 },
    { name: 'D pathological (2x C)', heldOtps: 40_000, otpMaxId: 80_000, spks: 2_000, channels: 150, epochsPerChannel: 50, dmReplay: 50_000, chanReplay: 30_000, avatarKeys: 1_500, retired: 500 },
];

/** Build the vault once (with the current store); return its dir + fixtures. */
async function buildVault(shape: Shape) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-vault-bench-src-'));
    vi.resetModules();
    const { secureStore: s } = await import('../../electron/storage');
    await s.initialize();
    const idKey = crypto.generateKeyPairSync('ed25519');
    const idJwk = idKey.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
    const identityPubB64 = Buffer.from(idJwk.x, 'base64url').toString('base64');
    const oldSpk = x25519();
    const held = new Set<number>();
    s.batch(() => {
        s.set('identity_priv', Buffer.from(idJwk.d, 'base64url').toString('hex'));
        s.set('identity_pub', identityPubB64);
        s.set('registration_id', '1234');
        for (let id = 1; id <= shape.spks; id++) {
            const k = id === 1 ? oldSpk : x25519();
            s.set(`signed_prekey_priv_${id}`, k.privHex);
            s.set(`signed_prekey_pub_${id}`, k.pubB64);
            s.set(`signed_prekey_sig_${id}`, b64(64));
            if (id < shape.spks) s.set(`signed_prekey_superseded_${id}`, new Date(Date.now() - DAY).toISOString());
        }
        s.set('signed_prekey_active_id', String(shape.spks));
        for (let i = shape.otpMaxId; held.size < Math.min(shape.heldOtps, 200) && i > 0; i--) held.add(i);
        while (held.size < shape.heldOtps) held.add(1 + Math.floor(Math.random() * shape.otpMaxId));
        for (const id of held) { s.set(`otp_priv_${id}`, hex(32)); s.set(`otp_pub_${id}`, b64(32)); }
        for (let st = 1; st <= shape.otpMaxId; st += 100) s.set(`otp_mint_${st}`, String(Date.now() - 40 * DAY));
        s.set('otp_max_id', String(shape.otpMaxId));
        s.set('__eph_replay__', JSON.stringify(Array.from({ length: shape.dmReplay }, () => b64(32))));
        s.set('__chan_replay__', JSON.stringify(Array.from({ length: shape.chanReplay }, () => [b64(16).replace(/=+$/, ''), b64(12)])));
        for (let c = 0; c < shape.channels; c++) {
            const obj: Record<string, { keyHex: string; rotatesAt: string }> = {};
            // Old epochs (prunable beyond the newest 50) so the startup prune has work.
            for (let e = 1; e <= shape.epochsPerChannel; e++) obj[e] = { keyHex: hex(32), rotatesAt: new Date(Date.now() - 90 * DAY).toISOString() };
            const id = crypto.randomUUID();
            s.set(`channel_keys:${id}`, JSON.stringify(obj));
            s.set(`protected_epochs:${id}`, '[1,2,3]');
        }
        for (let a = 0; a < shape.avatarKeys; a++) s.set(`avatar_key:${crypto.randomUUID()}`, JSON.stringify({ keyB64: b64(32), nonceB64: b64(12) }));
    });
    await s.whenDurable();
    // An envelope wrapped to the OLDEST signed prekey (a stale server bundle).
    const e2 = await import('../../electron/e2ee-engine');
    const sig = crypto.sign(null, Buffer.from(oldSpk.pubB64, 'base64'), idKey.privateKey).toString('base64');
    const dev = { device_id: 'dev-me', spk_pub_b64: oldSpk.pubB64, identity_pub_b64: identityPubB64, sig_b64: sig };
    const env1 = (await e2.encryptForDevices('{"t":"x","b":"1"}', 'u', [dev], 'dev-s')).envelope_b64;
    const env2 = (await e2.encryptForDevices('{"t":"x","b":"2"}', 'u', [dev], 'dev-s')).envelope_b64;
    const heldArr = [...held].sort((a, b) => a - b);
    return { dir: tmpDir, env1, env2, retired: heldArr.slice(0, shape.retired), unclaimed: heldArr.slice(-60) };
}

type Variant = 'old' | 'new';
/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadVariant(v: Variant, srcDir: string): Promise<any> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cl-vault-bench-${v}-`));
    fs.cpSync(srcDir, tmpDir, { recursive: true });
    vi.resetModules();
    const base = v === 'old' ? '../../.bench-baseline/electron' : '../../electron';
    const storage = await import(/* @vite-ignore */ `${base}/storage`);
    const heap0 = heapMB();
    const init = await measure(() => storage.secureStore.initialize());
    const vaultMB = heapMB() - heap0;
    const sig = await import(/* @vite-ignore */ `${base}/signal-identity`);
    const ck = await import(/* @vite-ignore */ `${base}/channel-keys`);
    const e2 = await import(/* @vite-ignore */ `${base}/e2ee-engine`);
    const order = v === 'new' ? new (await import('../../electron/spk-candidates')).SpkCandidateOrder() : null;
    return { v, dir: tmpDir, store: storage.secureStore, sig, ck, e2, order, init, heap0, vaultMB };
}

/** The main.ts crypto:decrypt-message body, as each version had it. */
function decryptOld(x: any, env: string) {
    const s = x.store;
    const activeIdStr = s.get('signed_prekey_active_id');
    const activeId = activeIdStr ? parseInt(activeIdStr, 10) : null;
    const ids = s.keys().map((k: string) => /^signed_prekey_priv_(\d+)$/.exec(k)?.[1]).filter((v: unknown) => v != null).map(Number)
        .sort((a: number, b: number) => (a === activeId ? -1 : b === activeId ? 1 : b - a));
    const c = ids.map((id: number) => ({ id, privHex: s.get(`signed_prekey_priv_${id}`), pubB64: s.get(`signed_prekey_pub_${id}`) }))
        .filter((q: any) => q.privHex && q.pubB64);
    return x.e2.decryptEnvelope(env, 'dev-me', c);
}
const decrypt = (x: any, env: string) => (x.v === 'old' ? decryptOld(x, env) : x.e2.decryptWithRetainedSpks(env, 'dev-me', x.order));
const durable = async (x: any) => { await x.store.whenDurable?.(); };

describe.skipIf(!RUN)('vault stall harness', () => {
    for (const shape of shapes) {
        it(shape.name, async () => {
            const fx = await buildVault(shape);
            const variants: Variant[] = HAVE_BASELINE ? ['old', 'new'] : ['new'];
            const ctx: Record<string, any> = {};
            const rows: Record<string, Partial<Record<Variant, M>>> = {};
            const rec = (op: string, v: Variant, m: M) => { (rows[op] ??= {})[v] = m; };

            for (const v of variants) { ctx[v] = await loadVariant(v, fx.dir); rec('initialize() (load + parse)', v, ctx[v].init); }
            // Interleave OLD/NEW for each operation.
            const each = async (op: string, fn: (x: any) => unknown) => {
                for (const v of variants) rec(op, v, await measure(() => fn(ctx[v])));
            };
            await each('crypto:ensure-identity-bundle #1', (x) => x.sig.ensureSignalIdentity());
            await each('crypto:ensure-identity-bundle #2', (x) => x.sig.ensureSignalIdentity());
            await each('crypto:ensure-identity-bundle #3', (x) => x.sig.ensureSignalIdentity());
            await each('crypto:get-local-identity', (x) => x.sig.getLocalIdentityPub());
            await each('keys:lowest-held-otp-id', (x) => x.sig.lowestHeldOtpId());
            await each('crypto:decrypt-message (stale-bundle SPK, cold)', (x) => decrypt(x, fx.env1));
            await each('crypto:decrypt-message (same SPK, next message)', (x) => decrypt(x, fx.env2));
            await each('set(small) -> durable  [securestore:save]', async (x) => { x.store.set('bench_k', String(Math.random())); await durable(x); });
            await each('startup channel-key prune', (x) => x.ck.pruneOldKeys());
            await each(`keys:get-rotation-bundle top-up (retired=${fx.retired.length})`, async (x) => {
                const r = await x.sig.generateRotationBundle({ rotateSpk: false, unclaimedPrekeyIds: fx.unclaimed, retiredPrekeyIds: fx.retired, otpPoolLow: true });
                await durable(x);
                return r;
            });

            // What main keeps resident: the parsed vault after initialize(), and
            // everything after the operations above (DM replay set loaded by the
            // first decrypt, identity, prune) — measured, not estimated.
            const mem = variants.map((v) => `${v.toUpperCase()} vault ${ctx[v].vaultMB.toFixed(1)} MB, after ops ${(heapMB() - ctx[v].heap0).toFixed(1)} MB`).join(' | ');
            const fmt = (m?: M) => (m ? `${m.block.toFixed(1).padStart(8)} ${m.cpu.toFixed(1).padStart(8)} ${m.total.toFixed(1).padStart(8)}` : ''.padStart(26));
            const size = (fs.statSync(path.join(fx.dir, 'secure-store.json')).size / 1e6).toFixed(2);
            const head = `  ${'operation'.padEnd(54)}` + variants.map((v) => ` | ${v.toUpperCase().padEnd(4)} ${'block'.padStart(4)}      cpu    total`).join('');
            const lines = Object.entries(rows).map(([op, r]) => `  ${op.padEnd(54)}` + variants.map((v) => ` | ${fmt(r[v])}`).join(''));
            process.stderr.write(`\n=== ${shape.name} — vault ${size} MB, load ${os.loadavg()[0].toFixed(1)} ===\n  main heap resident: ${mem}\n${head}\n${lines.join('\n')}\n`);
            for (const v of variants) { await durable(ctx[v]); fs.rmSync(ctx[v].dir, { recursive: true, force: true }); }
            fs.rmSync(fx.dir, { recursive: true, force: true });
        }, 1_800_000);
    }
});
