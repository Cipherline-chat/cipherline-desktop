/**
 * Local Rich Presence listener — a minimal server for the local IPC transport
 * games and launchers use to announce what you are doing ("Rich Presence").
 *
 * WHERE IT LISTENS
 *   Windows        named pipe   \\?\pipe\discord-ipc-N
 *   macOS / Linux  unix socket  <dir>/discord-ipc-N, where <dir> is the first
 *                  of $XDG_RUNTIME_DIR, $TMPDIR, $TMP, $TEMP that is set, else
 *                  /tmp — the exact order the client libraries search
 *                  (discord-rpc, discord-rpc-csharp, discord.js RPC, arRPC):
 *                  each takes that ONE directory and tries N = 0..9 in order,
 *                  connecting to the first that answers.
 *
 * DELIBERATELY NOT OPENED: the WebSocket transport other implementations
 * (arRPC) also serve on 127.0.0.1:6463-6472, and any HTTP or TCP listener.
 * A web page can reach a loopback port; it cannot open a named pipe or a unix
 * socket. Serving the port would let any site the user visits set (or probe
 * for) their presence. Only the local IPC transport exists here.
 *
 * COEXISTENCE — never break the user's real Discord (or another RPC server)
 *   Clients connect to the LOWEST slot that answers, so a second server on a
 *   higher slot receives nothing, and whoever holds slot 0 gets every game.
 *   If we held slot 0 while Discord started, Discord would bind slot 1 and
 *   silently lose every game's presence to us. So:
 *     - Before claiming, every slot 0..9 is probed (plus the Flatpak/Snap
 *       Discord locations under $XDG_RUNTIME_DIR that newer clients also
 *       probe). If ANY other live listener exists, we take NO slot (standby).
 *     - While listening, the probe repeats every PROBE_INTERVAL_MS. The moment
 *       another listener appears (Discord was started after us), we YIELD:
 *       close our endpoint and drop our clients. They reconnect and find the
 *       other server — the libraries retry on disconnect.
 *     - We never delete or replace another process's pipe or socket file. A
 *       stale socket file is removed only when it is provably OUR OWN (its
 *       device+inode match the marker we wrote when we created it); a stale
 *       file we did not create is skipped (clients skip it too: ECONNREFUSED).
 *   "Probe" = on Windows, a listing of \\.\pipe\ (no connection is opened to
 *   the other server); on Unix, a connect() that is closed immediately.
 *
 * HARDENING (the peer is any local process able to open the endpoint)
 *   - frames ≤ 64 KiB, strict JSON, known opcodes only (./rpc-frame.ts); a bad
 *     frame closes the connection;
 *   - activities are whitelisted (./rpc-activity.ts): buttons and secrets are
 *     stripped and never stored; image refs are data only, never fetched;
 *   - per-connection token-bucket rate limit; a client that keeps flooding is
 *     disconnected;
 *   - at most MAX_CONNECTIONS concurrent connections;
 *   - a connection must handshake within HANDSHAKE_TIMEOUT_MS, and one with
 *     no activity that sends nothing for IDLE_TIMEOUT_MS is closed;
 *   - the unix socket is chmod 0600 (owner only);
 *   - the READY reply identifies no one (a fixed stub user).
 *   The listener runs only while the user shares game activity (main.ts).
 *
 * No `electron` import: unit-testable with injectable paths.
 */
import * as net from 'net';
import { promises as fsp } from 'fs';
import { join } from 'path';
import {
    RpcFrameDecoder, RpcFrameError, encodeFrame,
    OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG,
} from './rpc-frame';
import { sanitizeActivity, isClientId, pidOf, type RpcPresence } from './rpc-activity';

export const SLOT_COUNT = 10;
export const MAX_CONNECTIONS = 8;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 120_000;
export const PROBE_INTERVAL_MS = 15_000;
/** Token bucket: BURST frames, refilled at REFILL_PER_SEC. */
export const RATE_BURST = 10;
export const RATE_REFILL_PER_SEC = 1;
/** Consecutive over-budget frames before the connection is dropped. */
export const RATE_DROP_AFTER = 30;

/** Close codes sent in a CLOSE frame. */
export const CLOSE_NORMAL = 1000;
export const CLOSE_UNSUPPORTED = 1003;
export const CLOSE_INVALID_CLIENT_ID = 4000;
export const CLOSE_RATE_LIMITED = 4002;
export const CLOSE_INVALID_VERSION = 4004;
/** RPC error codes in ERROR replies. */
export const ERR_INVALID_PAYLOAD = 4000;
export const ERR_INVALID_COMMAND = 4002;
export const ERR_RATE_LIMITED = 5011;

const PIPE_PREFIX = '\\\\?\\pipe\\';
const PIPE_LIST_DIR = '\\\\.\\pipe\\';
const SLOT_NAME_RE = /^discord-ipc-(\d)$/;

/** The stub user in READY. Identifies no one; clients only need the shape. */
const READY_DATA = {
    v: 1,
    config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
    user: {
        id: '0', username: 'cipherline', discriminator: '0', global_name: 'Cipherline',
        avatar: null, avatar_decoration_data: null, bot: false, flags: 0, premium_type: 0,
    },
};

export type RpcServerState = 'off' | 'listening' | 'standby';

export interface RpcIpcServerOptions {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    /** Unix only: listen here instead of the env-derived directory (tests). */
    socketDir?: string;
    /** Extra directories to probe for another listener (tests). */
    extraProbeDirs?: string[];
    /** Unix only: where we record the identity of the socket file we create. */
    markerPath?: string | null;
    /** Called with the current presence (most recent live one) whenever it changes. */
    onPresence: (p: RpcPresence | null) => void;
    onState?: (s: RpcServerState) => void;
    log?: (line: string) => void;
    now?: () => number;
    maxConnections?: number;
    handshakeTimeoutMs?: number;
    idleTimeoutMs?: number;
    probeIntervalMs?: number;
    rateBurst?: number;
    rateRefillPerSec?: number;
}

interface Conn {
    id: number;
    socket: net.Socket;
    decoder: RpcFrameDecoder;
    clientId: string | null;
    presence: RpcPresence | null;
    tokens: number;
    refilledAt: number;
    overBudget: number;
    lastFrameAt: number;
    handshakeTimer: ReturnType<typeof setTimeout> | null;
    closed: boolean;
}

/** The directory Rich Presence clients search (Unix). */
export function unixSocketDir(env: Record<string, string | undefined>): string {
    const d = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
    return d.length > 1 ? d.replace(/\/+$/, '') : d;
}

/** Every Unix directory probed for ANOTHER listener (we only ever listen in the first). */
export function unixProbeDirs(env: Record<string, string | undefined>, extra: string[] = []): string[] {
    const dirs = [unixSocketDir(env)];
    const xdg = env.XDG_RUNTIME_DIR?.replace(/\/+$/, '');
    if (xdg) dirs.push(join(xdg, 'app', 'com.discordapp.Discord'), join(xdg, 'snap.discord'));
    if (!dirs.includes('/tmp')) dirs.push('/tmp');
    for (const e of extra) if (!dirs.includes(e)) dirs.push(e);
    return dirs;
}

export function slotPath(platform: NodeJS.Platform, dir: string, n: number): string {
    return platform === 'win32' ? `${PIPE_PREFIX}discord-ipc-${n}` : join(dir, `discord-ipc-${n}`);
}

/** Is something listening at this unix socket path? A connect that is closed at once. */
export function isUnixListenerLive(path: string, timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const s = net.createConnection({ path });
        const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(v); };
        const t = setTimeout(() => finish(false), timeoutMs);
        s.once('connect', () => finish(true));
        s.once('error', () => finish(false));
    });
}

interface SocketIdentity { path: string; dev: number; ino: number }

export class RpcIpcServer {
    private readonly o: Required<Omit<RpcIpcServerOptions, 'socketDir' | 'extraProbeDirs' | 'markerPath' | 'onState' | 'log'>>
        & Pick<RpcIpcServerOptions, 'socketDir' | 'extraProbeDirs' | 'markerPath' | 'onState' | 'log'>;
    private server: net.Server | null = null;
    private listenPath: string | null = null;
    private ownIdentity: SocketIdentity | null = null;
    private readonly conns = new Map<number, Conn>();
    private nextId = 1;
    private probeTimer: ReturnType<typeof setInterval> | null = null;
    private idleTimer: ReturnType<typeof setInterval> | null = null;
    private _state: RpcServerState = 'off';
    private running = false;
    private reconciling: Promise<void> | null = null;
    private lastEmitted: RpcPresence | null = null;
    private _foreign = false;

    constructor(opts: RpcIpcServerOptions) {
        this.o = {
            now: () => Date.now(),
            maxConnections: MAX_CONNECTIONS,
            handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
            idleTimeoutMs: IDLE_TIMEOUT_MS,
            probeIntervalMs: PROBE_INTERVAL_MS,
            rateBurst: RATE_BURST,
            rateRefillPerSec: RATE_REFILL_PER_SEC,
            ...opts,
        };
    }

    get state(): RpcServerState { return this._state; }
    /** Another Rich Presence server (e.g. Discord) was seen on the last probe. */
    get foreignListenerPresent(): boolean { return this._foreign; }
    get endpoint(): string | null { return this.listenPath; }
    get connectionCount(): number { return this.conns.size; }

    /** The most recently set live presence, or null. */
    current(): RpcPresence | null {
        let best: RpcPresence | null = null;
        for (const c of this.conns.values()) {
            if (c.presence && (!best || c.presence.at >= best.at)) best = c.presence;
        }
        return best;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        await this.reconcile();
        if (!this.running) return;
        this.probeTimer = setInterval(() => { void this.reconcile(); }, this.o.probeIntervalMs);
        this.idleTimer = setInterval(() => this.sweepIdle(), Math.min(5_000, this.o.idleTimeoutMs));
        this.probeTimer.unref?.();
        this.idleTimer.unref?.();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.probeTimer) clearInterval(this.probeTimer);
        if (this.idleTimer) clearInterval(this.idleTimer);
        this.probeTimer = null;
        this.idleTimer = null;
        if (this.reconciling) await this.reconciling.catch(() => undefined);
        await this.release();
        this._foreign = false;
        this.setState('off');
    }

    // ── Coexistence ─────────────────────────────────────────────────────────

    /** Probe, then claim / keep / yield. Serialised. */
    reconcile(): Promise<void> {
        if (!this.running) return Promise.resolve();
        if (this.reconciling) return this.reconciling;
        this.reconciling = this.reconcileOnce().finally(() => { this.reconciling = null; });
        return this.reconciling;
    }

    private async reconcileOnce(): Promise<void> {
        const foreign = await this.foreignListenerExists().catch(() => true); // unsure → don't fight
        this._foreign = foreign;
        if (!this.running) return;
        if (foreign) {
            if (this.server) this.log('another Rich Presence server appeared; yielding our endpoint');
            await this.release();
            this.setState('standby');
            return;
        }
        if (this.server) return;
        const ok = await this.claim();
        if (!this.running) { await this.release(); return; }
        this.setState(ok ? 'listening' : 'standby');
    }

    /** Any live listener in slots 0..9 (any probed location) that is not us? */
    async foreignListenerExists(): Promise<boolean> {
        if (this.o.platform === 'win32') {
            let names: string[];
            try { names = await fsp.readdir(PIPE_LIST_DIR); } catch { return false; }
            for (const name of names) {
                const m = SLOT_NAME_RE.exec(name);
                if (!m) continue;
                if (this.listenPath === `${PIPE_PREFIX}${name}`) continue;
                return true;
            }
            return false;
        }
        const dirs = this.o.socketDir
            ? [this.o.socketDir, ...(this.o.extraProbeDirs ?? [])]
            : unixProbeDirs(this.o.env, this.o.extraProbeDirs);
        for (const dir of dirs) {
            for (let n = 0; n < SLOT_COUNT; n++) {
                const p = join(dir, `discord-ipc-${n}`);
                if (p === this.listenPath) continue;
                let st;
                try { st = await fsp.stat(p); } catch { continue; }
                if (!st.isSocket()) continue;
                if (await isUnixListenerLive(p)) return true;
            }
        }
        return false;
    }

    private async readMarker(): Promise<SocketIdentity | null> {
        if (!this.o.markerPath) return null;
        try {
            const v = JSON.parse(await fsp.readFile(this.o.markerPath, 'utf8')) as Partial<SocketIdentity>;
            return typeof v.path === 'string' && typeof v.dev === 'number' && typeof v.ino === 'number'
                ? { path: v.path, dev: v.dev, ino: v.ino } : null;
        } catch { return null; }
    }

    private async writeMarker(id: SocketIdentity | null): Promise<void> {
        if (!this.o.markerPath) return;
        try {
            if (id) await fsp.writeFile(this.o.markerPath, JSON.stringify(id), { mode: 0o600 });
            else await fsp.rm(this.o.markerPath, { force: true });
        } catch { /* best-effort */ }
    }

    /** Claim the lowest usable slot. False = none (stay in standby). */
    private async claim(): Promise<boolean> {
        const dir = this.o.platform === 'win32' ? '' : (this.o.socketDir ?? unixSocketDir(this.o.env));
        const marker = this.o.platform === 'win32' ? null : await this.readMarker();
        for (let n = 0; n < SLOT_COUNT; n++) {
            const p = slotPath(this.o.platform, dir, n);
            if (this.o.platform !== 'win32') {
                let st;
                try { st = await fsp.lstat(p); } catch { st = null; }
                if (st) {
                    if (!st.isSocket()) continue; // someone's file — not ours to touch
                    if (await isUnixListenerLive(p)) return false; // raced: someone is here now
                    // Stale. Remove it only if it is the socket WE created.
                    if (marker && marker.path === p && marker.dev === st.dev && marker.ino === st.ino) {
                        try { await fsp.unlink(p); } catch { continue; }
                        this.log(`removed our own stale socket ${p}`);
                    } else {
                        continue; // a stale file we did not create: skip the slot
                    }
                }
            }
            const ok = await this.listenOn(p);
            if (ok === 'ok') return true;
            if (ok === 'in_use') return false; // someone took it between probe and bind
        }
        return false;
    }

    private listenOn(p: string): Promise<'ok' | 'in_use' | 'error'> {
        return new Promise((resolve) => {
            const server = net.createServer({ pauseOnConnect: false }, (s) => this.accept(s));
            server.maxConnections = this.o.maxConnections;
            const onError = (e: NodeJS.ErrnoException) => {
                server.close();
                resolve(e.code === 'EADDRINUSE' ? 'in_use' : 'error');
            };
            server.once('error', onError);
            server.listen({ path: p, readableAll: false, writableAll: false }, async () => {
                server.off('error', onError);
                server.on('error', (e) => this.log(`server error: ${(e as Error).message}`));
                this.server = server;
                this.listenPath = p;
                if (this.o.platform !== 'win32') {
                    try {
                        await fsp.chmod(p, 0o600);
                        const st = await fsp.lstat(p);
                        this.ownIdentity = { path: p, dev: st.dev, ino: st.ino };
                        await this.writeMarker(this.ownIdentity);
                    } catch { /* chmod/stat failed: still owner-created under umask */ }
                }
                this.log(`listening on ${p}`);
                resolve('ok');
            });
        });
    }

    /** Close our endpoint, drop every client, remove OUR socket file. */
    private async release(): Promise<void> {
        const server = this.server;
        const path = this.listenPath;
        const own = this.ownIdentity;
        this.server = null;
        this.listenPath = null;
        this.ownIdentity = null;
        for (const c of [...this.conns.values()]) this.closeConn(c, CLOSE_NORMAL, 'Rich Presence listener stopped');
        if (server) await new Promise<void>((r) => server.close(() => r()));
        if (path && own && this.o.platform !== 'win32') {
            // Only if the file at that path is still the one we created.
            try {
                const st = await fsp.lstat(path);
                if (st.dev === own.dev && st.ino === own.ino) await fsp.unlink(path);
            } catch { /* already gone */ }
            await this.writeMarker(null);
        }
        this.emitIfChanged();
    }

    // ── Connections ─────────────────────────────────────────────────────────

    private accept(socket: net.Socket): void {
        if (!this.server || this.conns.size >= this.o.maxConnections) { socket.destroy(); return; }
        const now = this.o.now();
        const c: Conn = {
            id: this.nextId++, socket, decoder: new RpcFrameDecoder(), clientId: null, presence: null,
            tokens: this.o.rateBurst, refilledAt: now, overBudget: 0, lastFrameAt: now, handshakeTimer: null, closed: false,
        };
        this.conns.set(c.id, c);
        c.handshakeTimer = setTimeout(() => { if (!c.clientId) this.closeConn(c, CLOSE_UNSUPPORTED, 'Handshake timeout'); }, this.o.handshakeTimeoutMs);
        c.handshakeTimer.unref?.();
        socket.on('data', (chunk: Buffer) => this.onData(c, chunk));
        socket.on('error', () => this.dropConn(c));
        socket.on('close', () => this.dropConn(c));
    }

    private onData(c: Conn, chunk: Buffer): void {
        if (c.closed) return;
        let frames;
        try {
            frames = c.decoder.push(chunk);
        } catch (e) {
            const msg = e instanceof RpcFrameError ? e.message : 'malformed frame';
            this.closeConn(c, CLOSE_UNSUPPORTED, msg);
            return;
        }
        for (const f of frames) {
            if (c.closed) return;
            if (!this.takeToken(c)) {
                c.overBudget++;
                if (c.overBudget === 1 && f.op === OP_FRAME) {
                    this.reply(c, f.data, 'ERROR', { code: ERR_RATE_LIMITED, message: 'Rate limited' });
                }
                if (c.overBudget >= RATE_DROP_AFTER) { this.closeConn(c, CLOSE_RATE_LIMITED, 'Rate limited'); return; }
                continue;
            }
            c.overBudget = 0;
            c.lastFrameAt = this.o.now();
            this.onFrame(c, f.op, f.data);
        }
    }

    private takeToken(c: Conn): boolean {
        const now = this.o.now();
        const add = ((now - c.refilledAt) / 1000) * this.o.rateRefillPerSec;
        if (add > 0) { c.tokens = Math.min(this.o.rateBurst, c.tokens + add); c.refilledAt = now; }
        if (c.tokens < 1) return false;
        c.tokens -= 1;
        return true;
    }

    private onFrame(c: Conn, op: number, data: Record<string, unknown> | null): void {
        switch (op) {
            case OP_PING: this.write(c, encodeFrame(OP_PONG, data)); return;
            case OP_PONG: return;
            case OP_CLOSE: this.dropConn(c); c.socket.destroy(); return;
            case OP_HANDSHAKE: this.onHandshake(c, data); return;
            case OP_FRAME:
                if (!c.clientId) { this.closeConn(c, CLOSE_UNSUPPORTED, 'Need to handshake first'); return; }
                this.onCommand(c, data);
                return;
        }
    }

    private onHandshake(c: Conn, data: Record<string, unknown> | null): void {
        if (c.clientId) { this.closeConn(c, CLOSE_UNSUPPORTED, 'Already handshaken'); return; }
        const v = data?.v;
        if (!(v === 1 || v === '1')) { this.closeConn(c, CLOSE_INVALID_VERSION, 'Invalid version'); return; }
        if (!isClientId(data?.client_id)) { this.closeConn(c, CLOSE_INVALID_CLIENT_ID, 'Invalid client ID'); return; }
        c.clientId = data!.client_id as string;
        if (c.handshakeTimer) { clearTimeout(c.handshakeTimer); c.handshakeTimer = null; }
        this.write(c, encodeFrame(OP_FRAME, { cmd: 'DISPATCH', evt: 'READY', data: READY_DATA, nonce: null }));
    }

    private onCommand(c: Conn, data: Record<string, unknown> | null): void {
        const cmd = typeof data?.cmd === 'string' ? data.cmd : null;
        if (!cmd) { this.reply(c, data, 'ERROR', { code: ERR_INVALID_PAYLOAD, message: 'Missing cmd' }); return; }
        const args = data?.args && typeof data.args === 'object' && !Array.isArray(data.args) ? data.args as Record<string, unknown> : {};
        if (cmd === 'SET_ACTIVITY') {
            const now = this.o.now();
            const res = sanitizeActivity(args.activity, now);
            if (!res.ok) { this.reply(c, data, 'ERROR', { code: ERR_INVALID_PAYLOAD, message: res.error }); return; }
            c.presence = res.activity ? { ...res.activity, clientId: c.clientId!, pid: pidOf(args.pid), at: now } : null;
            this.reply(c, data, null, res.activity ? {
                // Echo what we kept (no buttons/secrets); clients only check for success.
                application_id: c.clientId, type: 0, name: '',
                ...(res.activity.details ? { details: res.activity.details } : {}),
                ...(res.activity.state ? { state: res.activity.state } : {}),
            } : null);
            this.emitIfChanged();
            return;
        }
        if (cmd === 'SUBSCRIBE' || cmd === 'UNSUBSCRIBE') {
            // Acknowledged so clients registering join/spectate handlers stay
            // happy; those events are never dispatched (secrets are stripped).
            this.reply(c, data, null, { evt: typeof args.evt === 'string' ? args.evt : null });
            return;
        }
        this.reply(c, data, 'ERROR', { code: ERR_INVALID_COMMAND, message: `Unsupported command ${cmd.slice(0, 64)}` });
    }

    private reply(c: Conn, req: Record<string, unknown> | null, evt: string | null, data: unknown): void {
        const nonce = typeof req?.nonce === 'string' && req.nonce.length <= 128 ? req.nonce : null;
        const cmd = typeof req?.cmd === 'string' ? req.cmd.slice(0, 64) : null;
        this.write(c, encodeFrame(OP_FRAME, { cmd, evt, nonce, data }));
    }

    private write(c: Conn, buf: Buffer): void {
        if (c.closed || c.socket.destroyed) return;
        // A client that never reads must not grow our buffer without bound.
        if (c.socket.writableLength > 256 * 1024) { this.dropConn(c); c.socket.destroy(); return; }
        c.socket.write(buf);
    }

    private closeConn(c: Conn, code: number, message: string): void {
        if (c.closed) return;
        try { if (!c.socket.destroyed) c.socket.end(encodeFrame(OP_CLOSE, { code, message })); } catch { /* ignore */ }
        this.dropConn(c);
        const s = c.socket;
        setTimeout(() => s.destroy(), 200).unref?.();
    }

    private dropConn(c: Conn): void {
        if (c.closed) return;
        c.closed = true;
        if (c.handshakeTimer) clearTimeout(c.handshakeTimer);
        this.conns.delete(c.id);
        const had = !!c.presence;
        c.presence = null;
        if (had) this.emitIfChanged();
    }

    private sweepIdle(): void {
        const now = this.o.now();
        for (const c of [...this.conns.values()]) {
            // A connection holding an activity is legitimately quiet for hours.
            if (!c.presence && now - c.lastFrameAt > this.o.idleTimeoutMs) this.closeConn(c, CLOSE_NORMAL, 'Idle');
        }
    }

    private emitIfChanged(): void {
        const cur = this.current();
        if (cur === this.lastEmitted) return;
        this.lastEmitted = cur;
        try { this.o.onPresence(cur); } catch (e) { this.log(`onPresence threw: ${(e as Error).message}`); }
    }

    private setState(s: RpcServerState): void {
        if (s === this._state) return;
        this._state = s;
        try { this.o.onState?.(s); } catch { /* ignore */ }
    }

    private log(line: string): void {
        this.o.log?.(`[RichPresence] ${line}`);
    }
}
