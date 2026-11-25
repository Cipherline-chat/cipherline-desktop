/**
 * Page snapshots, the parts that need no Electron (page-snapshot.ts): one
 * snapshot at a time, queued, cancellable (queued or running), bounded; the
 * snapshot window's request policy (schemes, private literals, the request
 * cap); the site check that blocks cross-site navigation. The window itself
 * is exercised in the real Electron app (harness/page-snapshots-electron.mjs).
 */
import { describe, it, expect } from 'vitest';
import { createSnapshotQueue, siteOf, snapshotRequestDecision, SNAPSHOT_LIMITS, type SnapshotResult } from './page-snapshot';

const okResult = (): SnapshotResult => ({ ok: true, bytes: new Uint8Array([1]), mime: 'image/png', width: 1200, height: 675, ms: 1 });

function controlledRunner() {
    const runs: { url: string; signal: AbortSignal; finish: (r: SnapshotResult) => void }[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (url: string, signal: AbortSignal) => new Promise<SnapshotResult>((ok) => {
        active++; maxActive = Math.max(maxActive, active);
        const finish = (r: SnapshotResult) => { active--; ok(r); };
        signal.addEventListener('abort', () => finish({ ok: false, reason: 'cancelled' }));
        runs.push({ url, signal, finish });
    });
    return { runs, run, maxActive: () => maxActive };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createSnapshotQueue', () => {
    it('one at a time, in order', async () => {
        const c = controlledRunner();
        const q = createSnapshotQueue(c.run);
        const a = q.request('https://a.example/', 'tokenaaaa');
        const b = q.request('https://b.example/', 'tokenbbbb');
        await tick();
        expect(c.runs.map((r) => r.url)).toEqual(['https://a.example/']);
        expect(q.state()).toEqual({ running: 'https://a.example/', queued: ['https://b.example/'] });
        c.runs[0].finish(okResult());
        expect((await a).ok).toBe(true);
        await tick();
        expect(c.runs.map((r) => r.url)).toEqual(['https://a.example/', 'https://b.example/']);
        c.runs[1].finish(okResult());
        expect((await b).ok).toBe(true);
        expect(c.maxActive()).toBe(1);
    });

    it('cancel: a queued one never runs; the running one is aborted and the next starts', async () => {
        const c = controlledRunner();
        const q = createSnapshotQueue(c.run);
        const a = q.request('https://a.example/', 'tokenaaaa');
        const b = q.request('https://b.example/', 'tokenbbbb');
        const d = q.request('https://d.example/', 'tokendddd');
        await tick();
        expect(q.cancel('tokenbbbb')).toBe(true);
        expect(await b).toEqual({ ok: false, reason: 'cancelled' });
        expect(q.cancel('tokenaaaa')).toBe(true);
        expect(c.runs[0].signal.aborted).toBe(true);
        expect(await a).toEqual({ ok: false, reason: 'cancelled' });
        await tick();
        expect(c.runs.map((r) => r.url)).toEqual(['https://a.example/', 'https://d.example/']);
        c.runs[1].finish(okResult());
        expect((await d).ok).toBe(true);
        expect(q.cancel('tokenzzzz')).toBe(false);
    });

    it('a picture that lands after its cancel is not handed out', async () => {
        const runs: ((r: SnapshotResult) => void)[] = [];
        const q = createSnapshotQueue((_u, _s) => new Promise((ok) => runs.push(ok)));
        const a = q.request('https://a.example/', 'tokenaaaa');
        await tick();
        q.cancel('tokenaaaa');
        runs[0](okResult()); // the runner ignored the abort and finished anyway
        expect(await a).toEqual({ ok: false, reason: 'cancelled' });
    });

    it('the same token joins its job; a full queue answers busy; a throwing runner is a failure, not a stall', async () => {
        const c = controlledRunner();
        const q = createSnapshotQueue(c.run, 2);
        const a1 = q.request('https://a.example/', 'tokenaaaa');
        const a2 = q.request('https://a.example/', 'tokenaaaa');
        expect(a2).toBe(a1);
        q.request('https://b.example/', 'tokenbbbb');
        q.request('https://c.example/', 'tokencccc');
        expect(await q.request('https://d.example/', 'tokendddd')).toEqual({ ok: false, reason: 'busy' });
        const bad = createSnapshotQueue(async () => { throw new Error('boom'); });
        expect(await bad.request('https://x.example/', 'tokenxxxx')).toEqual({ ok: false, reason: 'failed' });
        await tick();
        expect(bad.state()).toEqual({ running: null, queued: [] });
    });
});

describe('snapshotRequestDecision (webRequest, before the proxy)', () => {
    it('https / wss / data / blob are allowed to public names and addresses', () => {
        for (const u of ['https://www.bbc.com/news', 'wss://push.example.com/socket', 'data:image/png;base64,AAAA', 'blob:https://x.example/1', 'https://93.184.215.14/']) {
            expect([u, snapshotRequestDecision(u, 0)]).toEqual([u, 'allow']);
        }
    });
    it('every other scheme is refused (http, ws, file, ftp, chrome, javascript, custom app schemes)', () => {
        for (const u of ['http://example.com/', 'ws://example.com/', 'file:///etc/passwd', 'ftp://example.com/', 'chrome://gpu', 'javascript:alert(1)', 'clmedia://media/x', 'devtools://devtools/x']) {
            expect([u, snapshotRequestDecision(u, 0)]).toEqual([u, 'scheme']);
        }
    });
    it('literal private / loopback / link-local addresses, local names and odd ports are refused up front', () => {
        for (const u of ['https://127.0.0.1/', 'https://192.168.1.1/admin', 'https://10.1.2.3/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[fe80::1]/', 'https://localhost/', 'https://router.local/', 'https://intranet/', 'https://example.com:8443/', 'wss://127.0.0.1/']) {
            expect([u, snapshotRequestDecision(u, 0)]).toEqual([u, 'private']);
        }
    });
    it('the request cap', () => {
        expect(snapshotRequestDecision('https://example.com/a', SNAPSHOT_LIMITS.maxRequests - 1)).toBe('allow');
        expect(snapshotRequestDecision('https://example.com/a', SNAPSHOT_LIMITS.maxRequests)).toBe('cap');
    });
});

describe('siteOf (no cross-site navigation)', () => {
    it('groups a site\'s hosts and tells sites apart', () => {
        expect(siteOf('https://www.bbc.com/news')).toBe('bbc.com');
        expect(siteOf('https://feeds.bbc.com/x')).toBe('bbc.com');
        expect(siteOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
        expect(siteOf('https://docs.google.com/document/d/x')).toBe('google.com');
        expect(siteOf('https://evil.example/')).not.toBe(siteOf('https://www.bbc.com/'));
        expect(siteOf('nope')).toBe('');
    });
});
