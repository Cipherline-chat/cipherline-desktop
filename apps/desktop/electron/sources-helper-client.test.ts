import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createSourcesHelperClient, launchSourcesHelper, SOURCES_HELPER_UNAVAILABLE,
    type HelperConnection, type HelperLaunch, type SourcesHelperEvent,
} from './sources-helper-client';
import type { HelperMessage, ListedSource } from './sources-helper-protocol';

// ── A scripted fake launch for the state machine ───────────────────────────
interface FakeLaunch extends HelperLaunch {
    sent: Array<{ id: number; types: string[] }>;
    killed: boolean;
    connect(): void;
    failConnect(reason: string): void;
    reply(m: HelperMessage): void;
    exit(code: number): void;
    dropConnection(): void;
}

function fakeLaunch(): FakeLaunch {
    let resolveConn!: (c: HelperConnection) => void;
    let rejectConn!: (e: Error) => void;
    const connected = new Promise<HelperConnection>((res, rej) => { resolveConn = res; rejectConn = rej; });
    connected.catch(() => undefined);
    const msgCbs: Array<(m: HelperMessage) => void> = [];
    const closeCbs: Array<() => void> = [];
    const exitCbs: Array<(c: number | null, s: string | null) => void> = [];
    const f: FakeLaunch = {
        sent: [],
        killed: false,
        connected,
        onExit: (cb) => { exitCbs.push(cb); },
        kill: () => { f.killed = true; },
        connect: () => resolveConn({
            pid: 99,
            disabledFeatures: 'DirectXCapturer',
            send: (line) => f.sent.push(JSON.parse(line)),
            onMessage: (cb) => { msgCbs.push(cb); },
            onClose: (cb) => { closeCbs.push(cb); },
            close: () => { f.killed = true; },
        }),
        failConnect: (reason) => rejectConn(new Error(reason)),
        reply: (m) => { for (const cb of msgCbs) cb(m); },
        exit: (code) => { for (const cb of exitCbs) cb(code, null); },
        dropConnection: () => { for (const cb of closeCbs) cb(); },
    };
    return f;
}

const SCREEN: ListedSource = { id: 'screen:0:0', name: 'Screen 1', display_id: '', thumbnailDataUrl: '' };
const REQ = { types: ['screen' as const], thumbnailSize: { width: 0, height: 0 } };
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function setup(over: Partial<Parameters<typeof createSourcesHelperClient>[0]> = {}) {
    const launches: FakeLaunch[] = [];
    const events: SourcesHelperEvent[] = [];
    const client = createSourcesHelperClient({
        launch: () => { const l = fakeLaunch(); launches.push(l); return l; },
        onEvent: (e) => events.push(e),
        requestTimeoutMs: 1_000,
        idleMs: 5_000,
        ...over,
    });
    return { client, launches, events };
}

afterEach(() => { vi.useRealTimers(); });

describe('createSourcesHelperClient', () => {
    it('starts lazily, sends after the authenticated connect, resolves by id', async () => {
        const { client, launches, events } = setup();
        expect(launches).toHaveLength(0);
        const p = client.getSources(REQ);
        expect(launches).toHaveLength(1);
        expect(launches[0].sent).toEqual([]); // nothing before the hello
        launches[0].connect();
        await flush();
        expect(launches[0].sent).toEqual([{ id: 1, types: ['screen'], thumbnailSize: { width: 0, height: 0 } }]);
        launches[0].reply({ kind: 'result', id: 1, ok: true, sources: [SCREEN], ms: 5, dropped: 0 });
        await expect(p).resolves.toEqual([SCREEN]);
        expect(events.map(e => e.type)).toEqual(['spawn', 'ready']);
        // Reused, not respawned.
        const p2 = client.getSources(REQ);
        expect(launches).toHaveLength(1);
        launches[0].reply({ kind: 'result', id: 2, ok: true, sources: [], ms: 1, dropped: 0 });
        await expect(p2).resolves.toEqual([]);
    });

    it('a getSources error in the helper rejects that call only', async () => {
        const { client, launches } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await flush();
        launches[0].reply({ kind: 'result', id: 1, ok: false, error: 'Failed to get sources.' });
        await expect(p).rejects.toThrow('Failed to get sources.');
        expect(launches[0].killed).toBe(false);
        expect(client.isRunning()).toBe(true);
    });

    it('answers for unknown ids are ignored', async () => {
        const { client, launches } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await flush();
        launches[0].reply({ kind: 'result', id: 42, ok: true, sources: [SCREEN], ms: 1, dropped: 0 });
        launches[0].reply({ kind: 'result', id: 1, ok: true, sources: [], ms: 1, dropped: 0 });
        await expect(p).resolves.toEqual([]);
    });

    it('two failed starts → unavailable for the rest of the run (no more launches, one event)', async () => {
        const { client, launches, events } = setup();
        const p1 = client.getSources(REQ);
        launches[0].failConnect('spawn failed: ENOENT');
        await expect(p1).rejects.toThrow(/failed to start: spawn failed/);
        expect(client.isUnavailable()).toBe(false);
        const p2 = client.getSources(REQ);
        expect(launches).toHaveLength(2);
        launches[1].failConnect('no authenticated connection');
        await expect(p2).rejects.toThrow(SOURCES_HELPER_UNAVAILABLE);
        expect(client.isUnavailable()).toBe(true);
        await expect(client.getSources(REQ)).rejects.toThrow(SOURCES_HELPER_UNAVAILABLE);
        expect(launches).toHaveLength(2);
        expect(events.filter(e => e.type === 'unavailable')).toHaveLength(1);
        expect(launches.every(l => l.killed)).toBe(true);
    });

    it('a success in between resets the failure count', async () => {
        const { client, launches } = setup();
        const p1 = client.getSources(REQ);
        launches[0].failConnect('x');
        await expect(p1).rejects.toThrow();
        const p2 = client.getSources(REQ);
        launches[1].connect();
        await flush();
        launches[1].reply({ kind: 'result', id: 2, ok: true, sources: [], ms: 1, dropped: 0 });
        await p2;
        launches[1].exit(1); // crashed later
        const p3 = client.getSources(REQ);
        launches[2].failConnect('y');
        await expect(p3).rejects.toThrow(/failed to start/);
        expect(client.isUnavailable()).toBe(false);
    });

    it('a launch that throws counts as a failed start', async () => {
        let n = 0;
        const client = createSourcesHelperClient({ launch: () => { n++; throw new Error('EACCES'); }, maxStartFailures: 1 });
        await expect(client.getSources(REQ)).rejects.toThrow(SOURCES_HELPER_UNAVAILABLE);
        expect(n).toBe(1);
        expect(client.isUnavailable()).toBe(true);
    });

    it('the helper dying mid-request rejects it; the next request starts a fresh helper', async () => {
        const { client, launches } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await flush();
        launches[0].exit(3);
        await expect(p).rejects.toThrow(/exited/);
        const p2 = client.getSources(REQ);
        expect(launches).toHaveLength(2);
        launches[1].connect();
        await flush();
        launches[1].reply({ kind: 'result', id: 2, ok: true, sources: [SCREEN], ms: 1, dropped: 0 });
        await expect(p2).resolves.toEqual([SCREEN]);
    });

    it('a lost connection rejects pending work and kills the process', async () => {
        const { client, launches } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await flush();
        launches[0].dropConnection();
        await expect(p).rejects.toThrow(/connection closed/);
        expect(launches[0].killed).toBe(true);
        expect(client.isRunning()).toBe(false);
    });

    it('a wedged helper (no answer) is timed out and stopped', async () => {
        vi.useFakeTimers();
        const { client, launches, events } = setup();
        const p = client.getSources(REQ);
        const caught = p.catch(e => e as Error);
        launches[0].connect();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await caught).message).toMatch(/no answer within 1000 ms/);
        expect(launches[0].killed).toBe(true);
        expect(events.some(e => e.type === 'request-timeout')).toBe(true);
        // Not a start failure.
        expect(client.isUnavailable()).toBe(false);
    });

    it('stops when idle, and only when idle', async () => {
        vi.useFakeTimers();
        const { client, launches, events } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await vi.advanceTimersByTimeAsync(0);
        launches[0].reply({ kind: 'result', id: 1, ok: true, sources: [], ms: 1, dropped: 0 });
        await p;
        await vi.advanceTimersByTimeAsync(4_999);
        expect(launches[0].killed).toBe(false);
        // A request inside the window restarts the clock.
        const p2 = client.getSources(REQ);
        await vi.advanceTimersByTimeAsync(10);
        launches[0].reply({ kind: 'result', id: 2, ok: true, sources: [], ms: 1, dropped: 0 });
        await p2;
        await vi.advanceTimersByTimeAsync(4_999);
        expect(launches[0].killed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(launches[0].killed).toBe(true);
        expect(events.some(e => e.type === 'idle-stop')).toBe(true);
    });

    it('reports dropped (malformed) sources', async () => {
        const { client, launches, events } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await flush();
        launches[0].reply({ kind: 'result', id: 1, ok: true, sources: [SCREEN], ms: 1, dropped: 2 });
        await p;
        expect(events).toContainEqual({ type: 'dropped', id: 1, count: 2 });
    });

    it('dispose rejects pending work, kills the helper and refuses new work', async () => {
        const { client, launches } = setup();
        const p = client.getSources(REQ);
        launches[0].connect();
        await flush();
        client.dispose();
        await expect(p).rejects.toThrow(/disposed/);
        expect(launches[0].killed).toBe(true);
        await expect(client.getSources(REQ)).rejects.toThrow(/disposed/);
    });
});

// ── The real transport, with a plain Node child standing in for Electron ──
describe('launchSourcesHelper (real socket + child process)', () => {
    let dir: string;
    let script: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsh-test-'));
        script = path.join(dir, 'fake-helper.cjs');
        // Mirrors sources-helper.ts: connect, hello with the token, answer
        // requests. MODE=badtoken / silent / crash exercise the failures.
        fs.writeFileSync(script, `
const net = require('net');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'crash') process.exit(7);
const s = net.createConnection(process.env.CIPHERLINE_SOURCES_HELPER_ADDRESS);
s.setEncoding('utf8');
s.on('connect', () => {
  if (mode === 'silent') return;
  const token = mode === 'badtoken' ? 'f'.repeat(64) : process.env.CIPHERLINE_SOURCES_HELPER_TOKEN;
  s.write(JSON.stringify({ kind: 'hello', token, pid: process.pid, disabledFeatures: 'DirectXCapturer',
    sawDataDir: !!process.env.CIPHERLINE_SOURCES_HELPER_DATA_DIR }) + '\\n');
});
let buf = '';
s.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    s.write(JSON.stringify({ kind: 'result', id: req.id, ok: true, ms: 1, sources: [
      { id: 'screen:0:0', name: 'Screen ' + req.types.join('+'), display_id: '', thumbnailDataUrl: '' },
      { id: 'evil', name: 'x', display_id: '', thumbnailDataUrl: '' },
    ] }) + '\\n');
  }
});
s.on('close', () => process.exit(0));
`);
    });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const launchWith = (mode: string, timeout = 8_000) => launchSourcesHelper({
        command: process.execPath,
        args: [script],
        connectTimeoutMs: timeout,
        baseEnv: { ...process.env, FAKE_MODE: mode },
    });

    it('authenticates, round-trips a request through the client, drops a malformed entry', async () => {
        const events: SourcesHelperEvent[] = [];
        const client = createSourcesHelperClient({ launch: () => launchWith('ok'), onEvent: e => events.push(e) });
        const out = await client.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
        expect(out).toEqual([{ id: 'screen:0:0', name: 'Screen window+screen', display_id: '', thumbnailDataUrl: '' }]);
        expect(events.find(e => e.type === 'ready')).toMatchObject({ disabledFeatures: 'DirectXCapturer' });
        expect(events).toContainEqual({ type: 'dropped', id: 1, count: 1 });
        const exited = new Promise<void>(r => { const t = setInterval(() => { if (events.some(e => e.type === 'exit')) { clearInterval(t); r(); } }, 20); });
        client.dispose();
        await exited; // the child exits when its socket closes
    }, 20_000);

    it('NEGATIVE: a child with the wrong token is refused (and killed)', async () => {
        const l = launchWith('badtoken');
        await expect(l.connected).rejects.toThrow(/not a valid hello/);
    }, 20_000);

    it('NEGATIVE: a child that never says hello times out', async () => {
        const l = launchWith('silent', 1_500);
        await expect(l.connected).rejects.toThrow(/no authenticated connection within 1500 ms/);
    }, 20_000);

    it('NEGATIVE: a child that exits before connecting', async () => {
        const l = launchWith('crash');
        await expect(l.connected).rejects.toThrow(/exited \(7\) before connecting/);
    }, 20_000);

    it('NEGATIVE: a command that does not exist', async () => {
        const l = launchSourcesHelper({ command: path.join(dir, 'no-such-binary'), args: [], connectTimeoutMs: 5_000 });
        await expect(l.connected).rejects.toThrow(/spawn failed|exited/);
    }, 20_000);

    it('a second connection to the address is refused once authenticated', async () => {
        const net = await import('net');
        let address = '';
        const l = launchSourcesHelper({
            command: process.execPath, args: [script], connectTimeoutMs: 8_000,
            baseEnv: { ...process.env, FAKE_MODE: 'ok' },
            spawnImpl: (cmd, args, o) => {
                address = String(o.env?.CIPHERLINE_SOURCES_HELPER_ADDRESS);
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                return require('child_process').spawn(cmd, args, o);
            },
        });
        await l.connected;
        // The listener is gone (unix: the socket file is unlinked too).
        const err = await new Promise<Error | null>((resolve) => {
            const s = net.createConnection(address);
            s.on('connect', () => { s.destroy(); resolve(null); });
            s.on('error', (e) => resolve(e));
        });
        expect(err).not.toBeNull();
        l.kill();
    }, 20_000);
});
