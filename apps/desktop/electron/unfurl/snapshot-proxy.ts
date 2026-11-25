/**
 * The page-snapshot window's only way out to the network (main process).
 *
 * The hidden snapshot window (page-snapshot.ts) runs a web page with its
 * scripts on, so EVERY request it makes, the page's own and its scripts', is
 * forced through this small loopback proxy (the window's session has
 * `proxyRules` = this proxy and `proxyBypassRules: '<-loopback>'`, which also
 * routes loopback names through it instead of around it). Here, for each
 * connection:
 *
 *   - only HTTPS / WSS tunnels (HTTP CONNECT) to port 443; a plain-http
 *     request or any other port is refused (403);
 *   - the host is resolved and EVERY address checked by the same guard as
 *     the unfurler and clmedia:// (net-guard.ts: private, loopback,
 *     link-local, CGNAT, ULA, multicast, `localhost`, `.local`), then the
 *     tunnel is opened to THAT checked address. Chromium never resolves the
 *     name itself, so a DNS rebind cannot slip a private address in between
 *     the check and the connection;
 *   - a cap on the bytes of all tunnels together; past it every tunnel is
 *     cut and new ones refused (the page stops loading; what has drawn is
 *     still captured).
 *
 * The proxy lives only for one snapshot (a few seconds) on 127.0.0.1 and an
 * OS-chosen port, and is closed with all its sockets afterwards.
 *
 * No `electron` import: unit-tested with real sockets and a fake resolver
 * (snapshot-proxy.test.ts).
 */
import * as http from 'http';
import * as net from 'net';
import { assertPublicHttpUrl } from '../net-guard';

export interface SnapshotProxyOptions {
    /** Resolve + check a host; must throw for a non-public target. Returns the address to connect to. */
    resolve?: (hostname: string) => Promise<{ ip: string }>;
    /** All tunnels together, both directions. */
    maxBytes: number;
    /** Ports a tunnel may go to (default: 443 only). */
    ports?: readonly number[];
    connectTimeoutMs?: number;
    /** Test seam / dev log. */
    log?: (line: string) => void;
}

export interface SnapshotProxyStats { tunnels: number; refused: number; bytes: number; overCap: boolean }

export interface SnapshotProxy {
    port: number;
    stats(): SnapshotProxyStats;
    close(): Promise<void>;
}

const defaultResolve = async (hostname: string) => assertPublicHttpUrl(`https://${hostname.includes(':') ? `[${hostname}]` : hostname}/`);

/** `host:port` of a CONNECT line (IPv6 in brackets), or null. */
export function parseConnectTarget(raw: string | undefined): { host: string; port: number } | null {
    if (!raw || raw.length > 300) return null;
    const m = /^\[([0-9a-fA-F:.%]+)\]:(\d{1,5})$/.exec(raw) ?? /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(raw);
    if (!m) return null;
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: m[1].toLowerCase(), port };
}

export async function startSnapshotProxy(opts: SnapshotProxyOptions): Promise<SnapshotProxy> {
    const resolve = opts.resolve ?? defaultResolve;
    const ports = new Set(opts.ports ?? [443]);
    const sockets = new Set<net.Socket>();
    const stats: SnapshotProxyStats = { tunnels: 0, refused: 0, bytes: 0, overCap: false };
    let closed = false;

    const cutAll = () => { for (const s of sockets) s.destroy(); sockets.clear(); };
    const count = (n: number) => {
        stats.bytes += n;
        if (stats.bytes > opts.maxBytes && !stats.overCap) {
            stats.overCap = true;
            opts.log?.(`[snapshot-proxy] byte cap reached (${stats.bytes})`);
            cutAll();
        }
    };
    const track = (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => s.destroy()); };

    const server = http.createServer((_req, res) => {
        // A plain-http request (absolute URI to the proxy): never forwarded.
        stats.refused++;
        res.writeHead(403, { Connection: 'close' });
        res.end();
    });
    server.on('upgrade', (_req, socket: net.Socket) => { stats.refused++; socket.destroy(); });
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
        track(client);
        const refuse = (why: string) => {
            stats.refused++;
            opts.log?.(`[snapshot-proxy] refused ${req.url ?? ''}: ${why}`);
            if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        };
        const target = parseConnectTarget(req.url);
        if (closed || stats.overCap) { refuse('closed'); return; }
        if (!target) { refuse('bad target'); return; }
        if (!ports.has(target.port)) { refuse('port'); return; }
        client.pause();
        resolve(target.host).then(({ ip }) => {
            if (closed || stats.overCap || client.destroyed) { client.destroy(); return; }
            const upstream = net.connect({ host: ip, port: target.port });
            track(upstream);
            const timer = setTimeout(() => upstream.destroy(), opts.connectTimeoutMs ?? 4000);
            upstream.once('connect', () => {
                clearTimeout(timer);
                if (closed || stats.overCap) { upstream.destroy(); client.destroy(); return; }
                stats.tunnels++;
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head?.length) { count(head.length); upstream.write(head); }
                client.on('data', (c: Buffer) => { count(c.length); if (!upstream.destroyed) upstream.write(c); });
                upstream.on('data', (c: Buffer) => { count(c.length); if (!client.destroyed) client.write(c); });
                client.resume();
            });
            upstream.on('close', () => { clearTimeout(timer); client.destroy(); });
            client.on('close', () => upstream.destroy());
        }, (e: unknown) => refuse(e instanceof Error ? e.message : 'refused'));
    });

    await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => { server.off('error', fail); ok(); });
    });
    const port = (server.address() as net.AddressInfo).port;
    // Keep-alive connections from the window must not hold close() open.
    server.on('connection', (s: net.Socket) => track(s));

    return {
        port,
        stats: () => ({ ...stats }),
        close: () => new Promise<void>((ok) => {
            closed = true;
            cutAll();
            server.close(() => ok());
            // server.close waits for nothing now that every socket is gone.
            setTimeout(ok, 500).unref?.();
        }),
    };
}
