/**
 * The `near*` members of `window.electronAPI` for the local-network history TRANSFER between this account's own devices
 * (Electron build: macOS, Linux and Windows): strict validation of every renderer argument, and the password gate for hosts
 * without a biometric. (`near-helper-client.ts` is the wire; `main.ts` wires this to `ipcMain` and the preload.)
 *
 * SCOPE. This build serves ONLY the own-device transfer members (`NEAR_ACTIONS`). The proximity sign-in members
 * (`nearShowStart`, `nearInviteStart`, `nearApproverStart`, the biometric probes) are not registered, so the preload answers
 * them with the old "not available" shapes, and the helper refuses them as well (`near-helper/src/lib.rs::SERVED_MEMBERS`):
 * two independent allow-lists. Nothing here signs anything with the device identity or installs a link key.
 *
 * THE RENDERER IS NOT TRUSTED with anything that approves a transfer:
 *  - Every argument is validated here (type, length, shape; unknown fields dropped, never forwarded; the API base must be
 *    the real API). The helper validates again (`cl_near_engine::dispatch`): two independent checks.
 *  - Where the platform has no biometric the holder's gate is the account's step-up secret (password, or the authenticator
 *    code for 2FA accounts: the app's existing `verify-step-up` route). The page collects the typed secret; MAIN verifies it
 *    with the server and only then attests the verdict to the helper (an HMAC over the handshake nonce the page never sees).
 *    A forged "verified" from web content has nothing to forge: there is no channel on which the page's say-so is believed.
 *    (Windows Hello is a later item: Windows uses this same password gate.)
 *  - Nothing in main reaches a private address: the helper does all LAN work, main only talks to the public API (the
 *    step-up check), so `net-guard.ts` needs no exemption.
 */
import { randomBytes } from 'node:crypto';
import {
    createNearHelperClient, NearHelperUnavailable,
    type NearHelperClient, type NearHelperConfig, type SpawnFn, type GateVerdict,
} from './near-helper-client';

export const NEAR_UNAVAILABLE = { available: false, bluetooth: 'unsupported', lan: false, biometric: 'unavailable', gate: 'native_confirm' } as const;

/** Every member this build serves: the own-device transfer subset of `types/near.ts` (kept equal to the helper's `SERVED_MEMBERS`). */
export const NEAR_ACTIONS = [
    'nearProbe', 'nearGetState', 'nearApprove', 'nearRefuse', 'nearCancel',
    'nearTransferSend', 'nearTransferReceive', 'nearTransferResult', 'nearTransferDiscard', 'nearTransferPause', 'nearTransferResume',
    'nearTransferKeepPartial', 'nearTransferKey', 'nearTransferRequest', 'nearOwnDeliver',
] as const;
export type NearAction = (typeof NEAR_ACTIONS)[number];

const API_HOSTS = new Set(['api.cipherline.chat', 'api-staging.cipherline.chat']);

/** https to the two API hosts only (plus, in an unpackaged dev build, `http://127.0.0.1:<port>` for the fake server). */
export function isAllowedApiBase(base: unknown, isPackaged: boolean): base is string {
    if (typeof base !== 'string' || base.length > 200) return false;
    let u: URL;
    try { u = new URL(base); } catch { return false; }
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return false;
    if (u.protocol === 'https:' && API_HOSTS.has(u.hostname) && !u.port) return true;
    return !isPackaged && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, name: string): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`${name} has an invalid length`);
    return v;
};
const noControl = (s: string, name: string): string => {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`${name} contains control characters`);
    return s;
};

interface Auth { accessToken: string; userId: string; deviceId: string }
function parseAuth(v: unknown): Auth {
    if (!isObj(v)) throw new Error('auth is required');
    return { accessToken: str(v.accessToken, 4096, 'accessToken'), userId: str(v.userId, 128, 'userId'), deviceId: str(v.deviceId, 128, 'deviceId') };
}
/** The `sub` claim of a JWT, read WITHOUT verifying the signature (main cannot and need not: the server verifies the token). Used only to
 *  compare against the account the page claims, never as proof of anything. `null` when the token is not a JWT with a string `sub`. */
export function jwtSubject(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
        // The API's access token carries `user_id` (apps/api auth.service.ts: jwt.sign({ user_id, sid })); `sub` is read only as a fallback. Reading `sub` alone
        // made every own-device delivery fail "the token does not belong to this account" against the real server (found live, lan-transfer e2e round 2).
        if (!isObj(claims)) return null;
        const id = typeof claims.user_id === 'string' && claims.user_id.length > 0 ? claims.user_id : claims.sub;
        return typeof id === 'string' && id.length > 0 ? id : null;
    } catch { return null; }
}
const parseApiBase = (v: unknown, isPackaged: boolean): string => {
    const b = (v as Record<string, unknown>)?.apiBase;
    if (!isAllowedApiBase(b, isPackaged)) throw new Error('apiBase must be the Cipherline API');
    return b;
};
const noArgs = (a: unknown[]) => { if (a.length > 0 && a[0] !== undefined) throw new Error('unexpected argument'); return []; };

export type StepUpResult = 'ok' | 'rejected' | 'rate_limited' | 'unavailable' | 'locked' | 'expired';
export interface HttpResult { status: number; body: unknown }

export interface NearBridgeDeps {
    resolveBinary: () => string | null;
    spawn: SpawnFn;
    config: () => NearHelperConfig;
    isPackaged: boolean;
    /** The app's fs confinement (`rendererPath('backup-read', p)`): the absolute path the page may read, or a rejection. */
    resolveReadable(p: string): Promise<string>;
    /** HTTPS to the public API (main's own fetch): used ONLY for the step-up check. */
    http(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown): Promise<HttpResult>;
    send(channel: 'near:state' | 'near:own-out' | 'near:gate-prompt', payload: unknown): void;
    log?: (line: string) => void;
    randomHex?: (bytes: number) => string;
    gateTimeoutMs?: number;
    /** Defaults to `process.platform`; passed through to the helper client (Windows: nonce on stdin, three pipes). */
    platform?: NodeJS.Platform;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    /** Test seams for the helper client. */
    clientOptions?: Partial<Parameters<typeof createNearHelperClient>[0]>;
}

interface Session { auth: Auth; apiBase: string }
interface GatePending { ticket: string; method: 'totp' | 'password'; attempts: number; finish: (v: GateVerdict) => void; timer: unknown }

/** The session (and the token held for the step-up check) ends with these; `idle` is a starting state, not an end. */
const ENDED = new Set(['done', 'refused', 'expired', 'cancelled', 'failed']);
const MAX_GATE_ATTEMPTS = 5;

export interface NearBridge {
    invoke(action: string, args: unknown[]): Promise<unknown>;
    gateSubmit(ticket: unknown, value: unknown): Promise<StepUpResult>;
    gateCancel(ticket: unknown): void;
    shutdown(): void;
    /** Test hook. */
    readonly helper: NearHelperClient;
}

export function createNearBridge(deps: NearBridgeDeps): NearBridge {
    const log = deps.log ?? (() => undefined);
    const rnd = deps.randomHex ?? ((n: number) => randomBytes(n).toString('hex'));
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    const gateTimeoutMs = deps.gateTimeoutMs ?? 150_000;

    let session: Session | null = null;
    let approving = 0;
    let gate: GatePending | null = null;

    const finishGate = (v: GateVerdict) => {
        const g = gate;
        if (!g) return;
        gate = null;
        clearTimer(g.timer);
        g.finish(v);
        deps.send('near:gate-prompt', { ticket: g.ticket, method: g.method, closed: true });
    };

    const stepUpMethod = async (s: Session): Promise<'totp' | 'password' | null> => {
        try {
            const r = await deps.http('GET', `${s.apiBase}/v1/auth/2fa/totp/status`, { Authorization: `Bearer ${s.auth.accessToken}` });
            if (r.status !== 200 || !isObj(r.body)) return null;
            if (r.body.step_up_method === 'totp' || r.body.step_up_method === 'password') return r.body.step_up_method;
            return r.body.enabled ? 'totp' : 'password';
        } catch { return null; }
    };

    const helper = createNearHelperClient({
        resolveBinary: deps.resolveBinary,
        spawn: deps.spawn,
        config: deps.config,
        log,
        platform: deps.platform,
        onState: (s) => {
            const st = isObj(s) && typeof s.state === 'string' ? s.state : '';
            deps.send('near:state', s);
            if (ENDED.has(st)) { session = null; finishGate('declined'); }
        },
        onOwnOut: (m) => deps.send('near:own-out', m),
        handlers: {
            gateConfirm: async () => {
                if (!session || approving === 0 || gate) return 'declined';
                const s = session;
                const method = await stepUpMethod(s);
                if (!method || !session || session !== s || approving === 0) return 'declined';
                return new Promise<GateVerdict>((resolve) => {
                    const ticket = rnd(16);
                    const timer = setTimer(() => finishGate('declined'), gateTimeoutMs);
                    gate = { ticket, method, attempts: 0, finish: resolve, timer };
                    deps.send('near:gate-prompt', { ticket, method });
                });
            },
        },
        ...deps.clientOptions,
    });

    /** Per-member validation: the exact argument list forwarded to the helper. */
    const prepare = async (action: NearAction, a: unknown[]): Promise<unknown[]> => {
        const a0 = a[0];
        switch (action) {
            case 'nearProbe': case 'nearGetState': case 'nearApprove': case 'nearRefuse': case 'nearCancel':
            case 'nearTransferReceive': case 'nearTransferResult': case 'nearTransferDiscard': case 'nearTransferPause': case 'nearTransferResume':
            case 'nearTransferKeepPartial': case 'nearTransferKey':
                return noArgs(a);
            case 'nearTransferSend': {
                if (!isObj(a0)) throw new Error('options are required');
                const p = str(a0.path, 4096, 'path');
                return [{ path: await deps.resolveReadable(p) }];
            }
            case 'nearTransferRequest': {
                if (!isObj(a0)) throw new Error('options are required');
                return [{ deviceId: str(a0.deviceId, 128, 'deviceId'), ownDeviceId: str(a0.ownDeviceId, 128, 'ownDeviceId') }];
            }
            case 'nearOwnDeliver': {
                if (!isObj(a0) || !isObj(a0.content)) throw new Error('content must be an object');
                if (JSON.stringify(a0.content).length > 4096) throw new Error('content is too large');
                const out: Record<string, unknown> = { content: a0.content, fromDeviceId: str(a0.fromDeviceId, 128, 'fromDeviceId'), ownDeviceId: str(a0.ownDeviceId, 128, 'ownDeviceId') };
                if (a0.deviceLabel !== undefined) out.deviceLabel = noControl(str(a0.deviceLabel, 64, 'deviceLabel'), 'deviceLabel');
                return [out];
            }
        }
    };

    /** Security finding I2: `K_xfer` crosses into the page as BYTES (a Uint8Array, structured-cloned by IPC), never as a JS string.
     *  A string is immutable and lives in the renderer's heap until a GC that may never come; bytes the page can zero after its one
     *  write or import (`nearHistoryPort` does). The helper's base64 is decoded here and the decode buffer is zeroed; the returned
     *  array is what IPC clones (it is NOT zeroed here: zeroing it before the reply is serialised would hand the page an all-zero
     *  key). The helper's JSON line is still a string in main's heap (out of reach without changing the helper protocol). Anything
     *  that is not exactly 32 bytes is refused. */
    const transferKeyBytes = (v: unknown): Uint8Array => {
        if (typeof v !== 'string' || v.length !== 44) throw new Error('the helper returned no transfer key');
        const buf = Buffer.from(v, 'base64');
        try {
            if (buf.length !== 32) throw new Error('the helper returned no transfer key');
            const out = new Uint8Array(32);
            out.set(buf);
            return out;
        } finally { buf.fill(0); }
    };

    const bridge: NearBridge = {
        helper,
        async invoke(action, args) {
            if (!(NEAR_ACTIONS as readonly string[]).includes(action)) throw new Error('not a near member');
            const act = action as NearAction;
            const forwarded = await prepare(act, args);

            // never spawn the helper just to read or stop something
            if (!helper.running && (act === 'nearGetState')) return helper.lastSnapshot() ?? { seq: 0, role: null, state: 'idle' };
            if (!helper.running && (act === 'nearRefuse' || act === 'nearCancel' || act === 'nearTransferDiscard' || act === 'nearTransferResult')) {
                return act === 'nearTransferResult' ? null : undefined;
            }

            if (act === 'nearProbe') {
                try {
                    const v = await helper.call('nearProbe', []);
                    return isObj(v) ? { ...v, available: true } : NEAR_UNAVAILABLE;
                } catch (e) {
                    if (!(e instanceof NearHelperUnavailable)) log(`near: probe failed: ${(e as Error).message}`);
                    return NEAR_UNAVAILABLE;
                }
            }
            let ownSession: Session | null = null;
            if (act === 'nearOwnDeliver' && isObj(args[0]) && args[0].auth !== undefined) {
                // the holder of an own-device transfer approves with the same step-up gate, which needs this account's token
                const auth = parseAuth(args[0].auth);
                // Account pinning (security round M1). The page cannot be believed about WHOSE password it is asking the server to check:
                // the token must be issued to the account the page names (JWT `sub`, compared, not trusted for auth), and a session that is
                // already running for one account is never re-pointed at another by a later call. (A compromised page that only ever
                // names ITS OWN account still gates its own account; the account a holder sheet speaks for is the one its first offer named.)
                if (jwtSubject(auth.accessToken) !== auth.userId) throw new Error('the token does not belong to this account');
                if (session && session.auth.userId !== auth.userId) throw new Error('a transfer is already running for another account');
                ownSession = { auth, apiBase: parseApiBase(args[0], deps.isPackaged) };
                session = ownSession;
            }
            if (act === 'nearOwnDeliver') {
                const r = await helper.call(act, forwarded);
                // A re-ask REPLACES an undecided sheet ("the PC said no" fix, 2026-11-25): the replaced session's end ("cancelled") reaches
                // main DURING this call and clears `session` (see onState). Re-attach it when the helper says this offer opened a sheet, so
                // the new sheet's Send still reaches the password prompt (found live: it failed at once). Only for a sheet that started: an
                // answer or relay message that ENDED a session must not bring the token back.
                if (ownSession && (r === 'offer' || r === 'replaced')) session = ownSession;
                return r;
            }
            if (act === 'nearApprove') {
                approving += 1;
                try { return await helper.call('nearApprove', [], 240_000); } finally { approving -= 1; }
            }
            if (act === 'nearCancel' || act === 'nearRefuse') {
                finishGate('declined');
            }
            if (act === 'nearTransferKey') return transferKeyBytes(await helper.call(act, forwarded));
            return helper.call(act, forwarded);
        },

        async gateSubmit(ticket, value): Promise<StepUpResult> {
            const g = gate;
            if (!g || typeof ticket !== 'string' || ticket !== g.ticket) return 'expired';
            if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) return 'rejected';
            const s = session;
            if (!s || approving === 0) { finishGate('declined'); return 'expired'; }
            const body = g.method === 'totp' ? { code: value.trim() } : { password: value };
            let r: HttpResult;
            try {
                r = await deps.http('POST', `${s.apiBase}/v1/auth/2fa/verify-step-up`, { Authorization: `Bearer ${s.auth.accessToken}` }, body);
            } catch { return 'unavailable'; }
            if (gate !== g) return 'expired'; // answered, cancelled or timed out while the request was out
            if (r.status >= 200 && r.status < 300) { finishGate('approved'); return 'ok'; }
            if (r.status === 400 || r.status === 401) {
                g.attempts += 1;
                if (g.attempts >= MAX_GATE_ATTEMPTS) { finishGate('declined'); return 'locked'; }
                return 'rejected';
            }
            if (r.status === 429) return 'rate_limited';
            return 'unavailable';
        },

        gateCancel(ticket) {
            if (gate && typeof ticket === 'string' && ticket === gate.ticket) finishGate('declined');
        },

        shutdown() {
            finishGate('declined');
            session = null;
            helper.stop();
        },
    };
    return bridge;
}
