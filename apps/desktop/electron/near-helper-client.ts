/**
 * Main-process side of the near-helper: starts the helper (the Rust local-network transfer engine,
 * `apps/desktop-host/near-helper`) on demand, proves itself to it, speaks the line-delimited JSON protocol
 * (`near-helper/src/proto.rs` is the spec), answers the helper's one request this build honours (the password gate) and
 * stops it when idle.
 *
 * WHO TALKS TO WHOM. The helper accepts commands only from its parent: no socket, no argv/env surface. On macOS and Linux
 * the parent creates four pipes (stdin, stdout, stderr and fd 3), writes the 64-hex handshake nonce to fd 3 (never argv or
 * the environment, which other local processes can read), and repeats it in the first stdin line. WINDOWS has no fd 3 for a
 * Node child, so there the nonce is the FIRST stdin line (three pipes) and `hello` repeats it: equally private to the two
 * processes, though it can no longer prove "I created these pipes" (see `near-helper/src/lib.rs::read_nonce_line`). The same nonce keys the HMAC
 * that attests a gate verdict (`attestGate`), so a verdict the helper accepts must have been produced here, by main, after main
 * itself checked the password with the server. Web content only ever supplies the typed secret.
 *
 * No `electron` import: spawn and timers are injected, so the state machine is unit-tested with a fake child and the same
 * file is integration-tested against the real Linux helper (`near-helper.integration.test.ts`).
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { HelperLifecycle } from './near-diag';

export const NEAR_PROTOCOL_VERSION = 1;
/** The helper's own cap on an incoming line is 64 KiB; refuse to send more than that too. */
export const MAX_COMMAND_BYTES = 64 * 1024;
/** Cap on a single line FROM the helper (a snapshot is a few KiB). */
const MAX_HELPER_LINE = 1024 * 1024;

export interface NearHelperConfig {
    profile: string;
    stagingDir: string;
    version: string;
    deviceLabel: string;
    platform: 'linux' | 'mac' | 'windows';
    /** Ignored: never sent to the helper (see the hello). Kept so older callers still type-check. */
    attestSecret?: string;
}

export type GateVerdict = 'approved' | 'declined';

export interface NearHelperHandlers {
    /** The approval gate when the platform has no biometric: resolves only after the account secret was verified with the server. */
    gateConfirm(title: string, detail: string): Promise<GateVerdict>;
}

type Child = Pick<ChildProcess, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'stdio' | 'kill' | 'on' | 'once'>;
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Child;

export interface NearHelperClientOptions {
    /** Absolute path of the helper binary, or null when this build has none. */
    resolveBinary: () => string | null;
    spawn: SpawnFn;
    config: () => NearHelperConfig;
    handlers: NearHelperHandlers;
    onState: (snapshot: unknown) => void;
    onOwnOut: (msg: { to: string; content: unknown }) => void;
    /** Diagnostics only (the report's transfer trail): the helper was spawned / became ready / exited (with its exit code) / could not start. */
    onLifecycle?: (e: HelperLifecycle) => void;
    baseEnv?: NodeJS.ProcessEnv;
    /** Defaults to `process.platform`. `win32`: three pipes, the nonce as the first stdin line, a Windows environment allow-list. */
    platform?: NodeJS.Platform;
    extraArgs?: string[];
    log?: (line: string) => void;
    startTimeoutMs?: number;
    /** Stop the helper this long after the engine went quiet (idle/terminal state and no call in flight). */
    idleMs?: number;
    /** After a completed transfer the page still reads the result and K_xfer lives in the helper: keep it this long. */
    doneIdleMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    randomHex?: () => string;
}

export interface NearHelperClient {
    start(): Promise<void>;
    call(action: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
    stop(): void;
    /** TESTS ONLY: write one raw protocol object to the helper (the `test` command exists only in testkit builds, which refuse a release build). */
    sendRaw(obj: unknown): boolean;
    readonly running: boolean;
    /** The helper's last reported engine state, with seqs shifted so they keep rising across restarts. */
    lastSnapshot(): Record<string, unknown> | null;
}

export class NearHelperUnavailable extends Error {
    constructor(reason: string) {
        super(`near helper unavailable: ${reason}`);
        this.name = 'NearHelperUnavailable';
    }
}

/** hex(HMAC-SHA256(key = nonce, "gate:<rid>:<verdict>")): must equal `remote::attest_gate` in the helper. */
export function attestGate(nonce: string, rid: number, verdict: GateVerdict): string {
    return createHmac('sha256', nonce).update(`gate:${rid}:${verdict}`).digest('hex');
}

/** What the helper gets from our environment: nothing it does not need (never the attestation secret, tokens or proxies). */
export function helperEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
    // Windows: SystemRoot (Winsock and the resolver need it), the per-user temp/profile folders, PATH. Nothing else.
    const keep = platform === 'win32'
        ? ['PATH', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME']
        : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SYSTEM_BUS_ADDRESS', 'USER', 'LOGNAME'];
    const out: NodeJS.ProcessEnv = {};
    for (const k of keep) if (base[k] !== undefined) out[k] = base[k];
    return out;
}

const TERMINAL = new Set(['idle', 'done', 'refused', 'expired', 'cancelled', 'failed']);

export function createNearHelperClient(opts: NearHelperClientOptions): NearHelperClient {
    const log = opts.log ?? (() => undefined);
    const lifecycle = (e: HelperLifecycle) => { try { opts.onLifecycle?.(e); } catch { /* diagnostics never break the helper */ } };
    const startTimeoutMs = opts.startTimeoutMs ?? 8000;
    const idleMs = opts.idleMs ?? 60_000;
    const doneIdleMs = opts.doneIdleMs ?? 15 * 60_000;
    const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    const randomHex = opts.randomHex ?? (() => randomBytes(32).toString('hex'));
    const platform = opts.platform ?? process.platform;
    const win = platform === 'win32';

    let child: Child | null = null;
    let nonce = '';
    let ready = false;
    let starting: Promise<void> | null = null;
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
    let seqBase = 0;
    let lastSeq = 0;
    let last: Record<string, unknown> | null = null;
    let idleTimer: unknown = null;

    const failAll = (e: Error) => {
        for (const [, p] of pending) { clearTimer(p.timer); p.reject(e); }
        pending.clear();
    };

    const evaluateIdle = () => {
        if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
        if (!child || !ready || pending.size > 0) return;
        const st = typeof last?.state === 'string' ? last.state : 'idle';
        if (!TERMINAL.has(st)) return;
        idleTimer = setTimer(() => { if (pending.size === 0) client.stop(); }, st === 'done' ? doneIdleMs : idleMs);
    };

    const emitSynthetic = (error: { code: string; message: string }) => {
        lastSeq += 1;
        last = { seq: lastSeq, role: null, state: 'failed', error };
        opts.onState(last);
    };

    const send = (obj: unknown): boolean => {
        const c = child;
        if (!c?.stdin || c.stdin.destroyed || !c.stdin.writable) return false;
        const line = JSON.stringify(obj);
        if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) throw new Error('command too large');
        c.stdin.write(line + '\n');
        return true;
    };

    const answerRequest = async (m: { rid: number; what: string } & Record<string, unknown>) => {
        const h = opts.handlers;
        let value: Record<string, unknown> = {};
        let attest: string | undefined;
        try {
            switch (m.what) {
                // The sign-in requests (device identity, link slot) belong to the proximity sign-in build and are never
                // honoured here: this build signs nothing and installs no link key, whatever the helper asks.
                case 'identity_pub': value = { pub: null }; break;
                case 'sign': value = { sig: null }; break;
                case 'install_link': value = { ok: false }; break;
                case 'gate_confirm': {
                    const verdict = await h.gateConfirm(String(m.title ?? ''), String(m.detail ?? ''));
                    value = { verdict };
                    attest = attestGate(nonce, m.rid, verdict);
                    break;
                }
                default: value = { error: 'unknown request' };
            }
        } catch (e) {
            log(`near-helper: request ${m.what} failed: ${(e as Error)?.message ?? 'error'}`);
            value = m.what === 'gate_confirm' ? { verdict: 'declined' } : {};
            if (m.what === 'gate_confirm') attest = attestGate(nonce, m.rid, 'declined');
        }
        send({ t: 'reply', rid: m.rid, value, ...(attest ? { attest } : {}) });
    };

    const onLine = (line: string) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (!m || typeof m !== 'object') return;
        switch (m.t) {
            case 'ready': ready = true; lifecycle({ kind: 'ready' }); break;
            case 'result': {
                const p = typeof m.id === 'number' ? pending.get(m.id) : undefined;
                if (!p) break;
                pending.delete(m.id as number);
                clearTimer(p.timer);
                if (m.ok === true) p.resolve(m.value ?? null); else p.reject(new Error(typeof m.error === 'string' ? m.error : 'failed'));
                evaluateIdle();
                break;
            }
            case 'state': {
                const s = m.snapshot as Record<string, unknown> | undefined;
                if (!s || typeof s !== 'object') break;
                const seq = (typeof s.seq === 'number' ? s.seq : 0) + seqBase;
                lastSeq = Math.max(lastSeq, seq);
                last = { ...s, seq };
                opts.onState(last);
                evaluateIdle();
                break;
            }
            case 'own_out':
                if (typeof m.to === 'string') opts.onOwnOut({ to: m.to, content: m.content });
                break;
            case 'req':
                if (typeof m.rid === 'number' && typeof m.what === 'string') void answerRequest(m as { rid: number; what: string });
                break;
            case 'fatal': log(`near-helper: fatal: ${typeof m.error === 'string' ? m.error.slice(0, 120) : ''}`); break;
            default: break;
        }
    };

    const startOnce = (): Promise<void> => new Promise<void>((resolve, reject) => {
        const bin = opts.resolveBinary();
        if (!bin) { lifecycle({ kind: 'unavailable', why: 'no_binary' }); reject(new NearHelperUnavailable('no helper binary in this build')); return; }
        nonce = randomHex();
        let c: Child;
        try {
            c = opts.spawn(bin, opts.extraArgs ?? [], { stdio: win ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'], env: helperEnv(opts.baseEnv ?? process.env, platform), windowsHide: true, shell: false });
        } catch (e) {
            lifecycle({ kind: 'unavailable', why: 'spawn_failed' });
            reject(new NearHelperUnavailable(`spawn failed: ${(e as Error)?.message ?? 'error'}`));
            return;
        }
        lifecycle({ kind: 'spawned' });
        child = c;
        ready = false;
        seqBase = lastSeq;
        let settled = false;
        const settle = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimer(timer);
            if (err) { try { c.kill(); } catch { /* gone */ } reject(err); } else resolve();
        };
        const timer = setTimer(() => { lifecycle({ kind: 'unavailable', why: 'not_ready' }); settle(new NearHelperUnavailable('did not become ready in time')); }, startTimeoutMs);

        // stdout: one JSON object per line, bounded
        let buf = '';
        c.stdout?.setEncoding('utf8');
        c.stdout?.on('data', (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                onLine(line);
                if (!settled && ready) settle();
            }
            if (buf.length > MAX_HELPER_LINE) { log('near-helper: oversized line from helper; stopping it'); client.stop(); }
        });
        c.stdout?.on('error', () => undefined);
        c.stdin?.on('error', () => undefined);
        // stderr: fixed-word diagnostics only (the helper never writes a token or key); keep a few lines
        let errBuf = '';
        c.stderr?.setEncoding('utf8');
        c.stderr?.on('data', (d: string) => { errBuf = (errBuf + d).slice(-1024); });
        c.stderr?.on('error', () => undefined);
        c.on('error', (e: Error) => { lifecycle({ kind: 'unavailable', why: 'spawn_failed' }); settle(new NearHelperUnavailable(`spawn error: ${e.message}`)); });
        c.on('exit', (code: number | null, signal: string | null) => {
            lifecycle({ kind: 'exited', code, signal });
            const wasReady = ready;
            const current = child === c;
            if (current) { child = null; ready = false; if (idleTimer) { clearTimer(idleTimer); idleTimer = null; } }
            const why = `exited (${code ?? signal ?? '?'})`;
            if (errBuf.trim()) log(`near-helper: ${why}: ${errBuf.trim().split('\n').slice(-3).join(' | ')}`);
            settle(new NearHelperUnavailable(why));
            if (!current) return; // an old process that was stopped and replaced: nothing of the new one is affected
            failAll(new NearHelperUnavailable(why));
            // a session that was running is over: tell the page rather than leave it waiting
            if ((wasReady || !!last) && !(last && TERMINAL.has(String(last.state)))) emitSynthetic({ code: 'helper_exited', message: why });
        });

        // the handshake: nonce on fd 3 (then close it) or, on Windows, as the first stdin line; then hello on stdin
        if (win) {
            if (!c.stdin || !c.stdin.writable) { settle(new NearHelperUnavailable('no handshake pipe')); return; }
            c.stdin.write(nonce + '\n');
        } else {
            const fd3 = c.stdio?.[3] as NodeJS.WritableStream | null | undefined;
            if (!fd3 || typeof (fd3 as { write?: unknown }).write !== 'function') { settle(new NearHelperUnavailable('no handshake pipe')); return; }
            (fd3 as unknown as { on?: (e: string, f: () => void) => void }).on?.('error', () => undefined);
            fd3.write(nonce + '\n');
            fd3.end();
        }
        try {
            // `attestSecret` is never sent: this build uses no HTTP in the helper, so the helper holds no account or attestation secret at
            // all (security round L5; the Windows nonce proves nothing about who made the pipes, so keep it that way).
            const { attestSecret: _never, ...config } = opts.config();
            send({ t: 'hello', v: NEAR_PROTOCOL_VERSION, nonce, config });
        } catch (e) { settle(new NearHelperUnavailable((e as Error).message)); }
    });

    const client: NearHelperClient = {
        get running() { return !!child && ready; },
        lastSnapshot: () => last,
        start() {
            if (child && ready) return Promise.resolve();
            if (!starting) starting = startOnce().finally(() => { starting = null; });
            return starting;
        },
        async call(action, args, timeoutMs = 30_000) {
            await client.start();
            const id = nextId++;
            return new Promise<unknown>((resolve, reject) => {
                const timer = setTimer(() => { pending.delete(id); reject(new Error('the helper did not answer in time')); evaluateIdle(); }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
                try {
                    if (!send({ t: 'call', id, action, args })) throw new Error('the helper is not running');
                } catch (e) { pending.delete(id); clearTimer(timer); reject(e as Error); }
            });
        },
        sendRaw(obj) { return send(obj); },
        stop() {
            if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
            const c = child;
            if (!c) return;
            ready = false;
            try { c.stdin?.end(); } catch { /* gone */ }
            // closing stdin ends the helper cleanly; the kill is the backstop
            setTimer(() => { try { c.kill(); } catch { /* gone */ } }, 1500);
        },
    };
    return client;
}
