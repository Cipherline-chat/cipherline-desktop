/**
 * Facts about the audio OUTPUT devices, for "speakers or headphones?"
 * (renderer: src/utils/outputKind.ts decides; this file only gathers and
 * normalises what the operating system says).
 *
 * Per platform:
 *   - Windows: the native addon's getAudioOutputEndpoints() (IMMDevice
 *     PKEY_AudioEndpoint_FormFactor + JackSubType, src-native/audio_output_kind.cc).
 *   - macOS: the same export (CoreAudio transport type + output data source).
 *   - Linux: `pactl --format=json list sinks` + `pactl get-default-sink` (PulseAudio
 *     and PipeWire's pipewire-pulse both answer it): the sink's active port, its
 *     port type and `device.form_factor`. No pactl, or a pactl too old for JSON
 *     -> [] and the renderer falls back to the device label.
 *
 * Any failure yields []: the renderer then classifies by label, and "unknown"
 * is treated as speakers (echo is the worse failure).
 *
 * Reads device descriptors only. No audio, no application data. No `electron`
 * import and no import from src/ (rootDir): pure, unit-tested in
 * audio-output-facts.test.ts with a fake native addon and a fake pactl.
 */

export interface OutputEndpointFacts {
    /** Display name, matching what Chromium shows as the device label. */
    name: string;
    isDefault?: boolean;
    isCommunications?: boolean;
    /** windows: speakers | headphones | headset | handset | line_level | spdif | display | remote | digital_passthrough | unknown.
     *  linux: PulseAudio's device.form_factor, lowercased. */
    formFactor?: string;
    /** Windows: the jack's KSNODETYPE GUID (lowercase, no braces). */
    jackSubType?: string;
    /** macOS: builtin | usb | bluetooth | hdmi | displayport | airplay | virtual | other. linux: device.bus (bluetooth, usb, pci...). */
    transport?: string;
    /** macOS: the active data source: speaker | headphones | other. */
    dataSource?: string;
    /** Linux: the active port, "<name> <type>" lowercased (e.g. "analog-output-headphones headphones"). */
    port?: string;
}

/** The raw object the native addon returns. */
export interface NativeEndpoint {
    name?: unknown;
    isDefault?: unknown;
    isCommunications?: unknown;
    formFactor?: unknown;
    jackSubType?: unknown;
    transport?: unknown;
    dataSource?: unknown;
}

// EndpointFormFactor (mmdeviceapi.h).
const WIN_FORM_FACTOR: Record<number, string> = {
    0: 'remote', 1: 'speakers', 2: 'line_level', 3: 'headphones', 4: 'microphone', 5: 'headset',
    6: 'handset', 7: 'digital_passthrough', 8: 'spdif', 9: 'display', 10: 'unknown',
};

export function windowsFormFactorName(n: unknown): string | undefined {
    return typeof n === 'number' ? WIN_FORM_FACTOR[n] : undefined;
}

function macTransport(fourcc: string): string {
    switch (fourcc) {
        case 'bltn': return 'builtin';
        case 'usb ': return 'usb';
        case 'blue': case 'blea': return 'bluetooth';
        case 'hdmi': return 'hdmi';
        case 'dprt': return 'displayport';
        case 'airp': return 'airplay';
        case 'virt': case 'grup': return 'virtual';
        default: return 'other';
    }
}

function macDataSource(fourcc: string): string {
    if (fourcc === 'ispk' || fourcc === 'ispe') return 'speaker';   // internal speaker (stereo)
    if (fourcc === 'hdpn') return 'headphones';
    return 'other';
}

/** Normalise the addon's answer. Anything not an object with a name is dropped. */
export function mapNativeEndpoints(platform: string, raw: unknown): OutputEndpointFacts[] {
    if (!Array.isArray(raw)) return [];
    const out: OutputEndpointFacts[] = [];
    for (const e of raw as NativeEndpoint[]) {
        if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name) continue;
        const f: OutputEndpointFacts = { name: e.name.slice(0, 200), isDefault: e.isDefault === true };
        if (platform === 'win32') {
            f.isCommunications = e.isCommunications === true;
            const ff = windowsFormFactorName(e.formFactor);
            if (ff) f.formFactor = ff;
            if (typeof e.jackSubType === 'string' && /^[0-9a-f-]{36}$/.test(e.jackSubType)) f.jackSubType = e.jackSubType;
        } else if (platform === 'darwin') {
            if (typeof e.transport === 'string') f.transport = macTransport(e.transport);
            if (typeof e.dataSource === 'string') f.dataSource = macDataSource(e.dataSource);
        }
        out.push(f);
    }
    return out.slice(0, 64);
}

interface PactlPort { name?: unknown; type?: unknown; description?: unknown }
interface PactlSink {
    name?: unknown; description?: unknown; active_port?: unknown; ports?: unknown; properties?: unknown;
}

/** `pactl --format=json list sinks` output + the default sink's name -> facts. */
export function parsePactlSinks(json: unknown, defaultSinkName: string): OutputEndpointFacts[] {
    if (!Array.isArray(json)) return [];
    const out: OutputEndpointFacts[] = [];
    for (const s of json as PactlSink[]) {
        if (!s || typeof s !== 'object') continue;
        const desc = typeof s.description === 'string' ? s.description : '';
        const sinkName = typeof s.name === 'string' ? s.name : '';
        const name = desc || sinkName;
        if (!name) continue;
        const f: OutputEndpointFacts = { name: name.slice(0, 200), isDefault: !!defaultSinkName && sinkName === defaultSinkName };
        const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, unknown>;
        const ff = props['device.form_factor'];
        if (typeof ff === 'string' && ff) f.formFactor = ff.toLowerCase();
        const bus = props['device.bus'];
        if (typeof bus === 'string' && bus) f.transport = bus.toLowerCase();
        const active = typeof s.active_port === 'string' ? s.active_port : '';
        if (active) {
            const ports = Array.isArray(s.ports) ? (s.ports as PactlPort[]) : [];
            const p = ports.find(x => x && x.name === active);
            const type = p && typeof p.type === 'string' ? p.type : '';
            f.port = `${active} ${type}`.trim().toLowerCase();
        }
        out.push(f);
    }
    return out.slice(0, 64);
}

export interface FactsDeps {
    platform: string;
    /** The loaded audio_capture addon (or null when it did not load). */
    addon: { getAudioOutputEndpoints?: () => unknown } | null;
    /** Run a command, resolve its stdout; reject on error / timeout. */
    run: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
    now?: () => number;
}

const CACHE_MS = 2000;
let cache: { at: number; value: OutputEndpointFacts[] } | null = null;
let inflight: Promise<OutputEndpointFacts[]> | null = null;

export function __resetAudioOutputFactsCache(): void { cache = null; inflight = null; }

/** Never rejects. Concurrent calls share one probe; the answer is cached for 2 s. */
export function collectAudioOutputFacts(deps: FactsDeps): Promise<OutputEndpointFacts[]> {
    const now = (deps.now ?? Date.now)();
    if (cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = (async (): Promise<OutputEndpointFacts[]> => {
        let value: OutputEndpointFacts[] = [];
        try {
            if (deps.platform === 'win32' || deps.platform === 'darwin') {
                const fn = deps.addon?.getAudioOutputEndpoints;
                // An addon built before this export existed simply lacks it: no facts, label heuristics.
                if (typeof fn === 'function') value = mapNativeEndpoints(deps.platform, fn.call(deps.addon));
            } else if (deps.platform === 'linux') {
                const [listing, def] = await Promise.all([
                    deps.run('pactl', ['--format=json', 'list', 'sinks'], 2500),
                    deps.run('pactl', ['get-default-sink'], 2500).catch(() => ''),
                ]);
                value = parsePactlSinks(JSON.parse(listing), def.trim());
            }
        } catch {
            value = [];
        }
        cache = { at: (deps.now ?? Date.now)(), value };
        return value;
    })().finally(() => { inflight = null; });
    return inflight;
}
