import { describe, it, expect } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isExpectedLoopbackHost, handOffToRunningInstance, handoffResponseBody } from './instance-handoff';

describe('isExpectedLoopbackHost (DNS-rebinding guard on the local app server)', () => {
    it('accepts exactly 127.0.0.1:<port>', () => {
        expect(isExpectedLoopbackHost('127.0.0.1:42917', 42917)).toBe(true);
    });

    it.each([
        ['a rebinding attacker hostname', 'attacker.example:42917'],
        ['localhost (not the origin the app loads)', 'localhost:42917'],
        ['the wrong port', '127.0.0.1:42918'],
        ['no port', '127.0.0.1'],
        ['IPv6 loopback', '[::1]:42917'],
        ['a suffix trick', '127.0.0.1:42917.attacker.example'],
        ['empty', ''],
    ])('refuses %s', (_name, host) => {
        expect(isExpectedLoopbackHost(host, 42917)).toBe(false);
    });

    it('refuses a missing / non-string Host', () => {
        expect(isExpectedLoopbackHost(undefined, 42917)).toBe(false);
        expect(isExpectedLoopbackHost(['127.0.0.1:42917'], 42917)).toBe(false);
    });

    it('our own second-instance handoff still passes the guard (real request, real Host header)', async () => {
        let seenHost: string | undefined;
        const server = http.createServer((req, res) => {
            seenHost = req.headers.host;
            const port = (server.address() as AddressInfo).port;
            if (!isExpectedLoopbackHost(req.headers.host, port)) { res.writeHead(421); res.end(); return; }
            req.resume();
            req.on('end', () => { res.writeHead(200); res.end(handoffResponseBody()); });
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as AddressInfo).port;
        try {
            await expect(handOffToRunningInstance(port, null)).resolves.toBe(true);
            expect(seenHost).toBe(`127.0.0.1:${port}`);
        } finally {
            await new Promise<void>(r => server.close(() => r()));
        }
    });

    it('main.ts checks the Host header before serving anything', () => {
        const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
        const start = main.indexOf('const prodServer = http.createServer(');
        expect(start).toBeGreaterThan(-1);
        const body = main.slice(start, start + 3000);
        const guard = body.indexOf('isExpectedLoopbackHost(req.headers.host, CIPHERLINE_PROD_PORT)');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(body.indexOf('FOCUS_ENDPOINT'));
    });
});
