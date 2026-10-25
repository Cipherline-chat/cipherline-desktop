import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    decideHdrShare, parseHdrDisplays, parseHdrSharePref, parseNumberEnv, screenIndexFromSourceId,
    createHdrShareController, MAX_SEND_FAILURES, type HdrDisplayInfo, type SharedTextureLike,
} from './hdr-share';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const HDR: HdrDisplayInfo = {
    index: 1, hdr: true, width: 2560, height: 1440, rotation: 1, sameAdapterAsDefault: true,
    sdrWhiteNits: 240, maxLuminance: 1000, maxFullFrameLuminance: 600, bitsPerColor: 10,
};
const SDR: HdrDisplayInfo = { ...HDR, index: 0, hdr: false };

describe('parsing', () => {
    it('pref and env numbers', () => {
        // Off by default until verified on a real HDR PC (2026-10-24 renderer crash triage).
        expect(parseHdrSharePref(undefined)).toBe('off');
        expect(parseHdrSharePref('')).toBe('off');
        expect(parseHdrSharePref(' OFF ')).toBe('off');
        expect(parseHdrSharePref(' Auto ')).toBe('auto');
        expect(parseHdrSharePref('force')).toBe('force');
        expect(parseHdrSharePref('yes')).toBe('off');
        expect(parseNumberEnv('240', 80, 1000)).toBe(240);
        expect(parseNumberEnv('5000', 80, 1000)).toBe(0);
        expect(parseNumberEnv('abc', 0, 1)).toBe(0);
        expect(parseNumberEnv(undefined, 0, 1)).toBe(0);
    });
    it('screen ids map to the GDI device index; windows do not', () => {
        expect(screenIndexFromSourceId('screen:0:0')).toBe(0);
        expect(screenIndexFromSourceId('screen:12:0')).toBe(12);
        expect(screenIndexFromSourceId('window:1234:0')).toBeNull();
        expect(screenIndexFromSourceId('screen:-1:0')).toBeNull();
        expect(screenIndexFromSourceId(5)).toBeNull();
    });
    it('hdrGetDisplays output is narrowed, junk dropped', () => {
        expect(parseHdrDisplays(undefined)).toEqual([]);
        expect(parseHdrDisplays([null, { index: 'x' }, { index: 99 }, { index: 2, hdr: 'yes' }])).toEqual([
            expect.objectContaining({ index: 2, hdr: false, sameAdapterAsDefault: false }),
        ]);
    });
});

describe('decideHdrShare (decision table)', () => {
    const base = { platform: 'win32', pref: 'auto' as const, sourceId: 'screen:1:0', nativeAvailable: true, displays: [SDR, HDR] };
    const cases: Array<[string, Partial<typeof base> & { displays?: HdrDisplayInfo[] }, boolean, string]> = [
        ['HDR screen on Windows', {}, true, 'hdr'],
        ['SDR screen: zero cost, Chromium path', { sourceId: 'screen:0:0' }, false, 'sdr_display'],
        ['SDR screen, force', { sourceId: 'screen:0:0', pref: 'force' as never }, true, 'forced'],
        ['window share', { sourceId: 'window:42:0' }, false, 'window_source'],
        ['macOS', { platform: 'darwin' }, false, 'not_windows'],
        ['kill switch', { pref: 'off' as never }, false, 'off'],
        ['addon without the export', { nativeAvailable: false }, false, 'no_native'],
        ['display not listed', { sourceId: 'screen:5:0' }, false, 'display_unknown'],
        ['second GPU drives the display', { displays: [{ ...HDR, sameAdapterAsDefault: false }] }, false, 'cross_adapter'],
        ['rotated portrait display', { displays: [{ ...HDR, rotation: 2 }] }, false, 'rotated'],
    ];
    for (const [name, over, use, reason] of cases) {
        it(name, () => {
            const d = decideHdrShare({ ...base, ...over });
            expect(d.use).toBe(use);
            expect(d.reason).toBe(reason);
        });
    }
    it('reports the display HDR state even when it declines', () => {
        expect(decideHdrShare({ ...base, pref: 'off' }).hdr).toBe(true);
        expect(decideHdrShare({ ...base, sourceId: 'screen:0:0' }).hdr).toBe(false);
    });
});

function harness() {
    let onEvent: ((ev: unknown) => void) | null = null;
    const native = {
        hdrCaptureStart: vi.fn((_o: Record<string, number | boolean>, cb: (ev: unknown) => void) => { onEvent = cb; return { ok: true }; }),
        hdrCaptureRelease: vi.fn(),
        hdrCaptureStop: vi.fn(),
        hdrCaptureStats: vi.fn(() => ({ frames: 3 })),
    };
    const imports: Array<{ slot: number; info: unknown; allReleased?: () => void; release: ReturnType<typeof vi.fn> }> = [];
    let sendImpl: () => Promise<void> = async () => {};
    const sharedTexture: SharedTextureLike = {
        importSharedTexture: vi.fn((o) => {
            const rec = { slot: -1, info: o.textureInfo, allReleased: o.allReferencesReleased, release: vi.fn(() => rec.allReleased?.()) };
            imports.push(rec);
            return rec;
        }),
        sendSharedTexture: vi.fn((_o, _session, slot) => { imports[imports.length - 1].slot = slot as number; return sendImpl(); }),
    };
    const notifyEnded = vi.fn();
    const ctl = createHdrShareController({ native, sharedTexture, notifyEnded, startTimeoutMs: 1000 });
    const handles = [0, 1, 2, 3].map(i => Buffer.from([i, 0, 0, 0, 0, 0, 0, 0]));
    return {
        native, sharedTexture, imports, notifyEnded, ctl, handles,
        emit: (ev: unknown) => onEvent?.(ev),
        setSend: (f: () => Promise<void>) => { sendImpl = f; },
    };
}
const started = (handles: Buffer[]) => ({ type: 'started', generation: 9, width: 2560, height: 1440, srcWidth: 2560, srcHeight: 1440, hdr: true, inputFormat: 'fp16', sdrWhiteNits: 240, peakNits: 1000, knee: 0.8, handles });
const flush = () => new Promise(r => setTimeout(r, 0));

describe('createHdrShareController', () => {
    it('starts, then imports each frame as a bgra shared texture and sends it to the asking frame', async () => {
        const h = harness();
        const p = h.ctl.start({ target: 'frameA', index: 1, width: 2560, height: 1440, maxFps: 90 });
        expect(h.native.hdrCaptureStart).toHaveBeenCalledWith(expect.objectContaining({ index: 1, width: 2560, height: 1440, maxFps: 90, force: false }), expect.any(Function));
        h.emit(started(h.handles));
        const r = await p;
        expect(r).toMatchObject({ ok: true, info: { width: 2560, height: 1440, hdr: true, inputFormat: 'fp16' } });
        h.emit({ type: 'frame', slot: 2, timestampUs: 5_000_000 });
        h.emit({ type: 'frame', slot: 3, timestampUs: 5_011_111 });
        expect(h.imports.map(i => i.info)).toEqual([
            { pixelFormat: 'bgra', codedSize: { width: 2560, height: 1440 }, handle: { ntHandle: h.handles[2] }, timestamp: 0 },
            { pixelFormat: 'bgra', codedSize: { width: 2560, height: 1440 }, handle: { ntHandle: h.handles[3] }, timestamp: 11_111 },
        ]);
        expect(h.sharedTexture.sendSharedTexture).toHaveBeenCalledWith({ frame: 'frameA', importedSharedTexture: expect.anything() }, (r as { session: number }).session, 2);
        await flush();
        // main dropped its reference after the send; with the renderer's gone too the slot is free again
        expect(h.native.hdrCaptureRelease).toHaveBeenCalledWith(2, 9);
        expect(h.native.hdrCaptureRelease).toHaveBeenCalledWith(3, 9);
    });

    it('a start error resolves ok:false and stops the native side', async () => {
        const h = harness();
        const p = h.ctl.start({ target: 'f', index: 1, width: 0, height: 0, maxFps: 60 });
        h.emit({ type: 'error', error: 'cross_adapter' });
        expect(await p).toEqual({ ok: false, error: 'cross_adapter' });
        expect(h.native.hdrCaptureStop).toHaveBeenCalled();
        expect(h.ctl.activeSession()).toBeNull();
    });

    it('a start that never reports times out (and stops)', async () => {
        vi.useFakeTimers();
        try {
            const h = harness();
            const p = h.ctl.start({ target: 'f', index: 1, width: 0, height: 0, maxFps: 60 });
            await vi.advanceTimersByTimeAsync(1001);
            expect(await p).toEqual({ ok: false, error: 'start_timeout' });
            expect(h.native.hdrCaptureStop).toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('frames after stop are released, never imported', async () => {
        const h = harness();
        const p = h.ctl.start({ target: 'f', index: 1, width: 0, height: 0, maxFps: 60 });
        h.emit(started(h.handles));
        await p;
        h.ctl.stop('renderer');
        h.emit({ type: 'frame', slot: 1, timestampUs: 1 });
        expect(h.imports).toHaveLength(0);
        expect(h.native.hdrCaptureRelease).toHaveBeenCalledWith(1, 9);
    });

    it('a capture that ends on its own notifies the renderer', async () => {
        const h = harness();
        const p = h.ctl.start({ target: 'f', index: 1, width: 0, height: 0, maxFps: 60 });
        h.emit(started(h.handles));
        const r = await p;
        h.emit({ type: 'ended', reason: 'display_gone' });
        expect(h.notifyEnded).toHaveBeenCalledWith('f', (r as { session: number }).session, 'display_gone');
        expect(h.ctl.activeSession()).toBeNull();
    });

    it('gives up after repeated failed sends (receiver gone) and tells the renderer', async () => {
        const h = harness();
        h.setSend(() => Promise.reject(new Error('timed out')));
        const p = h.ctl.start({ target: 'f', index: 1, width: 0, height: 0, maxFps: 60 });
        h.emit(started(h.handles));
        await p;
        for (let i = 0; i < MAX_SEND_FAILURES; i++) { h.emit({ type: 'frame', slot: i % 4, timestampUs: i }); await flush(); }
        expect(h.notifyEnded).toHaveBeenCalledWith('f', expect.any(Number), 'send_failed');
        expect(h.native.hdrCaptureStop).toHaveBeenCalled();
    });

    it('stop(session) only stops that session', async () => {
        const h = harness();
        const p = h.ctl.start({ target: 'f', index: 1, width: 0, height: 0, maxFps: 60 });
        h.emit(started(h.handles));
        const r = await p as { session: number };
        h.ctl.stop('renderer', r.session + 1);
        expect(h.ctl.activeSession()).toBe(r.session);
        h.ctl.stop('renderer', r.session);
        expect(h.ctl.activeSession()).toBeNull();
    });

    it('an addon without the HDR exports declines', async () => {
        const ctl = createHdrShareController({ native: {}, sharedTexture: {} as SharedTextureLike, notifyEnded: vi.fn() });
        expect(await ctl.start({ target: 'f', index: 0, width: 0, height: 0, maxFps: 60 })).toEqual({ ok: false, error: 'no_native' });
    });
});

describe('wiring', () => {
    const MAIN = read('electron/main.ts');
    const PRELOAD = read('electron/preload.ts');
    const GYP = read('binding.gyp');
    const NATIVE = read('src-native/hdr_capture.cc');

    it('hdr-start goes through the same capture consent as getDisplayMedia, for a main-enumerated screen only', () => {
        const at = MAIN.indexOf("ipcMain.handle('share:hdr-start'");
        expect(at).toBeGreaterThan(0);
        const body = MAIN.slice(at, MAIN.indexOf("ipcMain.handle('share:hdr-stop'", at));
        expect(body).toContain('isCaptureSourceId(sourceId)');
        expect(body).toContain('screenIndexFromSourceId(sourceId) === null');
        expect(body).toMatch(/captureConsent\.authorizeVideo\(event\.sender\.id, grantToken, \{ id: match\.id, name: match\.name \}, false\)/);
        expect(body.indexOf('authorizeVideo')).toBeLessThan(body.indexOf('hdrShare.start('));
        expect(body).toContain('target: event.sender.mainFrame');
    });
    it('the capture stops with the renderer', () => {
        expect(MAIN).toMatch(/once\('destroyed', \(\) => \{\s*captureConsent\.forgetSender\(mainContentsId\);\s*hdrShare\.stop\('renderer_gone'\);/);
    });
    it('preload registers one releasing receiver and exposes the bridge', () => {
        expect(PRELOAD).toContain('sharedTexture?.setSharedTextureReceiver(');
        expect(PRELOAD).toMatch(/finally \{\s*imported\.release\(\);/);
        for (const ch of ['share:hdr-probe', 'share:hdr-start', 'share:hdr-stop', 'share:hdr-stats', 'share:hdr-ended']) expect(PRELOAD).toContain(`'${ch}'`);
    });
    it('the addon links and delay-loads D3D11 / DXGI / D3DCompiler, and registers the exports', () => {
        const json = JSON.parse(GYP.split('\n').filter(l => !l.trim().startsWith('#')).join('\n'));
        const win = json.targets[0].conditions.find((c: [string, unknown]) => c[0] === "OS=='win'")[1];
        expect(win.libraries).toEqual(expect.arrayContaining(['-ld3d11.lib', '-ldxgi.lib', '-ld3dcompiler.lib']));
        expect(win.msvs_settings.VCLinkerTool.DelayLoadDLLs).toEqual(expect.arrayContaining(['d3d11.dll', 'dxgi.dll', 'd3dcompiler_47.dll']));
        expect(read('src-native/audio_capture.cc')).toMatch(/RegisterSharePower\(env, exports\);\s*RegisterHdrCapture\(env, exports\);/);
        for (const name of ['hdrGetDisplays', 'hdrCaptureStart', 'hdrCaptureRelease', 'hdrCaptureStop', 'hdrCaptureStats']) {
            expect(NATIVE).toContain(`"${name}"`);
        }
    });
    it('the renderer tries the HDR capture only for a whole-screen share, re-mints after a spent attempt, and tears it down with the crop pipeline', () => {
        const SC = read('src/components/SidebarConference.tsx');
        expect(SC).toMatch(/if \(!sliceLayout && !isWindowSource\) \{\s*const hdr = await tryStartHdrShare\(options, box, captureFps\);/);
        expect(SC).toMatch(/if \(!hdrPipe && hdr\.spent\) \{\s*await mintShareGrant\(options\);\s*pendingScreenShareRef\.current = pendingShare\(/);
        expect(SC).toMatch(/const hdr = hdrPipelineRef\.current;\s*hdrPipelineRef\.current = null;\s*try \{ hdr\?\.stop\(\); \}/);
        expect(SC).toContain("publishTrack(new LocalVideoTrack(pipe.track, undefined, true), { source: Track.Source.ScreenShare, ...publishOptions })");
        expect(read('src/utils/callEventLog.ts')).toContain("'share_hdr',");
    });
    it('the native capture duplicates in FP16 and shares NT-handle textures without a keyed mutex', () => {
        expect(NATIVE).toMatch(/DuplicateOutput1\(device_\.Get\(\), 0, ARRAYSIZE\(formats\), formats/);
        expect(NATIVE).toContain('DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_B8G8R8A8_UNORM');
        expect(NATIVE).toContain('D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;');
        expect(NATIVE).not.toContain('SHARED_KEYEDMUTEX');
    });
});
