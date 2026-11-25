/**
 * Integration: the REAL near-helper binary (Rust, testkit build) driven by the REAL main-process bridge over real pipes, for the
 * own-device history TRANSFER (contract section 7). Two helpers, two bridges, and a Node "E2EE self-fan-out" between them
 * (what `nearOwnTransport.ts` does in the app): the asking device's `near:own-out` messages are delivered to the holder's
 * `nearOwnDeliver` and back. It proves what the unit tests cannot: the handshake over fd 3, the line protocol, the password
 * gate round trip (the attestation HMAC computed in TypeScript and verified in Rust), the proof on the local network, an
 * own-device transfer with a forced drop (pause) and a resume ending in the same sha256, refusals, and a crashed helper.
 *
 * It needs the testkit binary (debug only; a release build refuses the feature):
 *   cd apps/desktop-host/near-helper && cargo build --features testkit
 * Skipped (loudly) when it is not there, or on Windows (the Windows helper is compile-checked only). `CL_NEAR_TESTKIT_DIR`
 * overrides the directory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNearBridge, type NearBridge } from './near-bridge';

const DIR = process.env.CL_NEAR_TESTKIT_DIR ?? path.join(__dirname, '../../desktop-host/near-helper/target/debug');
const HELPER = path.join(DIR, 'cl-near-helper');
const HAVE = process.platform !== 'win32' && fs.existsSync(HELPER);
if (!HAVE) console.warn(`[near-helper.integration] SKIPPED: build the testkit binary first (cd apps/desktop-host/near-helper && cargo build --features testkit); looked in ${DIR}`);

const BASE = 'https://api.cipherline.chat';
// An unsigned JWT shaped like the API's access token (`{ user_id, sid }`): main compares its account claim with `userId` (security round M1).
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOK_H = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ user_id: 'u1', sid: 's-H' })}.c2ln`;
const AUTH_H = { accessToken: TOK_H, userId: 'u1', deviceId: 'dev-H' };

async function until<T>(what: string, f: () => T | undefined | false | null, ms = 60_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = f();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await new Promise<void>((r) => setTimeout(r, 40));
    }
}

interface Dev {
    id: string;
    bridge: NearBridge;
    states: Array<Record<string, unknown>>;
    prompts: Array<{ ticket: string; method: string; closed?: boolean }>;
    own: Array<{ to: string; content: Record<string, unknown> }>;
    http: Array<[string, string]>;
    tmp: string;
    pid: () => number | undefined;
}

describe.skipIf(!HAVE)('near-helper over real pipes: own-device history transfer', () => {
    const cleanup: Array<() => void> = [];
    afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

    /** One device = one real helper process behind a real bridge. `radio` is the fake adapter the helper reports. */
    function device(id: string, radio = 'ready', route?: (from: Dev, m: { to: string; content: Record<string, unknown> }) => void): Dev {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `clnear-${id}-`));
        let childPid: number | undefined;
        const d: Dev = { id, bridge: undefined as unknown as NearBridge, states: [], prompts: [], own: [], http: [], tmp, pid: () => childPid };
        d.bridge = createNearBridge({
            resolveBinary: () => HELPER,
            spawn: (cmd, args, o) => { const c = spawn(cmd, args, o); childPid = c.pid; return c; },
            isPackaged: false,
            config: () => ({ profile: path.join(tmp, 'profile'), stagingDir: path.join(tmp, 'staging'), version: '0.1.2', deviceLabel: `Linux PC ${id}`, platform: 'linux' }),
            resolveReadable: async (p) => p,
            http: async (method, url) => { d.http.push([method, url]); return method === 'GET' ? { status: 200, body: { enabled: false, step_up_method: 'password' } } : { status: 200, body: {} }; },
            send: (channel, payload) => {
                if (channel === 'near:state') d.states.push(payload as Record<string, unknown>);
                if (channel === 'near:gate-prompt') d.prompts.push(payload as never);
                if (channel === 'near:own-out') { const m = payload as { to: string; content: Record<string, unknown> }; d.own.push(m); route?.(d, m); }
            },
            clientOptions: { extraArgs: [radio] },
        });
        cleanup.push(() => { d.bridge.shutdown(); fs.rmSync(tmp, { recursive: true, force: true }); });
        return d;
    }
    const waitState = (d: Dev, what: string, f: (st: Record<string, unknown>) => boolean, ms = 60_000) => until(`${d.id}: ${what}`, () => [...d.states].reverse().find(f), ms);

    /** The "E2EE self-fan-out": a message one device sends to the other lands in that device's `nearOwnDeliver`, exactly as
     *  `Dashboard.tsx` + `deliverOwnNearControl` would hand it over (the page has already checked author + account). */
    function pair(opts: { dropType?: string } = {}) {
        const devs: Record<string, Dev> = {};
        const log: Array<{ from: string; to: string; content: Record<string, unknown> }> = [];
        const route = (from: Dev, m: { to: string; content: Record<string, unknown> }) => {
            log.push({ from: from.id, to: m.to, content: m.content });
            if (opts.dropType && m.content.type === opts.dropType) return;
            const target = devs[m.to];
            void target?.bridge.invoke('nearOwnDeliver', [{
                content: m.content, fromDeviceId: from.id, ownDeviceId: target.id, deviceLabel: `Linux PC ${from.id}`,
                apiBase: BASE, auth: { ...AUTH_H, deviceId: target.id },
            }]);
        };
        const holder = device('dev-H', 'ready', route);
        const asker = device('dev-N', 'none', route);
        devs['dev-H'] = holder; devs['dev-N'] = asker;
        return { holder, asker, log };
    }

    function mkFile(p: string, mib: number) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const b = Buffer.alloc(1 << 20);
        const fd = fs.openSync(p, 'w');
        for (let i = 0; i < mib; i++) { for (let j = 0; j < b.length; j += 4) b.writeUInt32LE(Math.imul(j + i * 977, 2654435761) >>> 0, j); fs.writeSync(fd, b); }
        fs.closeSync(fd);
        return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }

    it('probe: the helper starts and reports the adapter and the password gate; no adapter and radio off are reported', async () => {
        expect(await device('p1', 'ready').bridge.invoke('nearProbe', [])).toMatchObject({ available: true, bluetooth: 'ready', gate: 'password', biometric: 'unavailable', lan: true });
        expect(await device('p2', 'none').bridge.invoke('nearProbe', [])).toMatchObject({ available: true, bluetooth: 'no_adapter' });
        expect(await device('p3', 'off').bridge.invoke('nearProbe', [])).toMatchObject({ bluetooth: 'radio_off' });
    });

    it('the sign-in members are refused by main, the helper never starts for them, and a forged offer starts nothing', async () => {
        const d = device('s1');
        for (const a of ['nearShowStart', 'nearInviteStart', 'nearApproverStart', 'nearBiometricVerify']) {
            await expect(d.bridge.invoke(a, [{ apiBase: BASE, mode: 'qr' }])).rejects.toThrow(/not a near member/);
        }
        expect(d.pid()).toBeUndefined(); // never spawned
        // the helper's own allow-list is independent of main's: ask it directly for a sign-in member
        await d.bridge.invoke('nearProbe', []);
        d.bridge.helper.sendRaw({ t: 'call', id: 900, action: 'nearShowStart', args: [{ apiBase: BASE, mode: 'qr' }] });
        await new Promise((r) => setTimeout(r, 300));
        expect((await d.bridge.invoke('nearGetState', []) as { state: string }).state).toBe('idle');
        // a stale / misaddressed offer from another "device" is ignored by the engine
        const stale = { type: 'near_offer', v: 1, e_pub: 'A'.repeat(43), nonce: 'B'.repeat(22), ts: 1, to: 'dev-H' };
        expect(await d.bridge.invoke('nearOwnDeliver', [{ content: stale, fromDeviceId: 'dev-N', ownDeviceId: 'dev-H' }])).toBe('ignored');
        expect((await d.bridge.invoke('nearGetState', []) as { state: string }).state).toBe('idle');
    });

    it('holder -> receiver: request, password gate, proof on the LAN, K_xfer on both, a forced drop (pause) and a resume, same sha256', async () => {
        const { holder, asker, log } = pair();
        const src = path.join(holder.tmp, 'staging', 'history.enc');
        const sha = mkFile(src, 128);

        await expect(holder.bridge.invoke('nearTransferKey', [])).rejects.toThrow(); // no key before anything happened
        await asker.bridge.invoke('nearTransferRequest', [{ deviceId: 'dev-H', ownDeviceId: 'dev-N' }]);
        // the holder's sheet: its person sees the asking device named, and nothing has moved
        const sheet = await waitState(holder, 'sheet', (x) => x.role === 'own_sender' && x.state === 'awaiting_approval');
        expect(sheet.peer).toMatchObject({ label: 'Linux PC dev-N' });
        await waitState(asker, 'asker waits', (x) => x.role === 'own_receiver' && x.state === 'awaiting_approval');
        await expect(asker.bridge.invoke('nearTransferKey', [])).rejects.toThrow(); // K_xfer withheld before approval

        // approve: main asks the page for the account password, verifies it with the server ITSELF, attests to the helper
        const approving = holder.bridge.invoke('nearApprove', []) as Promise<{ result: string; gate: string }>;
        const prompt = await until('gate prompt', () => holder.prompts.find((p) => !p.closed));
        expect(prompt.method).toBe('password');
        expect(holder.http.map((h) => h[0])).toEqual(['GET']); // the method lookup; nothing approved yet
        expect(await holder.bridge.gateSubmit(prompt.ticket, 'correct horse')).toBe('ok');
        expect(await approving).toEqual({ result: 'approved', gate: 'password' }); // the HMAC main made verified in Rust
        expect(holder.http.map((h) => h[0])).toEqual(['GET', 'POST']);
        // the holder's token never reached the helper: only content / ids are forwarded
        await waitState(asker, 'asker approved', (x) => x.state === 'approved');
        const sent = await waitState(holder, 'holder approved', (x) => x.state === 'approved' && x.proximity === 'lan');
        expect(sent.proximity).toBe('lan'); // no Bluetooth in an own-device transfer

        const kh = await holder.bridge.invoke('nearTransferKey', []) as Uint8Array;
        const kn = await asker.bridge.invoke('nearTransferKey', []) as Uint8Array;
        expect(kh).toBeInstanceOf(Uint8Array); // I2: bytes to the page, never a string
        expect(kh.some((b) => b !== 0)).toBe(true);
        expect(kh).toHaveLength(32);
        expect(Buffer.from(kh).equals(Buffer.from(kn))).toBe(true); // the section 7 key schedule agrees on both devices, nothing about the key was sent

        await asker.bridge.invoke('nearTransferReceive', []);
        await holder.bridge.invoke('nearTransferSend', [{ path: src }]);

        // forced drop: pause closes the connection (abort { paused }); the transfer is interrupted, then resumes on a new connection
        await until('some bytes moved', () => holder.states.some((x) => (x.transfer as { bytesDone?: number } | undefined)?.bytesDone), 60_000);
        await holder.bridge.invoke('nearTransferPause', []);
        await waitState(holder, 'holder paused', (x) => x.state === 'transfer_paused', 60_000);
        await holder.bridge.invoke('nearTransferResume', []);
        await waitState(holder, 'sent', (x) => x.state === 'done', 120_000);
        await waitState(asker, 'received', (x) => x.state === 'done', 120_000);
        expect(Math.max(...asker.states.map((x) => (x.transfer as { attempt?: number } | undefined)?.attempt ?? 0)), 'the receiver reconnected').toBeGreaterThanOrEqual(2);

        const res = await asker.bridge.invoke('nearTransferResult', []) as { path: string; size: number };
        expect(res.path.startsWith(path.join(asker.tmp, 'staging'))).toBe(true);
        expect(crypto.createHash('sha256').update(fs.readFileSync(res.path)).digest('hex')).toBe(sha);

        // what travelled between the devices: an offer, an answer, then sealed near_msg only; every message addressed with `to`
        const types = log.map((m) => m.content.type);
        expect(types[0]).toBe('near_offer');
        expect(types[1]).toBe('near_answer');
        expect(types.slice(2).every((t) => t === 'near_msg')).toBe(true);
        expect(log.every((m) => m.content.to === m.to && m.content.v === 1)).toBe(true);
        const wire = JSON.stringify(log.map((m) => m.content));
        expect(wire).not.toContain('Linux PC');
        expect(wire).not.toContain(TOK_H);
    }, 300_000);

    it('the holder declines: the asker is told "denied", no key exists, nothing was signed or sent', async () => {
        const { holder, asker } = pair();
        await asker.bridge.invoke('nearTransferRequest', [{ deviceId: 'dev-H', ownDeviceId: 'dev-N' }]);
        await waitState(holder, 'sheet', (x) => x.state === 'awaiting_approval');
        await holder.bridge.invoke('nearRefuse', []);
        const told = await waitState(asker, 'refused', (x) => x.state === 'refused');
        expect(told.error).toMatchObject({ code: 'denied' });
        await expect(asker.bridge.invoke('nearTransferKey', [])).rejects.toThrow();
        expect(holder.http.map((h) => h[0]).includes('POST')).toBe(false); // no step-up was ever submitted
    }, 120_000);

    it('a cancelled password prompt declines (nothing approved), the sheet stays, and it can still be refused', async () => {
        const { holder, asker } = pair();
        await asker.bridge.invoke('nearTransferRequest', [{ deviceId: 'dev-H', ownDeviceId: 'dev-N' }]);
        await waitState(holder, 'sheet', (x) => x.state === 'awaiting_approval');
        const approving = holder.bridge.invoke('nearApprove', []) as Promise<{ result: string }>;
        const prompt = await until('gate prompt', () => holder.prompts.find((p) => !p.closed));
        holder.bridge.gateCancel(prompt.ticket);
        expect((await approving).result).toBe('cancelled');
        expect(holder.states.at(-1)!.state).toBe('awaiting_approval');
        expect(asker.states.some((x) => x.state === 'approved')).toBe(false);
        await holder.bridge.invoke('nearRefuse', []);
        expect((await waitState(asker, 'refused', (x) => x.state === 'refused')).state).toBe('refused');
    }, 120_000);

    it('a crash of the helper mid-session reaches the page as a failed state with a rising seq', async () => {
        const { asker } = pair();
        await asker.bridge.invoke('nearTransferRequest', [{ deviceId: 'dev-H', ownDeviceId: 'dev-N' }]);
        await waitState(asker, 'waiting', (x) => x.state === 'awaiting_approval');
        const before = asker.states.at(-1)!.seq as number;
        const pid = asker.pid();
        expect(pid).toBeGreaterThan(1);
        process.kill(pid!, 'SIGKILL'); // the child this test spawned, by pid
        const dead = await waitState(asker, 'failed', (x) => x.state === 'failed' && (x.error as { code: string } | undefined)?.code === 'helper_exited');
        expect(dead.seq as number).toBeGreaterThan(before);
    }, 60_000);
});
