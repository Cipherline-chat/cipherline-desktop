import { describe, it, expect, vi } from 'vitest';
import {
    mergeGameActivity, activityKey, capTitle, senderAlias, HeldHintTracker, HELD_HINT_AFTER_MS, RpcListenerGate,
    GAME_TITLE_MAX, type MergeContext,
} from './rich-presence';
import { gameNameKey, type RpcPresence } from './rpc-activity';

const NOW = 1_800_000_000_000;
const R6_ID = '356876590342340608';
const UNKNOWN_ID = '111111111111111111';

const presence = (o: Partial<RpcPresence> = {}): RpcPresence => ({
    clientId: R6_ID, pid: null, at: NOW, name: null,
    details: 'Ranked • Round 3', state: 'Score 2 – 1', start: NOW - 754_000, end: null,
    party: { size: 2, max: 5 }, assets: { largeImage: 'https://cdn.example/x.png', largeText: null, smallImage: null, smallText: null }, instance: false,
    ...o,
});

const ctx = (o: Partial<MergeContext> = {}): MergeContext => ({
    appName: (id) => (id === R6_ID ? 'Rainbow Six Siege' : null),
    senderProcess: null,
    senderGame: null,
    isIgnored: () => false,
    isNameIgnored: () => false,
    ...o,
});

describe('mergeGameActivity — RPC outranks the scan for the same game and adds detail', () => {
    it('no RPC → the scan, unchanged', () => {
        expect(mergeGameActivity({ name: 'Elden Ring', processName: 'eldenring' }, null, ctx()))
            .toEqual({ name: 'Elden Ring', processName: 'eldenring', source: 'process', detail: null });
        expect(mergeGameActivity(null, null, ctx())).toBeNull();
    });

    it('known RPC app + same game scanned → the scan’s name and exe, with the RPC detail lines', () => {
        const g = mergeGameActivity({ name: 'Rainbow Six Siege', processName: 'rainbowsix' }, presence(), ctx());
        expect(g).toEqual({
            name: 'Rainbow Six Siege', processName: 'rainbowsix', source: 'rpc',
            detail: { details: 'Ranked • Round 3', state: 'Score 2 – 1', partySize: 2, partyMax: 5, start: NOW - 754_000, end: null },
        });
        // Image refs never leave main.
        expect(JSON.stringify(g)).not.toContain('cdn.example');
    });

    it('known RPC app outranks a DIFFERENT scanned game', () => {
        const g = mergeGameActivity({ name: 'Steam Helper Game', processName: 'helper' }, presence(), ctx());
        expect(g).toMatchObject({ name: 'Rainbow Six Siege', source: 'rpc', processName: `rpc:${R6_ID}` });
    });

    it('an app named by its sending process (FiveM with a server-specific id) is known too', () => {
        const g = mergeGameActivity(null, presence({ clientId: UNKNOWN_ID, details: 'Playing on Los Santos RP', state: '42/128 players', party: null }),
            ctx({ senderProcess: 'fivem_b3095_gtaprocess', senderGame: senderAlias('fivem_b3095_gtaprocess') }));
        expect(g).toMatchObject({ name: 'Grand Theft Auto V (FiveM)', processName: 'fivem_b3095_gtaprocess', source: 'rpc', detail: { details: 'Playing on Los Santos RP' } });
    });

    it('an unknown app (titled by its own name/details) never beats a scanned game, but shows alone', () => {
        const unknown = presence({ clientId: UNKNOWN_ID, name: 'Some Tool' });
        expect(mergeGameActivity({ name: 'Elden Ring', processName: 'eldenring' }, unknown, ctx())).toMatchObject({ name: 'Elden Ring', source: 'process' });
        expect(mergeGameActivity(null, unknown, ctx())).toMatchObject({ name: 'Some Tool', source: 'rpc' });
        // Titled by details: the details line is not repeated underneath.
        const byDetails = mergeGameActivity(null, presence({ clientId: UNKNOWN_ID, name: null }), ctx());
        expect(byDetails).toMatchObject({ name: 'Ranked • Round 3', detail: { details: null, state: 'Score 2 – 1' } });
    });

    it('nothing to call it → ignored; never a raw id', () => {
        const g = mergeGameActivity(null, presence({ clientId: UNKNOWN_ID, name: null, details: null }), ctx());
        expect(g).toBeNull();
    });

    it('ignore list: rpc:<id>, the sender exe, or an ignored exe with the same name all hide it', () => {
        const scan = { name: 'Rainbow Six Siege', processName: 'rainbowsix' };
        expect(mergeGameActivity(null, presence(), ctx({ isIgnored: (p) => p === `rpc:${R6_ID}` }))).toBeNull();
        expect(mergeGameActivity(null, presence(), ctx({ senderProcess: 'rainbowsix', isIgnored: (p) => p === 'rainbowsix' }))).toBeNull();
        expect(mergeGameActivity(scan, presence(), ctx({ isNameIgnored: (n) => gameNameKey(n) === gameNameKey('Rainbow Six Siege') }))).toBeNull();
        // Ignoring the RPC app leaves an unrelated scanned game alone.
        expect(mergeGameActivity({ name: 'Chess', processName: 'chess' }, presence(), ctx({ isIgnored: (p) => p.startsWith('rpc:') })))
            .toMatchObject({ name: 'Chess', source: 'process' });
    });

    it('titles are capped to the API’s 100 UTF-16 units without splitting a surrogate pair', () => {
        const long = '🎮'.repeat(80);
        const c = capTitle(long);
        expect(c.length).toBeLessThanOrEqual(GAME_TITLE_MAX);
        expect(c.endsWith('…')).toBe(true);
        expect(/[\uD800-\uDBFF]$/.test(c.slice(0, -1))).toBe(false);
        expect(capTitle('short')).toBe('short');
    });

    it('activityKey changes with a new round line (so the renderer hears it) and not otherwise', () => {
        const a = mergeGameActivity(null, presence(), ctx());
        const b = mergeGameActivity(null, presence({ at: NOW + 5 }), ctx());
        const c = mergeGameActivity(null, presence({ details: 'Ranked • Round 4' }), ctx());
        expect(activityKey(a)).toBe(activityKey(b));
        expect(activityKey(a)).not.toBe(activityKey(c));
        expect(activityKey(null)).toBeNull();
    });
});

describe('HeldHintTracker — "another app is holding Rich Presence"', () => {
    const base = { scanGame: 'Rainbow Six Siege', knownRpcGame: true, foreignListener: true, rpcActive: false, enabled: true };

    it('fires once, after HELD_HINT_AFTER_MS of a known game with nothing received while another server holds the endpoint', () => {
        const t = new HeldHintTracker();
        expect(t.tick({ ...base, now: NOW })).toBeNull();
        expect(t.tick({ ...base, now: NOW + HELD_HINT_AFTER_MS - 1 })).toBeNull();
        expect(t.tick({ ...base, now: NOW + HELD_HINT_AFTER_MS })).toBe('Rainbow Six Siege');
        expect(t.tick({ ...base, now: NOW + HELD_HINT_AFTER_MS + 60_000 })).toBeNull(); // once per game per run
    });

    it.each([
        ['no foreign server (we hold the endpoint)', { foreignListener: false }],
        ['RPC is actually arriving', { rpcActive: true }],
        ['the game is not a known Rich Presence app', { knownRpcGame: false }],
        ['no game running', { scanGame: null }],
        ['game activity off (listener not running)', { enabled: false }],
    ])('never fires when %s', (_n, o) => {
        const t = new HeldHintTracker();
        t.tick({ ...base, ...o, now: NOW });
        expect(t.tick({ ...base, ...o, now: NOW + 10 * HELD_HINT_AFTER_MS })).toBeNull();
    });

    it('the 30 s window restarts when the condition breaks', () => {
        const t = new HeldHintTracker();
        t.tick({ ...base, now: NOW });
        t.tick({ ...base, rpcActive: true, now: NOW + 20_000 });
        expect(t.tick({ ...base, now: NOW + 35_000 })).toBeNull();
        expect(t.tick({ ...base, now: NOW + 35_000 + HELD_HINT_AFTER_MS })).toBe('Rainbow Six Siege');
    });
});

describe('RpcListenerGate — on/off with the setting, never under the smoke test', () => {
    const fake = () => {
        const inst = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
        return { inst, create: vi.fn(() => inst) };
    };

    it('starts on true, stops on false, and repeats', async () => {
        const f = fake();
        const g = new RpcListenerGate({ smokeTest: false, create: f.create });
        expect(g.running).toBe(false);
        await g.setEnabled(true);
        expect(g.running).toBe(true);
        expect(f.inst.start).toHaveBeenCalledTimes(1);
        await g.setEnabled(true);                      // idempotent
        expect(f.create).toHaveBeenCalledTimes(1);
        await g.setEnabled(false);
        expect(g.running).toBe(false);
        expect(f.inst.stop).toHaveBeenCalledTimes(1);
        await g.setEnabled(true);
        expect(f.create).toHaveBeenCalledTimes(2);
    });

    it('a quick on/off/on/off from Settings ends OFF', async () => {
        const f = fake();
        const g = new RpcListenerGate({ smokeTest: false, create: f.create });
        void g.setEnabled(true); void g.setEnabled(false); void g.setEnabled(true);
        await g.setEnabled(false);
        expect(g.running).toBe(false);
    });

    it('never starts under the CI smoke test (positive control above starts the same fake)', async () => {
        const f = fake();
        const g = new RpcListenerGate({ smokeTest: true, create: f.create });
        await g.setEnabled(true);
        expect(g.running).toBe(false);
        expect(f.create).not.toHaveBeenCalled();
    });
});

describe('processNameForPid', () => {
    it.skipIf(process.platform !== 'linux')('names a live pid from /proc (this test runner is node)', async () => {
        const { processNameForPid } = await import('./rich-presence');
        expect(await processNameForPid(process.pid, 'linux')).toMatch(/node/);
        expect(await processNameForPid(null, 'linux')).toBeNull();
        expect(await processNameForPid(-5, 'linux')).toBeNull();
        expect(await processNameForPid(0x7ffffffe, 'linux')).toBeNull(); // no such process
    });
});

describe('main.ts wiring (source checks)', () => {
    it('the listener is gated on IS_SMOKE_TEST and on an explicit true from the renderer; no TCP/WebSocket listener exists', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
        expect(main).toMatch(/new RpcListenerGate\(\{\s*smokeTest: IS_SMOKE_TEST,/);
        expect(main).toMatch(/rpcGate\.setEnabled\(enabled === true\)/);
        // Code only (the doc comment explains the WebSocket port it deliberately does NOT open).
        const server = readFileSync(join(__dirname, 'rpc-ipc-server.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Only path-based listen; no port, no host, no ws.
        expect(server).toMatch(/server\.listen\(\{ path: p,/);
        expect(server).not.toMatch(/listen\(\s*\d|\bport\s*:|\bhost\s*:|6463|WebSocket|require\('ws'\)|from 'ws'|createServer\(\s*\)\.listen\(\d/);
        // Positive control: the same check DOES see a port listen.
        expect('server.listen({ port: 6463 })').toMatch(/listen\(\s*\d|port\s*:|6463/);
    });
});

// A game must not change name when its Rich Presence takes over from the
// process scan: FiveM / RedM use the detector's names (game-detector PATTERN_GAMES).
describe('sender aliases use the process scan names', () => {
    it('FiveM and RedM game and helper processes', () => {
        expect(senderAlias('fivem_b3095_gtaprocess')).toBe('Grand Theft Auto V (FiveM)');
        expect(senderAlias('fivem_gtaprocess')).toBe('Grand Theft Auto V (FiveM)');
        expect(senderAlias('fivem')).toBe('Grand Theft Auto V (FiveM)');
        expect(senderAlias('redm_b1491_gtaprocess')).toBe('Red Dead Redemption 2 (RedM)');
        expect(senderAlias('redm')).toBe('Red Dead Redemption 2 (RedM)');
        expect(senderAlias('gta5')).toBeNull();
        expect(senderAlias('fivemx')).toBeNull();
    });
});
