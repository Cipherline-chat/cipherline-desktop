import { describe, it, expect, vi, beforeEach } from 'vitest';

// Count every child process the detector starts. The point of the rework is
// that a normal poll starts none (Linux) or exactly one tasklist (Windows) —
// never a shell, and never PowerShell unless a Java process exists.
const spawned: Array<{ file: string; args: readonly string[] }> = [];
vi.mock('child_process', () => ({
    execFile: (file: string, args: readonly string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        spawned.push({ file, args });
        cb(null, { stdout: '', stderr: '' });
    },
    exec: (cmd: string, _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
        spawned.push({ file: 'SHELL', args: [cmd] });
        cb(null, { stdout: '', stderr: '' });
    },
}));

const gd = await import('./game-detector');

beforeEach(() => {
    spawned.length = 0;
    gd.__resetGameDetectorForTests();
});

describe('process-list parsing', () => {
    it('parses tasklist CSV into bare lowercase names', () => {
        const out = '"System Idle Process","0","Services","0","8 K"\r\n"Cipherline.exe","1234","Console","1","200,000 K"\r\n"javaw.exe","99","Console","1","1 K"\r\n';
        expect(gd.parseTasklistCsv(out)).toEqual(['system idle process', 'cipherline', 'javaw']);
    });

    it('takes argv[0]\'s basename from a /proc cmdline blob', () => {
        expect(gd.procCmdlineName('/usr/lib/jvm/java-21/bin/java\0-jar\0mc.jar\0')).toBe('java');
        expect(gd.procCmdlineName('Steam\0')).toBe('steam');
        expect(gd.procCmdlineName('')).toBe('');
    });

    it('only a Java process can be Minecraft Java Edition', () => {
        expect(gd.mayBeMinecraftJava(['explorer', 'cipherline'])).toBe(false);
        expect(gd.mayBeMinecraftJava(['javaw'])).toBe(true);
        expect(gd.mayBeMinecraftJava(['java'])).toBe(true);
        expect(gd.mayBeMinecraftJava(['/library/java/jdk/bin/java'])).toBe(true); // macOS ps comm=
    });
});

describe('poll policy', () => {
    const base = { enabled: true, suspended: false, systemIdleSec: 0, onBattery: false };
    it('keeps the 10 s cadence while someone is using the machine on mains power', () => {
        expect(gd.nextGamePollDelayMs(base)).toBe(gd.GAME_POLL_MS);
        expect(gd.GAME_POLL_MS).toBe(10_000);
    });
    it('slows down on battery and when nobody is at the PC', () => {
        expect(gd.nextGamePollDelayMs({ ...base, onBattery: true })).toBe(gd.GAME_POLL_BATTERY_MS);
        expect(gd.nextGamePollDelayMs({ ...base, systemIdleSec: gd.GAME_AWAY_IDLE_SEC })).toBe(gd.GAME_POLL_AWAY_MS);
    });
    it('does not poll at all while asleep or with game activity switched off', () => {
        expect(gd.nextGamePollDelayMs({ ...base, suspended: true })).toBeNull();
        expect(gd.nextGamePollDelayMs({ ...base, enabled: false })).toBeNull();
    });
});

describe('detectCurrentGame', () => {
    it.runIf(process.platform === 'linux')('a Linux poll with no game and no Java starts NO child process (it used to fork a shell loop per poll)', async () => {
        const procs = await gd.getRunningProcessList();
        expect(procs.length).toBeGreaterThan(0);              // really read /proc
        if (gd.mayBeMinecraftJava(procs)) return;             // a JVM on the test box: the guard rightly lets it through
        await gd.detectCurrentGame();
        expect(spawned).toEqual([]);
    });

    it('concurrent callers share one scan, and the cached accessor reuses a fresh answer', async () => {
        const a = gd.detectCurrentGame();
        const b = gd.detectCurrentGame();
        expect(a).toBe(b);
        await a;
        // A fresh answer is reused: had getCurrentGameCached started a scan,
        // the next detectCurrentGame() would have joined that same promise.
        const cached = gd.getCurrentGameCached(60_000);
        const fresh = gd.detectCurrentGame();
        expect(cached).not.toBe(fresh);
        await fresh;
        // With maxAge 0 there is no reuse: it joins/starts a real scan.
        const stale = gd.getCurrentGameCached(-1);
        expect(stale).toBe(gd.detectCurrentGame());
        await stale;
    });
});
