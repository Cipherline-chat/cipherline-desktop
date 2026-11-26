import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createNearBridge, isAllowedApiBase, jwtSubject, NEAR_ACTIONS, NEAR_UNAVAILABLE, type NearBridgeDeps } from './near-bridge';
import { attestGate } from './near-helper-client';
import { createNearTrail } from './near-diag';

const NONCE = 'cd'.repeat(32);
// the API signs `{ user_id, sid }` (auth.service.ts), NOT a `sub` claim: the test token has the real shape
const jwtFor = (id: string) => `h.${Buffer.from(JSON.stringify({ user_id: id, sid: "s", exp: 9e9 })).toString("base64url")}.sig`;
const AUTH = { accessToken: jwtFor('user-1'), userId: 'user-1', deviceId: 'dev-A' };
const BASE = 'https://api.cipherline.chat';
const LINK = 'L'.repeat(22);
const OWN = { content: { type: 'near_offer', v: 1, nonce: 'n', e_pub: 'k', ts: 1, to: 'dev-A' }, fromDeviceId: 'dev-B', ownDeviceId: 'dev-A' };

type Responder = (args: unknown[]) => unknown | Promise<unknown>;

/** A scripted helper process: answers `call`s from `responders`, and the test can make it send `req`s / states. */
function scripted(responders: Record<string, Responder> = {}) {
    const ee = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const fd3 = new PassThrough();
    const calls: Array<{ action: string; args: unknown[] }> = [];
    const replies: Array<Record<string, unknown>> = [];
    const say = (o: unknown) => stdout.write(JSON.stringify(o) + '\n');
    let acc = '';
    stdin.on('data', (d: Buffer) => {
        acc += d.toString('utf8');
        let i: number;
        while ((i = acc.indexOf('\n')) >= 0) {
            const m = JSON.parse(acc.slice(0, i)) as Record<string, unknown>;
            acc = acc.slice(i + 1);
            if (m.t === 'hello') setImmediate(() => say({ t: 'ready', v: 1, pid: 1 }));
            else if (m.t === 'call') {
                const action = m.action as string;
                calls.push({ action, args: m.args as unknown[] });
                const r = responders[action];
                void Promise.resolve().then(() => (r ? r(m.args as unknown[]) : null)).then(
                    (value) => say({ t: 'result', id: m.id, ok: true, value }),
                    (e: Error) => say({ t: 'result', id: m.id, ok: false, error: e.message }),
                );
            } else if (m.t === 'reply') replies.push(m);
        }
    });
    const child = Object.assign(ee, { pid: 7, stdin, stdout, stderr: new PassThrough(), stdio: [stdin, stdout, null, fd3], kill: vi.fn() });
    return { child, calls, replies, say };
}

function mk(over: Partial<NearBridgeDeps> = {}, responders: Record<string, Responder> = {}) {
    const h = scripted(responders);
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const http = vi.fn(async (method: string) => (method === 'GET' ? { status: 200, body: { enabled: false, step_up_method: 'password' } } : { status: 200, body: { ok: true } }));
    const deps: NearBridgeDeps = {
        resolveBinary: () => '/res/near-helper',
        spawn: (() => h.child) as never,
        config: () => ({ profile: '/p', stagingDir: '/s', version: '1', deviceLabel: 'PC', platform: 'linux' }),
        isPackaged: true,
        resolveReadable: async (p) => { if (!p.startsWith('/ok/')) throw new Error('Path outside allowed root'); return p; },
        http: http as never,
        send: (channel, payload) => sent.push({ channel, payload }),
        randomHex: () => NONCE.slice(0, 32),
        clientOptions: { randomHex: () => NONCE },
        ...over,
    };
    return { b: createNearBridge(deps), h, sent, deps, http };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('near bridge: arguments are validated, never coerced', () => {
    it('knows exactly the members of the bridge type', () => {
        expect(NEAR_ACTIONS).toHaveLength(15);
        expect(new Set(NEAR_ACTIONS).size).toBe(15);
    });

    it('serves the own-device transfer members and NOT the sign-in ones (same list as the helper SERVED_MEMBERS)', async () => {
        for (const m of ['nearTransferRequest', 'nearOwnDeliver', 'nearApprove', 'nearRefuse', 'nearTransferKey', 'nearTransferPause', 'nearTransferKeepPartial']) expect(NEAR_ACTIONS).toContain(m);
        for (const m of ['nearShowStart', 'nearInviteStart', 'nearApproverStart', 'nearBiometricAvailability', 'nearBiometricVerify']) expect(NEAR_ACTIONS).not.toContain(m);
        const { b, h } = mk();
        for (const a of ['nearShowStart', 'nearInviteStart', 'nearApproverStart', 'nearBiometricVerify']) {
            await expect(b.invoke(a, [{ apiBase: BASE, mode: 'qr', auth: AUTH }]), a).rejects.toThrow(/not a near member/);
        }
        expect(h.calls).toHaveLength(0);
        // and the helper's own list is the same one (read from the Rust source: the two allow-lists must not drift)
        const rust = fs.readFileSync(path.join(__dirname, '../../desktop-host/near-helper/src/lib.rs'), 'utf8');
        const served = [...(/SERVED_MEMBERS: \[&str; \d+\] = \[([^\]]+)\]/.exec(rust)?.[1] ?? '').matchAll(/"(near\w+)"/g)].map((m) => m[1]).sort();
        expect(served).toEqual([...NEAR_ACTIONS].sort());
    });

    it('accepts only the real API as a base (a dev loopback only unpackaged)', () => {
        for (const ok of ['https://api.cipherline.chat', 'https://api-staging.cipherline.chat/']) expect(isAllowedApiBase(ok, true), ok).toBe(true);
        for (const bad of ['http://api.cipherline.chat', 'https://api.cipherline.chat.evil.example', 'https://evil.example', 'https://api.cipherline.chat:8443', 'https://user@api.cipherline.chat', 'https://api.cipherline.chat/v1', 'http://127.0.0.1:3005', 'file:///etc/passwd', 5, null, 'x'.repeat(300)]) {
            expect(isAllowedApiBase(bad, true), String(bad)).toBe(false);
        }
        expect(isAllowedApiBase('http://127.0.0.1:3005', false)).toBe(true);
        expect(isAllowedApiBase('http://127.0.0.1', false)).toBe(false);
        expect(isAllowedApiBase('http://localhost:3005', false)).toBe(false);
    });

    it('rejects malformed arguments without spawning the helper', async () => {
        const { b, h } = mk();
        const bad: Array<[string, unknown[]]> = [
            ['nearTransferSend', [{ path: '/etc/passwd' }]],
            ['nearTransferSend', [{ path: 7 }]],
            ['nearTransferRequest', [{ deviceId: 'a' }]],
            ['nearTransferRequest', [{ deviceId: '', ownDeviceId: 'b' }]],
            ['nearOwnDeliver', [{ content: 'str', fromDeviceId: 'a', ownDeviceId: 'b' }]],
            ['nearOwnDeliver', [{ content: { big: 'x'.repeat(5000) }, fromDeviceId: 'a', ownDeviceId: 'b' }]],
            ['nearOwnDeliver', [{ ...OWN, auth: { ...AUTH, accessToken: '' }, apiBase: BASE }]],
            ['nearOwnDeliver', [{ ...OWN, auth: AUTH, apiBase: 'https://evil.example' }]],
            ['nearOwnDeliver', [{ ...OWN, deviceLabel: 'a\nb' }]],
            ['nearApprove', ['unexpected']],
            ['nearTransferKey', ['unexpected']],
            ['fsReadFile', ['/etc/passwd']],
            ['constructor', []],
        ];
        for (const [action, args] of bad) await expect(b.invoke(action, args), `${action} ${JSON.stringify(args)}`).rejects.toThrow();
        expect(h.calls).toHaveLength(0);
    });

    it('forwards only the known fields of a valid call', async () => {
        const { b, h } = mk({}, { nearOwnDeliver: () => 'delivered', nearTransferRequest: () => ({ seq: 1 }) });
        await b.invoke('nearOwnDeliver', [{ ...OWN, auth: { ...AUTH, extra: 'drop' }, apiBase: BASE, evil: true }]);
        await b.invoke('nearTransferRequest', [{ deviceId: 'dev-B', ownDeviceId: 'dev-A', smuggled: 1 }]);
        // the token and API base are main's (for the step-up check), never forwarded to the helper
        expect(h.calls[0]).toEqual({ action: 'nearOwnDeliver', args: [OWN] });
        expect(h.calls[1]).toEqual({ action: 'nearTransferRequest', args: [{ deviceId: 'dev-B', ownDeviceId: 'dev-A' }] });
    });

    it('resolves a transfer path through the app\'s fs confinement', async () => {
        const { b, h } = mk({}, { nearTransferSend: () => null });
        await b.invoke('nearTransferSend', [{ path: '/ok/backup-staging/x.enc' }]);
        expect(h.calls[0].args).toEqual([{ path: '/ok/backup-staging/x.enc' }]);
    });
});

describe('near bridge: availability', () => {
    it('nearProbe is available only when the helper starts, and says unavailable otherwise', async () => {
        const up = mk({}, { nearProbe: () => ({ bluetooth: 'ready', lan: true, biometric: 'unavailable', gate: 'password' }) });
        expect(await up.b.invoke('nearProbe', [])).toEqual({ bluetooth: 'ready', lan: true, biometric: 'unavailable', gate: 'password', available: true });
        const none = mk({ resolveBinary: () => null });
        expect(await none.b.invoke('nearProbe', [])).toEqual(NEAR_UNAVAILABLE);
        const crash = mk({ spawn: () => { throw new Error('EACCES'); } });
        expect(await crash.b.invoke('nearProbe', [])).toEqual(NEAR_UNAVAILABLE);
    });

    it('does not spawn the helper just to read or stop something', async () => {
        const { b, h } = mk({ resolveBinary: () => { throw new Error('must not resolve'); } });
        expect(await b.invoke('nearGetState', [])).toEqual({ seq: 0, role: null, state: 'idle' });
        expect(await b.invoke('nearCancel', [])).toBeUndefined();
        expect(await b.invoke('nearRefuse', [])).toBeUndefined();
        expect(await b.invoke('nearTransferResult', [])).toBeNull();
        expect(h.calls).toHaveLength(0);
    });

    it('forwards engine state to the page', async () => {
        const { b, h, sent } = mk({}, { nearProbe: () => ({}) });
        await b.invoke('nearProbe', []);
        h.say({ t: 'state', snapshot: { seq: 2, role: 'new_device', state: 'showing_code' } });
        h.say({ t: 'own_out', to: 'dev-9', content: { type: 'near_offer' } });
        await tick();
        expect(sent).toContainEqual({ channel: 'near:state', payload: { seq: 2, role: 'new_device', state: 'showing_code' } });
        expect(sent).toContainEqual({ channel: 'near:own-out', payload: { to: 'dev-9', content: { type: 'near_offer' } } });
    });
});

describe('near bridge: what the helper may ask main to do', () => {
    const reply = (m: { h: ReturnType<typeof scripted> }, rid: number) => m.h.replies.find((r) => r.rid === rid);

    it('signs nothing and installs no link key, whatever the helper asks (sign-in is not part of this build)', async () => {
        const m = mk({}, { nearOwnDeliver: () => 'delivered', nearApprove: () => ({ result: 'approved' }) });
        await m.b.invoke('nearOwnDeliver', [{ ...OWN, auth: AUTH, apiBase: BASE }]);
        const done = m.b.invoke('nearApprove', []); // even inside an approval
        await tick();
        m.h.say({ t: 'req', rid: 1, what: 'identity_pub' });
        m.h.say({ t: 'req', rid: 2, what: 'sign', message: `cipherline-link-approve:v2:user-1:dev-A:${LINK}:${'A'.repeat(43)}=:lan:1795100000` });
        m.h.say({ t: 'req', rid: 3, what: 'install_link', linkId: LINK, ekPrivB64: Buffer.alloc(32, 7).toString('base64'), ekPubB64: 'pub' });
        await tick();
        expect(reply(m, 1)!.value).toEqual({ pub: null });
        expect(reply(m, 2)!.value).toEqual({ sig: null });
        expect(reply(m, 3)!.value).toEqual({ ok: false });
        await done;
    });
});

describe('near bridge: the password gate', () => {
    function gated(httpImpl?: NearBridgeDeps['http']) {
        let release!: () => void;
        const open = new Promise<void>((r) => { release = r; });
        const m = mk(httpImpl ? { http: httpImpl } : {}, { nearOwnDeliver: () => 'delivered', nearApprove: () => open.then(() => ({ result: 'approved', gate: 'password' })) });
        return { ...m, release };
    }
    const prompt = (m: { sent: Array<{ channel: string; payload: unknown }> }) => m.sent.filter((s) => s.channel === 'near:gate-prompt').map((s) => s.payload as { ticket: string; method: string; closed?: boolean });

    async function begin(m: ReturnType<typeof gated>) {
        await m.b.invoke('nearOwnDeliver', [{ ...OWN, auth: AUTH, apiBase: BASE }]); // the holder's session: the offer carried the account token
        const done = m.b.invoke('nearApprove', []);
        await tick();
        m.h.say({ t: 'req', rid: 11, what: 'gate_confirm', title: 't', detail: 'd' });
        await tick(); await tick();
        return done;
    }

    it('asks the page for the secret, verifies it with the server ITSELF, and only then attests approval to the helper', async () => {
        const m = gated();
        const done = begin(m);
        await tick(); await tick();
        const [p] = prompt(m);
        expect(p.method).toBe('password');
        expect(m.http).toHaveBeenCalledWith('GET', `${BASE}/v1/auth/2fa/totp/status`, { Authorization: `Bearer ${AUTH.accessToken}` });
        expect(m.h.replies.find((r) => r.rid === 11)).toBeUndefined(); // nothing is answered before the user types
        // a ticket the page invented does nothing
        expect(await m.b.gateSubmit('nope', 'hunter2')).toBe('expired');
        expect(await m.b.gateSubmit(p.ticket, 'hunter2')).toBe('ok');
        expect(m.http).toHaveBeenLastCalledWith('POST', `${BASE}/v1/auth/2fa/verify-step-up`, { Authorization: `Bearer ${AUTH.accessToken}` }, { password: 'hunter2' });
        await tick();
        const r = m.h.replies.find((x) => x.rid === 11)!;
        expect(r.value).toEqual({ verdict: 'approved' });
        expect(r.attest).toBe(attestGate(NONCE, 11, 'approved'));
        m.release();
        await done;
        // the prompt is closed on the page
        expect(prompt(m).at(-1)).toMatchObject({ ticket: p.ticket, closed: true });
    });

    it('M1: a token issued to another account, or a non-JWT, is refused before it can pin a session; a running session is never re-pointed', async () => {
        const m = gated();
        const bad = [
            { ...AUTH, accessToken: jwtFor('someone-else') },
            { ...AUTH, accessToken: 'not-a-jwt' },
            { ...AUTH, accessToken: `h.${Buffer.from('{"no":"sub"}').toString('base64url')}.s` },
        ];
        for (const auth of bad) await expect(m.b.invoke('nearOwnDeliver', [{ ...OWN, auth, apiBase: BASE }])).rejects.toThrow(/does not belong to this account/);
        await m.b.invoke('nearOwnDeliver', [{ ...OWN, auth: AUTH, apiBase: BASE }]);
        const other = { accessToken: jwtFor('user-2'), userId: 'user-2', deviceId: 'dev-A' };
        await expect(m.b.invoke('nearOwnDeliver', [{ ...OWN, auth: other, apiBase: BASE }])).rejects.toThrow(/already running for another account/);
        // and the gate still checks the PINNED account's token
        const done = m.b.invoke('nearApprove', []);
        await tick();
        m.h.say({ t: 'req', rid: 12, what: 'gate_confirm', title: 't', detail: 'd' });
        await tick(); await tick();
        expect(m.http).toHaveBeenCalledWith('GET', expect.any(String), { Authorization: `Bearer ${AUTH.accessToken}` });
        m.release();
        await done;
    });

    it('uses the authenticator code for an account with 2FA', async () => {
        const http = vi.fn(async (method: string) => (method === 'GET' ? { status: 200, body: { enabled: true, step_up_method: 'totp' } } : { status: 200, body: {} }));
        const m = gated(http as never);
        void begin(m);
        await tick(); await tick(); await tick();
        const [p] = prompt(m);
        expect(p.method).toBe('totp');
        expect(await m.b.gateSubmit(p.ticket, ' 123456 ')).toBe('ok');
        expect(http).toHaveBeenLastCalledWith('POST', `${BASE}/v1/auth/2fa/verify-step-up`, expect.anything(), { code: '123456' });
    });

    it('a wrong secret keeps the prompt open; five wrong ones decline; the server limit is reported', async () => {
        let status = 401;
        const http = vi.fn(async (method: string) => (method === 'GET' ? { status: 200, body: { step_up_method: 'password' } } : { status, body: {} }));
        const m = gated(http as never);
        void begin(m);
        await tick(); await tick(); await tick();
        const [p] = prompt(m);
        expect(await m.b.gateSubmit(p.ticket, 'a')).toBe('rejected');
        status = 429;
        expect(await m.b.gateSubmit(p.ticket, 'a')).toBe('rate_limited');
        status = 503;
        expect(await m.b.gateSubmit(p.ticket, 'a')).toBe('unavailable');
        expect(await m.b.gateSubmit(p.ticket, '')).toBe('rejected');
        status = 401;
        for (let i = 0; i < 3; i++) expect(await m.b.gateSubmit(p.ticket, 'a')).toBe('rejected');
        expect(await m.b.gateSubmit(p.ticket, 'a')).toBe('locked');
        await tick();
        const r = m.h.replies.find((x) => x.rid === 11)!;
        expect(r.value).toEqual({ verdict: 'declined' });
        expect(await m.b.gateSubmit(p.ticket, 'right')).toBe('expired');
    });

    it('cancel, an unreachable server and a request outside an approval all decline', async () => {
        const a = gated();
        void begin(a);
        await tick(); await tick(); await tick();
        const [p] = prompt(a);
        a.b.gateCancel(p.ticket);
        await tick();
        expect(a.h.replies.find((x) => x.rid === 11)!.value).toEqual({ verdict: 'declined' });

        const down = gated((async () => { throw new Error('offline'); }) as never);
        void begin(down);
        await tick(); await tick(); await tick();
        expect(prompt(down)).toHaveLength(0);
        expect(down.h.replies.find((x) => x.rid === 11)!.value).toEqual({ verdict: 'declined' });

        const idle = mk({}, { nearTransferReceive: () => ({}) });
        await idle.b.invoke('nearTransferReceive', []);
        idle.h.say({ t: 'req', rid: 1, what: 'gate_confirm' });
        await tick();
        expect(idle.h.replies.find((x) => x.rid === 1)!.value).toEqual({ verdict: 'declined' });
        expect(idle.http).not.toHaveBeenCalled();
    });

    it('"the PC said no" fix: a re-ask that REPLACES an undecided sheet keeps the step-up session for the new sheet', async () => {
        // the helper cancels the earlier sheet while it handles the re-ask: that session's end ("cancelled") reaches main DURING the
        // call and clears the held session. Found live (2026-11-25): the new sheet's Send then failed at once with no password prompt.
        let release!: () => void;
        const open = new Promise<void>((r) => { release = r; });
        const ref: { h?: ReturnType<typeof scripted> } = {};
        const m = mk({}, {
            nearOwnDeliver: () => { ref.h!.say({ t: 'state', snapshot: { seq: 4, role: 'own_sender', state: 'cancelled' } }); return 'replaced'; },
            nearApprove: () => open.then(() => ({ result: 'approved', gate: 'password' })),
        });
        ref.h = m.h;
        await m.b.invoke('nearOwnDeliver', [{ ...OWN, auth: AUTH, apiBase: BASE }]);
        const done = m.b.invoke('nearApprove', []);
        await tick();
        m.h.say({ t: 'req', rid: 21, what: 'gate_confirm', title: 't', detail: 'd' });
        await tick(); await tick(); await tick();
        const [p] = prompt(m);
        expect(p?.method).toBe('password');
        expect(m.h.replies.find((r) => r.rid === 21)).toBeUndefined();
        expect(await m.b.gateSubmit(p.ticket, 'hunter2')).toBe('ok');
        await tick();
        expect((m.h.replies.find((r) => r.rid === 21)!.value as { verdict: string }).verdict).toBe('approved');
        release(); await done;
    });

    it('an answer that ENDS the session does not leave the token behind', async () => {
        const ref: { h?: ReturnType<typeof scripted> } = {};
        const m = mk({}, { nearOwnDeliver: () => { ref.h!.say({ t: 'state', snapshot: { seq: 5, role: 'own_receiver', state: 'refused' } }); return 'routed'; } });
        ref.h = m.h;
        await m.b.invoke('nearOwnDeliver', [{ ...OWN, content: { ...OWN.content, type: 'near_answer' }, auth: AUTH, apiBase: BASE }]);
        m.h.say({ t: 'req', rid: 22, what: 'gate_confirm', title: 't', detail: 'd' });
        await tick(); await tick();
        expect(m.h.replies.find((x) => x.rid === 22)!.value).toEqual({ verdict: 'declined' });
        expect(m.http).not.toHaveBeenCalled();
    });

    it('a session that ends takes the prompt and the held token with it', async () => {
        const m = gated();
        void begin(m);
        await tick(); await tick(); await tick();
        const [p] = prompt(m);
        m.h.say({ t: 'state', snapshot: { seq: 9, state: 'cancelled' } });
        await tick();
        expect(await m.b.gateSubmit(p.ticket, 'hunter2')).toBe('expired');
        expect(m.http).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything(), expect.anything());
    });
});

describe('jwtSubject (M1 account pin)', () => {
    const tok = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
    it('reads the API\'s real `user_id` claim (the API signs no `sub`), falls back to `sub`, and rejects junk', () => {
        expect(jwtSubject(tok({ user_id: 'u-1', sid: 's' }))).toBe('u-1');
        expect(jwtSubject(tok({ sub: 'u-2' }))).toBe('u-2');
        expect(jwtSubject(tok({ user_id: 'u-3', sub: 'u-4' }))).toBe('u-3');
        expect(jwtSubject(tok({ user_id: '' }))).toBeNull();
        expect(jwtSubject(tok({ user_id: 5 }))).toBeNull();
        expect(jwtSubject('nope')).toBeNull();
        expect(jwtSubject('a.b.c')).toBeNull();
    });
});

describe('K_xfer leaves main as bytes (security finding I2)', () => {
    it('decodes the helper\'s base64 into a 32-byte Uint8Array for the page; anything else is refused', async () => {
        const key = Buffer.alloc(32, 3).toString('base64');
        const { b } = mk({}, { nearTransferKey: () => key });
        const out = await b.invoke('nearTransferKey', []);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Array.from(out as Uint8Array)).toEqual(new Array(32).fill(3));
        const bad = mk({}, { nearTransferKey: () => Buffer.alloc(16, 1).toString('base64') });
        await expect(bad.b.invoke('nearTransferKey', [])).rejects.toThrow('no transfer key');
        const none = mk({}, { nearTransferKey: () => null });
        await expect(none.b.invoke('nearTransferKey', [])).rejects.toThrow('no transfer key');
    });
});

describe('near bridge: the transfer trail for "Report a problem"', () => {
    function traced(httpImpl?: NearBridgeDeps['http'], responders: Record<string, Responder> = {}) {
        const rows: string[] = [];
        const trail = createNearTrail({ event: (name, _ms, detail) => { rows.push(detail ? `${name} ${detail}` : name); } });
        let release!: () => void;
        const open = new Promise<void>((r) => { release = r; });
        const m = mk({ trail, ...(httpImpl ? { http: httpImpl } : {}) }, { nearOwnDeliver: () => 'offer', nearApprove: () => open.then(() => ({ result: 'approved', gate: 'password' })), nearTransferRequest: () => ({ seq: 1 }), ...responders });
        return { ...m, rows, release };
    }

    it('writes the holder\'s attempt: the helper, the offer, the prompt, a wrong then a right password, and the verdict, with no secret in any row', async () => {
        let status = 401;
        const http = vi.fn(async (method: string) => (method === 'GET' ? { status: 200, body: { step_up_method: 'password' } } : { status, body: {} }));
        const m = traced(http as never);
        await m.b.invoke('nearOwnDeliver', [{ ...OWN, auth: AUTH, apiBase: BASE }]);
        const done = m.b.invoke('nearApprove', []);
        await tick();
        m.h.say({ t: 'req', rid: 11, what: 'gate_confirm', title: 't', detail: 'd' });
        await tick(); await tick(); await tick();
        const p = m.sent.filter((s) => s.channel === 'near:gate-prompt').map((s) => s.payload as { ticket: string })[0];
        expect(await m.b.gateSubmit(p.ticket, 'hunter2-wrong')).toBe('rejected');
        status = 200;
        expect(await m.b.gateSubmit(p.ticket, 'hunter2-right')).toBe('ok');
        m.release();
        await done;
        expect(m.rows).toEqual([
            'near:helper_spawned',
            'near:helper_ready',
            'near:offer_received result=offer',
            'near:prompt_shown method=password',
            'near:password_result result=wrong',
            'near:password_result result=ok',
            'near:prompt_closed verdict=approved why=submit',
            'near:approve result=approved',
        ]);
        const all = m.rows.join('\n');
        for (const secret of ['hunter2', 'user-1', 'dev-A', 'dev-B', 'api.cipherline', AUTH.accessToken]) expect(all).not.toContain(secret);
    });

    it('records a request, the control messages that left, the engine\'s outcome with its cause, and the helper\'s exit code', async () => {
        const m = traced();
        await m.b.invoke('nearTransferRequest', [{ deviceId: 'dev-B', ownDeviceId: 'dev-A' }]);
        m.h.say({ t: 'own_out', to: 'dev-B', content: { type: 'near_offer', v: 1, to: 'dev-B' } });
        m.h.say({ t: 'own_out', to: 'dev-B', content: { type: 'near_msg', v: 1, to: 'dev-B' } }); // sealed relay chatter is not trail
        m.h.say({ t: 'state', snapshot: { seq: 1, role: 'own_receiver', state: 'refused', error: { code: 'no_proximity', message: 'refused' }, diag: { dialAttempts: 0, sameSubnet: false, lanResult: 'off_link', lanFail: 'different_network', cause: 'different_network' } } });
        await tick();
        m.h.child.emit('exit', 1, null);
        await tick();
        expect(m.rows).toEqual([
            'near:request',
            'near:helper_spawned',
            'near:helper_ready',
            'near:offer_sent',
            'near:state role=receiver state=refused',
            'near:lan same_subnet=0 dials=0 result=off_link fail=different_network',
            'near:outcome role=receiver state=refused cause=different_network code=no_proximity',
            'near:helper_exited exit=1',
        ]);
    });

    it('a request the helper rejects is recorded as failed, and the trail never changes what the bridge returns or throws', async () => {
        const m = traced(undefined, { nearTransferRequest: () => { throw new Error('boom'); } });
        await expect(m.b.invoke('nearTransferRequest', [{ deviceId: 'dev-B', ownDeviceId: 'dev-A' }])).rejects.toThrow('boom');
        expect(m.rows).toContain('near:request_failed');
        // and a bridge whose sink throws still works
        const quiet = mk({ trail: createNearTrail({ event: () => { throw new Error('sink'); } }) }, { nearTransferRequest: () => ({ seq: 1 }) });
        await expect(quiet.b.invoke('nearTransferRequest', [{ deviceId: 'dev-B', ownDeviceId: 'dev-A' }])).resolves.toEqual({ seq: 1 });
    });
});
