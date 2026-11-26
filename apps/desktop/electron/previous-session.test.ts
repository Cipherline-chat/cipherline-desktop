import { describe, it, expect } from 'vitest';
import {
    PrevSessionWriter, buildFileText, consumePreviousSessionFile, parsePreviousSessionFile, previousSessionFromFile,
    MAX_PREV_SESSION_BYTES, MAX_PREV_SESSION_READ_BYTES, PREV_SESSION_FILE, PREV_SESSION_MAX_ROWS, PREV_SESSION_NEAR_ROWS, PREV_SESSION_MIN_GAP_MS, PREV_SESSION_WRITE_MS,
    type PerfEntryLike, type PrevSessionFs, type PrevSessionState,
} from './previous-session';
import { SessionLifecycle } from './session-lifecycle';
import { PendingCrashStore, mainScrubber, parsePendingCrashes, type CrashInfoLike, type MarkerFs } from './diagnostics';

/**
 * previous-session: the file a dying session leaves behind, and what the next
 * launch makes of it. One in-memory userData shared between "processes", like
 * the real one (session-lifecycle.test.ts does the same for the marker).
 */

const T0 = Date.UTC(2026, 10, 14, 15, 0, 0);
const MARKER = '/ud/diag-session.json';
const FILE = `/ud/${PREV_SESSION_FILE}`;
const scrubber = () => mainScrubber('/home/alice', 'alice');

type Mem = MarkerFs & PrevSessionFs & { files: Record<string, string>; writes: string[] };
function memFs(initial: Record<string, string> = {}): Mem {
    const files = { ...initial };
    const writes: string[] = [];
    return {
        files, writes,
        readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
        writeFileSync: (p, d) => { files[p] = d; if (p !== MARKER) writes.push(p); }, // the marker has its own tests
        renameSync: (a, b) => { if (!(a in files)) throw new Error('ENOENT'); files[b] = files[a]; delete files[a]; },
        unlinkSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); delete files[p]; },
    };
}

const entry = (secsAgo: number, activity: string, over: Partial<PerfEntryLike> = {}, now = T0): PerfEntryLike =>
    ({ at: now - secsAgo * 1000, source: 'main', ms: 250, activity, ...over });

/** One app process, wired like main.ts startSessionMarker. */
function launch(fs: Mem, o: { at?: number; version?: string; entries?: () => PerfEntryLike[]; state?: () => PrevSessionState; enabled?: boolean } = {}) {
    let t = o.at ?? T0;
    const version = o.version ?? '0.1.0';
    const lc = new SessionLifecycle({ markerEnabled: o.enabled ?? true, fs, markerPath: () => MARKER, appVersion: () => version, now: () => t });
    const store = new PendingCrashStore();
    const writer = new PrevSessionWriter({
        fs, file: FILE, version, now: () => t, entries: o.entries ?? (() => []), state: o.state ?? (() => ({})),
        isArmed: () => lc.armed, scrubber,
    }, o.enabled ?? true);
    return {
        lc, store, writer, fs,
        clock: { advance(ms: number) { t += ms; }, now: () => t },
        /** createWindow after winning the port: judge the previous session, arm ours. */
        start() {
            const leftover = lc.start();
            const prev = (o.enabled ?? true)
                ? consumePreviousSessionFile(fs, FILE, leftover ? Date.parse(leftover.occurred_at) : null, version, t, scrubber)
                : null;
            store.add(leftover, prev);
            writer.start(60_000_000);
            return this;
        },
        pending: () => store.all(),
    };
}

describe('writer: throttling, atomicity, never throws', () => {
    it('writes immediately on start, then at most once per beat; notable events respect the floor', () => {
        const fs = memFs();
        const p = launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        expect(fs.writes.filter(w => w.endsWith('.tmp'))).toHaveLength(1);

        p.clock.advance(3000); p.writer.tick();
        expect(fs.writes).toHaveLength(1); // not due
        p.clock.advance(PREV_SESSION_WRITE_MS); p.writer.tick();
        expect(fs.writes).toHaveLength(2); // due

        p.writer.notable(); // just wrote
        expect(fs.writes).toHaveLength(2);
        p.clock.advance(PREV_SESSION_MIN_GAP_MS); p.writer.notable();
        expect(fs.writes).toHaveLength(3);
    });

    it('is atomic: written to .tmp and renamed, the final file never holds a partial write', () => {
        const fs = memFs();
        launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        expect(fs.writes).toEqual([`${FILE}.tmp`]);
        expect(FILE in fs.files).toBe(true);
        expect(`${FILE}.tmp` in fs.files).toBe(false);
        expect(parsePreviousSessionFile(fs.files[FILE])).not.toBeNull();
    });

    it('never throws out of a write (disk full / EACCES) and stops nothing else', () => {
        const fs = memFs();
        fs.writeFileSync = () => { throw new Error('ENOSPC'); };
        const logs: string[] = [];
        const lc = new SessionLifecycle({ markerEnabled: true, fs, markerPath: () => MARKER, appVersion: () => '0.1.0', now: () => T0 });
        lc.start();
        const w = new PrevSessionWriter({ fs, file: FILE, version: '0.1.0', now: () => T0, entries: () => [], state: () => ({}), isArmed: () => lc.armed, scrubber, onLog: (m) => logs.push(m) }, true);
        expect(() => { w.start(60_000_000); w.tick(); w.notable(); w.finish(); }).not.toThrow();
        expect(logs).toHaveLength(1); // logged once, not per beat
    });

    it('a throwing entries()/state() provider cannot throw out either', () => {
        const fs = memFs();
        const w = new PrevSessionWriter({ fs, file: FILE, version: '0.1.0', now: () => T0, entries: () => { throw new Error('x'); }, state: () => ({}), isArmed: () => true, scrubber }, true);
        expect(() => { w.start(60_000_000); w.tick(); }).not.toThrow();
    });
});

describe('smoke test / disabled: no startup disk writes', () => {
    it('a disabled writer never touches the disk, not even a read or unlink', () => {
        const fs = memFs();
        const calls: string[] = [];
        for (const k of ['readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync'] as const) {
            const orig = fs[k] as (...a: unknown[]) => unknown;
            (fs as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { calls.push(k); return orig(...a); };
        }
        const w = new PrevSessionWriter({ fs, file: FILE, version: '0.1.0', now: () => T0, entries: () => [entry(1, 'a')], state: () => ({}), isArmed: () => true, scrubber }, false);
        w.start(); w.tick(); w.notable(); w.finish();
        expect(calls).toEqual([]);
        expect(w.isRunning).toBe(false);
    });

    it('SessionLifecycle with the marker disabled (smoke) leaves nothing, so nothing is armed to write', () => {
        const fs = memFs();
        const p = launch(fs, { enabled: false, entries: () => [entry(1, 'a')] }).start();
        p.writer.tick(); p.writer.notable();
        expect(fs.writes).toEqual([]);
        expect(Object.keys(fs.files)).toEqual([]);
    });

    it('main.ts gates both the read and the writer on SESSION_MARKER_ENABLED (which excludes the smoke test)', async () => {
        const src = (await import('fs')).readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
        expect(src).toMatch(/SESSION_MARKER_ENABLED = !IS_SMOKE_TEST/);
        expect(src).toMatch(/const consumePreviousSession = [\s\S]{0,200}if \(!SESSION_MARKER_ENABLED/);
        expect(src).toMatch(/const startPrevSessionWriter = [\s\S]{0,120}if \(!SESSION_MARKER_ENABLED/);
    });
});

describe('marker interplay', () => {
    it('crash: leftover marker + file → unclean_exit record carrying previous_session', () => {
        const fs = memFs();
        const a = launch(fs, {
            entries: () => [entry(30, 'ipc:securekv:open', { ms: 900 }), entry(2, 'resume:rehydrate', { source: 'event', ms: 0 })],
            state: () => ({ in_call: true, sharing: false, window_visible: true, window_focused: false }),
        }).start();
        a.clock.advance(40_000); a.writer.tick(); // alive for 40 s, then dies (no quit asked for)

        const b = launch(fs, { at: T0 + 3_600_000 }).start();
        const [rec] = b.pending();
        expect(rec.crash.kind).toBe('unclean_exit');
        const ps = rec.previous_session!;
        expect(ps).toBeDefined();
        expect(ps.started_at).toBe(new Date(T0).toISOString());
        expect(ps.last_written_at).toBe(new Date(T0 + 40_000).toISOString());
        expect(ps.app_version).toBe('0.1.0');
        expect(ps.state).toEqual({ in_call: true, sharing: false, window_visible: true, window_focused: false });
        expect(ps.rows.map(r => r.activity)).toEqual(['ipc:securekv:open', 'resume:rehydrate']);
        expect(ps.rows.every(r => r.t_s <= 0)).toBe(true);
        // consumed: this launch's writer rewrote the file for ITS session, not the dead one
        expect(parsePreviousSessionFile(fs.files[FILE])!.started_at).toBe(T0 + 3_600_000);
    });

    it('clean quit: no marker, no file at will-quit → the next report has no previous_session', () => {
        const fs = memFs();
        const a = launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        a.clock.advance(30_000); a.writer.tick();
        a.lc.beginQuit('before-quit');
        a.clock.advance(5_000); a.writer.tick(); // armed is false: nothing is written any more
        a.writer.finish(); // will-quit
        expect(FILE in fs.files).toBe(false);
        expect(MARKER in fs.files).toBe(false);

        const b = launch(fs, { at: T0 + 60_000 }).start();
        expect(b.pending()).toEqual([]);
    });

    it('a quit asked for stops writes but LEAVES the file (a hung app killed after SIGTERM keeps its evidence)', () => {
        const fs = memFs();
        const a = launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        a.clock.advance(20_000); a.writer.tick();
        const before = fs.files[FILE];
        a.lc.beginQuit('before-quit');
        a.clock.advance(60_000); a.writer.tick(); a.writer.notable();
        expect(fs.files[FILE]).toBe(before);
    });

    it('a quit cut short (SIGKILL after before-quit, no freeze record): no marker, so the file is ignored and deleted', () => {
        const fs = memFs();
        const a = launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        a.lc.beginQuit('quit-and-install'); // marker gone; will-quit never runs
        expect(FILE in fs.files).toBe(true);

        const b = launch(fs, { at: T0 + 60_000 });
        b.start();
        expect(b.pending()).toEqual([]); // no record at all
        expect(parsePreviousSessionFile(fs.files[FILE])!.started_at).toBe(T0 + 60_000); // not the old one
    });

    it('re-arms with the marker after a suspected session end is cancelled', () => {
        const fs = memFs();
        const a = launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        a.lc.suspectSessionEnd();
        a.clock.advance(30_000); a.writer.tick();
        expect(fs.writes).toHaveLength(1);
        a.lc.resumeAfterSuspectedEnd();
        a.clock.advance(1_000); a.writer.tick();
        expect(fs.writes).toHaveLength(2);
    });

    it('hung-exit style record (no marker, expected start from the freeze record) gets the file too', () => {
        const fs = memFs();
        const a = launch(fs, { entries: () => [entry(1, 'ipc:x')] }).start();
        a.clock.advance(15_000); a.writer.tick();
        a.lc.beginQuit('before-quit'); // SIGTERM from the taskbar; then SIGKILL
        const ps = consumePreviousSessionFile(fs, FILE, T0, '0.1.0', T0 + 99_000, scrubber);
        expect(ps?.rows).toHaveLength(1);
        expect(FILE in fs.files).toBe(false);
    });
});

describe('stale / corrupt / foreign files are ignored (and deleted)', () => {
    const good = () => buildFileText({ version: '0.1.0', startedAt: T0, now: T0 + 10_000, state: { in_call: true }, entries: [entry(1, 'ipc:x', {}, T0 + 10_000)], scrubber: scrubber() });
    const consume = (text: string | null, expectedStart: number | null = T0, version = '0.1.0') => {
        const fs = memFs(text === null ? {} : { [FILE]: text, [`${FILE}.tmp`]: 'half' });
        const r = consumePreviousSessionFile(fs, FILE, expectedStart, version, T0 + 3_600_000, scrubber);
        expect(Object.keys(fs.files)).toEqual([]); // consumed whatever it was
        return r;
    };

    it('the good file is accepted (control)', () => { expect(consume(good())?.rows).toHaveLength(1); });
    it('no file', () => { expect(consume(null)).toBeNull(); });
    it('garbage / truncated JSON', () => {
        expect(consume('{"v":1,"version":"0.1.0","started')).toBeNull();
        expect(consume('not json')).toBeNull();
        expect(consume('')).toBeNull();
    });
    it('wrong schema (v, version, timestamps)', () => {
        const o = JSON.parse(good());
        expect(consume(JSON.stringify({ ...o, v: 2 }))).toBeNull();
        expect(consume(JSON.stringify({ ...o, version: 'x; rm -rf' }))).toBeNull();
        expect(consume(JSON.stringify({ ...o, started_at: 'yesterday' }))).toBeNull();
        expect(consume(JSON.stringify({ ...o, written_at: o.started_at - 1 }))).toBeNull();
    });
    it('a file of another app version (an installer replaced the app)', () => { expect(consume(good(), T0, '0.1.1')).toBeNull(); });
    it('a file from an EARLIER session than the marker/freeze record it would attach to', () => {
        expect(consume(good(), T0 + 5 * 60_000)).toBeNull();
        expect(consume(good(), T0 + 1000)).not.toBeNull(); // within tolerance
    });
    it('no record to attach to (expected start unknown)', () => { expect(consume(good(), null)).toBeNull(); });
    it('a written_at in the future', () => {
        const o = JSON.parse(good());
        expect(previousSessionFromFile(JSON.stringify({ ...o, written_at: T0 + 10 * 3_600_000 }), T0, '0.1.0', T0 + 3_600_000, scrubber())).toBeNull();
    });
    it('an oversized file is not even parsed', () => {
        const o = JSON.parse(good());
        o.pad = 'x'.repeat(MAX_PREV_SESSION_READ_BYTES);
        expect(consume(JSON.stringify(o))).toBeNull();
    });
    it('malformed rows inside an otherwise valid file are dropped, not coerced', () => {
        const o = JSON.parse(good());
        o.rows = [
            { t_s: -1, source: 'main', ms: 5, activity: 'ok' },
            { t_s: 5, source: 'main', ms: 5, activity: 'future' },
            { t_s: -1, source: 'evil', ms: 5, activity: 'bad-source' },
            { t_s: -1, source: 'main', ms: -5, activity: 'neg' },
            { t_s: -1, source: 'main', ms: 5, activity: 'C:\\Users\\alice\\secret.docx' },
            { t_s: -1, source: 'main', ms: 5, activity: 'https://evil.example/?token=abc' },
            'x', null,
        ];
        expect(consume(JSON.stringify(o))!.rows.map(r => r.activity)).toEqual(['ok']);
    });
});

describe('privacy: the scrubber runs, and nothing outside the perf_log alphabet gets in', () => {
    const now = T0 + 5_000;
    const build = (entries: PerfEntryLike[]) => buildFileText({ version: '0.1.0', startedAt: T0, now, state: {}, entries, scrubber: scrubber() });

    it('the OS account name inside an otherwise allowed activity is scrubbed on write', () => {
        const text = build([entry(1, 'ipc:alice:open', {}, now), entry(2, 'ipc:other', {}, now)]);
        expect(text).not.toMatch(/alice/i);
        expect(parsePreviousSessionFile(text)!.rows).toHaveLength(2);
    });

    it('rows outside the freeze monitor alphabet (URLs, quotes, braces) never reach the file; a path is scrubbed', () => {
        const text = build([
            entry(1, '/home/alice/Documents/plan.docx', {}, now),
            entry(2, 'GET https://api.cipherline.chat/v1/x?token=abc', {}, now),
            entry(3, '{"msg":"hello bob"}', {}, now),
            entry(4, 'ipc:fine', {}, now),
        ]);
        const rows = parsePreviousSessionFile(text)!.rows;
        expect(rows.map(r => r.activity)).toEqual(['ipc:fine', '<path>']); // the path is in the alphabet, so the scrubber takes it
        expect(text).not.toMatch(/docx|token|bob|cipherline\.chat/);
    });

    it('a hand-edited file is scrubbed AGAIN on read', () => {
        const o = JSON.parse(build([entry(1, 'ipc:x', {}, now)]));
        o.rows[0].activity = 'ipc:alice';
        const ps = previousSessionFromFile(JSON.stringify(o), T0, '0.1.0', now, scrubber())!;
        expect(JSON.stringify(ps)).not.toMatch(/alice/);
    });

    it('state carries booleans under the known names only', () => {
        const text = buildFileText({
            version: '0.1.0', startedAt: T0, now, entries: [], scrubber: scrubber(),
            state: { in_call: true, user: 'alice', sharing: 'yes', evil: true } as unknown as PrevSessionState,
        });
        expect(parsePreviousSessionFile(text)!.state).toEqual({ in_call: true });
    });
});

describe('size cap', () => {
    it('keeps the newest PREV_SESSION_MAX_ROWS rows', () => {
        const now = T0 + 1000;
        const entries = Array.from({ length: 400 }, (_, i) => entry(400 - i, `ipc:row${i}`, {}, now));
        const rows = parsePreviousSessionFile(buildFileText({ version: '0.1.0', startedAt: T0, now, state: {}, entries, scrubber: scrubber() }))!.rows;
        expect(rows).toHaveLength(PREV_SESSION_MAX_ROWS);
        expect(rows[rows.length - 1].activity).toBe('ipc:row399');
    });

    it('drops the OLDEST rows until the file fits the byte cap, even with maximum-length activities', () => {
        const now = T0 + 1000;
        const long = 'ab cd '.repeat(49);
        const entries = Array.from({ length: 200 }, (_, i) => entry(200 - i, `${long}${i % 10}`.slice(0, 300), {}, now));
        const text = buildFileText({ version: '0.1.0', startedAt: T0, now, state: { in_call: true }, entries, scrubber: scrubber() });
        expect(text.length).toBeLessThanOrEqual(MAX_PREV_SESSION_BYTES);
        const rows = parsePreviousSessionFile(text)!.rows;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(PREV_SESSION_MAX_ROWS);
        expect(rows[rows.length - 1].t_s).toBeCloseTo(-1, 0); // newest survived
        // and what the writer puts on disk obeys it too
        const fs = memFs();
        const w = new PrevSessionWriter({ fs, file: FILE, version: '0.1.0', now: () => now, entries: () => entries, state: () => ({}), isArmed: () => true, scrubber }, true);
        w.start(60_000_000);
        expect(fs.files[FILE].length).toBeLessThanOrEqual(MAX_PREV_SESSION_BYTES);
    });
});

describe('persisted with the pending record', () => {
    it('survives the encrypted-store round trip, only on unclean_exit, and re-validates on load', () => {
        const fs = memFs();
        const a = launch(fs, { entries: () => [entry(1, 'ipc:x')], state: () => ({ in_call: true }) }).start();
        a.clock.advance(20_000); a.writer.tick();
        const b = launch(fs, { at: T0 + 100_000 }).start();

        let stored: string | null = null;
        const store = new PendingCrashStore();
        for (const p of b.pending()) store.add(p.crash, p.previous_session);
        store.attach({ read: () => stored, write: (v) => { stored = v; }, clear: () => { stored = null; } }, '0.1.0');
        expect(stored).toContain('previous_session');

        const reloaded = parsePendingCrashes(stored);
        expect(reloaded[0].previous_session?.rows.map(r => r.activity)).toEqual(['ipc:x']);

        // not on another kind
        const other: CrashInfoLike = { kind: 'main_exception', error_name: 'Error', message: 'x', occurred_at: new Date(T0).toISOString() };
        const s2 = new PendingCrashStore();
        s2.add(other, reloaded[0].previous_session);
        expect(s2.all()[0].previous_session).toBeUndefined();

        // a tampered persisted record is narrowed again
        const tampered = JSON.parse(stored!);
        tampered[0].previous_session.rows.push({ t_s: -1, source: 'main', ms: 1, activity: '/home/alice/x' });
        tampered[0].previous_session.started_at = 'nope';
        expect(parsePendingCrashes(tampered)[0].previous_session).toBeUndefined();
    });
});

describe('the transfer trail survives a crash', () => {
    it('keeps the newest `near:` rows even when newer rows of other kinds fill the window, without growing past the two caps', () => {
        const now = T0 + 1000;
        const trail = ['near:state role=sender state=awaiting_approval', 'near:prompt_shown method=password', 'near:capabilities usable=0 peer_usable=1 plan=none elig=0 filt=2', 'near:outcome role=sender state=refused cause=no_usable_network code=no_proximity'];
        const entries = [
            ...trail.map((a, i) => entry(900 - i, a, { source: 'event', ms: 0 }, now)),
            ...Array.from({ length: 300 }, (_, i) => entry(300 - i, `browser ${i}.0% 140MB | total 1100MB`, { source: 'metrics', ms: 0 }, now)),
        ];
        const rows = parsePreviousSessionFile(buildFileText({ version: '0.1.0', startedAt: T0, now, state: {}, entries, scrubber: scrubber() }))!.rows;
        expect(rows).toHaveLength(PREV_SESSION_MAX_ROWS + trail.length);
        expect(rows.slice(0, trail.length).map((r) => r.activity)).toEqual(trail);
        expect(rows[rows.length - 1].activity).toContain('browser 299');
        // a flood of trail rows adds at most PREV_SESSION_NEAR_ROWS beyond the newest window
        const flood = Array.from({ length: 100 }, (_, i) => entry(900 - i, `near:state role=sender state=awaiting_approval n${i}`, { source: 'event', ms: 0 }, now));
        const capped = parsePreviousSessionFile(buildFileText({ version: '0.1.0', startedAt: T0, now, state: {}, entries: [...flood, ...entries.slice(trail.length)], scrubber: scrubber() }))!.rows;
        expect(capped.filter((r) => r.activity.startsWith('near:'))).toHaveLength(PREV_SESSION_NEAR_ROWS);
    });

    it('a MAC address in a row is scrubbed before it is written', () => {
        const now = T0 + 1000;
        const text = buildFileText({ version: '0.1.0', startedAt: T0, now, state: {}, entries: [entry(5, 'near:capabilities mac=aa:bb:cc:dd:ee:ff 192.168.1.20', { source: 'event', ms: 0 }, now)], scrubber: scrubber() });
        expect(text).not.toContain('aa:bb:cc:dd:ee:ff');
        expect(text).not.toContain('192.168.1.20');
        expect(parsePreviousSessionFile(text)!.rows[0].activity).toBe('near:capabilities mac=<mac> <ip>');
    });
});
