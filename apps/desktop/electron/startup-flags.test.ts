import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    parseStartupFlags, validateStartupFlagsPatch, serializeStartupFlags, readStartupFlagsFile,
    writeStartupFlagsFile, resolveStartupFlags, prepareCaptureLogFiles, enforceCaptureLogCap,
    DEFAULT_STARTUP_FLAGS, STARTUP_FLAGS_MAX_BYTES, CAPTURE_LOG_FILENAME, CAPTURE_LOG_PREV_FILENAME,
    type StartupFlags,
} from './startup-flags';

describe('parseStartupFlags', () => {
    it('reads exactly what serializeStartupFlags writes', () => {
        const f: StartupFlags = { screenCapturer: 'dxgi', captureLog: true };
        expect(parseStartupFlags(serializeStartupFlags(f))).toEqual(f);
        expect(parseStartupFlags(serializeStartupFlags({ screenCapturer: 'wgc', captureLog: false })))
            .toEqual({ screenCapturer: 'wgc', captureLog: false });
    });

    it.each([
        ['empty', ''],
        ['null', null],
        ['undefined', undefined],
        ['malformed JSON', '{"screenCapturer": "dxgi",'],
        ['a JSON array', '["dxgi", true]'],
        ['a JSON string', '"dxgi"'],
        ['JSON null', 'null'],
        ['a number', '42'],
    ])('%s → all defaults', (_label, text) => {
        expect(parseStartupFlags(text as string | null | undefined)).toEqual(DEFAULT_STARTUP_FLAGS);
    });

    it('falls back per field: a bad value resets only that field', () => {
        expect(parseStartupFlags('{"screenCapturer":"gdi","captureLog":true}'))
            .toEqual({ screenCapturer: 'auto', captureLog: true });
        expect(parseStartupFlags('{"screenCapturer":"wgc","captureLog":"true"}'))
            .toEqual({ screenCapturer: 'wgc', captureLog: false });
    });

    it('is exact, not lenient: no case folding, trimming or truthy coercion', () => {
        expect(parseStartupFlags('{"screenCapturer":"DXGI"}').screenCapturer).toBe('auto');
        expect(parseStartupFlags('{"screenCapturer":" dxgi "}').screenCapturer).toBe('auto');
        expect(parseStartupFlags('{"captureLog":1}').captureLog).toBe(false);
        expect(parseStartupFlags('{"captureLog":"1"}').captureLog).toBe(false);
    });

    it('ignores unknown keys and does not honour inherited ones', () => {
        expect(parseStartupFlags('{"captureLog":true,"enable-logging":"stderr","vmodule":"*=9"}'))
            .toEqual({ screenCapturer: 'auto', captureLog: true });
        expect(parseStartupFlags('{"__proto__":{"captureLog":true}}')).toEqual(DEFAULT_STARTUP_FLAGS);
    });

    it('ignores oversized text unread', () => {
        const big = JSON.stringify({ captureLog: true, pad: 'x'.repeat(STARTUP_FLAGS_MAX_BYTES) });
        expect(parseStartupFlags(big)).toEqual(DEFAULT_STARTUP_FLAGS);
    });
});

describe('validateStartupFlagsPatch (IPC trust boundary)', () => {
    it('accepts known keys with exact values, alone or together', () => {
        expect(validateStartupFlagsPatch({ screenCapturer: 'wgc' })).toEqual({ screenCapturer: 'wgc' });
        expect(validateStartupFlagsPatch({ captureLog: false })).toEqual({ captureLog: false });
        expect(validateStartupFlagsPatch({ screenCapturer: 'auto', captureLog: true }))
            .toEqual({ screenCapturer: 'auto', captureLog: true });
        expect(validateStartupFlagsPatch({})).toEqual({});
    });

    it.each([
        ['null', null],
        ['a string', 'dxgi'],
        ['an array', ['dxgi']],
        ['an unknown key', { vmodule: '*=2' }],
        ['a known plus an unknown key', { captureLog: true, logFile: '/etc/passwd' }],
        ['a bad capturer', { screenCapturer: 'gdi' }],
        ['a capturer in the wrong case', { screenCapturer: 'DXGI' }],
        ['a non-boolean captureLog', { captureLog: 'true' }],
        ['a numeric captureLog', { captureLog: 1 }],
    ])('rejects %s', (_label, input) => {
        expect(() => validateStartupFlagsPatch(input)).toThrow();
    });
});

describe('resolveStartupFlags — env > file > default', () => {
    const file: StartupFlags = { screenCapturer: 'dxgi', captureLog: true };

    it('default when neither env nor file sets anything', () => {
        const r = resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS }, env: {}, packaged: true });
        expect(r).toEqual({ screenCapturer: 'auto', captureLog: false, source: { screenCapturer: 'default', captureLog: 'default' } });
    });

    it('file wins over default', () => {
        const r = resolveStartupFlags({ file, env: {}, packaged: true });
        expect(r).toEqual({ screenCapturer: 'dxgi', captureLog: true, source: { screenCapturer: 'file', captureLog: 'file' } });
    });

    it('env wins over file (dev build)', () => {
        const r = resolveStartupFlags({
            file, env: { CIPHERLINE_SCREEN_CAPTURER: 'wgc', CIPHERLINE_CAPTURE_LOG: '0' }, packaged: false,
        });
        expect(r).toEqual({ screenCapturer: 'wgc', captureLog: false, source: { screenCapturer: 'env', captureLog: 'env' } });
    });

    it('an env capturer that is set but unrecognised still wins, as auto (the pre-existing env semantics)', () => {
        const r = resolveStartupFlags({ file, env: { CIPHERLINE_SCREEN_CAPTURER: 'gdi' }, packaged: true });
        expect(r.screenCapturer).toBe('auto');
        expect(r.source.screenCapturer).toBe('env');
    });

    it('an empty or blank env var counts as unset', () => {
        const r = resolveStartupFlags({ file, env: { CIPHERLINE_SCREEN_CAPTURER: '  ', CIPHERLINE_CAPTURE_LOG: '' }, packaged: false });
        expect(r.source).toEqual({ screenCapturer: 'file', captureLog: 'file' });
    });

    it('CIPHERLINE_SCREEN_CAPTURER applies in a packaged build too (as it always did)', () => {
        expect(resolveStartupFlags({ file, env: { CIPHERLINE_SCREEN_CAPTURER: 'wgc' }, packaged: true }).screenCapturer).toBe('wgc');
    });

    it('CIPHERLINE_CAPTURE_LOG is ignored in a packaged build — Settings only there', () => {
        const on = resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS }, env: { CIPHERLINE_CAPTURE_LOG: '1' }, packaged: true });
        expect(on.captureLog).toBe(false);
        expect(on.source.captureLog).toBe('default');
        const off = resolveStartupFlags({ file, env: { CIPHERLINE_CAPTURE_LOG: '0' }, packaged: true });
        expect(off.captureLog).toBe(true);
        expect(off.source.captureLog).toBe('file');
    });

    it('dev: CIPHERLINE_CAPTURE_LOG=1 turns it on, anything else set turns it off', () => {
        const base = { file: { ...DEFAULT_STARTUP_FLAGS }, packaged: false };
        expect(resolveStartupFlags({ ...base, env: { CIPHERLINE_CAPTURE_LOG: '1' } }).captureLog).toBe(true);
        expect(resolveStartupFlags({ ...base, env: { CIPHERLINE_CAPTURE_LOG: 'yes' } }).captureLog).toBe(false);
    });
});

describe('startup-flags.json and capture-log files on disk', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-startup-flags-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const flagsPath = () => path.join(dir, 'startup-flags.json');
    const cur = () => path.join(dir, CAPTURE_LOG_FILENAME);
    const prev = () => path.join(dir, CAPTURE_LOG_PREV_FILENAME);

    it('write → read round-trips and leaves no temp file', () => {
        writeStartupFlagsFile(flagsPath(), { screenCapturer: 'wgc', captureLog: true });
        expect(readStartupFlagsFile(flagsPath())).toEqual({ screenCapturer: 'wgc', captureLog: true });
        expect(fs.readdirSync(dir)).toEqual(['startup-flags.json']);
    });

    it('read never throws: missing file, a directory, oversized, garbage → defaults', () => {
        expect(readStartupFlagsFile(flagsPath())).toEqual(DEFAULT_STARTUP_FLAGS);
        fs.mkdirSync(flagsPath());
        expect(readStartupFlagsFile(flagsPath())).toEqual(DEFAULT_STARTUP_FLAGS);
        fs.rmdirSync(flagsPath());
        fs.writeFileSync(flagsPath(), '{"captureLog":true}' + ' '.repeat(STARTUP_FLAGS_MAX_BYTES));
        expect(readStartupFlagsFile(flagsPath())).toEqual(DEFAULT_STARTUP_FLAGS);
        fs.writeFileSync(flagsPath(), Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
        expect(readStartupFlagsFile(flagsPath())).toEqual(DEFAULT_STARTUP_FLAGS);
    });

    it('log off: deletes a stale log and its previous generation', () => {
        fs.writeFileSync(cur(), 'old');
        fs.writeFileSync(prev(), 'older');
        prepareCaptureLogFiles(dir, false);
        expect(fs.existsSync(cur())).toBe(false);
        expect(fs.existsSync(prev())).toBe(false);
    });

    it('log off with nothing on disk is a no-op, not a throw', () => {
        expect(() => prepareCaptureLogFiles(dir, false)).not.toThrow();
        expect(() => prepareCaptureLogFiles(path.join(dir, 'missing'), false)).not.toThrow();
    });

    it('log on: keeps the last launch as .prev and starts this one empty', () => {
        fs.writeFileSync(cur(), 'last launch');
        fs.writeFileSync(prev(), 'launch before that');
        prepareCaptureLogFiles(dir, true);
        expect(fs.readFileSync(cur(), 'utf8')).toBe('');
        expect(fs.readFileSync(prev(), 'utf8')).toBe('last launch');
    });

    it('log on: an over-cap previous log is dropped rather than kept', () => {
        fs.writeFileSync(cur(), 'x'.repeat(200));
        fs.writeFileSync(prev(), 'stale');
        prepareCaptureLogFiles(dir, true, 100);
        expect(fs.readFileSync(cur(), 'utf8')).toBe('');
        expect(fs.existsSync(prev())).toBe(false);
    });

    it('running cap truncates only once the file is over the limit', async () => {
        fs.writeFileSync(cur(), 'x'.repeat(100));
        expect(await enforceCaptureLogCap(cur(), 100)).toBe(false);
        expect(fs.statSync(cur()).size).toBe(100);
        fs.appendFileSync(cur(), 'y');
        expect(await enforceCaptureLogCap(cur(), 100)).toBe(true);
        expect(fs.statSync(cur()).size).toBe(0);
        expect(await enforceCaptureLogCap(path.join(dir, 'missing.log'), 100)).toBe(false);
    });

    it('an O_APPEND writer keeps writing at the new end after a running-cap truncate', async () => {
        // Chromium holds the log open for append; after we truncate, its next
        // line must land at offset 0, not leave a hole of NULs up to its old offset.
        const fd = fs.openSync(cur(), 'a');
        try {
            fs.writeSync(fd, 'x'.repeat(150));
            expect(await enforceCaptureLogCap(cur(), 100)).toBe(true);
            fs.writeSync(fd, 'after\n');
        } finally {
            fs.closeSync(fd);
        }
        expect(fs.readFileSync(cur(), 'utf8')).toBe('after\n');
    });
});
