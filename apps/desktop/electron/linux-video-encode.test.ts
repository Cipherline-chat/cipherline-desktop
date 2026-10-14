import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    decideLinuxHwEncode, parseLinuxHwEncodeMode, LINUX_HW_ENCODE_FEATURE, LINUX_HW_ENCODE_ENV,
    LINUX_HW_ENCODE_DEFAULT_ON, LINUX_HW_ENCODE_BLOCKING_SWITCHES,
} from './linux-video-encode';
import { buildChromiumMediaSwitches } from './capture-flags';

const noSwitches = () => false;
const only = (...names: string[]) => (n: string) => names.includes(n);

describe('parseLinuxHwEncodeMode', () => {
    it.each([['1', 'on'], ['on', 'on'], ['TRUE', 'on'], [' yes ', 'on'], ['0', 'off'], ['off', 'off'], ['False', 'off'], ['no', 'off']])(
        '%j -> %s', (v, want) => expect(parseLinuxHwEncodeMode(v)).toBe(want));
    it.each([undefined, '', '2', 'maybe', 'enable'])('%j -> auto (never an error: it is a test knob)', (v) => {
        expect(parseLinuxHwEncodeMode(v)).toBe('auto');
    });
});

describe('decideLinuxHwEncode', () => {
    it('is OFF by default until hardware encode has been seen working on real AMD / Intel hardware', () => {
        // If this flips to true, the dev-box evidence in linux-video-encode.ts must be replaced with a
        // working measurement first - see the header.
        expect(LINUX_HW_ENCODE_DEFAULT_ON).toBe(false);
        expect(decideLinuxHwEncode({ platform: 'linux', mode: 'auto', hasSwitch: noSwitches }))
            .toEqual({ enable: false, features: [], reason: 'auto: off by default' });
    });

    it('opt-in: the env knob turns exactly the one verified feature on', () => {
        expect(decideLinuxHwEncode({ platform: 'linux', mode: 'on', hasSwitch: noSwitches }))
            .toEqual({ enable: true, features: ['AcceleratedVideoEncoder'], reason: 'on (env)' });
        expect(LINUX_HW_ENCODE_FEATURE).toBe('AcceleratedVideoEncoder');
        expect(LINUX_HW_ENCODE_ENV).toBe('CIPHERLINE_LINUX_HW_ENCODE');
    });

    it('explicit off wins over everything', () => {
        expect(decideLinuxHwEncode({ platform: 'linux', mode: 'off', hasSwitch: noSwitches }).enable).toBe(false);
    });

    it('is Linux only - Windows and macOS keep their own encoders (Media Foundation / VideoToolbox)', () => {
        for (const platform of ['win32', 'darwin']) {
            for (const mode of ['auto', 'on', 'off'] as const) {
                expect(decideLinuxHwEncode({ platform, mode, hasSwitch: noSwitches })).toEqual({ enable: false, features: [], reason: 'not linux' });
            }
        }
    });

    it('does not even try when the user launched with the GPU or video acceleration switched off', () => {
        expect(LINUX_HW_ENCODE_BLOCKING_SWITCHES).toEqual(['disable-gpu', 'disable-accelerated-video-encode']);
        for (const sw of LINUX_HW_ENCODE_BLOCKING_SWITCHES) {
            const d = decideLinuxHwEncode({ platform: 'linux', mode: 'on', hasSwitch: only(sw) });
            expect(d).toEqual({ enable: false, features: [], reason: `blocked by --${sw}` });
        }
    });

    it('never enables anything for NVIDIA: VaapiOnNvidiaGPUs and the blocklist override stay untouched', () => {
        // nvidia-vaapi-driver is decode-only; Chromium skips nvidia-drm unless VaapiOnNvidiaGPUs (off by default).
        const d = decideLinuxHwEncode({ platform: 'linux', mode: 'on', hasSwitch: noSwitches });
        expect(d.features.join(',')).not.toMatch(/Nvidia/i);
        expect(d.features).toEqual(['AcceleratedVideoEncoder']);
    });
});

describe('the assembled --enable-features list', () => {
    it('Linux, opt-in: ONE list with the capturer feature and the encoder feature', () => {
        const m = buildChromiumMediaSwitches('linux', 'auto', 'chromium-default', ['AcceleratedVideoEncoder']);
        expect(m.enableFeatures).toEqual(['WebRTCPipeWireCapturer', 'AcceleratedVideoEncoder']);
        expect(m.disableFeatures).toEqual([]);
    });

    it('does not duplicate an entry that is already there', () => {
        const m = buildChromiumMediaSwitches('linux', 'auto', 'chromium-default', ['WebRTCPipeWireCapturer', 'AcceleratedVideoEncoder', 'AcceleratedVideoEncoder']);
        expect(m.enableFeatures).toEqual(['WebRTCPipeWireCapturer', 'AcceleratedVideoEncoder']);
    });

    it('default (nothing extra) is byte-for-byte what it was before', () => {
        expect(buildChromiumMediaSwitches('linux', 'auto')).toEqual({ enableFeatures: ['WebRTCPipeWireCapturer'], disableFeatures: [] });
        expect(buildChromiumMediaSwitches('darwin', 'auto')).toEqual({ enableFeatures: [], disableFeatures: [] });
    });

    it('the Windows list is unchanged by the Linux decision', () => {
        const win = buildChromiumMediaSwitches('win32', 'auto', 'chromium-default', decideLinuxHwEncode({ platform: 'win32', mode: 'on', hasSwitch: noSwitches }).features);
        expect(win).toEqual(buildChromiumMediaSwitches('win32', 'auto'));
    });
});

describe('main.ts wiring (source pins - main.ts cannot run under vitest)', () => {
    const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');

    it('feeds the decision into the ONE media feature list and reports it in capture:switches', () => {
        expect(MAIN).toMatch(/decideLinuxHwEncode\(\{[\s\S]*?platform: process\.platform,[\s\S]*?parseLinuxHwEncodeMode\(process\.env\[LINUX_HW_ENCODE_ENV\]\)/);
        expect(MAIN).toMatch(/buildChromiumMediaSwitches\(process\.platform, SCREEN_CAPTURER_PREF, AUTO_CAPTURER\.backend, linuxHwEncode\.features\)/);
        expect(MAIN).toMatch(/linux_hw_encode=\$\{linuxHwEncode\.reason\}/);
    });

    it('appends enable-features exactly once (a second append would silently replace the first list)', () => {
        const appends = MAIN.match(/appendSwitch\('enable-features'/g) ?? [];
        expect(appends).toHaveLength(1);
    });

    it('never touches the GPU blocklist or the NVIDIA VA-API gate', () => {
        expect(MAIN).not.toMatch(/ignore-gpu-blocklist/);
        expect(MAIN).not.toMatch(/VaapiOnNvidiaGPUs/);
    });
});
