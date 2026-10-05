import { describe, it, expect } from 'vitest';
import {
    parseScreenCapturerPref, windowsBuildFromRelease, buildChromiumMediaSwitches, expectedScreenCapturer,
    captureLogSwitches, parseCaptureTimingLog, summarizeGpuDevices, WIN11_24H2_BUILD,
    decideAutoScreenCapturer, gpuTopologyFromInfo, parseGpuTopologyHint, serializeGpuTopologyHint, resolveCapturedDisplayHz,
} from './capture-flags';

describe('parseScreenCapturerPref', () => {
    it.each([
        ['dxgi', 'dxgi'], ['DXGI', 'dxgi'], [' wgc ', 'wgc'],
        ['', 'auto'], [undefined, 'auto'], ['gdi', 'auto'], ['auto', 'auto'],
    ] as const)('%j → %s', (v, expected) => {
        expect(parseScreenCapturerPref(v)).toBe(expected);
    });
});

describe('windowsBuildFromRelease', () => {
    it.each([
        ['10.0.26100', 26100], ['10.0.22631', 22631], ['10.0.19045', 19045],
        ['6.8.0-142-generic', null], ['', null], [undefined, null],
    ] as const)('%j → %j', (r, expected) => {
        expect(windowsBuildFromRelease(r)).toBe(expected);
    });
});

describe('buildChromiumMediaSwitches', () => {
    it('Windows always enables hardware Constrained Baseline H.264 and leaves the capturer to Chromium on auto', () => {
        expect(buildChromiumMediaSwitches('win32', 'auto')).toEqual({
            enableFeatures: ['PlatformH264CbpEncoding'], disableFeatures: [],
        });
    });

    it('forcing DXGI DISABLES the WGC screen feature (an explicit override beats the 24H2 default)', () => {
        expect(buildChromiumMediaSwitches('win32', 'dxgi')).toEqual({
            enableFeatures: ['PlatformH264CbpEncoding'], disableFeatures: ['AllowWgcScreenCapturer'],
        });
    });

    it('forcing WGC enables it', () => {
        expect(buildChromiumMediaSwitches('win32', 'wgc')).toEqual({
            enableFeatures: ['PlatformH264CbpEncoding', 'AllowWgcScreenCapturer'], disableFeatures: [],
        });
    });

    it('Linux keeps PipeWire capture and ignores the Windows-only knobs', () => {
        for (const pref of ['auto', 'dxgi', 'wgc'] as const) {
            expect(buildChromiumMediaSwitches('linux', pref)).toEqual({
                enableFeatures: ['WebRTCPipeWireCapturer'], disableFeatures: [],
            });
        }
    });

    it('macOS gets nothing', () => {
        expect(buildChromiumMediaSwitches('darwin', 'dxgi')).toEqual({ enableFeatures: [], disableFeatures: [] });
    });

    it('never names the removed no-op CPU switch', () => {
        const all = JSON.stringify(['win32', 'linux', 'darwin'].map(p => buildChromiumMediaSwitches(p, 'auto')));
        expect(all).not.toMatch(/cpu/i);
    });
});

describe('expectedScreenCapturer', () => {
    const win = (windowsBuild: number | null, pref: 'auto' | 'dxgi' | 'wgc', sourceKind: 'screen' | 'window' | 'unknown' = 'screen') =>
        expectedScreenCapturer({ platform: 'win32', windowsBuild, pref, sourceKind }).backend;

    it('auto follows Chromium 150: WGC from Windows 11 24H2, DXGI before', () => {
        expect(win(WIN11_24H2_BUILD, 'auto')).toBe('wgc');
        expect(win(26200, 'auto')).toBe('wgc');
        expect(win(WIN11_24H2_BUILD - 1, 'auto')).toBe('dxgi');
        expect(win(22631, 'auto')).toBe('dxgi');
        expect(win(19045, 'auto')).toBe('dxgi');
        expect(win(null, 'auto')).toBe('unknown');
    });

    it('a forced pref wins over the OS build', () => {
        expect(win(26100, 'dxgi')).toBe('dxgi');
        expect(win(22631, 'wgc')).toBe('wgc');
    });

    it('window sources are always WGC, whatever the screen pref', () => {
        expect(win(22631, 'dxgi', 'window')).toBe('wgc');
        expect(win(26100, 'auto', 'window')).toBe('wgc');
    });

    it('Linux: PipeWire on Wayland, X11 otherwise', () => {
        expect(expectedScreenCapturer({ platform: 'linux', windowsBuild: null, pref: 'auto', sourceKind: 'screen', waylandSession: true }).backend).toBe('pipewire');
        expect(expectedScreenCapturer({ platform: 'linux', windowsBuild: null, pref: 'auto', sourceKind: 'screen' }).backend).toBe('x11');
    });
});

describe('captureLogSwitches', () => {
    it('is empty unless enabled with a path', () => {
        expect(captureLogSwitches(false, '/x/capture.log')).toEqual([]);
        expect(captureLogSwitches(true, null)).toEqual([]);
    });

    it('turns on file logging with desktop_capture_device at verbosity 2', () => {
        const s = Object.fromEntries(captureLogSwitches(true, '/x/capture.log'));
        expect(s['enable-logging']).toBe('file');
        expect(s['log-file']).toBe('/x/capture.log');
        expect(s.vmodule).toContain('desktop_capture_device=2');
    });

    it('keeps ordinary logging at FATAL so console lines and URLs stay out of the file', () => {
        for (const packaged of [true, false]) {
            expect(Object.fromEntries(captureLogSwitches(true, '/x/capture.log', { packaged }))['log-level']).toBe('3');
        }
    });

    it('packaged builds log desktop_capture_device only (no device names / window titles)', () => {
        const packaged = Object.fromEntries(captureLogSwitches(true, '/x/capture.log', { packaged: true }));
        expect(packaged.vmodule).toBe('desktop_capture_device=2');
        // Default is the conservative (packaged) set.
        expect(Object.fromEntries(captureLogSwitches(true, '/x/capture.log')).vmodule).toBe('desktop_capture_device=2');
        const dev = Object.fromEntries(captureLogSwitches(true, '/x/capture.log', { packaged: false }));
        expect(dev.vmodule).toBe('desktop_capture_device=2,media_stream_manager=1');
    });

    it('never turns on global verbosity or stderr logging', () => {
        for (const packaged of [true, false]) {
            const names = captureLogSwitches(true, '/x/capture.log', { packaged }).map(([n]) => n);
            expect(names).not.toContain('v');
            expect(names).not.toContain('enable-logging=stderr');
            expect(Object.fromEntries(captureLogSwitches(true, '/x/capture.log', { packaged }))['enable-logging']).toBe('file');
        }
    });
});

describe('expectedScreenCapturer — forced reason names where it came from', () => {
    it('env (default) vs Settings', () => {
        const base = { platform: 'win32', windowsBuild: 26100, sourceKind: 'screen' as const };
        expect(expectedScreenCapturer({ ...base, pref: 'dxgi' }).why).toBe('forced (CIPHERLINE_SCREEN_CAPTURER=dxgi)');
        expect(expectedScreenCapturer({ ...base, pref: 'dxgi', prefSource: 'settings' }))
            .toEqual({ backend: 'dxgi', why: 'forced (Settings → Advanced)' });
        expect(expectedScreenCapturer({ ...base, pref: 'wgc', prefSource: 'settings' }).backend).toBe('wgc');
    });
});

// Real line shapes, copied from Chromium 150's own output on this repo's
// harness (Electron 43.2.0, --vmodule=desktop_capture_device=2).
const P = '[389254:0929/014420.251628:VERBOSE2:content/browser/media/capture/desktop_capture_device.cc';
const frame = (dur: number, period: number, zeroHz = false) => [
    `${P}:866] CaptureFrame(is_refresh_frame=0)`,
    `${P}:607] OnCaptureResult [SUCCESS]${zeroHz ? '[0Hz]' : ''}`,
    `${P}:632] OnCaptureResult [output_size=(2560x1440)]`,
    `${P}:913] ScheduleNextCaptureFrame [last_capture_duration=${dur}]`,
    `${P}:920]   capture_period=${period}`,
    `${P}:921]   timer(dT=${period - dur})`,
].join('\n');
const start = (fps: number) =>
    `[1:2:VERBOSE1:content/browser/media/capture/desktop_capture_device.cc:1001] DesktopCaptureOptions: options={prefer_cursor_embedded: 1, allow_wgc_screen_capturer: 0, allow_wgc_window_capturer: 1, allow_wgc_zero_hertz: 0, wgc_require_border: 0}\n` +
    `[1:2:VERBOSE1:content/browser/media/capture/desktop_capture_device.cc:488] AllocateAndStart (requested_frame_rate=${fps}, max_frame_size=2560x1440, requested_frame_duration=${Math.round(1000 / fps)}, max_cpu_consumption_percentage=50)`;

describe('parseCaptureTimingLog', () => {
    it('returns null with too few frames', () => {
        expect(parseCaptureTimingLog(start(90) + '\n' + frame(9, 18))).toBeNull();
        expect(parseCaptureTimingLog('')).toBeNull();
    });

    it('reads the throttle: 9-10 ms grabs scheduled every 18-20 ms (the owner\'s ~52 fps)', () => {
        const frames = Array.from({ length: 60 }, (_, i) => frame(i % 2 ? 9 : 10, i % 2 ? 18 : 20)).join('\n');
        const t = parseCaptureTimingLog(start(90) + '\n' + frames)!;
        expect(t.samples).toBe(60);
        expect(t.captureMs).toBe(9.5);
        expect(t.periodMs).toBe(19);
        expect(t.pollFps).toBeCloseTo(52.6, 1);
        expect(t.unchangedRatio).toBe(0);
        expect(t.requestedFps).toBe(90);
        expect(t.maxCpuPercent).toBe(50);
        expect(t.wgcScreenAllowed).toBe(false);
    });

    it('counts 0 Hz polls (no new frame) separately from the throttle', () => {
        const frames = Array.from({ length: 40 }, (_, i) => frame(3, 11, i % 4 === 0)).join('\n');
        const t = parseCaptureTimingLog(start(90) + '\n' + frames)!;
        expect(t.periodMs).toBe(11);
        expect(t.unchangedRatio).toBeCloseTo(0.25, 5);
    });

    it('only summarises the MOST RECENT capture session', () => {
        const old = start(30) + '\n' + Array.from({ length: 50 }, () => frame(30, 60)).join('\n');
        const cur = start(90) + '\n' + Array.from({ length: 50 }, () => frame(4, 11)).join('\n');
        const t = parseCaptureTimingLog(old + '\n' + cur)!;
        expect(t.requestedFps).toBe(90);
        expect(t.captureMs).toBe(4);
        expect(t.samples).toBe(50);
    });

    it('uses the MEAN so a few long grabs show up in the rate (a median would hide them)', () => {
        // 80% on time at 11 ms, 20% at 33 ms: median says 90/s, reality is ~65/s.
        const frames = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? frame(16, 33) : frame(4, 11))).join('\n');
        const t = parseCaptureTimingLog(start(90) + '\n' + frames)!;
        expect(t.periodMs).toBeCloseTo(15.4, 1);
        expect(t.pollFps).toBeLessThan(70);
    });

    it('bounds the window to the newest frames', () => {
        const frames = [
            ...Array.from({ length: 100 }, () => frame(20, 40)),
            ...Array.from({ length: 100 }, () => frame(5, 11)),
        ].join('\n');
        const t = parseCaptureTimingLog(start(90) + '\n' + frames, 100)!;
        expect(t.captureMs).toBe(5);
    });

    it('ignores refresh-frame results in the 0 Hz ratio', () => {
        const rrf = `${P}:607] OnCaptureResult [SUCCESS][RRF]`;
        const frames = Array.from({ length: 20 }, () => frame(4, 11) + '\n' + rrf).join('\n');
        expect(parseCaptureTimingLog(start(90) + '\n' + frames)!.unchangedRatio).toBe(0);
    });
});

describe('summarizeGpuDevices', () => {
    it('keeps vendor/device ids, active flag and adapter name — nothing else', () => {
        const out = summarizeGpuDevices({
            gpuDevice: [
                { active: true, vendorId: 0x10de, deviceId: 0x2684, deviceString: 'NVIDIA GeForce RTX 4090', driverVersion: '560.1', luid: { high: 1, low: 2 } },
                { active: false, vendorId: 0x8086, deviceId: 0xa780 },
            ],
            auxAttributes: { secret: 'x' },
        });
        expect(out).toEqual([
            { vendor: 'NVIDIA', vendorId: 0x10de, deviceId: 0x2684, name: 'NVIDIA GeForce RTX 4090', active: true },
            { vendor: 'Intel', vendorId: 0x8086, deviceId: 0xa780, name: undefined, active: false },
        ]);
    });

    it('tolerates junk', () => {
        expect(summarizeGpuDevices(null)).toEqual([]);
        expect(summarizeGpuDevices({ gpuDevice: 'no' })).toEqual([]);
        expect(summarizeGpuDevices({ gpuDevice: [null, 3, { vendorId: 0, deviceId: 0 }] })).toEqual([]);
    });

    it('labels unknown vendors by id', () => {
        expect(summarizeGpuDevices({ gpuDevice: [{ vendorId: 0x1234, deviceId: 1 }] })[0].vendor).toBe('0x1234');
    });
});

// ── Capture pacing: the measured interval (delta_ms) vs the scheduled period ─
describe('parseCaptureTimingLog — measured interval', () => {
    // Real line shape (Chromium 150, desktop_capture_device.cc:898, this repo's harness).
    const delta = (ms: number) => `${P}:898]  delta_ms=${ms}, frame_rate=${(1000 / ms).toFixed(4)} [fps]`;
    const paced = (dur: number, period: number, real: number) =>
        `${P}:866] CaptureFrame(is_refresh_frame=0)\n${delta(real)}\n` + frame(dur, period).split('\n').slice(1).join('\n');

    it('reads the owner\'s DXGI case: 3–4 ms grabs, 11 ms scheduled, ~12.1 ms real (timer late)', () => {
        const frames = Array.from({ length: 60 }, (_, i) => paced(i % 2 ? 3 : 4, 11, i % 2 ? 11.3 : 12.9)).join('\n');
        const t = parseCaptureTimingLog(start(90) + '\n' + frames)!;
        expect(t.periodMs).toBe(11);
        expect(t.intervalMs).toBe(12.1);
        expect(t.captureMs).toBe(3.5);
    });

    it('omits intervalMs for logs without delta_ms lines (older shape)', () => {
        const frames = Array.from({ length: 30 }, () => frame(4, 11)).join('\n');
        expect(parseCaptureTimingLog(start(90) + '\n' + frames)!.intervalMs).toBeUndefined();
    });
});

// ── Automatic screen capturer on Windows ────────────────────────────────────
describe('decideAutoScreenCapturer', () => {
    const DESKTOP = { hybrid: false, vendors: ['NVIDIA', 'AMD', 'Microsoft (software)'] };
    const LAPTOP = { hybrid: true, vendors: ['Intel', 'NVIDIA'] };
    it.each<[string, string, number | null, typeof DESKTOP | null, 'dxgi' | 'chromium-default', RegExp]>([
        ['owner: Win11 26200, NVIDIA + AMD desktop', 'win32', 26200, DESKTOP, 'dxgi', /DXGI/],
        ['24H2 exactly', 'win32', WIN11_24H2_BUILD, DESKTOP, 'dxgi', /DXGI/],
        ['hybrid laptop (Optimus / AMD switchable) keeps WGC', 'win32', 26200, LAPTOP, 'chromium-default', /hybrid/],
        ['first launch: layout unknown → Chromium default', 'win32', 26200, null, 'chromium-default', /not known/],
        ['pre-24H2: Chromium already uses DXGI', 'win32', 22631, DESKTOP, 'chromium-default', /< 24H2/],
        ['Windows build unknown', 'win32', null, DESKTOP, 'chromium-default', /unknown/],
        ['not Windows', 'linux', null, DESKTOP, 'chromium-default', /linux/],
    ])('%s', (_l, platform, windowsBuild, gpu, backend, why) => {
        const d = decideAutoScreenCapturer({ platform, windowsBuild, gpu });
        expect(d.backend).toBe(backend);
        expect(d.why).toMatch(why);
    });

    it('only "auto → dxgi" adds a switch; an explicit pref still wins', () => {
        expect(buildChromiumMediaSwitches('win32', 'auto', 'dxgi').disableFeatures).toEqual(['AllowWgcScreenCapturer']);
        expect(buildChromiumMediaSwitches('win32', 'auto', 'chromium-default').disableFeatures).toEqual([]);
        expect(buildChromiumMediaSwitches('win32', 'wgc', 'dxgi')).toEqual({
            enableFeatures: ['PlatformH264CbpEncoding', 'AllowWgcScreenCapturer'], disableFeatures: [],
        });
        expect(buildChromiumMediaSwitches('linux', 'auto', 'dxgi').disableFeatures).toEqual([]);
    });

    it('the overlay reports what auto actually did', () => {
        const base = { platform: 'win32', windowsBuild: 26200, pref: 'auto' as const, sourceKind: 'screen' as const };
        expect(expectedScreenCapturer({ ...base, auto: decideAutoScreenCapturer({ platform: 'win32', windowsBuild: 26200, gpu: DESKTOP }) }))
            .toEqual({ backend: 'dxgi', why: 'auto: DXGI (grabs ~2.7× faster than WGC)' });
        expect(expectedScreenCapturer({ ...base, auto: decideAutoScreenCapturer({ platform: 'win32', windowsBuild: 26200, gpu: LAPTOP }) }))
            .toEqual({ backend: 'wgc', why: 'auto: hybrid GPU — DXGI can fail there' });
        // Window sources are WGC whatever auto decided.
        expect(expectedScreenCapturer({ ...base, sourceKind: 'window', auto: { backend: 'dxgi', why: 'x' } }).backend).toBe('wgc');
        // Without an auto decision the old behaviour stands.
        expect(expectedScreenCapturer(base).why).toBe('auto: Windows build 26200 ≥ 24H2');
    });
});

describe('GPU topology hint (persisted for the next launch)', () => {
    it('reads Chromium\'s own hybrid flags from getGPUInfo(basic)', () => {
        const info = (aux: Record<string, unknown>) => ({
            gpuDevice: [{ vendorId: 0x10de, deviceId: 1, active: true }, { vendorId: 0x8086, deviceId: 2 }],
            auxAttributes: aux,
        });
        expect(gpuTopologyFromInfo(info({ optimus: true }))).toEqual({ hybrid: true, vendors: ['NVIDIA', 'Intel'] });
        expect(gpuTopologyFromInfo(info({ amdSwitchable: true }))!.hybrid).toBe(true);
        expect(gpuTopologyFromInfo(info({ optimus: false, amdSwitchable: false }))!.hybrid).toBe(false);
        expect(gpuTopologyFromInfo(info({}))!.hybrid).toBe(false);
        expect(gpuTopologyFromInfo({ gpuDevice: [] })).toBeNull();
        expect(gpuTopologyFromInfo(null)).toBeNull();
    });

    it('round-trips, and a bad file is "unknown", never an error', () => {
        const h = { hybrid: false, vendors: ['NVIDIA', 'AMD'] };
        expect(parseGpuTopologyHint(serializeGpuTopologyHint(h))).toEqual(h);
        for (const bad of [null, '', 'not json', '{"hybrid":"no"}', '[]', 'x'.repeat(5000)]) {
            expect(parseGpuTopologyHint(bad)).toBeNull();
        }
        expect(parseGpuTopologyHint('{"hybrid":true,"vendors":[1,"Intel"]}')).toEqual({ hybrid: true, vendors: ['Intel'] });
    });
});

describe('resolveCapturedDisplayHz', () => {
    const displays = [{ id: 111, displayFrequency: 200 }, { id: 222, displayFrequency: 60 }];
    it('matches the captured screen by display_id', () => {
        expect(resolveCapturedDisplayHz({ sourceKind: 'screen', displayId: '222', displays, primaryId: 111 }))
            .toEqual({ hz: 60, how: 'matched' });
    });
    it('falls back to the primary (a labelled guess) when the source carries no usable display_id — the "? Hz" case', () => {
        expect(resolveCapturedDisplayHz({ sourceKind: 'screen', displayId: '', displays, primaryId: 111 }))
            .toEqual({ hz: 200, how: 'primary' });
        expect(resolveCapturedDisplayHz({ sourceKind: 'screen', displayId: '999', displays, primaryId: 111 }))
            .toEqual({ hz: 200, how: 'primary' });
    });
    it('a single display is the display, whatever the source says', () => {
        expect(resolveCapturedDisplayHz({ sourceKind: 'window', displays: [{ id: 5, displayFrequency: 144 }], primaryId: 5 }))
            .toEqual({ hz: 144, how: 'only-display' });
    });
    it('window shares on several displays use the primary', () => {
        expect(resolveCapturedDisplayHz({ sourceKind: 'window', displays, primaryId: 222 })).toEqual({ hz: 60, how: 'primary' });
    });
    it('0 Hz (virtual/Linux) is unknown, not a limit; unknown sources get nothing', () => {
        expect(resolveCapturedDisplayHz({ sourceKind: 'screen', displayId: '1', displays: [{ id: 1, displayFrequency: 0 }], primaryId: 1 }))
            .toEqual({ hz: null, how: null });
        expect(resolveCapturedDisplayHz({ sourceKind: 'unknown', displays, primaryId: 111 })).toEqual({ hz: null, how: null });
    });
});
