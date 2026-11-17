// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { mkdtempSync, rmSync, existsSync, writeFileSync, lstatSync } from 'fs';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RpcIpcServer, unixSocketDir, unixProbeDirs, isUnixListenerLive, type RpcServerState } from './rpc-ipc-server';
import { RpcFrameDecoder, encodeFrame, OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG, MAX_FRAME_BYTES, type RpcFrame } from './rpc-frame';
import type { RpcPresence } from './rpc-activity';

const R6_ID = '356876590342340608';

/** A minimal Rich Presence CLIENT over a real unix socket. */
class Client {
    readonly frames: RpcFrame[] = [];
    private readonly dec = new RpcFrameDecoder();
    private waiters: Array<() => void> = [];
    ended = false;
    readonly closed: Promise<void>;
    private constructor(readonly sock: net.Socket) {
        sock.on('data', (c: Buffer) => { try { this.frames.push(...this.dec.push(c)); } catch { /* ignore */ } this.wake(); });
        this.closed = new Promise((r) => sock.once('close', () => { this.ended = true; this.wake(); r(); }));
        sock.on('error', () => undefined);
    }
    static connect(path: string): Promise<Client> {
        return new Promise((resolve, reject) => {
            const s = net.createConnection({ path });
            s.once('connect', () => resolve(new Client(s)));
            s.once('error', reject);
        });
    }
    private wake() { const w = this.waiters; this.waiters = []; w.forEach(f => f()); }
    send(op: number, data: unknown) { this.sock.write(encodeFrame(op as 0, data)); }
    async next(pred: (f: RpcFrame) => boolean = () => true, timeoutMs = 3000): Promise<RpcFrame> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const i = this.frames.findIndex(pred);
            if (i >= 0) return this.frames.splice(i, 1)[0];
            if (this.ended) throw new Error('connection closed');
            if (Date.now() > deadline) throw new Error('timeout waiting for frame');
            await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
        }
    }
    async handshake(clientId = R6_ID) {
        this.send(OP_HANDSHAKE, { v: 1, client_id: clientId });
        return this.next(f => f.op === OP_FRAME && f.data?.evt === 'READY');
    }
    async command(cmd: string, args: unknown, nonce = `n-${Math.random()}`) {
        this.send(OP_FRAME, { cmd, args, nonce });
        return this.next(f => f.data?.nonce === nonce);
    }
    end() { this.sock.destroy(); }
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('waitFor timeout');
        await new Promise(r => setTimeout(r, 20));
    }
};

/** Another process's Rich Presence server (e.g. Discord) at a path. */
function foreignListener(path: string): Promise<net.Server> {
    return new Promise((resolve) => {
        const s = net.createServer((c) => c.on('error', () => undefined));
        s.listen(path, () => resolve(s));
    });
}

let dir: string;
const servers: RpcIpcServer[] = [];
const others: net.Server[] = [];
let presences: Array<RpcPresence | null>;
let states: RpcServerState[];

function make(opts: Partial<ConstructorParameters<typeof RpcIpcServer>[0]> = {}) {
    const s = new RpcIpcServer({
        platform: 'linux',
        env: {},
        socketDir: dir,
        markerPath: join(dir, 'marker.json'),
        onPresence: (p) => presences.push(p),
        onState: (st) => states.push(st),
        probeIntervalMs: 60_000,
        ...opts,
    });
    servers.push(s);
    return s;
}
const slot = (n: number) => join(dir, `discord-ipc-${n}`);

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clrpc-'));
    presences = [];
    states = [];
});
afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    for (const o of others.splice(0)) await new Promise<void>(r => o.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
});

describe('paths clients search', () => {
    it('XDG_RUNTIME_DIR, then TMPDIR, TMP, TEMP, then /tmp', () => {
        expect(unixSocketDir({ XDG_RUNTIME_DIR: '/run/user/1000/', TMPDIR: '/x' })).toBe('/run/user/1000');
        expect(unixSocketDir({ TMPDIR: '/var/folders/ab/T/' })).toBe('/var/folders/ab/T');
        expect(unixSocketDir({ TMP: '/t1', TEMP: '/t2' })).toBe('/t1');
        expect(unixSocketDir({ TEMP: '/t2' })).toBe('/t2');
        expect(unixSocketDir({})).toBe('/tmp');
    });
    it('probes the Flatpak / Snap Discord locations too (but never listens there)', () => {
        expect(unixProbeDirs({ XDG_RUNTIME_DIR: '/run/user/1000' })).toEqual([
            '/run/user/1000', '/run/user/1000/app/com.discordapp.Discord', '/run/user/1000/snap.discord', '/tmp',
        ]);
    });
});

describe('handshake → READY → SET_ACTIVITY → clear, over a real socket', () => {
    it('full flow', async () => {
        const s = make();
        await s.start();
        expect(s.state).toBe('listening');
        expect(s.endpoint).toBe(slot(0));
        expect(lstatSync(slot(0)).mode & 0o777).toBe(0o600);

        const c = await Client.connect(slot(0));
        const ready = await c.handshake();
        expect(ready.data).toMatchObject({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'cipherline' } } });

        const res = await c.command('SET_ACTIVITY', {
            pid: process.pid,
            activity: {
                details: 'Ranked • Round 3', state: 'Score 2 – 1', timestamps: { start: Date.now() - 754_000 },
                party: { id: 'p', size: [2, 5] }, secrets: { join: 'SECRET' }, buttons: [{ label: 'x', url: 'https://x.example' }],
            },
        }, 'nonce-1');
        expect(res.data).toMatchObject({ cmd: 'SET_ACTIVITY', evt: null, nonce: 'nonce-1', data: { application_id: R6_ID, details: 'Ranked • Round 3' } });
        expect(JSON.stringify(res.data)).not.toContain('SECRET');
        await waitFor(() => presences.length === 1);
        expect(presences[0]).toMatchObject({ clientId: R6_ID, pid: process.pid, details: 'Ranked • Round 3', state: 'Score 2 – 1', party: { size: 2, max: 5 } });
        expect(JSON.stringify(presences[0])).not.toMatch(/SECRET|x\.example/);
        expect(s.current()).toMatchObject({ details: 'Ranked • Round 3' });

        // Clear with null.
        const cleared = await c.command('SET_ACTIVITY', { pid: process.pid, activity: null }, 'nonce-2');
        expect(cleared.data).toMatchObject({ nonce: 'nonce-2', evt: null, data: null });
        await waitFor(() => presences.length === 2);
        expect(presences[1]).toBeNull();
        c.end();
    });

    it('disconnect clears the activity', async () => {
        const s = make();
        await s.start();
        const c = await Client.connect(slot(0));
        await c.handshake();
        await c.command('SET_ACTIVITY', { activity: { details: 'In menus' } });
        await waitFor(() => presences.length === 1);
        c.end();
        await waitFor(() => presences.length === 2);
        expect(presences[1]).toBeNull();
        expect(s.current()).toBeNull();
    });

    it('PING → PONG with the same data', async () => {
        make();
        await servers[0].start();
        const c = await Client.connect(slot(0));
        c.send(OP_PING, { t: 7 });
        expect(await c.next(f => f.op === OP_PONG)).toEqual({ op: OP_PONG, data: { t: 7 } });
        c.end();
    });

    it('other commands get a polite ERROR; SUBSCRIBE is acknowledged; nothing is set', async () => {
        make();
        await servers[0].start();
        const c = await Client.connect(slot(0));
        await c.handshake();
        const auth = await c.command('AUTHORIZE', { scopes: ['rpc'] }, 'a1');
        expect(auth.data).toMatchObject({ cmd: 'AUTHORIZE', evt: 'ERROR', nonce: 'a1', data: { code: 4002 } });
        const sub = await c.command('SUBSCRIBE', { evt: 'ACTIVITY_JOIN' }, 's1');
        expect(sub.data).toMatchObject({ cmd: 'SUBSCRIBE', evt: null, nonce: 's1', data: { evt: 'ACTIVITY_JOIN' } });
        const bad = await c.command('SET_ACTIVITY', { activity: { details: 'x'.repeat(129) } }, 'b1');
        expect(bad.data).toMatchObject({ evt: 'ERROR', nonce: 'b1', data: { code: 4000 } });
        expect(presences).toEqual([]);
        c.end();
    });

    it.each([
        ['bad version', { v: 2, client_id: R6_ID }, 4004],
        ['missing client id', { v: 1 }, 4000],
        ['non-snowflake client id', { v: 1, client_id: '../../etc' }, 4000],
    ])('handshake with %s → CLOSE and disconnect', async (_n, body, code) => {
        make();
        await servers[0].start();
        const c = await Client.connect(slot(0));
        c.send(OP_HANDSHAKE, body);
        const close = await c.next(f => f.op === OP_CLOSE);
        expect(close.data).toMatchObject({ code });
        await c.closed;
    });

    it('a FRAME before the handshake closes the connection', async () => {
        make();
        await servers[0].start();
        const c = await Client.connect(slot(0));
        c.send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { activity: { details: 'x' } }, nonce: '1' });
        await c.closed;
        expect(presences).toEqual([]);
    });
});

describe('hardening', () => {
    it('an oversize frame header drops the connection (the body is never awaited)', async () => {
        make();
        await servers[0].start();
        const c = await Client.connect(slot(0));
        await c.handshake();
        const h = Buffer.alloc(8);
        h.writeUInt32LE(OP_FRAME, 0);
        h.writeUInt32LE(MAX_FRAME_BYTES + 1, 4);
        c.sock.write(h);
        await c.closed;
        expect(servers[0].connectionCount).toBe(0);
    });

    it('bad JSON / bad opcode drop the connection', async () => {
        make();
        await servers[0].start();
        const c1 = await Client.connect(slot(0));
        const h = Buffer.alloc(8); h.writeUInt32LE(OP_FRAME, 0); h.writeUInt32LE(5, 4);
        c1.sock.write(Buffer.concat([h, Buffer.from('{nope')]));
        await c1.closed;
        const c2 = await Client.connect(slot(0));
        const h2 = Buffer.alloc(8); h2.writeUInt32LE(42, 0); h2.writeUInt32LE(2, 4);
        c2.sock.write(Buffer.concat([h2, Buffer.from('{}')]));
        await c2.closed;
    });

    it('rate limit: a burst beyond the bucket gets one RATE_LIMITED error, then a flood is disconnected', async () => {
        make({ rateBurst: 5, rateRefillPerSec: 0.0001 });
        await servers[0].start();
        const c = await Client.connect(slot(0));
        await c.handshake(); // 1 token
        for (let i = 0; i < 4; i++) await c.command('SET_ACTIVITY', { activity: { details: `r${i}` } }, `ok${i}`); // 4 more
        c.send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { activity: { details: 'over' } }, nonce: 'over' });
        const limited = await c.next(f => f.data?.nonce === 'over');
        expect(limited.data).toMatchObject({ evt: 'ERROR', data: { code: 5011 } });
        expect(servers[0].current()?.details).toBe('r3'); // the over-budget frame was NOT applied
        for (let i = 0; i < 40; i++) c.send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { activity: { details: 'flood' } }, nonce: `f${i}` });
        const close = await c.next(f => f.op === OP_CLOSE);
        expect(close.data).toMatchObject({ code: 4002 });
        await c.closed;
    });

    it('positive control: the same traffic under the budget is all applied', async () => {
        make({ rateBurst: 50, rateRefillPerSec: 0.0001 });
        await servers[0].start();
        const c = await Client.connect(slot(0));
        await c.handshake();
        for (let i = 0; i < 20; i++) await c.command('SET_ACTIVITY', { activity: { details: `r${i}` } }, `ok${i}`);
        expect(servers[0].current()?.details).toBe('r19');
        c.end();
    });

    it('connection cap: the (cap+1)th connection is refused', async () => {
        make({ maxConnections: 3 });
        await servers[0].start();
        const cs = await Promise.all([0, 1, 2].map(() => Client.connect(slot(0))));
        await waitFor(() => servers[0].connectionCount === 3);
        const extra = await Client.connect(slot(0));
        await extra.closed;
        expect(servers[0].connectionCount).toBe(3);
        cs.forEach(c => c.end());
    });

    it('a connection that never handshakes is closed; an idle one without activity is closed; one holding an activity stays', async () => {
        make({ handshakeTimeoutMs: 150, idleTimeoutMs: 300 });
        await servers[0].start();
        const silent = await Client.connect(slot(0));
        await silent.closed;
        const idle = await Client.connect(slot(0));
        await idle.handshake();
        const holder = await Client.connect(slot(0));
        await holder.handshake();
        await holder.command('SET_ACTIVITY', { activity: { details: 'long match' } });
        await idle.closed;
        expect(holder.ended).toBe(false);
        expect(servers[0].current()?.details).toBe('long match');
        holder.end();
    });
});

describe('coexistence — never break the user’s real Discord', () => {
    it('another server already on discord-ipc-0 → we take NO slot (standby), and its socket is untouched', async () => {
        const discord = await foreignListener(slot(0));
        others.push(discord);
        const before = lstatSync(slot(0)).ino;
        const s = make();
        await s.start();
        expect(s.state).toBe('standby');
        expect(s.endpoint).toBeNull();
        expect(s.foreignListenerPresent).toBe(true);
        expect(existsSync(slot(1))).toBe(false);          // did not claim the next slot either
        expect(lstatSync(slot(0)).ino).toBe(before);      // never replaced
        expect(await isUnixListenerLive(slot(0))).toBe(true);
        await s.stop();
        expect(await isUnixListenerLive(slot(0))).toBe(true); // stop() did not touch it either
    });

    it('another server on a HIGHER slot (e.g. discord-ipc-3) also means standby', async () => {
        others.push(await foreignListener(slot(3)));
        const s = make();
        await s.start();
        expect(s.state).toBe('standby');
        expect(existsSync(slot(0))).toBe(false);
    });

    it('positive control: with nothing else there we listen on slot 0', async () => {
        const s = make();
        await s.start();
        expect(s.state).toBe('listening');
        expect(await isUnixListenerLive(slot(0))).toBe(true);
    });

    it('Discord starting AFTER us (binds slot 1) → we yield slot 0 and drop our clients', async () => {
        const s = make();
        await s.start();
        const c = await Client.connect(slot(0));
        await c.handshake();
        await c.command('SET_ACTIVITY', { activity: { details: 'x' } });
        others.push(await foreignListener(slot(1)));
        await s.reconcile();
        expect(s.state).toBe('standby');
        expect(existsSync(slot(0))).toBe(false);            // our socket removed → clients fall through to Discord
        await c.closed;
        expect(presences.at(-1)).toBeNull();
        // Discord quits → we take over again.
        await new Promise<void>(r => others.pop()!.close(() => r()));
        await s.reconcile();
        expect(s.state).toBe('listening');
    });

    it('a stale foreign socket file on slot 0 is skipped (not deleted) and we take slot 1', async () => {
        const stale = join(dir, 'stale-src');
        const srv = net.createServer();
        await new Promise<void>(r => srv.listen(stale, () => r()));
        await fsp.link(stale, slot(0));                         // a second name for the same socket inode
        await new Promise<void>(r => srv.close(() => r()));     // listener gone; slot(0) is now a stale socket file
        expect(lstatSync(slot(0)).isSocket()).toBe(true);
        expect(await isUnixListenerLive(slot(0))).toBe(false);
        const ino = lstatSync(slot(0)).ino;
        const s = make();
        await s.start();
        expect(s.endpoint).toBe(slot(1));
        expect(lstatSync(slot(0)).ino).toBe(ino);               // untouched
    });

    it('our OWN stale socket file (marker matches) is removed and slot 0 reclaimed', async () => {
        const stale = join(dir, 'stale-own');
        const srv = net.createServer();
        await new Promise<void>(r => srv.listen(stale, () => r()));
        await fsp.link(stale, slot(0));
        await new Promise<void>(r => srv.close(() => r()));
        const st = lstatSync(slot(0));
        writeFileSync(join(dir, 'marker.json'), JSON.stringify({ path: slot(0), dev: st.dev, ino: st.ino }));
        const s = make();
        await s.start();
        // Listening on slot 0 at all proves the stale file was removed (bind on an existing path fails).
        expect(s.endpoint).toBe(slot(0));
        expect(await isUnixListenerLive(slot(0))).toBe(true);
    });

    it('stop() removes our socket and marker, and nothing else', async () => {
        const s = make();
        await s.start();
        expect(existsSync(slot(0))).toBe(true);
        expect(existsSync(join(dir, 'marker.json'))).toBe(true);
        await s.stop();
        expect(existsSync(slot(0))).toBe(false);
        expect(existsSync(join(dir, 'marker.json'))).toBe(false);
        expect(states).toEqual(['listening', 'off']);
    });
});
