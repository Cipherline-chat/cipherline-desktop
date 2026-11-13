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
        const f: StartupFlags = { screenCapturer: 'dxgi', captureLog: true, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true };
        expect(parseStartupFlags(serializeStartupFlags(f))).toEqual(f);
        expect(parseStartupFlags(serializeStartupFlags({ screenCapturer: 'wgc', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true })))
            .toEqual({ screenCapturer: 'wgc', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true });
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
            .toEqual({ screenCapturer: 'auto', captureLog: true, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
        expect(parseStartupFlags('{"screenCapturer":"wgc","captureLog":"true"}'))
            .toEqual({ screenCapturer: 'wgc', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
    });

    it('gamingVideo is ON by default (it used to be off)', () => {
        expect(DEFAULT_STARTUP_FLAGS.gamingVideo).toBe(true);
        expect(parseStartupFlags('').gamingVideo).toBe(true);
    });

    // The migration: the call-only "Prioritize call video while gaming" toggle (OFF by
    // default, key `gamingVideo`) became "Prioritize calls and screen share while gaming"
    // (ON by default, SAME key - there is no second key to migrate from).
    it.each([
        ['old ON (stored true) stays ON', '{"screenCapturer":"auto","captureLog":false,"gamingVideo":true}', true],
        ['old OFF (stored false) stays OFF - the explicit choice is respected', '{"screenCapturer":"auto","captureLog":false,"gamingVideo":false}', false],
        ['unset: a file from before the setting existed gets ON', '{"screenCapturer":"dxgi","captureLog":true}', true],
        ['unset: no file / empty text gets ON', '', true],
        ['unset: an empty object gets ON', '{}', true],
        ['a garbled string gets the default, ON', '{"gamingVideo":"false"}', true],
        ['a garbled number gets the default, ON', '{"gamingVideo":0}', true],
        ['a null gets the default, ON', '{"gamingVideo":null}', true],
    ])('migration: %s', (_label, text, expected) => {
        expect(parseStartupFlags(text).gamingVideo).toBe(expected);
    });

    it('migration keeps the other fields intact', () => {
        expect(parseStartupFlags('{"screenCapturer":"dxgi","captureLog":true}'))
            .toEqual({ screenCapturer: 'dxgi', captureLog: true, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
        expect(parseStartupFlags('{"screenCapturer":"dxgi","captureLog":true,"gamingVideo":false}'))
            .toEqual({ screenCapturer: 'dxgi', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true });
    });

    it('an explicit OFF survives a save/load round trip, and ON writes true (never a bare default-false)', () => {
        const off = parseStartupFlags(serializeStartupFlags({ ...DEFAULT_STARTUP_FLAGS, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true }));
        expect(off.gamingVideo).toBe(false);
        expect(serializeStartupFlags({ ...DEFAULT_STARTUP_FLAGS })).toContain('"gamingVideo": true');
        // saving ANOTHER flag for a never-touched user writes the new default, not a false
        const onlyLog = serializeStartupFlags({ ...parseStartupFlags(''), captureLog: true });
        expect(parseStartupFlags(onlyLog).gamingVideo).toBe(true);
    });

    it('the old separate screen-share key is gone: ignored on read, rejected on write, never written', () => {
        expect(parseStartupFlags('{"shareBoost":false}').gamingVideo).toBe(true);
        expect(parseStartupFlags('{"gamingVideo":false,"shareBoost":true}').gamingVideo).toBe(false);
        expect(() => validateStartupFlagsPatch({ shareBoost: true })).toThrow(/unknown key/);
        expect(serializeStartupFlags({ ...DEFAULT_STARTUP_FLAGS })).not.toContain('shareBoost');
        expect(Object.keys(DEFAULT_STARTUP_FLAGS).sort()).toEqual(['captureLog', 'gamingVideo', 'linuxHwDecode', 'linuxHwEncode', 'screenCapturer']);
    });

    it('is exact, not lenient: no case folding, trimming or truthy coercion', () => {
        expect(parseStartupFlags('{"screenCapturer":"DXGI"}').screenCapturer).toBe('auto');
        expect(parseStartupFlags('{"screenCapturer":" dxgi "}').screenCapturer).toBe('auto');
        expect(parseStartupFlags('{"captureLog":1}').captureLog).toBe(false);
        expect(parseStartupFlags('{"captureLog":"1"}').captureLog).toBe(false);
    });

    it('ignores unknown keys and does not honour inherited ones', () => {
        expect(parseStartupFlags('{"captureLog":true,"enable-logging":"stderr","vmodule":"*=9"}'))
            .toEqual({ screenCapturer: 'auto', captureLog: true, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
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
        expect(validateStartupFlagsPatch({ gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true })).toEqual({ gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
        expect(validateStartupFlagsPatch({ gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true })).toEqual({ gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true });
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
        ['a string gamingVideo', { gamingVideo: 'true' }],
        ['a numeric gamingVideo', { gamingVideo: 1 }],
        ['a null gamingVideo', { gamingVideo: null }],
    ])('rejects %s', (_label, input) => {
        expect(() => validateStartupFlagsPatch(input)).toThrow();
    });
});

describe('resolveStartupFlags — env > file > default', () => {
    const file: StartupFlags = { screenCapturer: 'dxgi', captureLog: true, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true };

    it('default when neither env nor file sets anything', () => {
        const r = resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS }, env: {}, packaged: true });
        expect(r).toEqual({ screenCapturer: 'auto', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true, source: { screenCapturer: 'default', captureLog: 'default', gamingVideo: 'default', linuxHwEncode: 'default', linuxHwDecode: 'default' } });
    });

    it('file wins over default', () => {
        const r = resolveStartupFlags({ file, env: {}, packaged: true });
        expect(r).toEqual({ screenCapturer: 'dxgi', captureLog: true, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true, source: { screenCapturer: 'file', captureLog: 'file', gamingVideo: 'default', linuxHwEncode: 'default', linuxHwDecode: 'default' } });
    });

    it('env wins over file (dev build)', () => {
        const r = resolveStartupFlags({
            file, env: { CIPHERLINE_SCREEN_CAPTURER: 'wgc', CIPHERLINE_CAPTURE_LOG: '0' }, packaged: false,
        });
        expect(r).toEqual({ screenCapturer: 'wgc', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true, source: { screenCapturer: 'env', captureLog: 'env', gamingVideo: 'default', linuxHwEncode: 'default', linuxHwDecode: 'default' } });
    });

    it('an env capturer that is set but unrecognised still wins, as auto (the pre-existing env semantics)', () => {
        const r = resolveStartupFlags({ file, env: { CIPHERLINE_SCREEN_CAPTURER: 'gdi' }, packaged: true });
        expect(r.screenCapturer).toBe('auto');
        expect(r.source.screenCapturer).toBe('env');
    });

    it('an empty or blank env var counts as unset', () => {
        const r = resolveStartupFlags({ file, env: { CIPHERLINE_SCREEN_CAPTURER: '  ', CIPHERLINE_CAPTURE_LOG: '' }, packaged: false });
        expect(r.source).toEqual({ screenCapturer: 'file', captureLog: 'file', gamingVideo: 'default', linuxHwEncode: 'default', linuxHwDecode: 'default' });
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

    it('gamingVideo comes from the file only (no env override); only an explicit OFF is "file"', () => {
        const on = resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS }, env: { CIPHERLINE_CAPTURE_LOG: '1' }, packaged: false });
        expect(on.gamingVideo).toBe(true);
        expect(on.source.gamingVideo).toBe('default');
        const off = resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true }, env: {}, packaged: true });
        expect(off.gamingVideo).toBe(false);
        expect(off.source.gamingVideo).toBe('file');
    });

    it('dev: CIPHERLINE_CAPTURE_LOG=1 turns it on, anything else set turns it off', () => {
        const base = { file: { ...DEFAULT_STARTUP_FLAGS }, packaged: false };
        expect(resolveStartupFlags({ ...base, env: { CIPHERLINE_CAPTURE_LOG: '1' } }).captureLog).toBe(true);
        expect(resolveStartupFlags({ ...base, env: { CIPHERLINE_CAPTURE_LOG: 'yes' } }).captureLog).toBe(false);
    });
});

describe('linuxHwEncode (Linux hardware video encode, linux-video-encode.ts)', () => {
    it('is ON by default; only an exact boolean is kept (a garbled value gets the default)', () => {
        expect(DEFAULT_STARTUP_FLAGS.linuxHwEncode).toBe(true);
        expect(parseStartupFlags('').linuxHwEncode).toBe(true);
        expect(parseStartupFlags('{"linuxHwEncode":false}').linuxHwEncode).toBe(false);
        expect(parseStartupFlags('{"linuxHwEncode":true}').linuxHwEncode).toBe(true);
        for (const bad of ['"false"', '0', 'null', '"off"']) expect(parseStartupFlags(`{"linuxHwEncode":${bad}}`).linuxHwEncode).toBe(true);
    });

    it('an explicit OFF survives a save/load round trip; saving another flag does not flip it', () => {
        const off = parseStartupFlags(serializeStartupFlags({ ...DEFAULT_STARTUP_FLAGS, linuxHwEncode: false }));
        expect(off.linuxHwEncode).toBe(false);
        expect(serializeStartupFlags({ ...DEFAULT_STARTUP_FLAGS })).toContain('"linuxHwEncode": true');
        expect(parseStartupFlags(serializeStartupFlags({ ...off, captureLog: true })).linuxHwEncode).toBe(false);
    });

    it('the renderer patch accepts exactly a boolean and nothing else', () => {
        expect(validateStartupFlagsPatch({ linuxHwEncode: false })).toEqual({ linuxHwEncode: false });
        expect(validateStartupFlagsPatch({ linuxHwEncode: true })).toEqual({ linuxHwEncode: true });
        for (const bad of ['true', 1, null, 'off', {}]) expect(() => validateStartupFlagsPatch({ linuxHwEncode: bad })).toThrow();
    });

    it('resolve: the setting comes from the file; the env var is NOT merged into it, only reported as the source', () => {
        const off = { ...DEFAULT_STARTUP_FLAGS, linuxHwEncode: false };
        const a = resolveStartupFlags({ file: off, env: {}, packaged: true });
        expect(a.linuxHwEncode).toBe(false);
        expect(a.source.linuxHwEncode).toBe('file');
        const b = resolveStartupFlags({ file: off, env: { CIPHERLINE_LINUX_HW_ENCODE: '1' }, packaged: true });
        expect(b.linuxHwEncode).toBe(false);          // the decision combines env + setting itself (and lets env =1 win there)
        expect(b.source.linuxHwEncode).toBe('env');
        expect(resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS }, env: { CIPHERLINE_LINUX_HW_ENCODE: 'maybe' }, packaged: true }).source.linuxHwEncode).toBe('default');
        expect(resolveStartupFlags({ file: { ...DEFAULT_STARTUP_FLAGS }, env: { CIPHERLINE_LINUX_HW_ENCODE: ' OFF ' }, packaged: true }).source.linuxHwEncode).toBe('env');
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
        writeStartupFlagsFile(flagsPath(), { screenCapturer: 'wgc', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true });
        expect(readStartupFlagsFile(flagsPath())).toEqual({ screenCapturer: 'wgc', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true });
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

