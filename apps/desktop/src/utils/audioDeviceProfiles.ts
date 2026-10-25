/**
 * Audio settings remembered PER DEVICE: each microphone keeps its own input
 * volume, noise suppression, voice gate, echo cancellation, auto gain and mic
 * EQ; each speaker / headset keeps its own output volume and "Normalize voice
 * volume". When the device in use changes (a headset plugged in, the Windows
 * default moved, a pick in Settings or the call's right-click menu) that
 * device's settings come back on their own.
 *
 * Pure. The hook that wires it to the live settings, the device list and
 * storage is hooks/useAudioDeviceProfiles.ts.
 *
 * WHAT IS PER DEVICE, WHAT IS NOT
 *   Per input device: things that compensate for the microphone and the room
 *   it is in. A quiet USB mic needs more input volume than a headset boom; a
 *   laptop's built-in mic beside the fan wants Strong noise suppression and a
 *   higher gate, a broadcast mic wants Light or none; echo cancellation is for
 *   speakers, so it belongs to the setup that has them; an EQ shapes one
 *   capsule's frequency response.
 *   Per output device: how loud it plays (headphones vs speakers differ by tens
 *   of dB), and the incoming leveler that goes with it.
 *   Global: push to talk and its key (how you talk, not what you talk into),
 *   the device picks themselves, everything camera and video.
 *
 * DEVICE IDENTITY (survives unplug / replug / restart / Windows re-enumeration)
 *   A profile is keyed by the device's NORMALISED LABEL, separately for input
 *   and output. Chromium's deviceId is stable per origin for one endpoint, but
 *   Windows re-creates endpoints (another USB port, a driver update, a
 *   Bluetooth re-pair) and the id changes while the label does not, apart from
 *   the "(2- " instance number Windows inserts. So:
 *     1. same normalised label → that profile;
 *     2. else the profile last seen under this exact deviceId (the device was
 *        renamed in Windows' Sound settings) → that profile, re-keyed;
 *     3. else the one profile with the same label minus the USB vendor:product
 *        suffix Chromium appends (groupId breaks a tie) → re-keyed.
 *   Two identical headsets share a label and therefore a profile, which is the
 *   setting one would want for two units of the same model anyway.
 *   Chromium's synthetic "default" / "communications" rows are never a device:
 *   "follow the system default" resolves to the real device the OS prefers
 *   (resolveDefaultDevice) so headphones that become the Windows default get
 *   THEIR settings.
 *
 * PRIVACY: labels can carry a person's name ("Dawson's AirPods"). They live
 * only in this encrypted, per-account record (and the user's own encrypted
 * backup), are never logged, and never go into a diagnostic report
 * (diagnostics/settingsSnapshot.ts takes scalars only).
 */
import type { VoiceSettings } from '../hooks/useVoiceSettings';
import { clampVolumePercent } from './volumeLimits';
import { isNoiseSuppressionMode } from './nsLatency';
import { findStoredDevice, type DeviceHint } from './deviceResolve';

export type AudioDeviceKind = 'input' | 'output';

/** The fields remembered per microphone. */
export const INPUT_PROFILE_FIELDS = [
    'micVolume', 'noiseSuppression', 'noiseSuppressionMode', 'voiceGate', 'voiceGateThreshold',
    'echoCancellation', 'volumeNormalization', 'eqEnabled', 'eqBands',
] as const satisfies readonly (keyof VoiceSettings)[];

/** The fields remembered per speaker / headset. */
export const OUTPUT_PROFILE_FIELDS = [
    'speakerVolume', 'normalizeIncomingVolume',
] as const satisfies readonly (keyof VoiceSettings)[];

export type InputProfileSettings = Pick<VoiceSettings, typeof INPUT_PROFILE_FIELDS[number]>;
export type OutputProfileSettings = Pick<VoiceSettings, typeof OUTPUT_PROFILE_FIELDS[number]>;
export type ProfileSettings<K extends AudioDeviceKind> = K extends 'input' ? InputProfileSettings : OutputProfileSettings;

export interface DeviceProfile<S> {
    /** Display label as last seen (pseudo-device prefixes stripped). */
    label: string;
    /** Last seen deviceId / groupId — hints for re-finding a renamed device. */
    deviceId: string;
    groupId: string;
    /** ms epoch the device was last the one in use. */
    lastUsedAt: number;
    settings: S;
}

export interface DeviceProfiles {
    v: 1;
    input: Record<string, DeviceProfile<InputProfileSettings>>;
    output: Record<string, DeviceProfile<OutputProfileSettings>>;
}

/** The device in use for one direction, as resolved from enumerateDevices(). */
export interface DeviceIdentity {
    deviceId: string;
    groupId: string;
    /** Real device label (never "Default - …"). */
    label: string;
    /** True when it is in use because it is the system default (no pick, or the pick is unplugged). */
    viaDefault: boolean;
}

export const fieldsOf = (kind: AudioDeviceKind): readonly (keyof VoiceSettings)[] =>
    kind === 'input' ? INPUT_PROFILE_FIELDS : OUTPUT_PROFILE_FIELDS;

/** Per-account storage key (secureLocalStore; per-account HKDF subkey). */
export const AUDIO_DEVICE_PROFILES_KEY_PREFIX = 'cipherline_audio_device_profiles_';
export const audioDeviceProfilesKey = (userId: string) => `${AUDIO_DEVICE_PROFILES_KEY_PREFIX}${userId}`;

/** How many devices per direction are remembered; the least recently used go first. */
export const MAX_PROFILES_PER_KIND = 40;

const SYNTHETIC_IDS = new Set(['default', 'communications']);
const PSEUDO_PREFIX = /^\s*(default|communications)\s+-\s+/i;
const USB_ID_SUFFIX = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i;

/** "Default - Microphone (Shure MV7)" → "Microphone (Shure MV7)". */
export function stripPseudoPrefix(label: string): string {
    return label.replace(PSEUDO_PREFIX, '').trim();
}

/**
 * The identity a label is remembered by: pseudo-device prefix dropped, the
 * "(2- " instance number Windows inserts on re-enumeration dropped, case and
 * whitespace folded. "Microphone (2- Shure MV7)" and "Microphone (Shure MV7)"
 * are the same device.
 */
export function normalizeDeviceLabel(label: string): string {
    return stripPseudoPrefix(label)
        .replace(/\(\s*\d+\s*-\s*/g, '(')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** normalizeDeviceLabel without Chromium's trailing USB "(vvvv:pppp)". */
function looseKey(label: string): string {
    return normalizeDeviceLabel(label).replace(USB_ID_SUFFIX, '').trim();
}

export function emptyDeviceProfiles(): DeviceProfiles {
    return { v: 1, input: {}, output: {} };
}

// ── Sanitising (stored data is untrusted: hand edits, older builds) ─────────

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, lo: number, hi: number, d: number) =>
    (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function cleanInput(raw: unknown, fallback: InputProfileSettings): InputProfileSettings {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const bands = Array.isArray(r.eqBands) && r.eqBands.length === 5 && r.eqBands.every(b => typeof b === 'number' && Number.isFinite(b))
        ? (r.eqBands as number[]).map(b => num(b, -12, 12, 0))
        : [...fallback.eqBands];
    return {
        micVolume: clampVolumePercent(r.micVolume, fallback.micVolume),
        noiseSuppression: bool(r.noiseSuppression, fallback.noiseSuppression),
        noiseSuppressionMode: isNoiseSuppressionMode(r.noiseSuppressionMode) ? r.noiseSuppressionMode : fallback.noiseSuppressionMode,
        voiceGate: bool(r.voiceGate, fallback.voiceGate),
        voiceGateThreshold: num(r.voiceGateThreshold, -60, -20, fallback.voiceGateThreshold),
        echoCancellation: bool(r.echoCancellation, fallback.echoCancellation),
        volumeNormalization: bool(r.volumeNormalization, fallback.volumeNormalization),
        eqEnabled: bool(r.eqEnabled, fallback.eqEnabled),
        eqBands: bands,
    };
}

function cleanOutput(raw: unknown, fallback: OutputProfileSettings): OutputProfileSettings {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        speakerVolume: clampVolumePercent(r.speakerVolume, fallback.speakerVolume),
        normalizeIncomingVolume: bool(r.normalizeIncomingVolume, fallback.normalizeIncomingVolume),
    };
}

/** The per-device subset of the live settings, copied (eqBands too). */
export function pickProfileSettings(kind: 'input', s: VoiceSettings): InputProfileSettings;
export function pickProfileSettings(kind: 'output', s: VoiceSettings): OutputProfileSettings;
export function pickProfileSettings(kind: AudioDeviceKind, s: VoiceSettings): InputProfileSettings | OutputProfileSettings;
export function pickProfileSettings(kind: AudioDeviceKind, s: VoiceSettings): InputProfileSettings | OutputProfileSettings {
    if (kind === 'input') {
        return {
            micVolume: s.micVolume, noiseSuppression: s.noiseSuppression, noiseSuppressionMode: s.noiseSuppressionMode,
            voiceGate: s.voiceGate, voiceGateThreshold: s.voiceGateThreshold, echoCancellation: s.echoCancellation,
            volumeNormalization: s.volumeNormalization, eqEnabled: s.eqEnabled, eqBands: [...s.eqBands],
        };
    }
    return { speakerVolume: s.speakerVolume, normalizeIncomingVolume: s.normalizeIncomingVolume !== false };
}

/**
 * Parse the stored record. null = nothing usable stored (first run, or garbage)
 * — the caller then seeds it (seedDeviceProfiles). Individual bad profiles are
 * dropped or repaired, never allowed to poison the rest.
 */
export function parseDeviceProfiles(raw: string | null | undefined, defaults: VoiceSettings): DeviceProfiles | null {
    if (!raw) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return null;
    const p = parsed as { input?: unknown; output?: unknown };
    const out = emptyDeviceProfiles();
    const inDefaults = pickProfileSettings('input', defaults);
    const outDefaults = pickProfileSettings('output', defaults);
    for (const kind of ['input', 'output'] as const) {
        const src = p[kind];
        if (!src || typeof src !== 'object') continue;
        for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
            if (!key || !value || typeof value !== 'object') continue;
            const v = value as Record<string, unknown>;
            if (typeof v.label !== 'string' || !v.label) continue;
            const base = {
                label: v.label,
                deviceId: typeof v.deviceId === 'string' ? v.deviceId : '',
                groupId: typeof v.groupId === 'string' ? v.groupId : '',
                lastUsedAt: typeof v.lastUsedAt === 'number' && Number.isFinite(v.lastUsedAt) ? v.lastUsedAt : 0,
            };
            const k = normalizeDeviceLabel(v.label) || key;
            if (kind === 'input') out.input[k] = { ...base, settings: cleanInput(v.settings, inDefaults) };
            else out.output[k] = { ...base, settings: cleanOutput(v.settings, outDefaults) };
        }
    }
    return out;
}

/**
 * MIGRATION (first run with this feature). Nothing is lost: the settings
 * everyone already has become the starting profile of the devices in use as
 * soon as they are seen (rememberActiveDevice, "first seen inherits"). On top
 * of that, a microphone / speaker that was explicitly PICKED (its label was
 * recorded with the pick) is remembered right away with today's settings,
 * even if it happens to be unplugged at the moment of the upgrade.
 */
export function seedDeviceProfiles(s: VoiceSettings, now: number): DeviceProfiles {
    const out = emptyDeviceProfiles();
    if (s.micDeviceId && s.micDeviceLabel) {
        const k = normalizeDeviceLabel(s.micDeviceLabel);
        if (k) out.input[k] = { label: stripPseudoPrefix(s.micDeviceLabel), deviceId: s.micDeviceId, groupId: s.micDeviceGroupId ?? '', lastUsedAt: now, settings: pickProfileSettings('input', s) };
    }
    if (s.speakerDeviceId && s.speakerDeviceLabel) {
        const k = normalizeDeviceLabel(s.speakerDeviceLabel);
        if (k) out.output[k] = { label: stripPseudoPrefix(s.speakerDeviceLabel), deviceId: s.speakerDeviceId, groupId: s.speakerDeviceGroupId ?? '', lastUsedAt: now, settings: pickProfileSettings('output', s) };
    }
    return out;
}

// ── Which device is in use ──────────────────────────────────────────────────

const realDevices = (list: readonly MediaDeviceInfo[]) =>
    list.filter(d => d.deviceId !== '' && !SYNTHETIC_IDS.has(d.deviceId) && d.label !== '');

const identityOf = (d: Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'label'>, viaDefault: boolean): DeviceIdentity =>
    ({ deviceId: d.deviceId, groupId: d.groupId ?? '', label: stripPseudoPrefix(d.label), viaDefault });

/**
 * The real device behind Chromium's "default" row: same groupId and the label
 * without "Default - "; else that label alone if unique; else the groupId alone
 * if unique. Where the row carries no usable label (Linux/PulseAudio says just
 * "Default") it is remembered as itself. No default row at all → the first
 * device, which is what Chromium opens for an unconstrained capture.
 */
export function resolveDefaultDevice(list: readonly MediaDeviceInfo[]): DeviceIdentity | null {
    const real = realDevices(list);
    const def = list.find(d => d.deviceId === 'default');
    if (def && (def.label || def.groupId)) {
        const bare = stripPseudoPrefix(def.label ?? '');
        const byGroupLabel = real.filter(d => d.groupId === def.groupId && d.label === bare);
        if (byGroupLabel.length === 1) return identityOf(byGroupLabel[0], true);
        const byLabel = bare ? real.filter(d => normalizeDeviceLabel(d.label) === normalizeDeviceLabel(bare)) : [];
        if (byLabel.length === 1) return identityOf(byLabel[0], true);
        const byGroup = def.groupId ? real.filter(d => d.groupId === def.groupId) : [];
        if (byGroup.length === 1) return identityOf(byGroup[0], true);
        if (def.label) return { deviceId: 'default', groupId: def.groupId ?? '', label: bare || def.label, viaDefault: true };
    }
    return real[0] ? identityOf(real[0], true) : null;
}

/**
 * The device actually in use for one direction: the stored pick when it is
 * plugged in (followed to a new id the same way the call does — deviceResolve),
 * otherwise the system default resolved to its real device. null before media
 * permission (placeholder list with no labels) — nothing can be recognised yet.
 */
export function resolveActiveDevice(
    raw: readonly MediaDeviceInfo[],
    kind: AudioDeviceKind,
    storedId: string | null | undefined,
    hint?: DeviceHint | null,
): DeviceIdentity | null {
    const list = raw.filter(d => d.kind === (kind === 'input' ? 'audioinput' : 'audiooutput'));
    if (!list.some(d => d.deviceId !== '' && d.label !== '')) return null;
    if (storedId && !SYNTHETIC_IDS.has(storedId)) {
        const { device } = findStoredDevice(storedId, hint, list);
        if (device && !SYNTHETIC_IDS.has(device.deviceId) && device.label) return identityOf(device, false);
    }
    return resolveDefaultDevice(list);
}

// ── Matching a device to its profile ────────────────────────────────────────

export type ProfileMatch = 'label' | 'device_id' | 'loose_label';

/** The stored profile a device is, or null when it has never been seen. */
export function findDeviceProfile(
    profiles: DeviceProfiles,
    kind: AudioDeviceKind,
    device: Pick<DeviceIdentity, 'deviceId' | 'groupId' | 'label'>,
): { key: string; match: ProfileMatch } | null {
    const map = profiles[kind] as Record<string, DeviceProfile<unknown>>;
    const key = normalizeDeviceLabel(device.label);
    if (key && map[key]) return { key, match: 'label' };
    if (device.deviceId && !SYNTHETIC_IDS.has(device.deviceId)) {
        const byId = Object.keys(map).filter(k => map[k].deviceId === device.deviceId);
        if (byId.length === 1) return { key: byId[0], match: 'device_id' };
    }
    const lk = looseKey(device.label);
    if (lk) {
        let same = Object.keys(map).filter(k => looseKey(map[k].label) === lk);
        if (same.length > 1 && device.groupId) same = same.filter(k => map[k].groupId === device.groupId);
        if (same.length === 1) return { key: same[0], match: 'loose_label' };
    }
    return null;
}

function trim<S>(map: Record<string, DeviceProfile<S>>, keep: string): Record<string, DeviceProfile<S>> {
    const keys = Object.keys(map);
    if (keys.length <= MAX_PROFILES_PER_KIND) return map;
    const drop = keys.filter(k => k !== keep).sort((a, b) => map[a].lastUsedAt - map[b].lastUsedAt).slice(0, keys.length - MAX_PROFILES_PER_KIND);
    const out = { ...map };
    for (const k of drop) delete out[k];
    return out;
}

export interface RememberResult {
    profiles: DeviceProfiles;
    key: string;
    /** First time this device was seen: its profile was just made from `current`. */
    created: boolean;
    /** `profiles` differs from the input (caller persists). */
    changed: boolean;
}

/**
 * Remember the device in use. Known device → its profile (re-keyed if it was
 * found by id or loose label, hints refreshed). Never seen → a new profile that
 * INHERITS the current settings, so plugging something in changes nothing
 * until you change something. `touch` stamps lastUsedAt.
 */
export function rememberActiveDevice(
    profiles: DeviceProfiles,
    kind: AudioDeviceKind,
    device: DeviceIdentity,
    current: VoiceSettings,
    now: number,
    touch: boolean,
): RememberResult {
    const key = normalizeDeviceLabel(device.label);
    const map = { ...(profiles[kind] as Record<string, DeviceProfile<InputProfileSettings | OutputProfileSettings>>) };
    const found = findDeviceProfile(profiles, kind, device);
    if (!found) {
        map[key] = {
            label: device.label, deviceId: device.deviceId, groupId: device.groupId,
            lastUsedAt: now, settings: pickProfileSettings(kind, current),
        };
        return { profiles: { ...profiles, [kind]: trim(map, key) }, key, created: true, changed: true };
    }
    const prev = map[found.key];
    const next = {
        ...prev,
        label: device.label,
        deviceId: device.deviceId !== 'default' ? device.deviceId : prev.deviceId,
        groupId: device.groupId || prev.groupId,
        lastUsedAt: touch ? now : prev.lastUsedAt,
    };
    const rekey = found.key !== key;
    const changed = rekey || next.label !== prev.label || next.deviceId !== prev.deviceId
        || next.groupId !== prev.groupId || next.lastUsedAt !== prev.lastUsedAt;
    if (!changed) return { profiles, key, created: false, changed: false };
    if (rekey) delete map[found.key];
    map[key] = next;
    return { profiles: { ...profiles, [kind]: map }, key, created: false, changed: true };
}

/**
 * Save a settings change into one device's profile. Only that direction's
 * fields are taken from `partial`; anything else is ignored. Returns the same
 * object when nothing changed.
 */
export function recordProfileChange(
    profiles: DeviceProfiles,
    kind: AudioDeviceKind,
    key: string,
    partial: Partial<VoiceSettings>,
    now: number,
): DeviceProfiles {
    const map = profiles[kind] as Record<string, DeviceProfile<Record<string, unknown>>>;
    const prev = map[key];
    if (!prev) return profiles;
    const settings: Record<string, unknown> = { ...prev.settings };
    let any = false;
    for (const f of fieldsOf(kind)) {
        if (!(f in partial)) continue;
        const v = partial[f];
        if (v === undefined) continue;
        const nv = Array.isArray(v) ? [...v] : v;
        if (JSON.stringify(settings[f]) !== JSON.stringify(nv)) { settings[f] = nv; any = true; }
    }
    if (!any) return profiles;
    const cleaned = kind === 'input'
        ? cleanInput(settings, prev.settings as unknown as InputProfileSettings)
        : cleanOutput(settings, prev.settings as unknown as OutputProfileSettings);
    return { ...profiles, [kind]: { ...map, [key]: { ...prev, lastUsedAt: Math.max(prev.lastUsedAt, now), settings: cleaned } } };
}

export function forgetDeviceProfile(profiles: DeviceProfiles, kind: AudioDeviceKind, key: string): DeviceProfiles {
    if (!(key in profiles[kind])) return profiles;
    const map = { ...profiles[kind] } as Record<string, unknown>;
    delete map[key];
    return { ...profiles, [kind]: map } as DeviceProfiles;
}

/** The fields of a stored profile that differ from the live settings (what to apply). */
export function profileDiff(kind: AudioDeviceKind, live: VoiceSettings, profile: InputProfileSettings | OutputProfileSettings): Partial<VoiceSettings> {
    const out: Record<string, unknown> = {};
    const cur = pickProfileSettings(kind, live) as unknown as Record<string, unknown>;
    for (const f of fieldsOf(kind)) {
        const v = (profile as unknown as Record<string, unknown>)[f];
        if (v === undefined) continue;
        if (JSON.stringify(cur[f]) !== JSON.stringify(v)) out[f] = Array.isArray(v) ? [...v] : v;
    }
    return out as Partial<VoiceSettings>;
}

/** Profile keys of the devices plugged in right now, per direction. */
export function connectedProfileKeys(profiles: DeviceProfiles, raw: readonly MediaDeviceInfo[]): { input: Set<string>; output: Set<string> } {
    const out = { input: new Set<string>(), output: new Set<string>() };
    for (const kind of ['input', 'output'] as const) {
        const list = realDevices(raw.filter(d => d.kind === (kind === 'input' ? 'audioinput' : 'audiooutput')));
        for (const d of list) {
            const f = findDeviceProfile(profiles, kind, d);
            if (f) out[kind].add(f.key);
        }
    }
    return out;
}

/** "Used just now" / "Used 12 min ago" / "Used 3 h ago" / "Used yesterday" / "Used 4 days ago" / "Used Sep 12". */
export function lastUsedText(at: number, now: number): string {
    if (!at) return 'Not used yet';
    const s = Math.max(0, now - at) / 1000;
    if (s < 90) return 'Used just now';
    if (s < 3600) return `Used ${Math.round(s / 60)} min ago`;
    if (s < 86400) return `Used ${Math.round(s / 3600)} h ago`;
    const days = Math.floor(s / 86400);
    if (days === 1) return 'Used yesterday';
    if (days < 14) return `Used ${days} days ago`;
    return `Used ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** Split a settings partial into the direction(s) whose profile it touches. */
export function kindsTouched(partial: Partial<VoiceSettings>): AudioDeviceKind[] {
    const out: AudioDeviceKind[] = [];
    if (INPUT_PROFILE_FIELDS.some(f => f in partial)) out.push('input');
    if (OUTPUT_PROFILE_FIELDS.some(f => f in partial)) out.push('output');
    return out;
}
