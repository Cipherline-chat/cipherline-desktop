/**
 * Rich Presence → the game-activity pipeline (pure decisions + a tiny pid
 * lookup). main.ts owns the listener (./rpc-ipc-server.ts) and the process
 * scan (./game-detector.ts); this decides what ONE game the user is shown as
 * playing, with which detail lines.
 *
 * Ranking:
 *   - An RPC activity whose app is known (the bundled id map, or the sending
 *     process is a game this computer recognises) OUTRANKS the process scan
 *     and adds its detail lines (round, score, party, time).
 *   - An RPC activity from an unknown app (titled by its own `name`/`details`)
 *     is shown only when the scan found nothing — or enriches the scanned game
 *     when the titles match.
 *   - The ignore list applies to both: the sender's executable, an
 *     `rpc:<application id>` entry, or any ignored executable this computer
 *     names the same as the RPC title.
 */
import { execFile } from 'child_process';
import { winSys } from './win-sys';
import { openSync, readSync, closeSync } from 'fs';
import { basename } from 'path';
import { rpcTitle, gameNameKey, type RpcPresence } from './rpc-activity';
import { matchPatternGame } from './game-detector';

/** Same bound as the API's game_name (MAX_GAME_NAME_LENGTH). */
export const GAME_TITLE_MAX = 100;

export interface GameDetail {
    details: string | null;
    state: string | null;
    partySize: number | null;
    partyMax: number | null;
    /** Epoch ms. */
    start: number | null;
    /** Epoch ms. */
    end: number | null;
}

export interface GameActivity {
    name: string;
    /** What the ignore list operates on: an executable name, or `rpc:<application id>`. */
    processName: string;
    source: 'process' | 'rpc';
    detail: GameDetail | null;
}

export interface ScanGame { name: string; processName: string }

export interface MergeContext {
    appName: (clientId: string) => string | null;
    /** The sending process's executable name (lowercase, no .exe), if the pid resolved. */
    senderProcess: string | null;
    /** What this computer calls that executable, if anything. */
    senderGame: string | null;
    isIgnored: (processName: string) => boolean;
    isNameIgnored: (name: string) => boolean;
}

/** Cap to GAME_TITLE_MAX UTF-16 units (what the API's MaxLength counts), never splitting a surrogate pair. */
export function capTitle(s: string): string {
    if (s.length <= GAME_TITLE_MAX) return s;
    let out = '';
    for (const ch of s) {
        if (out.length + ch.length > GAME_TITLE_MAX - 1) break;
        out += ch;
    }
    return out + '…';
}
const cap = capTitle;

export function detailOf(p: RpcPresence, titleFrom: string): GameDetail | null {
    const d: GameDetail = {
        // A title taken from `details` is not repeated as a detail line.
        details: titleFrom === 'details' ? null : p.details,
        state: p.state,
        partySize: p.party ? p.party.size : null,
        partyMax: p.party ? p.party.max : null,
        start: p.start,
        end: p.end,
    };
    return d.details || d.state || d.partyMax || d.start || d.end ? d : null;
}

export function mergeGameActivity(scan: ScanGame | null, rpc: RpcPresence | null, ctx: MergeContext): GameActivity | null {
    const fromScan = (): GameActivity | null => (scan ? { name: scan.name, processName: scan.processName, source: 'process', detail: null } : null);
    if (!rpc) return fromScan();
    const t = rpcTitle(rpc, { appName: ctx.appName, processGame: ctx.senderGame });
    if (!t) return fromScan();
    const title = cap(t.title);
    const rpcKey = `rpc:${rpc.clientId}`;
    if (ctx.isIgnored(rpcKey) || (ctx.senderProcess && ctx.isIgnored(ctx.senderProcess)) || ctx.isNameIgnored(title)) {
        // Ignored over Rich Presence; the scan still applies on its own terms
        // (unless it is the same game, which isNameIgnored also covered there).
        return scan && gameNameKey(scan.name) === gameNameKey(title) ? null : fromScan();
    }
    const sameAsScan = !!scan && gameNameKey(scan.name) === gameNameKey(title);
    const known = t.from === 'map' || t.from === 'process';
    if (!known && scan && !sameAsScan) return fromScan();
    return {
        name: sameAsScan ? scan!.name : title,
        processName: sameAsScan ? scan!.processName : (ctx.senderProcess ?? rpcKey),
        source: 'rpc',
        detail: detailOf(rpc, t.from),
    };
}

/** Composite identity: a change here is something the renderer must hear about. */
export function activityKey(a: GameActivity | null): string | null {
    if (!a) return null;
    const d = a.detail;
    return JSON.stringify([a.processName, a.name, a.source, d?.details, d?.state, d?.partySize, d?.partyMax, d?.start, d?.end]);
}

// ── The sender's executable, from the pid it announced ─────────────────────

/**
 * RPC-only aliases for clients that report through a child process (FiveM, RedM).
 * The names are the SAME ones the process scan gives (game-detector.ts
 * PATTERN_GAMES), so a game never changes name when its Rich Presence takes over
 * from exe detection. The exact build-numbered game process is tried first via
 * the detector's own matcher; these looser patterns catch the launcher / other
 * sub-processes a client may report from.
 */
const SENDER_ALIASES: Array<[RegExp, string]> = [
    [/^fivem(_[a-z0-9]+)*$/, 'Grand Theft Auto V (FiveM)'],
    [/^redm(_[a-z0-9]+)*$/, 'Red Dead Redemption 2 (RedM)'],
];
export function senderAlias(proc: string): string | null {
    const exact = matchPatternGame(proc);
    if (exact) return exact;
    for (const [re, name] of SENDER_ALIASES) if (re.test(proc)) return name;
    return null;
}

const pidCache = new Map<number, { at: number; name: string | null }>();
const PID_TTL_MS = 60_000;

function linuxPidName(pid: number): string | null {
    const buf = Buffer.alloc(512);
    try {
        const fd = openSync(`/proc/${pid}/cmdline`, 'r');
        try {
            const n = readSync(fd, buf, 0, buf.length, 0);
            const argv0 = buf.toString('utf8', 0, n).split('\0')[0]?.trim() ?? '';
            return argv0 ? basename(argv0.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '') : null;
        } finally { closeSync(fd); }
    } catch { return null; }
}

function execOut(file: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
        execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
}

/**
 * The executable name behind a pid (lowercase, no `.exe`), or null. Cached per
 * pid for a minute. The pid is client-supplied: a liar only mislabels its own
 * activity, and the lookup is a plain read (no shell, integer argument).
 */
export async function processNameForPid(pid: number | null, platform: NodeJS.Platform = process.platform): Promise<string | null> {
    if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
    const hit = pidCache.get(pid);
    if (hit && Date.now() - hit.at < PID_TTL_MS) return hit.name;
    let name: string | null = null;
    if (platform === 'linux') name = linuxPidName(pid);
    else if (platform === 'win32') {
        // The signed win-helper.exe looks the pid up in a process snapshot: no tasklist.exe.
        name = await winSys().pidName(pid);
    } else if (platform === 'darwin') {
        const out = (await execOut('ps', ['-p', String(pid), '-o', 'comm='])).trim();
        name = out ? basename(out).toLowerCase() : null;
    }
    pidCache.set(pid, { at: Date.now(), name });
    if (pidCache.size > 64) pidCache.delete(pidCache.keys().next().value as number);
    return name;
}

// ── "Another app is holding Rich Presence" (one-time hint) ─────────────────

/** How long a known Rich Presence game must run with nothing received before the hint. */
export const HELD_HINT_AFTER_MS = 30_000;

/**
 * Decides when to tell the renderer that a game which normally announces Rich
 * Presence is running, another Rich Presence server (Discord) holds the
 * endpoint, and nothing has reached us for HELD_HINT_AFTER_MS. Fires at most
 * once per game name per run; the renderer adds the once-per-device rule.
 */
export class HeldHintTracker {
    private since: number | null = null;
    private game: string | null = null;
    private readonly fired = new Set<string>();

    /** Returns the game name to hint about, or null. */
    tick(input: { scanGame: string | null; knownRpcGame: boolean; foreignListener: boolean; rpcActive: boolean; enabled: boolean; now: number }): string | null {
        const eligible = input.enabled && !!input.scanGame && input.knownRpcGame && input.foreignListener && !input.rpcActive;
        if (!eligible) { this.since = null; this.game = null; return null; }
        const g = input.scanGame!;
        if (this.game !== g) { this.game = g; this.since = input.now; }
        if (this.since !== null && input.now - this.since >= HELD_HINT_AFTER_MS && !this.fired.has(gameNameKey(g))) {
            this.fired.add(gameNameKey(g));
            return g;
        }
        return null;
    }
}

// ── On / off ────────────────────────────────────────────────────────────────

export interface Startable { start(): Promise<void>; stop(): Promise<void> }

/**
 * The listener exists only while the user shares game activity, and never in
 * the CI smoke test. Starts are serialised with stops, so a quick off/on/off
 * from Settings always ends in the last state asked for.
 */
export class RpcListenerGate {
    private instance: Startable | null = null;
    private wanted = false;
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly deps: { smokeTest: boolean; create: () => Startable }) {}

    get running(): boolean { return this.instance !== null; }

    setEnabled(on: boolean): Promise<void> {
        this.wanted = on && !this.deps.smokeTest;
        this.chain = this.chain.then(() => this.apply()).catch(() => undefined);
        return this.chain;
    }

    private async apply(): Promise<void> {
        if (this.wanted && !this.instance) {
            const inst = this.deps.create();
            this.instance = inst;
            await inst.start();
        } else if (!this.wanted && this.instance) {
            const inst = this.instance;
            this.instance = null;
            await inst.stop();
        }
    }
}
