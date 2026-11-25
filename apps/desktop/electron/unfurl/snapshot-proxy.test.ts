/**
 * The snapshot window's proxy (snapshot-proxy.ts), with real sockets: a
 * tunnel to an allowed target works; private / loopback / link-local targets,
 * `localhost`, plain http, other ports and malformed targets are refused with
 * the REAL guard (net-guard.ts); the byte cap cuts every tunnel; close() ends
 * everything. POSITIVE CONTROL: the same upstream IS reachable through a
 * resolver that allows it, so the refusals are the guard's doing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import * as http from 'http';
import { parseConnectTarget, startSnapshotProxy, type SnapshotProxy } from './snapshot-proxy';

let upstream: net.Server | null = null;
let proxy: SnapshotProxy | null = null;
afterEach(async () => {
    await proxy?.close();
    proxy = null;
    await new Promise<void>((ok) => (upstream ? upstream.close(() => ok()) : ok()));
    upstream = null;
});

/** A TCP echo server on 127.0.0.1 (stands in for a site's :443). */
async function echoServer(): Promise<number> {
    upstream = net.createServer((s) => { s.on('data', (d) => s.write(d)); s.on('error', () => {}); });
    await new Promise<void>((ok) => upstream!.listen(0, '127.0.0.1', () => ok()));
    return (upstream.address() as net.AddressInfo).port;
}

/** CONNECT through the proxy; resolves with the status line and an open socket (or ended). */
function connect(port: number, target: string): Promise<{ status: string; sock: net.Socket }> {
    return new Promise((ok, fail) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let buf = '';
        const onData = (d: Buffer) => {
            buf += d.toString('latin1');
            const i = buf.indexOf('\r\n\r\n');
            if (i !== -1) { sock.off('data', onData); ok({ status: buf.slice(0, buf.indexOf('\r\n')), sock }); }
        };
        sock.on('data', onData);
        sock.on('error', fail);
        sock.on('close', () => ok({ status: buf.split('\r\n')[0] || '(closed)', sock }));
    });
}
const echo = (sock: net.Socket, msg: string) => new Promise<string>((ok) => {
    let got = '';
    sock.on('data', (d) => { got += d.toString(); if (got.length >= msg.length) ok(got); });
    sock.on('close', () => ok(got));
    sock.write(msg);
});

describe('snapshot proxy', () => {
    it('POSITIVE CONTROL: a tunnel to an allowed (resolver-approved) target carries bytes both ways', async () => {
        const port = await echoServer();
        proxy = await startSnapshotProxy({ maxBytes: 1_000_000, ports: [port], resolve: async (h) => { if (h !== 'public.test') throw new Error('nope'); return { ip: '127.0.0.1' }; } });
        const { status, sock } = await connect(proxy.port, `public.test:${port}`);
        expect(status).toBe('HTTP/1.1 200 Connection Established');
        expect(await echo(sock, 'hello')).toBe('hello');
        expect(proxy.stats()).toMatchObject({ tunnels: 1, refused: 0 });
        sock.destroy();
    });

    it('the REAL guard refuses loopback, private, link-local, CGNAT and local names (even on an allowed port)', async () => {
        const port = await echoServer();
        proxy = await startSnapshotProxy({ maxBytes: 1_000_000, ports: [port] });
        for (const t of [`127.0.0.1:${port}`, `localhost:${port}`, `192.168.1.10:${port}`, `10.0.0.5:${port}`, `169.254.169.254:${port}`, `100.64.0.1:${port}`, `[::1]:${port}`, `printer.local:${port}`]) {
            const { status, sock } = await connect(proxy.port, t);
            expect([t, status]).toEqual([t, 'HTTP/1.1 403 Forbidden']);
            sock.destroy();
        }
        expect(proxy.stats().tunnels).toBe(0);
        expect(proxy.stats().refused).toBe(8);
    });

    it('only port 443 by default; plain-http proxying and websocket upgrades are refused', async () => {
        proxy = await startSnapshotProxy({ maxBytes: 1_000_000, resolve: async () => ({ ip: '127.0.0.1' }) });
        const { status, sock } = await connect(proxy.port, 'public.test:22');
        expect(status).toBe('HTTP/1.1 403 Forbidden');
        sock.destroy();
        const code = await new Promise<number>((ok) => {
            http.get({ host: '127.0.0.1', port: proxy!.port, path: 'http://public.test/', headers: { Host: 'public.test' } }, (res) => { res.resume(); ok(res.statusCode ?? 0); }).on('error', () => ok(-1));
        });
        expect(code).toBe(403);
    });

    it('the byte cap cuts every tunnel and refuses new ones', async () => {
        const port = await echoServer();
        proxy = await startSnapshotProxy({ maxBytes: 64, ports: [port], resolve: async () => ({ ip: '127.0.0.1' }) });
        const { sock } = await connect(proxy.port, `public.test:${port}`);
        const closed = new Promise<void>((ok) => sock.on('close', () => ok()));
        sock.write('x'.repeat(200));
        await closed;
        expect(proxy.stats().overCap).toBe(true);
        const again = await connect(proxy.port, `public.test:${port}`);
        expect(again.status).toBe('HTTP/1.1 403 Forbidden');
        again.sock.destroy();
    });

    it('close() ends open tunnels', async () => {
        const port = await echoServer();
        proxy = await startSnapshotProxy({ maxBytes: 1_000_000, ports: [port], resolve: async () => ({ ip: '127.0.0.1' }) });
        const { sock } = await connect(proxy.port, `public.test:${port}`);
        const closed = new Promise<void>((ok) => sock.on('close', () => ok()));
        await proxy.close();
        proxy = null;
        await closed;
    });

    it('parseConnectTarget', () => {
        expect(parseConnectTarget('example.com:443')).toEqual({ host: 'example.com', port: 443 });
        expect(parseConnectTarget('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 });
        expect(parseConnectTarget('example.com')).toBeNull();
        expect(parseConnectTarget('exa mple.com:443')).toBeNull();
        expect(parseConnectTarget('example.com:99999')).toBeNull();
        expect(parseConnectTarget(undefined)).toBeNull();
    });
});
