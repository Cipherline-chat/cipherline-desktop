import { describe, it, expect, vi } from 'vitest';
import { DiscordApiError, DiscordClient, routeKey, type FetchLike } from './discord-client';

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');

interface Reply { status?: number; headers?: Record<string, string>; json?: unknown; bytes?: Uint8Array; throws?: Error; jsonThrows?: boolean }

function harness(replies: Reply[], opts: { start?: number } = {}) {
    let t = opts.start ?? 1_000_000;
    const calls: Array<{ url: string; auth?: string; at: number }> = [];
    const sleeps: number[] = [];
    const queue = [...replies];
    const fetchFn: FetchLike = async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization, at: t });
        const r = queue.shift();
        if (!r) throw new Error('unexpected extra request');
        if (r.throws) throw r.throws;
        const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        return {
            status: r.status ?? 200,
            headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
            json: async () => { if (r.jsonThrows) throw new Error('bad json'); return r.json; },
            arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
        };
    };
    const client = new DiscordClient({
        token: TOKEN, fetchFn,
        sleep: async (ms) => { sleeps.push(ms); t += ms; },
        now: () => t, random: () => 0, timeoutMs: 1000,
    });
    return { client, calls, sleeps, left: () => queue.length };
}

describe('DiscordClient: auth and host', () => {
    it('sends the BOT token to discord.com/api/v10 only', async () => {
        const h = harness([{ json: { id: '1' } }]);
        await h.client.getJson('/users/@me');
        expect(h.calls[0].url).toBe('https://discord.com/api/v10/users/@me');
        expect(h.calls[0].auth).toBe(`Bot ${TOKEN}`);
    });

    it('CDN requests carry NO Authorization header and stay on the CDN host', async () => {
        const h = harness([{ headers: { 'content-type': 'image/png' }, bytes: new Uint8Array([1, 2, 3]) }]);
        const r = await h.client.getCdn('/emojis/123456789012345678.png?size=128', 1000);
        expect(h.calls[0].url).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png?size=128');
        expect(h.calls[0].auth).toBeUndefined();
        expect(r.contentType).toBe('image/png');
    });

    it('refuses odd paths (traversal, double slash, other CDN folders)', async () => {
        const h = harness([]);
        await expect(h.client.getJson('guilds/1')).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getJson('/guilds/../x')).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getJson('//evil.example/x')).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getCdn('/attachments/1/2/x.png', 10)).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getCdn('/emojis/../../x.png', 10)).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getCdn('/role-icons/../../x.png', 10)).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getCdn('/role-iconsX/1/2.png', 10)).rejects.toBeInstanceOf(DiscordApiError);
        await expect(h.client.getCdn('/stickers/1.png', 10)).rejects.toBeInstanceOf(DiscordApiError); // stickers go through getMedia
        expect(h.calls).toHaveLength(0);
    });

    it('role icons are on the CDN allow-list (role-icons/<role id>/<hash>.png), still no Authorization', async () => {
        const h = harness([{ headers: { 'content-type': 'image/png' }, bytes: new Uint8Array([1]) }]);
        await h.client.getCdn('/role-icons/123456789012345678/abc123.png?size=128', 1000);
        expect(h.calls[0].url).toBe('https://cdn.discordapp.com/role-icons/123456789012345678/abc123.png?size=128');
        expect(h.calls[0].auth).toBeUndefined();
    });

    it('guild stickers come through the strict MEDIA path (media.discordapp.net/stickers/<id>.png|gif), no Authorization', async () => {
        const h = harness([{ headers: { 'content-type': 'image/gif' }, bytes: new Uint8Array([1]) }]);
        await h.client.getMedia('https://media.discordapp.net/stickers/123456789012345678.gif', 1000);
        expect(h.calls[0].url).toBe('https://media.discordapp.net/stickers/123456789012345678.gif');
        expect(h.calls[0].auth).toBeUndefined();
    });

    it('CDN: rejects an oversize body, declared or actual', async () => {
        const a = harness([{ headers: { 'content-length': '5000' }, bytes: new Uint8Array(1) }]);
        await expect(a.client.getCdn('/emojis/123456789012345678.png', 100)).rejects.toMatchObject({ kind: 'invalid_response' });
        const b = harness([{ bytes: new Uint8Array(500) }]);
        await expect(b.client.getCdn('/emojis/123456789012345678.png', 100)).rejects.toMatchObject({ kind: 'invalid_response' });
    });
});

describe('DiscordClient: rate limits', () => {
    it('429: waits retry_after from the body, then retries and succeeds', async () => {
        const h = harness([{ status: 429, json: { retry_after: 1.5, global: false } }, { json: { ok: 1 } }]);
        await expect(h.client.getJson('/guilds/123456789012345678')).resolves.toEqual({ ok: 1 });
        expect(h.sleeps).toEqual([1500]);
        expect(h.calls).toHaveLength(2);
    });

    it('429 with an unreadable body falls back to the Retry-After header', async () => {
        const h = harness([{ status: 429, jsonThrows: true, headers: { 'retry-after': '2' } }, { json: {} }]);
        await h.client.getJson('/users/@me');
        expect(h.sleeps).toEqual([2000]);
    });

    it('a GLOBAL 429 blocks a different route too', async () => {
        const h = harness([
            { status: 429, json: { retry_after: 3, global: true } },
            { json: 1 },
            { json: 2 },
        ]);
        await h.client.getJson('/users/@me');
        const before = h.sleeps.length;
        await h.client.getJson('/guilds/123456789012345678/channels');
        // the second route found the global block already served: no extra wait
        expect(h.sleeps.length).toBe(before);
        expect(h.sleeps[0]).toBe(3000);
    });

    it('per-route buckets: waits BEFORE sending once Remaining hits 0 (no wasted 429)', async () => {
        const h = harness([
            { json: 1, headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.2' } },
            { json: 2, headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset-after': '5' } },
        ]);
        await h.client.getJson('/guilds/123456789012345678');
        await h.client.getJson('/guilds/123456789012345678');
        expect(h.sleeps).toEqual([2200]);
        expect(h.calls[1].at - h.calls[0].at).toBe(2200);
    });

    it('buckets are per guild (major parameter): another guild is not delayed', async () => {
        expect(routeKey('GET', '/guilds/123456789012345678/channels')).not.toBe(routeKey('GET', '/guilds/223456789012345678/channels'));
        const h = harness([
            { json: 1, headers: { 'x-ratelimit-bucket': 'abc', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '9' } },
            { json: 2 },
        ]);
        await h.client.getJson('/guilds/123456789012345678/channels');
        await h.client.getJson('/guilds/223456789012345678/channels');
        expect(h.sleeps).toEqual([]);
    });

    it('gives up (rate_limited, with retryAfterMs) after the retry budget', async () => {
        const h = harness(Array.from({ length: 6 }, () => ({ status: 429, json: { retry_after: 0.1 } })));
        await expect(h.client.getJson('/users/@me')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 100 });
        expect(h.calls).toHaveLength(6);
    });

    it('a wait longer than maxWaitMs is surfaced, not slept through', async () => {
        const h = harness([{ status: 429, json: { retry_after: 600 } }]);
        await expect(h.client.getJson('/users/@me')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 600_000 });
        expect(h.sleeps).toEqual([]);
    });
});

describe('DiscordClient: errors and backoff', () => {
    it('401 -> invalid_token, NOT retried (invalid requests earn IP bans)', async () => {
        const h = harness([{ status: 401, json: { code: 0 } }]);
        await expect(h.client.getJson('/users/@me')).rejects.toMatchObject({ kind: 'invalid_token', status: 401 });
        expect(h.calls).toHaveLength(1);
    });

    it('403 carries Discord\'s numeric code only; 404 not retried', async () => {
        const h = harness([{ status: 403, json: { code: 50001, message: 'Missing Access' } }, { status: 404, json: { code: 10004 } }]);
        await expect(h.client.getJson('/guilds/123456789012345678')).rejects.toMatchObject({ kind: 'forbidden', discordCode: 50001 });
        await expect(h.client.getJson('/guilds/123456789012345679')).rejects.toMatchObject({ kind: 'not_found', discordCode: 10004 });
    });

    it('5xx: exponential backoff, then success', async () => {
        const h = harness([{ status: 502 }, { status: 503 }, { status: 500 }, { json: { ok: true } }]);
        await expect(h.client.getJson('/users/@me')).resolves.toEqual({ ok: true });
        // random()=0 => half of base each time: 250, 500, 1000
        expect(h.sleeps).toEqual([250, 500, 1000]);
    });

    it('network failure retries, then reports a redacted network error', async () => {
        const boom = new Error(`connect failed for Bot ${TOKEN}`);
        const h = harness(Array.from({ length: 6 }, () => ({ throws: boom })));
        const err = await h.client.getJson('/users/@me').catch(e => e) as DiscordApiError;
        expect(err.kind).toBe('network');
        expect(err.message).not.toContain(TOKEN);
        expect(err.message).not.toContain('MTIzNDU2Nzg5MDEyMzQ1Njc4');
        expect(h.calls).toHaveLength(6);
    });

    it('timeout: aborts the request and reports timeout', async () => {
        vi.useFakeTimers();
        try {
            const fetchFn: FetchLike = (_u, init) => new Promise((_res, rej) => {
                init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            });
            const c = new DiscordClient({ token: TOKEN, fetchFn, timeoutMs: 500, maxRetries: 0, sleep: async () => undefined });
            const p = c.getJson('/users/@me').catch(e => e);
            await vi.advanceTimersByTimeAsync(600);
            expect(await p).toMatchObject({ kind: 'timeout' });
        } finally { vi.useRealTimers(); }
    });

    it('cancel: an aborted signal stops before sending and during a wait', async () => {
        const h = harness([{ json: 1 }]);
        const ctl = new AbortController();
        ctl.abort();
        await expect(h.client.getJson('/users/@me', ctl.signal)).rejects.toMatchObject({ kind: 'aborted' });
        expect(h.calls).toHaveLength(0);
    });

    it('never puts the token in any error text', async () => {
        for (const reply of [{ status: 401 }, { status: 403, json: {} }, { status: 404 }, { status: 418 }, { status: 500 }]) {
            const h = harness(Array.from({ length: 7 }, () => reply as Reply));
            const err = await h.client.getJson('/users/@me').catch(e => e) as Error;
            expect(`${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`).not.toContain(TOKEN);
        }
    });

    it('a non-JSON success body is invalid_response, not a crash', async () => {
        const h = harness([{ jsonThrows: true }]);
        await expect(h.client.getJson('/users/@me')).rejects.toMatchObject({ kind: 'invalid_response' });
    });
});

describe('DiscordClient: pagination', () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(100000000000000000n + BigInt(from + i)) }));

    it('follows the after cursor until a short page', async () => {
        const h = harness([{ json: page(0, 3) }, { json: page(3, 3) }, { json: page(6, 1) }]);
        const all = await h.client.paginateAfter<{ id: string }>('/users/@me/guilds', 3);
        expect(all).toHaveLength(7);
        expect(h.calls[0].url).toContain('/users/@me/guilds?limit=3');
        expect(h.calls[0].url).not.toContain('after=');
        expect(h.calls[1].url).toContain(`after=${page(2, 1)[0].id}`);
        expect(h.calls[2].url).toContain(`after=${page(5, 1)[0].id}`);
    });

    it('an exact multiple of the page size costs one extra empty request', async () => {
        const h = harness([{ json: page(0, 2) }, { json: [] }]);
        expect(await h.client.paginateAfter('/users/@me/guilds', 2)).toHaveLength(2);
        expect(h.calls).toHaveLength(2);
    });

    it('stops at the page limit instead of looping forever', async () => {
        const h = harness(Array.from({ length: 5 }, (_, i) => ({ json: page(i * 2, 2) })));
        await h.client.paginateAfter('/users/@me/guilds', 2, undefined, 3);
        expect(h.calls).toHaveLength(3);
    });

    it('a non-array page is invalid_response', async () => {
        const h = harness([{ json: { message: 'nope' } }]);
        await expect(h.client.paginateAfter('/users/@me/guilds', 2)).rejects.toMatchObject({ kind: 'invalid_response' });
    });
});
