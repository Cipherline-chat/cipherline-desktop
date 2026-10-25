/**
 * Beta diagnostics — the device profile (contract `POST …/beta/profile`):
 * "what kind of machine is this", so a failure can be lined up against
 * hardware, OS and drivers across the beta.
 *
 * Sources, all already in the app — no new Electron IPC:
 *   - the issue reporter's system info (diagGetSystemInfo → parseSystemInfoReply):
 *     OS version, arch, CPU model + cores, RAM, GPU vendor ids + driver,
 *     displays + scale, hardware-acceleration state, Electron / Chrome;
 *   - the renderer: WebGL's unmasked renderer string (GPU model), media
 *     device COUNTS by kind (enumerateDevices — labels and ids are never
 *     read), navigator.connection, navigator.language.
 *
 * Everything is reduced to coarse classes before it leaves: the CPU model to
 * its family + generation ("Intel Core i7-8xxx"), RAM to a bucket, the
 * locale to two letters. The scrubber's home dir / OS user name never come
 * near this — nothing here is free text.
 */
import type { SystemInfo } from '../diagnostics/reportTypes';
import type { AudioApi, BetaProfileBody, NetworkType, RamBucket } from './types';

export type ProfileCore = Omit<BetaProfileBody, 'schema' | 'session_id' | 'app_version' | 'platform'>;

const SAFE = /[^A-Za-z0-9 ._()+/-]+/g;
const clean = (s: unknown, max = 64): string =>
    (typeof s === 'string' ? s.replace(SAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || 'unknown';

/**
 * Wire-token fields the API matches against a strict alphabet (os_version,
 * arch, gpu_driver): anything else becomes a dot rather than a 400, because the
 * client drops every refused (4xx) profile silently. `parens` is os_version's.
 */
export function wireToken(s: unknown, max: number, parens = false): string {
    const v = typeof s === 'string'
        ? s.replace(parens ? /[^0-9A-Za-z._()-]+/g : /[^0-9A-Za-z._-]+/g, '.').replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '').slice(0, max)
        : '';
    return v || 'unknown';
}

/** Must stay inside the API's BETA_BUILD_COMMIT_RE / BETA_ELECTRON_RE / BETA_CHROME_RE (beta-wire-contract.spec.ts proves it). */
const BUILD_COMMIT = /^(?:[0-9a-f]{7,40}(?:-dirty)?|unknown)$/;
const ELECTRON_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,20})?$/;
const CHROME_VERSION = /^\d{1,4}(?:\.\d{1,6}){1,3}$/;
const orUnknown = (v: string, re: RegExp): string => (re.test(v) ? v : 'unknown');

/**
 * "Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz" → "Intel Core i7-8xxx";
 * "AMD Ryzen 7 5800X 8-Core Processor" → "AMD Ryzen 7 5xxx";
 * "Apple M2 Pro" stays. Model numbers keep their generation digit(s) only.
 */
export function cpuModelClass(model: unknown): string {
    if (typeof model !== 'string' || !model.trim()) return 'unknown';
    let s = model
        .replace(/\((?:R|TM|C)\)/gi, '')
        .replace(/@.*$/, '')
        .replace(/\b(?:CPU|Processor|with Radeon.*|w\/ Radeon.*)\b/gi, '')
        .replace(/\b\d+-Core\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    s = s.replace(/\b([A-Za-z]{0,2}-?)(\d{3,5})([A-Za-z]{0,3})\b/g, (_m, pre: string, digits: string) => {
        const keep = digits.length === 5 ? 2 : 1;
        return `${pre}${digits.slice(0, keep)}${'x'.repeat(digits.length - keep)}`;
    });
    return clean(s);
}

const RAM_BUCKETS: readonly RamBucket[] = [4, 8, 16, 32, 64, 128];
/** 15.9 → 16, 7.7 → 8, 24 → 32; ≤ 4 → 4; ≥ 128 → 128. */
export function ramBucket(gb: number): RamBucket {
    if (!(gb > 0)) return 4;
    for (const b of RAM_BUCKETS) if (gb <= b * 1.05) return b;
    return 128;
}

const VENDORS: Record<string, string> = {
    '0x10de': 'NVIDIA', '0x1002': 'AMD', '0x1022': 'AMD', '0x8086': 'Intel', '0x106b': 'Apple',
    '0x5143': 'Qualcomm', '0x13b5': 'ARM', '0x1414': 'Microsoft', '0x15ad': 'VMware', '0x80ee': 'VirtualBox',
};

export function gpuVendorName(vendorId: unknown, webglRenderer?: string): string {
    const v = typeof vendorId === 'string' ? VENDORS[vendorId.toLowerCase()] : undefined;
    if (v) return v;
    const r = webglRenderer ?? '';
    for (const name of ['NVIDIA', 'AMD', 'Intel', 'Apple', 'Qualcomm', 'Microsoft', 'VMware', 'llvmpipe', 'SwiftShader', 'Mesa']) {
        if (r.toLowerCase().includes(name.toLowerCase())) return name;
    }
    return 'unknown';
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 3070". */
export function normalizeGpuRenderer(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
    let s = raw.trim();
    const angle = /^ANGLE \((.*)\)$/.exec(s);
    if (angle) {
        const parts = angle[1].split(',').map(p => p.trim());
        s = parts.length >= 2 ? parts[1] : parts[0];
    }
    s = s.replace(/^ANGLE Metal Renderer:\s*/i, '')
        .replace(/\(0x[0-9a-f]+\)/gi, '')
        .replace(/\b(?:Direct3D\d+|D3D\d+|vs_\d_\d|ps_\d_\d|OpenGL.*|Vulkan.*)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Nothing readable left (e.g. a nested "Vulkan 1.3 (SwiftShader ...)" unwrapped to ") )").
    return /[A-Za-z0-9]/.test(s) ? clean(s) : 'unknown';
}

export function audioApiFor(platform: SystemInfo['platform']): AudioApi {
    // Chromium's own audio backend per OS. On Linux it is PulseAudio — or
    // PipeWire behind pipewire-pulse, or ALSA — and the renderer cannot tell
    // which, so it stays 'unknown' rather than guessed.
    if (platform === 'win32') return 'wasapi';
    if (platform === 'darwin') return 'coreaudio';
    return 'unknown';
}

export function networkTypeOf(conn: { type?: unknown } | undefined | null): NetworkType {
    const t = conn?.type;
    if (t === 'ethernet') return 'ethernet';
    if (t === 'wifi') return 'wifi';
    if (t === 'cellular') return 'cellular';
    return 'unknown';
}

export function localeLang(lang: unknown): string {
    const l = typeof lang === 'string' ? lang.slice(0, 2).toLowerCase() : '';
    return /^[a-z]{2}$/.test(l) ? l : 'xx';
}

export interface RendererProbe {
    webglRenderer?: string;
    audioInputs: number;
    audioOutputs: number;
    webcams: number;
    networkType: NetworkType;
    localeLang: string;
    devicePixelRatio: number;
}

/** Pure: system info + renderer probe → the wire profile. */
export function buildProfile(system: SystemInfo, probe: RendererProbe): ProfileCore {
    const active = system.gpu.devices.find(d => d.active) ?? system.gpu.devices[0];
    const comp = system.gpu.feature_status?.gpu_compositing;
    const swRenderer = /SwiftShader|llvmpipe|Software|Basic Render/i.test(probe.webglRenderer ?? '');
    const gpuAccel = system.hardware_acceleration !== false
        && (comp === undefined || /^enabled/.test(comp))
        && !swRenderer;
    const scales = system.displays.map(d => d.scale_factor).filter(n => Number.isFinite(n) && n > 0);
    return {
        build_commit: orUnknown(wireToken(system.build_commit, 47), BUILD_COMMIT),
        os_version: wireToken(system.os_version, 64, true),
        arch: wireToken(system.arch, 16),
        cpu_model_class: cpuModelClass(system.cpu_model),
        cpu_cores: Math.max(0, Math.min(1024, Math.round(system.cpu_cores || 0))),
        ram_gb_bucket: ramBucket(system.ram_gb),
        gpu_vendor: gpuVendorName(active?.vendor_id, probe.webglRenderer),
        gpu_renderer: normalizeGpuRenderer(probe.webglRenderer),
        gpu_driver: wireToken(active?.driver_version, 40),
        gpu_accel: gpuAccel,
        displays: Math.max(system.displays.length, 1),
        max_scale_factor: Math.round((scales.length ? Math.max(...scales) : probe.devicePixelRatio || 1) * 100) / 100,
        audio_inputs: probe.audioInputs,
        audio_outputs: probe.audioOutputs,
        audio_api: audioApiFor(system.platform),
        webcam_count: probe.webcams,
        network_type: probe.networkType,
        locale_lang: probe.localeLang,
        electron: orUnknown(wireToken(system.electron, 24), ELECTRON_VERSION),
        chrome: orUnknown(wireToken(system.chrome, 24), CHROME_VERSION),
    };
}

/** The unmasked WebGL renderer string, from a throwaway context. */
export function readWebglRenderer(): string | undefined {
    try {
        if (typeof document === 'undefined') return undefined;
        const canvas = document.createElement('canvas');
        const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        if (!gl) return undefined;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return typeof r === 'string' ? r : undefined;
    } catch {
        return undefined;
    }
}

/** Counts by kind only — device labels and ids are never read. */
export async function mediaDeviceCounts(): Promise<{ audioInputs: number; audioOutputs: number; webcams: number }> {
    try {
        const list = await navigator.mediaDevices?.enumerateDevices?.();
        const count = (k: string) => (list ?? []).filter(d => d.kind === k && d.deviceId !== 'default' && d.deviceId !== 'communications').length;
        return { audioInputs: count('audioinput'), audioOutputs: count('audiooutput'), webcams: count('videoinput') };
    } catch {
        return { audioInputs: 0, audioOutputs: 0, webcams: 0 };
    }
}
