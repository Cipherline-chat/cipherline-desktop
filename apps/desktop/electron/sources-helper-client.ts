/**
 * Main-process side of the out-of-process screen-share source lister: starts
 * the helper (./sources-helper.ts) on demand, authenticates its connection,
 * runs getSources requests through it, and stops it when idle.
 *
 * Why the helper exists: whenever DXGI Desktop Duplication is enabled in the
 * main process (so a screen SHARE can run at 90+ fps), Electron's
 * desktopCapturer.getSources() would initialise and tear down DXGI on the
 * main thread on every call — the 2026-10-07 whole-PC freeze. The helper is
 * the same executable launched with DirectXCapturer disabled, so listing
 * never touches DXGI in any process. Full reasoning: pickerEnumeration in
 * ./capture-flags.ts.
 *
 * No `electron` import: launchSourcesHelper uses only node:net /
 * node:child_process (integration-tested with a plain Node child in
 * sources-helper-client.test.ts), createSourcesHelperClient is a pure state
 * machine over an injected launcher.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { DesktopSourceType } from './desktop-sources';
import {
    SOURCES_HELPER_ENV_ADDRESS, SOURCES_HELPER_ENV_TOKEN, SOURCES_HELPER_ENV_DATA_DIR,
    createLineSplitter, encodeLine, parseHelperMessage, tokenMatches,
    type HelperMessage, type ListedSource,
} from './sources-helper-protocol';

// ── Transport ───────────────────────────────────────────────────────────────

export interface HelperConnection {
    pid: number;
    disabledFeatures: string;
    send(line: string): void;
    onMessage(cb: (m: HelperMessage) => void): void;
    onClose(cb: () => void): void;
    close(): void;
}

export interface HelperLaunch {
    /** Resolves once the child connected AND proved the token; rejects on
     *  spawn error, timeout, a bad/missing token, or exit before that. */
    connected: Promise<HelperConnection>;
    onExit(cb: (code: number | null, signal: string | null) => void): void;
    kill(): void;
}

const DATA_DIR_PREFIX = 'cl-srch-';
const STALE_DATA_DIR_MS = 24 * 60 * 60 * 1000;

/** Best-effort removal of profile dirs a crashed parent left behind. */
function sweepStaleDataDirs(base: string, now: number): void {
    try {
        for (const name of fs.readdirSync(base)) {
            if (!name.startsWith(DATA_DIR_PREFIX)) continue;
            const p = path.join(base, name);
            try {
                if (now - fs.statSync(p).mtimeMs > STALE_DATA_DIR_MS) fs.rmSync(p, { recursive: true, force: true });
            } catch { /* in use or gone */ }
        }
    } catch { /* unreadable tmp: nothing to sweep */ }
}

function removeDirSoon(dir: string): void {
    const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; } };
    // Windows can keep a just-exited process's files locked for a moment.
    if (!rm()) setTimeout(rm, 1500).unref?.();
}

export function launchSourcesHelper(opts: {
    command: string;
    args: string[];
    /** Connect + authenticate deadline (child start included). */
    connectTimeoutMs: number;
    platform?: NodeJS.Platform;
    baseEnv?: NodeJS.ProcessEnv;
    tmpBase?: string;
    spawnImpl?: (cmd: string, args: string[], o: SpawnOptions) => ChildProcess;
}): HelperLaunch {
    const platform = opts.platform ?? process.platform;
    const spawnImpl = opts.spawnImpl ?? nodeSpawn;
    let tmpBase = opts.tmpBase ?? os.tmpdir();
    // A unix socket path is limited to ~104-108 bytes.
    if (platform !== 'win32' && tmpBase.length > 60) tmpBase = '/tmp';
    sweepStaleDataDirs(tmpBase, Date.now());
    const token = randomBytes(32).toString('hex');
    const dataDir = fs.mkdtempSync(path.join(tmpBase, DATA_DIR_PREFIX));
    const address = platform === 'win32'
        ? `\\\\.\\pipe\\cipherline-sources-${randomBytes(16).toString('hex')}`
        : path.join(dataDir, 's.sock');

    const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
    let child: ChildProcess | null = null;
    let socket: net.Socket | null = null;
    let exited = false;
    let settled = false;
    let resolveConn!: (c: HelperConnection) => void;
    let rejectConn!: (e: Error) => void;
    const connected = new Promise<HelperConnection>((res, rej) => { resolveConn = res; rejectConn = rej; });
    // A rejection nobody awaited yet must not become an unhandled rejection.
    connected.catch(() => undefined);

    const server = net.createServer();
    const closeServer = () => {
        try { server.close(); } catch { /* already closed */ }
        if (platform !== 'win32') { try { fs.unlinkSync(address); } catch { /* gone */ } }
    };
    const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeServer();
        socket?.destroy();
        try { child?.kill(); } catch { /* gone */ }
        rejectConn(new Error(`sources helper: ${reason}`));
    };
    const timer = setTimeout(() => fail(`no authenticated connection within ${opts.connectTimeoutMs} ms`), opts.connectTimeoutMs);

    server.on('connection', (s) => {
        if (socket || settled) { s.destroy(); return; }
        socket = s;
        s.setEncoding('utf8');
        const msgCbs: Array<(m: HelperMessage) => void> = [];
        const closeCbs: Array<() => void> = [];
        let authed = false;
        const split = createLineSplitter((line) => {
            const msg = parseHelperMessage(line);
            if (!authed) {
                if (!msg || msg.kind !== 'hello' || !tokenMatches(token, msg.token)) {
                    fail('first message was not a valid hello');
                    return;
                }
                authed = true;
                settled = true;
                clearTimeout(timer);
                closeServer();
                resolveConn({
                    pid: msg.pid,
                    disabledFeatures: msg.disabledFeatures,
                    send: (l) => { if (!s.destroyed) s.write(l); },
                    onMessage: (cb) => { msgCbs.push(cb); },
                    onClose: (cb) => { closeCbs.push(cb); },
                    close: () => { s.end(); s.destroy(); },
                });
                return;
            }
            if (msg && msg.kind === 'result') for (const cb of msgCbs) cb(msg);
        }, () => s.destroy());
        s.on('data', (chunk: string) => split(chunk));
        s.on('error', () => { /* 'close' follows */ });
        s.on('close', () => {
            if (!authed) fail('connection closed before hello');
            for (const cb of closeCbs) cb();
        });
    });
    server.on('error', (e) => fail(`listen failed: ${e.message}`));

    server.listen(address, () => {
        if (settled) return;
        const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env) };
        // Would turn the child into plain Node (no desktopCapturer).
        delete env.ELECTRON_RUN_AS_NODE;
        env[SOURCES_HELPER_ENV_ADDRESS] = address;
        env[SOURCES_HELPER_ENV_TOKEN] = token;
        env[SOURCES_HELPER_ENV_DATA_DIR] = dataDir;
        try {
            child = spawnImpl(opts.command, opts.args, { env, stdio: 'ignore', windowsHide: true, detached: false });
        } catch (e) {
            fail(`spawn threw: ${(e as Error).message}`);
            removeDirSoon(dataDir);
            return;
        }
        child.on('error', (e) => { fail(`spawn failed: ${e.message}`); removeDirSoon(dataDir); });
        child.on('exit', (code, signal) => {
            exited = true;
            fail(`exited (${code ?? signal}) before connecting`);
            socket?.destroy();
            removeDirSoon(dataDir);
            for (const cb of exitCbs) cb(code, signal);
        });
    });

    return {
        connected,
        onExit: (cb) => { exitCbs.push(cb); },
        kill: () => {
            fail('killed');
            socket?.destroy();
            if (child && !exited) { try { child.kill(); } catch { /* gone */ } }
            if (!child) removeDirSoon(dataDir);
        },
    };
}

// ── Client ──────────────────────────────────────────────────────────────────

export const SOURCES_HELPER_UNAVAILABLE = 'The screen-share source list could not start (out-of-process picker unavailable)';

export type SourcesHelperEvent =
    | { type: 'spawn' }
    | { type: 'ready'; ms: number; pid: number; disabledFeatures: string }
    | { type: 'start-failed'; reason: string; failures: number }
    | { type: 'unavailable'; reason: string }
    | { type: 'exit'; code: number | null; signal: string | null }
    | { type: 'request-timeout'; id: number }
    | { type: 'dropped'; id: number; count: number }
    | { type: 'idle-stop' };

export interface SourcesHelperClient {
    getSources(req: { types: DesktopSourceType[]; thumbnailSize: { width: number; height: number } }): Promise<ListedSource[]>;
    /** True once start failures reached the limit; stays true for this run. */
    isUnavailable(): boolean;
    /** Running (or starting) right now — for tests and the log. */
    isRunning(): boolean;
    dispose(): void;
}

interface Pending {
    line: string;
    sent: boolean;
    resolve: (s: ListedSource[]) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export function createSourcesHelperClient(opts: {
    launch: () => HelperLaunch;
    /** Per request, start-up included. Electron's own getSources gives up waiting for previews after 3 s. */
    requestTimeoutMs?: number;
    /** Stop the helper this long after the last request settled. */
    idleMs?: number;
    /** Consecutive failed starts before giving up for the rest of the run. */
    maxStartFailures?: number;
    now?: () => number;
    onEvent?: (e: SourcesHelperEvent) => void;
}): SourcesHelperClient {
    const requestTimeoutMs = opts.requestTimeoutMs ?? 25_000;
    const idleMs = opts.idleMs ?? 120_000;
    const maxStartFailures = opts.maxStartFailures ?? 2;
    const now = opts.now ?? (() => Date.now());
    const emit = (e: SourcesHelperEvent) => { try { opts.onEvent?.(e); } catch { /* logging never breaks listing */ } };

    let current: { launch: HelperLaunch; conn: HelperConnection | null } | null = null;
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let startFailures = 0;
    let unavailable = false;
    let disposed = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
    const rejectAll = (err: Error) => {
        for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(err); }
    };
    const stop = () => {
        const c = current;
        current = null;
        if (!c) return;
        try { c.conn?.close(); } catch { /* gone */ }
        c.launch.kill();
    };
    const scheduleIdle = () => {
        clearIdle();
        if (!current || pending.size > 0 || disposed) return;
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (pending.size === 0 && current) { stop(); emit({ type: 'idle-stop' }); }
        }, idleMs);
        (idleTimer as { unref?: () => void }).unref?.();
    };
    const flush = () => {
        const conn = current?.conn;
        if (!conn) return;
        for (const p of pending.values()) {
            if (!p.sent) { p.sent = true; conn.send(p.line); }
        }
    };

    const start = () => {
        const startedAt = now();
        let launch: HelperLaunch;
        try {
            launch = opts.launch();
        } catch (e) {
            onStartFailure(`launch threw: ${(e as Error).message}`);
            return;
        }
        const entry = { launch, conn: null as HelperConnection | null };
        current = entry;
        emit({ type: 'spawn' });
        launch.onExit((code, signal) => {
            emit({ type: 'exit', code, signal });
            if (current === entry && entry.conn) {
                current = null;
                rejectAll(new Error(`sources helper exited (${code ?? signal})`));
            }
        });
        launch.connected.then((conn) => {
            if (current !== entry) { conn.close(); return; }
            entry.conn = conn;
            startFailures = 0;
            emit({ type: 'ready', ms: now() - startedAt, pid: conn.pid, disabledFeatures: conn.disabledFeatures });
            conn.onMessage((m) => {
                if (m.kind !== 'result') return;
                const p = pending.get(m.id);
                if (!p) return;
                pending.delete(m.id);
                clearTimeout(p.timer);
                if (m.ok) {
                    if (m.dropped > 0) emit({ type: 'dropped', id: m.id, count: m.dropped });
                    p.resolve(m.sources);
                } else {
                    p.reject(new Error(m.error));
                }
                scheduleIdle();
            });
            conn.onClose(() => {
                if (current !== entry) return;
                current = null;
                launch.kill();
                rejectAll(new Error('sources helper connection closed'));
            });
            flush();
        }, (err: Error) => {
            if (current !== entry) return;
            current = null;
            launch.kill();
            onStartFailure(err.message);
        });
    };

    const onStartFailure = (reason: string) => {
        startFailures++;
        emit({ type: 'start-failed', reason, failures: startFailures });
        if (startFailures >= maxStartFailures && !unavailable) {
            unavailable = true;
            emit({ type: 'unavailable', reason });
        }
        rejectAll(new Error(unavailable ? SOURCES_HELPER_UNAVAILABLE : `sources helper failed to start: ${reason}`));
    };

    return {
        getSources(req) {
            if (disposed) return Promise.reject(new Error('sources helper disposed'));
            if (unavailable) return Promise.reject(new Error(SOURCES_HELPER_UNAVAILABLE));
            clearIdle();
            const id = nextId++;
            const line = encodeLine({ id, types: req.types, thumbnailSize: req.thumbnailSize });
            const promise = new Promise<ListedSource[]>((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    emit({ type: 'request-timeout', id });
                    reject(new Error(`sources helper: no answer within ${requestTimeoutMs} ms`));
                    // A helper that does not answer is wedged (or never
                    // started): stop it; the next request starts a fresh one.
                    stop();
                    rejectAll(new Error('sources helper restarted after a timeout'));
                }, requestTimeoutMs);
                pending.set(id, { line, sent: false, resolve, reject, timer });
            });
            if (!current) start();
            else flush();
            return promise;
        },
        isUnavailable: () => unavailable,
        isRunning: () => current !== null,
        dispose() {
            disposed = true;
            clearIdle();
            stop();
            rejectAll(new Error('sources helper disposed'));
        },
    };
}
