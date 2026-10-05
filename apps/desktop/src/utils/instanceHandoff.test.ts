import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import {
    handOffToRunningInstance,
    isTrustedHandoffRequest,
    encodeHandoffBody,
    decodeHandoffBody,
    handoffResponseBody,
    FOCUS_ENDPOINT,
} from '../../electron/instance-handoff';

/**
 * These drive the REAL functions main.ts ships against REAL loopback servers,
 * because the failure they exist to prevent is a dialog in the user's face:
 * a second launch must hand off silently to the running copy, and must NOT
 * mistake some other program's server for Cipherline and vanish — that would
 * turn "wrong error box" into "app won't open and says nothing".
 */

const servers: http.Server[] = [];
afterEach(() => { servers.forEach((s) => s.close()); servers.length = 0; });

/** Start a server on an ephemeral port; resolves its port. */
function listen(handler: http.RequestListener): Promise<number> {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        servers.push(s);
        s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port));
    });
}

/** A stand-in for the running Cipherline: the same guard and the same reply
 *  main.ts uses, so this test breaks if either side drifts. */
function cipherlineLike(onDeepLink?: (url: string | null) => void): http.RequestListener {
    return (req, res) => {
        if (req.url?.split('?')[0] !== FOCUS_ENDPOINT) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html>index.html');  // the SPA fallback
            return;
        }
        if (!isTrustedHandoffRequest(req.method, req.headers as Record<string, unknown>)) {
            res.writeHead(403); res.end(); return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            onDeepLink?.(decodeHandoffBody(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(handoffResponseBody());
        });
    };
}

describe('second-instance handoff', () => {
    it('hands off to a running Cipherline', async () => {
        const port = await listen(cipherlineLike());
        expect(await handOffToRunningInstance(port, null)).toBe(true);
    });

    it('carries the deep link across', async () => {
        let received: string | null | undefined;
        const port = await listen(cipherlineLike((u) => { received = u; }));
        await handOffToRunningInstance(port, 'cipherline://invite/ABC123');
        expect(received).toBe('cipherline://invite/ABC123');
    });

    it('is a no-op payload when there is no deep link', async () => {
        let received: string | null | undefined = 'unset';
        const port = await listen(cipherlineLike((u) => { received = u; }));
        await handOffToRunningInstance(port, null);
        expect(received).toBeNull();
    });

    describe('refuses to hand off to something that is not us', () => {
        // Each of these must be false, or the second instance exits silently and
        // the user is left with an app that simply never opens.
        it('a foreign server answering 200 on every path', async () => {
            const port = await listen((_req, res) => { res.writeHead(200); res.end('OK'); });
            expect(await handOffToRunningInstance(port, null)).toBe(false);
        });

        it("an old Cipherline whose SPA fallback answers with index.html", async () => {
            const port = await listen((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!doctype html>index.html');
            });
            expect(await handOffToRunningInstance(port, null)).toBe(false);
        });

        it('a server returning JSON without our signature', async () => {
            const port = await listen((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, app: 'something-else' }));
            });
            expect(await handOffToRunningInstance(port, null)).toBe(false);
        });

        it('nothing listening at all', async () => {
            const port = await listen((_req, res) => { res.end(); });
            servers[0].close();                       // free the port
            await new Promise((r) => setTimeout(r, 50));
            expect(await handOffToRunningInstance(port, null, 500)).toBe(false);
        });

        it('a server that accepts the socket then never replies', async () => {
            const port = await listen(() => { /* deliberately silent */ });
            expect(await handOffToRunningInstance(port, null, 300)).toBe(false);
        });
    });

    describe('request guard', () => {
        const hdrs = (o: Record<string, unknown> = {}) => o;

        it('accepts our own second instance', () => {
            expect(isTrustedHandoffRequest('POST', hdrs())).toBe(true);
        });

        it('rejects GET — a page could trigger it with an <img> or a redirect', () => {
            expect(isTrustedHandoffRequest('GET', hdrs())).toBe(false);
        });

        it('rejects a browser cross-site POST (Origin present)', () => {
            expect(isTrustedHandoffRequest('POST', hdrs({ origin: 'https://evil.example' }))).toBe(false);
        });

        it('rejects a browser fetch that sets Sec-Fetch-Site', () => {
            expect(isTrustedHandoffRequest('POST', hdrs({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
        });

        it('rejects a same-origin page too — the app itself never calls this', () => {
            expect(isTrustedHandoffRequest('POST', hdrs({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
        });
    });

    describe('body encoding', () => {
        it('round-trips a deep link', () => {
            expect(decodeHandoffBody(encodeHandoffBody('cipherline://ref/XYZ'))).toBe('cipherline://ref/XYZ');
        });
        it('round-trips null', () => {
            expect(decodeHandoffBody(encodeHandoffBody(null))).toBeNull();
        });
        for (const junk of ['', 'not json', '{', '{"url":42}', '{"url":{"nested":1}}', 'null']) {
            it(`survives malformed body ${JSON.stringify(junk)}`, () => {
                expect(decodeHandoffBody(junk)).toBeNull();
            });
        }
    });
});
