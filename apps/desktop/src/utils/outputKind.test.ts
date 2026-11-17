/**
 * Speakers vs headphones: label heuristics, OS facts -> class, matching Chromium's
 * device to the OS record, and the auto echo-cancellation default built on it
 * (never chosen / user-set / an older stored `true` / output device change).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>([['cipherline_voice_defaults_migrated_v1', '1']]);
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import secureLocalStore from './secureLocalStore';
import {
    autoEchoCancellation, classifyEndpointFacts, classifyOutputLabel, describeAutoEcho, effectiveEchoCancellation,
    matchEndpointFacts, resolveEchoAutoFlag, resolveOutputKind, stripDeviceLabelPrefix, type OutputEndpointFacts,
} from './outputKind';
import { sanitizeFacts } from './outputKindProbe';
import { DEFAULT_VOICE_SETTINGS, VOICE_SETTINGS_STORAGE_KEY, loadVoiceSettings } from '../hooks/useVoiceSettings';
import { classifyKvKey } from '../services/backupRegistry';
import { ECHO_PROMPT_STORAGE_KEY } from './echoPrompt';

describe('label heuristics', () => {
    const cases: [string, 'speakers' | 'headphones' | 'unknown'][] = [
        ['Speakers (Realtek(R) Audio)', 'speakers'],
        ['Default - Speakers (Realtek(R) Audio)', 'speakers'],
        ['Communications - Speakers (Realtek(R) Audio)', 'speakers'],
        ['Headphones (Realtek(R) Audio)', 'headphones'],
        ['Headset Earphone (Realtek High Definition Audio)', 'headphones'],
        ['Headset (HyperX Cloud II Wireless)', 'headphones'],
        ['Speakers (Arctis 7 Game)', 'headphones'],
        ['AirPods Pro', 'headphones'],
        ["Dawson's AirPods", 'headphones'],
        ['WH-1000XM5 Hands-Free', 'headphones'],
        ['Galaxy Buds2', 'headphones'],
        ['Earbuds', 'headphones'],
        ['MacBook Pro Speakers', 'speakers'],
        ['External Headphones', 'headphones'],
        ['LG ULTRAGEAR (NVIDIA High Definition Audio)', 'speakers'],
        ['DELL U2723QE (HDMI)', 'speakers'],
        ['Display Audio', 'speakers'],
        ['Monitor Audio', 'speakers'],
        ['Samsung Soundbar Q70', 'speakers'],
        ['Built-in Audio Analog Stereo', 'unknown'],
        ['Speakers (USB Audio Device)', 'speakers'],
        // both words: a jack-sensing codec's combined name is ambiguous, never guessed
        ['Headphones/Speakers (Realtek(R) Audio)', 'unknown'],
        ['', 'unknown'],
    ];
    for (const [label, want] of cases) it(`${JSON.stringify(label)} -> ${want}`, () => expect(classifyOutputLabel(label)).toBe(want));

    it('null / undefined are unknown', () => {
        expect(classifyOutputLabel(null)).toBe('unknown');
        expect(classifyOutputLabel(undefined)).toBe('unknown');
    });

    it('strips only Chromium\'s two synthetic prefixes', () => {
        expect(stripDeviceLabelPrefix('Default - Speakers (X)')).toBe('Speakers (X)');
        expect(stripDeviceLabelPrefix('Communications - Headset (Y)')).toBe('Headset (Y)');
        expect(stripDeviceLabelPrefix('Default Speakers')).toBe('Default Speakers');
    });
});

describe('OS facts -> class', () => {
    const f = (o: Partial<OutputEndpointFacts>): OutputEndpointFacts => ({ name: 'x', ...o });

    it('Windows form factor: speakers / display are speakers; headphones, headset, handset are headphones', () => {
        expect(classifyEndpointFacts(f({ formFactor: 'speakers' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ formFactor: 'display' }))).toBe('speakers'); // monitor speakers
        expect(classifyEndpointFacts(f({ formFactor: 'headphones' }))).toBe('headphones');
        expect(classifyEndpointFacts(f({ formFactor: 'headset' }))).toBe('headphones');
        expect(classifyEndpointFacts(f({ formFactor: 'handset' }))).toBe('headphones');
    });

    it('Windows: a generic or line-level endpoint is decided by its jack sub-type, otherwise unknown', () => {
        expect(classifyEndpointFacts(f({ formFactor: 'line_level', jackSubType: 'dff21ce2-f70f-11d0-b917-00a0c9223196' }))).toBe('headphones');
        expect(classifyEndpointFacts(f({ formFactor: 'unknown', jackSubType: 'dff21ce1-f70f-11d0-b917-00a0c9223196' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ formFactor: 'line_level' }))).toBe('unknown');
        expect(classifyEndpointFacts(f({ formFactor: 'spdif' }))).toBe('unknown');
        expect(classifyEndpointFacts(f({ formFactor: 'remote' }))).toBe('unknown');
    });

    it('form factor outranks the jack (a USB headset whose jack GUID says speaker is still a headset)', () => {
        expect(classifyEndpointFacts(f({ formFactor: 'headset', jackSubType: 'dff21ce1-f70f-11d0-b917-00a0c9223196' }))).toBe('headphones');
    });

    it('macOS: the data source decides; a built-in output with none is the speaker; Bluetooth/USB are left to the label', () => {
        expect(classifyEndpointFacts(f({ transport: 'builtin', dataSource: 'headphones' }))).toBe('headphones');
        expect(classifyEndpointFacts(f({ transport: 'builtin', dataSource: 'speaker' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ transport: 'builtin' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ transport: 'hdmi' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ transport: 'bluetooth' }))).toBe('unknown');
        expect(classifyEndpointFacts(f({ transport: 'usb' }))).toBe('unknown');
    });

    it('Linux: the active port, then the form factor', () => {
        expect(classifyEndpointFacts(f({ port: 'analog-output-headphones headphones' }))).toBe('headphones');
        expect(classifyEndpointFacts(f({ port: 'analog-output-speaker speaker' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ port: 'hdmi-output-0 hdmi' }))).toBe('speakers');
        expect(classifyEndpointFacts(f({ port: 'headset-output headset' }))).toBe('headphones'); // BlueZ
        expect(classifyEndpointFacts(f({ formFactor: 'headset' }))).toBe('headphones');
        expect(classifyEndpointFacts(f({ formFactor: 'internal' }))).toBe('unknown');
        expect(classifyEndpointFacts(f({ port: 'analog-output-lineout lineout' }))).toBe('speakers');
    });

    it('nothing useful -> unknown', () => {
        expect(classifyEndpointFacts(f({}))).toBe('unknown');
    });
});

describe('matching the Chromium device to the OS record', () => {
    const win: OutputEndpointFacts[] = [
        { name: 'Speakers (Realtek(R) Audio)', isDefault: true, formFactor: 'speakers' },
        { name: 'Headset Earphone (Logitech G PRO X)', isCommunications: true, formFactor: 'headset' },
        { name: 'LG ULTRAGEAR (NVIDIA High Definition Audio)', formFactor: 'display' },
    ];

    it('"default" / "" resolves to the system default, "communications" to the communications default', () => {
        expect(matchEndpointFacts('default', 'Default - Speakers (Realtek(R) Audio)', win)?.formFactor).toBe('speakers');
        expect(matchEndpointFacts('', null, win)?.formFactor).toBe('speakers');
        expect(matchEndpointFacts('communications', 'Communications - Headset Earphone (Logitech G PRO X)', win)?.formFactor).toBe('headset');
    });

    it('a concrete device matches by exact name (case and spacing insensitive)', () => {
        expect(matchEndpointFacts('abc', 'headset  earphone (logitech g pro x)', win)?.formFactor).toBe('headset');
        expect(matchEndpointFacts('abc', 'LG ULTRAGEAR (NVIDIA High Definition Audio)', win)?.formFactor).toBe('display');
    });

    it('falls back to a unique substring match; an ambiguous one is no match', () => {
        expect(matchEndpointFacts('abc', 'LG ULTRAGEAR', win)?.formFactor).toBe('display');
        expect(matchEndpointFacts('abc', '(', win)).toBeNull(); // matches all three
    });

    it('no facts / no match -> null', () => {
        expect(matchEndpointFacts('abc', 'Something Else', win)).toBeNull();
        expect(matchEndpointFacts('default', 'x', [])).toBeNull();
    });
});

describe('resolveOutputKind', () => {
    const outputs = [
        { deviceId: 'default', label: 'Default - Speakers (USB Audio Device)' },
        { deviceId: 'communications', label: 'Communications - Speakers (USB Audio Device)' },
        { deviceId: 'dev1', label: 'Speakers (USB Audio Device)' },
        { deviceId: 'dev2', label: 'Headphones (Realtek(R) Audio)' },
    ];

    it('the OS answer beats the label: Windows calls a USB headset "Speakers", the form factor knows', () => {
        const r = resolveOutputKind({
            speakerDeviceId: '', outputs,
            facts: [{ name: 'Speakers (USB Audio Device)', isDefault: true, formFactor: 'headset' }],
        });
        expect(r).toEqual({ kind: 'headphones', source: 'os' });
    });

    it('no OS facts: the label decides', () => {
        expect(resolveOutputKind({ speakerDeviceId: 'dev2', outputs, facts: [] })).toEqual({ kind: 'headphones', source: 'label' });
        expect(resolveOutputKind({ speakerDeviceId: 'dev1', outputs, facts: [] })).toEqual({ kind: 'speakers', source: 'label' });
    });

    it('an OS record that says nothing decisive defers to its own name', () => {
        const r = resolveOutputKind({
            speakerDeviceId: 'x', outputs: [{ deviceId: 'x', label: 'External Headphones' }],
            facts: [{ name: 'External Headphones', transport: 'usb' }],
        });
        expect(r).toEqual({ kind: 'headphones', source: 'label' });
    });

    it('nothing known -> unknown (which the auto default treats as speakers)', () => {
        expect(resolveOutputKind({ speakerDeviceId: 'gone', outputs: [], facts: [] })).toEqual({ kind: 'unknown', source: 'none' });
        expect(resolveOutputKind({ speakerDeviceId: '', outputs: [{ deviceId: 'default', label: 'Built-in Audio Analog Stereo' }], facts: [] }).kind).toBe('unknown');
    });

    it('a stored pick that no longer exists still resolves a default-follow through the default row', () => {
        expect(resolveOutputKind({ speakerDeviceId: '', outputs, facts: [{ name: 'x', isDefault: true, formFactor: 'speakers' }] }).kind).toBe('speakers');
    });
});

describe('IPC hygiene', () => {
    it('sanitizeFacts keeps well-formed records only and bounds what it keeps', () => {
        const out = sanitizeFacts([
            { name: 'A', isDefault: true, formFactor: 'speakers', evil: 'x' },
            { name: 5 }, null, 'str', { formFactor: 'headset' },
            { name: 'B', port: 'p'.repeat(500) },
        ]);
        expect(out.map(o => o.name)).toEqual(['A', 'B']);
        expect(out[0]).not.toHaveProperty('evil');
        expect(out[1].port!.length).toBe(200);
        expect(sanitizeFacts('nope')).toEqual([]);
        expect(sanitizeFacts(Array.from({ length: 200 }, () => ({ name: 'n' })))).toHaveLength(64);
    });
});

describe('the auto default', () => {
    it('speakers and unknown -> ON, headphones -> OFF', () => {
        expect(autoEchoCancellation('speakers')).toBe(true);
        expect(autoEchoCancellation('unknown')).toBe(true);
        expect(autoEchoCancellation('headphones')).toBe(false);
    });

    it('while Auto, the output decides and the stored boolean is irrelevant; re-evaluated on a device change', () => {
        const at = (kind: 'speakers' | 'headphones' | 'unknown') => effectiveEchoCancellation({ auto: true, stored: false, kind });
        expect(at('speakers')).toBe(true);
        expect(at('headphones')).toBe(false); // plugged in headphones: off
        expect(at('speakers')).toBe(true);    // unplugged again: back on
        expect(effectiveEchoCancellation({ auto: true, stored: true, kind: 'headphones' })).toBe(false);
    });

    it('an explicit choice always wins, whatever the output', () => {
        for (const kind of ['speakers', 'headphones', 'unknown'] as const) {
            expect(effectiveEchoCancellation({ auto: false, stored: true, kind })).toBe(true);
            expect(effectiveEchoCancellation({ auto: false, stored: false, kind })).toBe(false);
        }
    });

    it('Settings wording', () => {
        expect(describeAutoEcho('speakers')).toBe('Auto (on — speakers detected)');
        expect(describeAutoEcho('headphones')).toBe('Auto (off — headphones detected)');
        expect(describeAutoEcho('unknown')).toMatch(/^Auto \(on/);
    });
});

describe('who counts as "never chose" (migration by absence)', () => {
    it('nothing stored -> Auto', () => expect(resolveEchoAutoFlag(null)).toBe(true));
    // Owner, 2026-11-16: existing users move to Auto too; only a choice made in the
    // On / Auto / Off setting (the flag) is kept. Replaces "any stored value is user-set".
    it('an older blob with a stored TRUE (no flag) -> Auto', () => {
        expect(resolveEchoAutoFlag({ echoCancellation: true, micVolume: 100 })).toBe(true);
    });
    it('an older blob with a stored false (no flag) -> Auto', () => {
        expect(resolveEchoAutoFlag({ echoCancellation: false })).toBe(true);
    });
    it('a blob older than the setting (no boolean at all) -> never chose -> Auto', () => {
        expect(resolveEchoAutoFlag({ micVolume: 100 })).toBe(true);
    });
    it('a blob that already carries the flag follows it', () => {
        expect(resolveEchoAutoFlag({ echoCancellation: false, echoCancellationAuto: true })).toBe(true);
        expect(resolveEchoAutoFlag({ echoCancellation: true, echoCancellationAuto: false })).toBe(false);
    });
    it('garbage -> leave the boolean alone (not Auto)', () => expect(resolveEchoAutoFlag(42)).toBe(false));
});

describe('loadVoiceSettings carries the flag', () => {
    beforeEach(() => { secureLocalStore.removeItem(VOICE_SETTINGS_STORAGE_KEY); });

    it('never saved -> Auto', () => {
        expect(loadVoiceSettings().echoCancellationAuto).toBe(true);
        expect(DEFAULT_VOICE_SETTINGS.echoCancellationAuto).toBe(true);
    });

    it('saved by this version without touching echo (flag true) -> still Auto', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, micVolume: 120 }));
        expect(loadVoiceSettings().echoCancellationAuto).toBe(true);
    });

    // Owner, 2026-11-16: pre-Auto users move to Auto (was: "user-set, kept").
    it('saved before this version with echoCancellation true -> Auto (the stored boolean is kept, unused)', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ micVolume: 100, echoCancellation: true }));
        const s = loadVoiceSettings();
        expect(s.echoCancellationAuto).toBe(true);
        expect(s.echoCancellation).toBe(true);
    });

    it('saved before this version with echoCancellation false -> Auto too', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ micVolume: 100, echoCancellation: false }));
        const s = loadVoiceSettings();
        expect(s.echoCancellationAuto).toBe(true);
        expect(s.echoCancellation).toBe(false);
    });

    it('an explicit pick made by this version (flag false) is kept', () => {
        secureLocalStore.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, echoCancellation: true, echoCancellationAuto: false }));
        const s = loadVoiceSettings();
        expect(s.echoCancellationAuto).toBe(false);
        expect(s.echoCancellation).toBe(true);
    });
});

describe('storage keys', () => {
    it('the prompt nag state is classified (not backed up)', () => {
        expect(classifyKvKey(ECHO_PROMPT_STORAGE_KEY, 'u1')).toBe('exclude');
    });
});
