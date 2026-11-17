import { describe, it, expect, beforeEach } from 'vitest';
import {
    __resetAudioOutputFactsCache, collectAudioOutputFacts, mapNativeEndpoints, parsePactlSinks, windowsFormFactorName,
} from './audio-output-facts';

beforeEach(() => __resetAudioOutputFactsCache());

describe('Windows native endpoints', () => {
    it('maps EndpointFormFactor numbers to names', () => {
        const names = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(windowsFormFactorName);
        expect(names).toEqual(['remote', 'speakers', 'line_level', 'headphones', 'microphone', 'headset', 'handset', 'digital_passthrough', 'spdif', 'display', 'unknown']);
        expect(windowsFormFactorName(99)).toBeUndefined();
        expect(windowsFormFactorName('1')).toBeUndefined();
    });

    it('normalises the addon answer and drops malformed rows', () => {
        const out = mapNativeEndpoints('win32', [
            { name: 'Speakers (Realtek(R) Audio)', isDefault: true, isCommunications: false, formFactor: 1, jackSubType: 'dff21ce1-f70f-11d0-b917-00a0c9223196' },
            { name: 'Headset (X)', isCommunications: true, formFactor: 5, jackSubType: 'not-a-guid' },
            { name: '' }, { formFactor: 1 }, null, 7,
        ]);
        expect(out).toEqual([
            { name: 'Speakers (Realtek(R) Audio)', isDefault: true, isCommunications: false, formFactor: 'speakers', jackSubType: 'dff21ce1-f70f-11d0-b917-00a0c9223196' },
            { name: 'Headset (X)', isDefault: false, isCommunications: true, formFactor: 'headset' },
        ]);
    });

    it('a non-array answer is no facts', () => {
        expect(mapNativeEndpoints('win32', undefined)).toEqual([]);
        expect(mapNativeEndpoints('win32', 'x')).toEqual([]);
    });
});

describe('macOS native endpoints', () => {
    it('maps transport and data-source FourCCs', () => {
        const out = mapNativeEndpoints('darwin', [
            { name: 'MacBook Pro Speakers', isDefault: true, transport: 'bltn', dataSource: 'ispk' },
            { name: 'External Headphones', transport: 'bltn', dataSource: 'hdpn' },
            { name: "Dawson's AirPods", transport: 'blue' },
            { name: 'Studio Display', transport: 'usb ' },
        ]);
        expect(out.map(o => [o.transport, o.dataSource])).toEqual([['builtin', 'speaker'], ['builtin', 'headphones'], ['bluetooth', undefined], ['usb', undefined]]);
        expect(out[0].isDefault).toBe(true);
    });
});

describe('PulseAudio / PipeWire sinks', () => {
    const sinks = [
        {
            name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo',
            active_port: 'analog-output-headphones',
            ports: [{ name: 'analog-output-speaker', type: 'Speaker' }, { name: 'analog-output-headphones', type: 'Headphones' }],
            properties: { 'device.form_factor': 'internal', 'device.bus': 'pci' },
        },
        {
            name: 'bluez_output.AA_BB', description: 'WH-1000XM5', active_port: 'headset-output',
            ports: [{ name: 'headset-output', type: 'Headset' }], properties: { 'device.bus': 'bluetooth', 'device.form_factor': 'headphone' },
        },
        { name: 'alsa_output.hdmi', description: 'HDMI / DisplayPort', active_port: 'hdmi-output-0', ports: [{ name: 'hdmi-output-0', type: 'HDMI' }], properties: {} },
    ];

    it('reads the active port, its type, the form factor and the bus; marks the default', () => {
        const out = parsePactlSinks(sinks, 'alsa_output.pci-0000_00_1f.3.analog-stereo');
        expect(out[0]).toEqual({ name: 'Built-in Audio Analog Stereo', isDefault: true, formFactor: 'internal', transport: 'pci', port: 'analog-output-headphones headphones' });
        expect(out[1]).toMatchObject({ name: 'WH-1000XM5', isDefault: false, formFactor: 'headphone', transport: 'bluetooth', port: 'headset-output headset' });
        expect(out[2].port).toBe('hdmi-output-0 hdmi');
    });

    it('garbage is no facts', () => {
        expect(parsePactlSinks({}, '')).toEqual([]);
        expect(parsePactlSinks([null, 3, { description: '' }], '')).toEqual([]);
    });
});

describe('collectAudioOutputFacts', () => {
    const noRun = () => Promise.reject(new Error('no pactl'));

    it('Windows: asks the addon; an addon without the export (older build) yields none', async () => {
        const addon = { getAudioOutputEndpoints: () => [{ name: 'Speakers (X)', isDefault: true, formFactor: 1 }] };
        expect(await collectAudioOutputFacts({ platform: 'win32', addon, run: noRun })).toHaveLength(1);
        __resetAudioOutputFactsCache();
        expect(await collectAudioOutputFacts({ platform: 'win32', addon: {}, run: noRun })).toEqual([]);
        __resetAudioOutputFactsCache();
        expect(await collectAudioOutputFacts({ platform: 'win32', addon: null, run: noRun })).toEqual([]);
    });

    it('an addon that throws is no facts, never a rejection', async () => {
        const addon = { getAudioOutputEndpoints: () => { throw new Error('com'); } };
        expect(await collectAudioOutputFacts({ platform: 'win32', addon, run: noRun })).toEqual([]);
    });

    it('Linux: runs pactl twice and parses; a missing pactl is no facts', async () => {
        const calls: string[] = [];
        const run = async (_cmd: string, args: string[]) => {
            calls.push(args.join(' '));
            return args[0] === 'get-default-sink' ? 'sinkA\n' : JSON.stringify([{ name: 'sinkA', description: 'A', active_port: 'p', ports: [{ name: 'p', type: 'Speaker' }], properties: {} }]);
        };
        const out = await collectAudioOutputFacts({ platform: 'linux', addon: null, run });
        expect(out).toEqual([{ name: 'A', isDefault: true, port: 'p speaker' }]);
        expect(calls.sort()).toEqual(['--format=json list sinks', 'get-default-sink']);
        __resetAudioOutputFactsCache();
        expect(await collectAudioOutputFacts({ platform: 'linux', addon: null, run: noRun })).toEqual([]);
    });

    it('Linux: non-JSON output (an old pactl) is no facts', async () => {
        expect(await collectAudioOutputFacts({ platform: 'linux', addon: null, run: async () => 'Sink #0\n  State: RUNNING' })).toEqual([]);
    });

    it('caches for 2 s, then asks again', async () => {
        let n = 0; let t = 1000;
        const addon = { getAudioOutputEndpoints: () => { n++; return []; } };
        const deps = { platform: 'win32', addon, run: noRun, now: () => t };
        await collectAudioOutputFacts(deps); await collectAudioOutputFacts(deps);
        expect(n).toBe(1);
        t += 2500;
        await collectAudioOutputFacts(deps);
        expect(n).toBe(2);
    });

    it('other platforms: none', async () => {
        expect(await collectAudioOutputFacts({ platform: 'freebsd', addon: null, run: noRun })).toEqual([]);
    });
});
