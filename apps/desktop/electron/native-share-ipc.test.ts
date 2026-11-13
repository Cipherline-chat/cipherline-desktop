import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeShareBinding, sanitizeStartArgs, portCommandLine, registerNativeShareIpc, probeBackends, parseProbeOutput } from './native-share-ipc';

const ok = { width: 1920, height: 1080, fps: 90, bitrateBps: 20_000_000 };

describe('native share IPC validation', () => {
    it('accepts a sane request and pins the helper path + default device', () => {
        expect(sanitizeStartArgs({ ...ok, device: '/etc/passwd', helperPath: '/bin/sh' }, '/opt/h')).toEqual({ helperPath: '/opt/h', backend: 'vaapi', ...ok });
    });
    it('NEGATIVE: rejects non-objects, floats, strings, out of range', () => {
        for (const bad of [null, 'x', 5, { ...ok, width: 1920.5 }, { ...ok, width: '1920' }, { ...ok, fps: 0 }, { ...ok, fps: 1000 }, { ...ok, bitrateBps: 5 }, { ...ok, height: 100000 }, {}]) {
            expect(sanitizeStartArgs(bad, '/opt/h')).toBeNull();
        }
    });
    it('unknown backend falls back to vaapi (never passed through)', () => {
        expect(sanitizeStartArgs({ ...ok, backend: '; rm -rf /' }, '/opt/h')?.backend).toBe('vaapi');
    });
});

describe('port commands: the sharer\'s own preview', () => {
    it('maps preview on (bounded width and rate) and off', () => {
        expect(portCommandLine({ cmd: 'preview', on: true, w: 512, fps: 6 })).toBe('PREVIEW 512 6');
        expect(portCommandLine({ cmd: 'preview', on: false })).toBe('PREVIEW OFF');
    });
    it('NEGATIVE: refuses non-integers, out-of-range values, newline injection, a missing rate and the low layer', () => {
        for (const bad of [
            { cmd: 'preview', on: true, w: 512 }, { cmd: 'preview', on: true, fps: 6 },
            { cmd: 'preview', on: true, w: '512\nSTOP', fps: 6 }, { cmd: 'preview', on: true, w: 512.5, fps: 6 },
            { cmd: 'preview', on: true, w: 63, fps: 6 }, { cmd: 'preview', on: true, w: 1281, fps: 6 },
            { cmd: 'preview', on: true, w: 512, fps: 0 }, { cmd: 'preview', on: true, w: 512, fps: 16 },
            { cmd: 'preview', on: 'true', w: 512, fps: 6 }, { cmd: 'preview' }, { cmd: 'preview', on: false, layer: 'low' },
        ]) expect(portCommandLine(bad)).toBeNull();
    });
});

describe('port commands', () => {
    it('maps idr and bounded bitrate only', () => {
        expect(portCommandLine({ cmd: 'idr' })).toBe('IDR');
        expect(portCommandLine({ cmd: 'refresh' })).toBe('REFRESH');
        expect(portCommandLine({ cmd: 'bitrate', bps: 8_000_000 })).toBe('BITRATE 8000000');
    });
    it('addresses the lighter copy\'s own session only through layer:low / cmd:low, with integer-bounded arguments', () => {
        expect(portCommandLine({ cmd: 'idr', layer: 'low' })).toBe('LOW_IDR');
        expect(portCommandLine({ cmd: 'bitrate', layer: 'low', bps: 3_000_000 })).toBe('LOW_BITRATE 3000000');
        expect(portCommandLine({ cmd: 'low', on: true, w: 1280, h: 720, fps: 30, bps: 3_000_000 })).toBe('LOW 1280 720 30 3000000');
        expect(portCommandLine({ cmd: 'low', on: false })).toBe('LOW OFF');
        expect(portCommandLine({ cmd: 'idr', layer: 'full' })).toBe('IDR');
    });
    it('NEGATIVE: the lighter copy commands refuse non-integers, out-of-range values, newline injection and a missing flag', () => {
        for (const bad of [
            { cmd: 'low', on: true, w: 1280, h: 720, fps: 30 },                                   // no bitrate
            { cmd: 'low', on: true, w: '1280\nSTOP', h: 720, fps: 30, bps: 3_000_000 },
            { cmd: 'low', on: true, w: 1280.5, h: 720, fps: 30, bps: 3_000_000 },
            { cmd: 'low', on: true, w: 1280, h: 720, fps: 90, bps: 3_000_000 },                   // above the copy's 60 fps ceiling
            { cmd: 'low', on: true, w: 8, h: 720, fps: 30, bps: 3_000_000 },
            { cmd: 'low', on: true, w: 1280, h: 720, fps: 30, bps: 1e12 },
            { cmd: 'low', on: 'true', w: 1280, h: 720, fps: 30, bps: 3_000_000 },
            { cmd: 'low' },
            { cmd: 'refresh', layer: 'low' },
            { cmd: 'bitrate', layer: 'low', bps: '3000000\nSTOP' },
        ]) expect(portCommandLine(bad)).toBeNull();
    });
    it('NEGATIVE: ignores everything else (no newline injection, no STOP, no out-of-range)', () => {
        for (const bad of [null, 'IDR', { cmd: 'stop' }, { cmd: 'bitrate', bps: '8000000\nSTOP' }, { cmd: 'bitrate', bps: 1 }, { cmd: 'bitrate', bps: 1e12 }, { cmd: 'bitrate', bps: 1.5e6 + 0.5 }]) {
            expect(portCommandLine(bad)).toBeNull();
        }
    });
});

describe('registration', () => {
    it('registers exactly the start/stop handlers and refuses invalid start without spawning', async () => {
        const handlers = new Map<string, (e: never, a?: unknown) => unknown>();
        registerNativeShareIpc({ handle: (ch, fn) => { handlers.set(ch, fn as never); } }, () => { throw new Error('no channel for invalid args'); }, '/nonexistent');
        expect([...handlers.keys()].sort()).toEqual(['native-share:available', 'native-share:probe', 'native-share:start', 'native-share:stop']);
        expect(await handlers.get('native-share:start')!({} as never, { width: 1 })).toEqual({ ok: false, error: 'invalid arguments' });
    });
});

describe('probeBackends', () => {
    it('NEGATIVE: a missing helper is a clean "both unavailable", never a throw', async () => {
        const r = await probeBackends('/nonexistent/helper');
        expect(r.vaapi).toBe(false);
        expect(r.nvenc).toBe(false);
    });
    it('a helper that exits 0 is "available" for that backend', async () => {
        const r = await probeBackends('/bin/true');
        expect(r.vaapi).toBe(true);
        expect(r.nvenc).toBe(true);
    });
});

describe('capture start args', () => {
    const cap = { source: 'any', persist: true };
    it('accepts a capture request and pins everything the renderer must not choose', () => {
        expect(sanitizeStartArgs({ ...ok, backend: 'nvenc', capture: { ...cap, restoreToken: 'tok_1' }, device: '/dev/x' }, '/opt/h'))
            .toEqual({ helperPath: '/opt/h', backend: 'nvenc', ...ok, capture: { source: 'any', persist: true, restoreToken: 'tok_1' } });
    });
    it('NEGATIVE: bad source, non-boolean persist, hostile token, non-object capture are all refused', () => {
        for (const bad of [{ ...cap, source: 'rm' }, { ...cap, persist: 'yes' }, { ...cap, restoreToken: 'a b' }, { ...cap, restoreToken: 5 }, null, 'x']) {
            expect(sanitizeStartArgs({ ...ok, capture: bad }, '/opt/h')).toBeNull();
        }
    });
    it('the software test backend is refused unless the lab explicitly allows it', () => {
        expect(sanitizeStartArgs({ ...ok, backend: 'pcm' }, '/opt/h')?.backend).toBe('vaapi');
        expect(sanitizeStartArgs({ ...ok, backend: 'pcm' }, '/opt/h', true)?.backend).toBe('pcm');
    });
});

describe('native-share:start without a helper', () => {
    it('answers a clean error (no spawn, no throw) when the helper binary is missing', async () => {
        const handlers = new Map<string, (e: never, a?: unknown) => unknown>();
        registerNativeShareIpc({ handle: (ch, fn) => { handlers.set(ch, fn as never); } }, () => { throw new Error('must not open a channel'); }, '/nonexistent', { exists: () => false });
        expect(await handlers.get('native-share:start')!({ sender: {} } as never, { ...ok, backend: 'nvenc' })).toEqual({ ok: false, error: 'helper missing' });
        expect(await handlers.get('native-share:available')!({} as never)).toEqual({ helper: false });
    });
});

describe('parseProbeOutput', () => {
    it('reads GPU/driver/API/caps and the calibration fps', () => {
        const err = [
            '{"backend":"nvenc","open":"ok","gpu":"NVIDIA GeForce RTX 5070","driver":"615.78.08","nvenc_api":"13.0","cap_w":8192,"cap_h":8192,"bgrx_input":1}',
            '{"backend":"nvenc","mode":"unpaced","w":3440,"h":1440,"fps_target":90,"frames":45,"wall_s":0.160,"fps":281.2,"enc_ms_p50":3.3}',
        ].join('\n');
        expect(parseProbeOutput(err)).toEqual({ info: { gpu: 'NVIDIA GeForce RTX 5070', driver: '615.78.08', nvencApi: '13.0', capW: 8192, capH: 8192, bgrxInput: true }, sustainedFps: 281 });
    });
    it('NEGATIVE: garbage yields nothing rather than throwing', () => {
        expect(parseProbeOutput('Cannot load libcuda.so.1\n{"error":"NVIDIA driver not available"}\n[')).toEqual({ info: undefined, sustainedFps: undefined });
    });
});


describe('sanitizeShareBinding + the native start binds the grant when the helper really captures', () => {
    it('accepts a well-formed {sourceId, token}; NEGATIVE: junk is null', () => {
        expect(sanitizeShareBinding({ grant: { sourceId: 'screen:0:0', token: 'abc' } })).toEqual({ sourceId: 'screen:0:0', token: 'abc' });
        for (const bad of [null, {}, { grant: null }, { grant: { sourceId: 'x', token: 'abc' } }, { grant: { sourceId: 'screen:0:0', token: '' } }, { grant: { sourceId: 'screen:0:0', token: 5 } }, { grant: { sourceId: 'screen:0:0', token: 'a'.repeat(201) } }]) {
            expect(sanitizeShareBinding(bad)).toBeNull();
        }
    });
    const run = async (grant: unknown, helperBody: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'nsh-'));
        const helper = join(dir, 'helper.sh');
        writeFileSync(helper, `#!/bin/sh\n${helperBody}\nsleep 1\n`); chmodSync(helper, 0o755);
        const handlers = new Map<string, (e: never, a?: unknown) => unknown>();
        const begun: unknown[] = []; let commits = 0;
        const consent = { beginNativeShare: (s: number, t: unknown, src: unknown) => { begun.push([s, t, src]); return t === 'good' ? { commit: () => { commits++; return true; } } : null; } };
        registerNativeShareIpc({ handle: (ch, fn) => { handlers.set(ch, fn as never); } }, () => ({ port1: { postMessage() {}, on() {}, start() {}, close() {} }, port2: {} }), helper, { consent });
        const sender = { id: 7, postMessage() {}, send() {}, once() {} };
        const r = await handlers.get('native-share:start')!({ sender } as never, { ...ok, backend: 'nvenc', capture: { source: 'any', persist: true }, ...(grant ? { grant } : {}) });
        await new Promise((res) => setTimeout(res, 400));
        await handlers.get('native-share:stop')!({} as never);
        return { r, begun, commits };
    };
    const FORMAT = `echo '{"event":"format","src_w":1920,"src_h":1080,"w":1920,"h":1080,"encoder":"nvenc","gpu":"x"}' >&2`;
    it('commits once the helper reports its first format, with the sender id and the presented grant', async () => {
        const o = await run({ sourceId: 'screen:0:0', token: 'good' }, FORMAT);
        expect(o.r).toEqual({ ok: true });
        expect(o.begun).toEqual([[7, 'good', 'screen:0:0']]);
        expect(o.commits).toBe(1);
    });
    it('NEGATIVE: a forged grant never commits; no grant never even asks main; a helper that never captures never commits', async () => {
        expect((await run({ sourceId: 'screen:0:0', token: 'forged' }, FORMAT)).commits).toBe(0);
        const none = await run(null, FORMAT);
        expect(none.begun).toEqual([]); expect(none.commits).toBe(0);
        expect((await run({ sourceId: 'screen:0:0', token: 'good' }, 'exit 1')).commits).toBe(0);
    });
});
