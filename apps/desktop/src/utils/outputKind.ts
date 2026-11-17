/**
 * Is the audio OUTPUT speakers or headphones? - and what that means for echo
 * cancellation.
 *
 * Why: with speakers the mic hears the other people and sends them back ("echo
 * but also not": a late, AGC-boosted copy of their own voice); with headphones
 * there is no echo path, and Chromium's AEC only costs CPU and colours the voice.
 * So a user who never chose gets echo cancellation ON for speakers and OFF for
 * headphones, re-evaluated when the output changes.
 *
 * Inputs, strongest first:
 *   1. What the OS says about the endpoint (Windows form factor / jack, macOS
 *      data source + transport, Linux port + form factor) - `OutputEndpointFacts`,
 *      gathered by electron/audio-output-facts.ts.
 *   2. The device LABEL (Chromium's `audiooutput` label).
 *   3. Nothing known -> 'unknown', which is treated as SPEAKERS: echo is the worse
 *      failure (everyone else hears themselves), a bit of CPU is the cheap one.
 *
 * Pure: no DOM, no IPC. The probe that feeds it lives in outputKindProbe.ts.
 */

export type OutputKind = 'speakers' | 'headphones' | 'unknown';

/** Mirrors electron/audio-output-facts.ts OutputEndpointFacts (electron/ cannot be imported from src/). */
export interface OutputEndpointFacts {
    name: string;
    isDefault?: boolean;
    isCommunications?: boolean;
    formFactor?: string;
    jackSubType?: string;
    transport?: string;
    dataSource?: string;
    port?: string;
}

// ── Label heuristics ─────────────────────────────────────────────────────────

/** Chromium prefixes its two synthetic rows; the real name follows. */
export function stripDeviceLabelPrefix(label: string): string {
    return label.replace(/^\s*(default|communications)\s*-\s*/i, '').trim();
}

const HEADPHONE_RE = /head\s?phones?|headset|ear\s?buds?|earphones?|ear\s?pieces?|airpods?|\bbuds\b|galaxy buds|hands[- ]?free|handset|\bhfp\b|arctis|hyperx cloud|\bbeats\b/i;
// Product names that are only ever worn. Windows gives a USB headset the generic endpoint name "Speakers (<product>)",
// so one of these beats the word "speakers" - unlike the generic words above, which on their own name (an ambiguous
// "Headphones/Speakers (Realtek)" codec) cancel against it.
const WORN_PRODUCT_RE = /airpods?|\bbuds\b|ear\s?buds?|arctis|hyperx cloud|\bbeats\b/i;
// Words that mean "this is the thing that sits on a desk / in a monitor".
const SPEAKER_RE = /speakers?|display audio|\bhdmi\b|displayport|\bdp audio\b|\bmonitor\b|soundbar|sound bar|\btv\b|\bhomepod\b|\becho dot\b|\bboombox\b|\bnvidia high definition\b|\bamd high definition\b/i;

/**
 * Classify by name alone. A label naming BOTH ("Headphones/Speakers (Realtek)",
 * a jack-sensing codec's combined name) is ambiguous -> 'unknown'. A bare
 * "Speakers (USB Audio)" is 'speakers' - the generic name Windows gives a USB
 * headset too, which is why the native form factor outranks this.
 */
export function classifyOutputLabel(label: string | null | undefined): OutputKind {
    const name = stripDeviceLabelPrefix(label ?? '');
    if (!name) return 'unknown';
    const head = HEADPHONE_RE.test(name);
    const spk = SPEAKER_RE.test(name);
    if (WORN_PRODUCT_RE.test(name)) return 'headphones';
    if (head && spk) return 'unknown';
    if (head) return 'headphones';
    if (spk) return 'speakers';
    return 'unknown';
}

// ── OS facts ─────────────────────────────────────────────────────────────────

// KSNODETYPE_* jack sub-types (ksmedia.h). The Windows form factor is read first;
// this decides only when that says nothing useful (line level / unknown).
const JACK_HEADPHONES = new Set([
    'dff21ce2-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_HEADPHONES
    'dff21ce3-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_HEAD_MOUNTED_DISPLAY_AUDIO
]);
const JACK_SPEAKERS = new Set([
    'dff21ce1-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_SPEAKER
    'dff21ce4-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_DESKTOP_SPEAKER
    'dff21ce5-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_ROOM_SPEAKER
    'dff21ce6-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_COMMUNICATION_SPEAKER
    'dff21ce7-f70f-11d0-b917-00a0c9223196', // KSNODETYPE_LOW_FREQUENCY_EFFECTS_SPEAKER
]);

/** What the OS facts say, or 'unknown' when they do not decide. */
export function classifyEndpointFacts(f: OutputEndpointFacts): OutputKind {
    // macOS: the data source is how CoreAudio itself tells the jack from the internal speaker.
    if (f.dataSource === 'headphones') return 'headphones';
    if (f.dataSource === 'speaker') return 'speakers';

    // Linux: the active port, then the device's declared form factor.
    if (f.port) {
        const p = f.port.toLowerCase();
        const hp = /headphone|headset|hands-?free|handsfree|earpiece|handset/.test(p);
        const spk = /speaker|lineout|line-out|hdmi|displayport|iec958|spdif/.test(p);
        if (hp && !spk) return 'headphones';
        if (spk && !hp) return 'speakers';
    }

    const ff = (f.formFactor ?? '').toLowerCase();
    switch (ff) {
        // Windows EndpointFormFactor + PulseAudio device.form_factor values
        case 'headphones': case 'headphone': case 'headset': case 'handset': case 'hands-free': return 'headphones';
        case 'speakers': case 'speaker': case 'display': case 'tv': case 'hifi': case 'computer': case 'car': return 'speakers';
        default: break;
    }

    // Windows: a line-level / unknown endpoint may still name its jack.
    if (f.jackSubType) {
        if (JACK_HEADPHONES.has(f.jackSubType)) return 'headphones';
        if (JACK_SPEAKERS.has(f.jackSubType)) return 'speakers';
    }

    // macOS: a built-in output with no data source is the speaker; display / AirPlay outputs are speakers.
    if (f.transport === 'builtin' || f.transport === 'hdmi' || f.transport === 'displayport' || f.transport === 'airplay') return 'speakers';
    return 'unknown';
}

const norm = (s: string) => stripDeviceLabelPrefix(s).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Find the OS's record for the device Chromium calls `deviceId` / `label`.
 *
 * Chromium's labels are the OS names (Windows: the endpoint FriendlyName, e.g.
 * "Speakers (Realtek(R) Audio)"; macOS: the CoreAudio device name; Linux: the
 * PulseAudio sink description), so an exact, then a unique-substring, name match
 * works. The two synthetic rows are resolved by role instead of by name:
 * 'default' / '' -> the system default render device, 'communications' -> the
 * default communications device. No match -> null (the label is used on its own).
 */
export function matchEndpointFacts(
    deviceId: string,
    label: string | null | undefined,
    facts: readonly OutputEndpointFacts[],
): OutputEndpointFacts | null {
    if (!facts.length) return null;
    if (!deviceId || deviceId === 'default') return facts.find(f => f.isDefault) ?? null;
    if (deviceId === 'communications') return facts.find(f => f.isCommunications) ?? facts.find(f => f.isDefault) ?? null;
    const want = norm(label ?? '');
    if (!want) return null;
    const exact = facts.filter(f => norm(f.name) === want);
    if (exact.length >= 1) return exact[0];
    const near = facts.filter(f => { const n = norm(f.name); return n.includes(want) || want.includes(n); });
    return near.length === 1 ? near[0] : null;
}

export interface OutputKindInput {
    /** The stored speaker pick ('' = follow the system default). */
    speakerDeviceId: string;
    /** enumerateDevices() output rows (kind 'audiooutput'). */
    outputs: readonly Pick<MediaDeviceInfo, 'deviceId' | 'label'>[];
    /** OS facts, if available. */
    facts: readonly OutputEndpointFacts[];
}

export interface OutputKindResult {
    kind: OutputKind;
    /** Where the answer came from, for diagnostics: an enum, never a name. */
    source: 'os' | 'label' | 'none';
}

export function resolveOutputKind(input: OutputKindInput): OutputKindResult {
    const id = input.speakerDeviceId || 'default';
    const row = input.outputs.find(o => o.deviceId === id)
        ?? (id === 'default' ? input.outputs.find(o => o.deviceId === 'communications') : undefined);
    const label = row?.label ?? '';
    const matched = matchEndpointFacts(input.speakerDeviceId, label, input.facts);
    if (matched) {
        const k = classifyEndpointFacts(matched);
        if (k !== 'unknown') return { kind: k, source: 'os' };
        // The OS record exists but says nothing decisive: its own name may (macOS "External Headphones").
        const byName = classifyOutputLabel(matched.name);
        if (byName !== 'unknown') return { kind: byName, source: 'label' };
    }
    const byLabel = classifyOutputLabel(label);
    if (byLabel !== 'unknown') return { kind: byLabel, source: 'label' };
    return { kind: 'unknown', source: 'none' };
}

// ── The auto default ─────────────────────────────────────────────────────────

/**
 * Echo cancellation when the user has NOT chosen: on for speakers and for
 * anything we cannot tell (echo is the worse failure), off for headphones.
 */
export function autoEchoCancellation(kind: OutputKind): boolean {
    return kind !== 'headphones';
}

export interface EchoSettingInputs {
    /** True while the user has never picked On/Off (see useVoiceSettings: echoCancellationAuto). */
    auto: boolean;
    /** The stored boolean: the user's explicit choice when `auto` is false. */
    stored: boolean;
    kind: OutputKind;
}

/** The value every mic open uses. An explicit choice always wins. */
export function effectiveEchoCancellation(i: EchoSettingInputs): boolean {
    return i.auto ? autoEchoCancellation(i.kind) : i.stored;
}

/** The sentence Settings shows next to the Auto choice. */
export function describeAutoEcho(kind: OutputKind): string {
    switch (kind) {
        case 'headphones': return 'Auto (off — headphones detected)';
        case 'speakers': return 'Auto (on — speakers detected)';
        default: return 'Auto (on — output type unknown)';
    }
}

/**
 * Migration by absence. Only a blob that carries `echoCancellationAuto` records
 * a choice made in the On / Auto / Off setting; that is honoured as-is.
 *
 * Everything older moves to Auto (owner, 2026-11-16: "make sure echo
 * cancellation is on auto by default", confirmed for EXISTING users too). A
 * pre-Auto blob's `echoCancellation` boolean was usually the old default carried
 * along, and there was no Auto to pick then, so it is not treated as a choice of
 * On or Off any more. (This replaces the earlier "any stored value is user-set"
 * rule.) Nothing saved also means Auto. Garbage leaves the boolean alone.
 */
export function resolveEchoAutoFlag(saved: unknown): boolean {
    if (saved === null || saved === undefined) return true;                         // nothing stored: never chosen
    if (typeof saved !== 'object') return false;                                    // garbage: leave the boolean alone
    const o = saved as { echoCancellationAuto?: unknown };
    if (typeof o.echoCancellationAuto === 'boolean') return o.echoCancellationAuto; // chosen in the 3-way setting
    return true;                                                                    // pre-Auto blob: Auto
}
