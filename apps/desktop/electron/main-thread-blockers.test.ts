/**
 * Guards for "nothing in electron/ may block the main thread on a child process
 * or the PipeWire daemon". Source scans, because the failure they prevent (a
 * frozen window mid-call, owner report 6cdf2342) is invisible in unit tests:
 * the code runs fine, it just runs on the wrong thread.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FreezeMonitor } from './freeze-monitor';

const DIR = __dirname;
const sources = fs.readdirSync(DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('test-'))
    .map(f => ({ f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));

/** Strip comments so a doc line that NAMES a call is not mistaken for a call. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** file -> why a synchronous child-process / blocking call is acceptable there. Empty on purpose. */
const SYNC_EXEC_ALLOWLIST: Record<string, string> = {};

describe('no synchronous child-process calls in electron/', () => {
    const SYNC = /\b(execFileSync|spawnSync|execSync)\b/;
    it('finds none outside the allowlist', () => {
        const offenders = sources.filter(s => SYNC.test(code(s.text)) && !(s.f in SYNC_EXEC_ALLOWLIST)).map(s => s.f);
        expect(offenders).toEqual([]);
    });
    it('control: the scanner does see a planted call', () => {
        expect(SYNC.test(code('const x = execFileSync("ps", []);'))).toBe(true);
        expect(SYNC.test(code('// execFileSync is banned\n/* spawnSync */ const ok = 1;'))).toBe(false);
    });
    it('the Linux child processes that run during a call are async and bounded', () => {
        const read = (f: string) => code(fs.readFileSync(path.join(DIR, f), 'utf8'));
        expect(read('keyring-bus.ts')).toMatch(/timeout:\s*timeoutMs/);          // busctl: deadline + SIGKILL
        expect(read('game-detector.ts')).toMatch(/CHILD_OPTS = \{ timeout: \d+/);  // ps -eo: 5 s
        expect(read('game-detector.ts')).not.toMatch(/\bexecSync\b/);
        expect(read('annotation-overlay-wayland.ts')).toMatch(/MAX_PIPE_BACKLOG_BYTES/); // helper stdin: bounded, killed when stuck
        expect(read('annotation-overlay-wayland.ts')).toMatch(/HELPER_STEP_TIMEOUT_MS|stepTimeoutMs/);
    });
});

describe('main.ts keeps PipeWire probes off the main thread', () => {
    const main = code(fs.readFileSync(path.join(DIR, 'main.ts'), 'utf8'));
    it('addon.isSupported() is called directly in exactly one place (the no-worker fallback)', () => {
        expect(main.match(/audioCaptureAddon\??\.isSupported\??\.?\(\)/g) ?? []).toHaveLength(1);
        expect(main.match(/audioCaptureAddon\??\.listApps\??\.\(/g) ?? []).toHaveLength(1);
    });
    it('async IPC handlers wait for the offloaded probe instead of calling the sync reader', () => {
        for (const ch of ['audio:list-apps', 'audio:start-window-capture', 'audio:start-app-capture', 'audio:is-capture-supported']) {
            const i = main.indexOf(`'${ch}'`);
            expect(i, ch).toBeGreaterThan(-1);
            const body = main.slice(i, i + 900);
            expect(body, ch).toContain('nativeAudioCaptureReady()');
            expect(body, ch).not.toContain('nativeAudioCaptureAvailable()');
        }
    });
    it('freeze evidence is wired: quit note, renderer events, in-flight hook, gated on the marker switch', () => {
        expect(main).toContain('mainWatchdog?.setRendererUnresponsive(true)');
        expect(main).toContain('mainWatchdog?.setRendererUnresponsive(false)');
        expect(main).toContain('mainWatchdog?.noteQuit()');
        expect(main).toContain('freezeMonitor.inflightHook = wd.board');
        expect(main).toMatch(/if \(!SESSION_MARKER_ENABLED \|\| mainWatchdog\) return null;/);
        // SESSION_MARKER_ENABLED already excludes the smoke test.
        expect(main).toMatch(/const SESSION_MARKER_ENABLED = !IS_SMOKE_TEST/);
    });
});

describe('FreezeMonitor in-flight hook', () => {
    it('mirrors open activities (begin and track, sync and async) and clears them when they end', async () => {
        const open = new Map<number, string>();
        let next = 0;
        const m = new FreezeMonitor();
        m.inflightHook = { enter: (l) => { open.set(next, l); return next++; }, leave: (s) => { open.delete(s); } };
        const end = m.begin('startup:hydrate');
        expect([...open.values()]).toEqual(['startup:hydrate']);
        end();
        end(); // idempotent
        expect(open.size).toBe(0);
        let release!: () => void;
        const p = m.track('ipc:slow', () => new Promise<void>(r => { release = r; }));
        expect([...open.values()]).toEqual(['ipc:slow']);
        release();
        await p;
        await Promise.resolve();
        expect(open.size).toBe(0);
        m.track('ipc:sync', () => { expect([...open.values()]).toEqual(['ipc:sync']); });
        expect(open.size).toBe(0);
    });

    it('a throwing hook never breaks tracking; recentActivityLabels lists labels only', () => {
        const m = new FreezeMonitor();
        m.inflightHook = { enter: () => { throw new Error('boom'); }, leave: () => { throw new Error('boom'); } };
        expect(m.track('ipc:x', () => 7)).toBe(7);
        m.begin('not a label with spaces')();
        expect(m.recentActivityLabels()).toEqual(['unlabelled', 'ipc:x']);
    });
});
