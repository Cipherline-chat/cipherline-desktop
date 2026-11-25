import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
    attestGate, createNearHelperClient, helperEnv, NearHelperUnavailable,
    type NearHelperHandlers, type SpawnFn,
} from './near-helper-client';

const NONCE = 'ab'.repeat(32);
const BASE_CONFIG = { profile: '/p', stagingDir: '/s', version: '0.1.2', deviceLabel: 'PC', platform: 'linux' as const };
// carries an attestation secret on purpose: the client must never put it in `hello` (L5)
const CONFIG = { ...BASE_CONFIG, attestSecret: 'S3CRET-ATTEST' };

/** A scripted helper: records every stdin line, lets the test push stdout lines, and can "exit". */
function fakeChild() {
    const ee = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fd3 = new PassThrough();
    const sent: Array<Record<string, unknown>> = [];
    const rawLines: string[] = [];
    let acc = '';
    stdin.on('data', (d: Buffer) => {
        acc += d.toString('utf8');
        let i: number;
        while ((i = acc.indexOf('\n')) >= 0) {
            const line = acc.slice(0, i);
            acc = acc.slice(i + 1);
            rawLines.push(line);
            try { sent.push(JSON.parse(line)); } catch { /* the Windows nonce line */ }
        }
    });
    let fd3Data = '';
    fd3.on('data', (d: Buffer) => { fd3Data += d.toString('utf8'); });
    const child = Object.assign(ee, {
        pid: 4242, stdin, stdout, stderr, stdio: [stdin, stdout, stderr, fd3],
        kill: vi.fn(() => { child.exit(null, 'SIGTERM'); return true; }),
    });
    const api = {
        child, sent, spawned: [] as Array<{ cmd: string; args: string[]; opts: unknown }>,
        say: (o: unknown) => stdout.write(JSON.stringify(o) + '\n'),
        exit: (code: number | null, signal: string | null = null) => { ee.emit('exit', code, signal); },
        fd3: () => fd3Data,
        raw: () => rawLines,
    };
    return api;
}

function harness(over: Partial<NearHelperHandlers> = {}, platform?: NodeJS.Platform) {
    const f = fakeChild();
    const states: unknown[] = [];
    const own: unknown[] = [];
    const logs: string[] = [];
    const handlers: NearHelperHandlers = {
        gateConfirm: async () => 'approved',
        ...over,
    };
    const spawn: SpawnFn = (cmd, args, opts) => { f.spawned.push({ cmd, args, opts }); return f.child as never; };
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const client = createNearHelperClient({
        resolveBinary: () => '/res/near-helper', spawn, config: () => CONFIG, handlers,
        onState: (s) => states.push(s), onOwnOut: (m) => own.push(m), log: (l) => logs.push(l),
        randomHex: () => NONCE, platform,
        setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimer: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
        baseEnv: { PATH: '/bin', HOME: '/h', CLIENT_ATTEST_SECRET: 'LEAK', ACCESS_TOKEN: 'LEAK2', DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/x' },
    });
    const start = async () => { const p = client.start(); await tick(); f.say({ t: 'ready', v: 1, pid: 1 }); await p; };
    return { f, client, states, own, logs, timers, start };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('near helper client: start and handshake', () => {
    it('writes the nonce to fd 3, repeats it in hello, and passes the config; nothing secret goes in argv or env', async () => {
        const h = harness();
        await h.start();
        expect(h.f.fd3()).toBe(NONCE + '\n');
        expect(h.f.sent[0]).toEqual({ t: 'hello', v: 1, nonce: NONCE, config: BASE_CONFIG });
        expect(JSON.stringify(h.f.sent[0])).not.toContain('S3CRET');
        const sp = h.f.spawned[0];
        expect(sp.cmd).toBe('/res/near-helper');
        expect(sp.args).toEqual([]);
        const o = sp.opts as { stdio: string[]; env: Record<string, string>; shell: boolean };
        expect(o.stdio).toEqual(['pipe', 'pipe', 'pipe', 'pipe']);
        expect(o.shell).toBe(false);
        expect(Object.keys(o.env).sort()).toEqual(['DBUS_SYSTEM_BUS_ADDRESS', 'HOME', 'PATH']);
        expect(JSON.stringify(o)).not.toContain('LEAK');
    });

    it('Windows: three pipes, the nonce is the FIRST stdin line (no fd 3), a Windows env allow-list', async () => {
        const f = fakeChild();
        const sp: Array<{ opts: { stdio: string[]; env: Record<string, string> } }> = [];
        const client = createNearHelperClient({
            resolveBinary: () => 'C:\\res\\near-helper.exe',
            spawn: ((_c: string, _a: string[], opts: never) => { sp.push({ opts }); return f.child; }) as never,
            config: () => ({ ...CONFIG, platform: 'windows' as const }), handlers: { gateConfirm: async () => 'declined' },
            onState: () => undefined, onOwnOut: () => undefined, randomHex: () => NONCE, platform: 'win32',
            baseEnv: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', HOME: '/nope', CLIENT_ATTEST_SECRET: 'LEAK', DBUS_SYSTEM_BUS_ADDRESS: 'x' },
        });
        const p = client.start();
        await tick();
        f.say({ t: 'ready', v: 1, pid: 1 });
        await p;
        expect(sp[0].opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
        expect(Object.keys(sp[0].opts.env).sort()).toEqual(['PATH', 'SystemRoot', 'TEMP']);
        expect(f.fd3()).toBe(''); // nothing on the (absent) fourth pipe
        expect(f.raw()[0]).toBe(NONCE); // the nonce line comes first, bare
        expect(f.sent[0]).toMatchObject({ t: 'hello', nonce: NONCE, config: { platform: 'windows' } });
    });

    it('helperEnv keeps only the platform allow-list', () => {
        expect(Object.keys(helperEnv({ PATH: 'p', HOME: 'h', SystemRoot: 's', ACCESS_TOKEN: 't' }, 'linux')).sort()).toEqual(['HOME', 'PATH']);
        expect(Object.keys(helperEnv({ PATH: 'p', HOME: 'h', SystemRoot: 's', ACCESS_TOKEN: 't' }, 'win32')).sort()).toEqual(['PATH', 'SystemRoot']);
    });

    it('is unavailable when there is no binary, when spawn throws, when it exits early or never says ready', async () => {
        const f = fakeChild();
        const mk = (over: Record<string, unknown>) => createNearHelperClient({
            resolveBinary: () => '/b', spawn: (() => f.child) as never, config: () => CONFIG, onState: () => undefined, onOwnOut: () => undefined,
            handlers: { gateConfirm: async () => 'declined' }, ...over,
        });
        await expect(mk({ resolveBinary: () => null }).start()).rejects.toBeInstanceOf(NearHelperUnavailable);
        await expect(mk({ spawn: () => { throw new Error('ENOENT'); } }).start()).rejects.toThrow(/spawn failed/);
        const early = mk({});
        const p = early.start();
        await tick();
        f.exit(65);
        await expect(p).rejects.toThrow(/exited \(65\)/);
        const g = fakeChild();
        const slow = mk({ spawn: () => g.child, setTimer: (fn: () => void) => { setImmediate(fn); return 1; }, clearTimer: () => undefined });
        await expect(slow.start()).rejects.toThrow(/did not become ready/);
        expect(g.child.kill).toHaveBeenCalled();
    });

    it('two concurrent starts spawn one helper', async () => {
        const h = harness();
        const a = h.client.start();
        const b = h.client.start();
        await tick();
        h.f.say({ t: 'ready', v: 1, pid: 1 });
        await Promise.all([a, b]);
        expect(h.f.spawned).toHaveLength(1);
    });

    it('helperEnv keeps an allow-list only', () => {
        expect(helperEnv({ PATH: 'p', ATTEST: 'x', TOKEN: 'y', LANG: 'C', http_proxy: 'z' })).toEqual({ PATH: 'p', LANG: 'C' });
    });
});

describe('near helper client: calls and events', () => {
    it('matches results to calls by id, rejects failures, and times a silent helper out', async () => {
        const h = harness();
        await h.start();
        const p1 = h.client.call('nearProbe', []);
        const p2 = h.client.call('nearApprove', [], 5);
        await tick();
        const calls = h.f.sent.filter((m) => m.t === 'call');
        expect(calls.map((c) => c.action)).toEqual(['nearProbe', 'nearApprove']);
        h.f.say({ t: 'result', id: calls[1].id, ok: false, error: 'nope' });
        await expect(p2).rejects.toThrow('nope');
        h.f.say({ t: 'result', id: calls[0].id, ok: true, value: { available: true } });
        await expect(p1).resolves.toEqual({ available: true });
        // never answered: the per-call timer fires
        const p3 = h.client.call('nearGetState', [], 10);
        await tick();
        const t = h.timers.find((x) => x.ms === 10)!;
        t.fn();
        await expect(p3).rejects.toThrow(/did not answer/);
    });

    it('keeps state seqs rising across a restart and tells the page when the helper dies mid-session', async () => {
        const h = harness();
        await h.start();
        h.f.say({ t: 'state', snapshot: { seq: 5, role: 'approver', state: 'awaiting_approval' } });
        h.f.say({ t: 'state', snapshot: { seq: 6, role: 'approver', state: 'approving' } });
        await tick();
        expect((h.states.at(-1) as { seq: number }).seq).toBe(6);
        h.f.exit(139, null);
        await tick();
        const dead = h.states.at(-1) as { seq: number; state: string; error: { code: string } };
        expect([dead.seq, dead.state, dead.error.code]).toEqual([7, 'failed', 'helper_exited']);
    });

    it('a restarted helper starts its own seq at 1; the page still sees rising numbers', async () => {
        const kids = [fakeChild(), fakeChild()];
        const seen: Array<{ seq: number }> = [];
        const client = createNearHelperClient({
            resolveBinary: () => '/b', spawn: (() => kids.shift()!.child) as never, config: () => CONFIG, randomHex: () => NONCE,
            onState: (s) => seen.push(s as { seq: number }), onOwnOut: () => undefined,
            handlers: { gateConfirm: async () => 'declined' },
        });
        const first = kids[0];
        const second = kids[1];
        let p = client.start(); await tick(); first.say({ t: 'ready' }); await p;
        first.say({ t: 'state', snapshot: { seq: 3, state: 'transferring' } });
        await tick();
        first.exit(1);
        await tick();
        p = client.start(); await tick(); second.say({ t: 'ready' }); await p;
        second.say({ t: 'state', snapshot: { seq: 1, state: 'showing_code' } });
        await tick();
        const seqs = seen.map((s) => s.seq);
        expect(seqs).toEqual([3, 4, 5]);
    });

    it('does not announce a failure when a finished session ends with the helper being stopped', async () => {
        const h = harness();
        await h.start();
        h.f.say({ t: 'state', snapshot: { seq: 1, role: 'new_device', state: 'done' } });
        await tick();
        const n = h.states.length;
        h.client.stop();
        h.f.exit(0);
        await tick();
        expect(h.states).toHaveLength(n);
    });

    it('forwards own-device messages and ignores junk lines', async () => {
        const h = harness();
        await h.start();
        h.f.child.stdout.write('not json\n');
        h.f.say({ t: 'own_out', to: 'dev-2', content: { type: 'near_offer' } });
        h.f.say({ t: 'own_out', content: {} });
        await tick();
        expect(h.own).toEqual([{ to: 'dev-2', content: { type: 'near_offer' } }]);
    });

    it('stops the helper when the engine has been quiet, but not while a session runs or a call is open', async () => {
        const h = harness();
        await h.start();
        h.f.say({ t: 'state', snapshot: { seq: 1, role: 'approver', state: 'transferring' } });
        await tick();
        expect(h.timers.some((t) => t.ms === 60_000)).toBe(false);
        h.f.say({ t: 'state', snapshot: { seq: 2, role: 'approver', state: 'cancelled' } });
        await tick();
        const idle = h.timers.find((t) => t.ms === 60_000)!;
        expect(idle).toBeTruthy();
        idle.fn();
        expect(h.f.child.stdin.writableEnded).toBe(true);
        // after a completed transfer the page still needs the result: a long grace
        const d = harness();
        await d.start();
        d.f.say({ t: 'state', snapshot: { seq: 1, role: 'new_device', state: 'done' } });
        await tick();
        expect(d.timers.some((t) => t.ms === 15 * 60_000)).toBe(true);
    });
});

describe('near helper client: requests from the helper', () => {
    it('never honours the sign-in requests (identity, signing, link slot): this build has no handler for them', async () => {
        const h = harness();
        await h.start();
        h.f.say({ t: 'req', rid: 1, what: 'identity_pub' });
        h.f.say({ t: 'req', rid: 2, what: 'sign', message: 'cipherline-link-approve:v2:u:d:L:K:ble:1763500000' });
        h.f.say({ t: 'req', rid: 3, what: 'install_link', linkId: 'L'.repeat(22), ekPrivB64: 'p', ekPubB64: 'q' });
        h.f.say({ t: 'req', rid: 4, what: 'whatever' });
        await tick(); await tick();
        const replies = Object.fromEntries(h.f.sent.filter((m) => m.t === 'reply').map((m) => [m.rid as number, m.value]));
        expect(replies[1]).toEqual({ pub: null });
        expect(replies[2]).toEqual({ sig: null });
        expect(replies[3]).toEqual({ ok: false });
        expect(replies[4]).toEqual({ error: 'unknown request' });
    });

    it('attests a gate verdict with the handshake nonce (and declines when the handler throws)', async () => {
        const h = harness();
        await h.start();
        h.f.say({ t: 'req', rid: 9, what: 'gate_confirm', title: 't', detail: 'd' });
        await tick(); await tick();
        const r = h.f.sent.find((m) => m.t === 'reply' && m.rid === 9)!;
        expect(r.value).toEqual({ verdict: 'approved' });
        expect(r.attest).toBe(attestGate(NONCE, 9, 'approved'));
        expect(attestGate(NONCE, 9, 'approved')).not.toBe(attestGate(NONCE, 10, 'approved'));

        const bad = harness({ gateConfirm: async () => { throw new Error('boom'); } });
        await bad.start();
        bad.f.say({ t: 'req', rid: 1, what: 'gate_confirm' });
        await tick(); await tick();
        const r2 = bad.f.sent.find((m) => m.t === 'reply')!;
        expect(r2.value).toEqual({ verdict: 'declined' });
        expect(r2.attest).toBe(attestGate(NONCE, 1, 'declined'));
    });
});
