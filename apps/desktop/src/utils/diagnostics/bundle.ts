/**
 * Diagnostic report builder — ONE entry point (buildDiagnosticReport) that
 * turns already-gathered inputs into the exact schema-1 body the user will
 * preview, save or send (reportTypes.ts).
 *
 * Pure: no IPC, no DOM, no clock — `collect.ts` gathers the live inputs and
 * passes `now`. That is what lets bundle.test.ts plant identities in every
 * input and grep the result.
 *
 * Order of operations (it matters):
 *   1. Assemble the RAW payload for the category (the matrix below), capping
 *      row / sample / error counts, newest kept.
 *   2. Drop sensitive terms that collide with the report's own structured
 *      values (sensitiveTerms.ts filterTermsAgainstStructured — a friend
 *      called "video" must not turn `kind: 'video'` into `<name>`).
 *   3. scrubDeep(raw, scrubber, …, DIAGNOSTIC_VERBATIM_KEYS) — every string
 *      in the payload goes through the scrubber; verbatim keys must match
 *      their strict patterns. The description goes through scrubber.text().
 *   4. Fit DIAGNOSTIC_LIMITS.maxPayloadBytes by dropping the OLDEST perf rows,
 *      then call events (down to 60), then WebRTC samples, then error stacks / errors — only ever removing
 *      already-scrubbed items, never adding anything.
 */
import { createScrubber, scrubDeep, DEFAULT_DEEP_LIMITS } from './scrub';
import { filterTermsAgainstStructured } from './sensitiveTerms';
import {
    DIAGNOSTIC_LIMITS, DIAGNOSTIC_VERBATIM_KEYS,
    type CallEvent, type CrashInfo, type DiagnosticCategory, type DiagnosticPayload, type DiagnosticReportBody,
    type DiagnosticTrigger, type EntitlementInfo, type PerfRow, type RecentError, type SystemInfo,
    type WebrtcSummary,
} from './reportTypes';
import type { CallEventInput } from './callEventsSource';
import type { ScreenShareOptions } from '../../components/ScreenSharePickerModal';

// ── Category matrix ──────────────────────────────────────────────────────────

export type SettingsGroup = 'general' | 'screen_share' | 'call' | 'camera' | 'notifications';
export type SettingsValue = string | number | boolean | null;
export type SettingsSnapshot = Partial<Record<SettingsGroup, Record<string, SettingsValue>>>;

export interface CategorySpec {
    settings: SettingsGroup[];
    entitlement: boolean;
    webrtc: boolean;
    crash: boolean;
    recentErrors: boolean;
    /** The call engine's decision log (`call_events`). */
    callEvents: boolean;
    /** Newest perf-log rows included. */
    perfRows: number;
}

export const CATEGORY_SPEC: Record<DiagnosticCategory, CategorySpec> = {
    crash:         { settings: ['general'],                          entitlement: false, webrtc: false, crash: true,  recentErrors: true,  callEvents: false, perfRows: 150 },
    screen_share:  { settings: ['general', 'screen_share', 'call'],  entitlement: true,  webrtc: true,  crash: false, recentErrors: false, callEvents: true, perfRows: 60 },
    call_audio:    { settings: ['general', 'call'],                  entitlement: true,  webrtc: true,  crash: false, recentErrors: false, callEvents: true, perfRows: 60 },
    video_camera:  { settings: ['general', 'camera', 'call'],        entitlement: true,  webrtc: true,  crash: false, recentErrors: false, callEvents: true, perfRows: 60 },
    performance:   { settings: ['general', 'screen_share'],          entitlement: false, webrtc: false, crash: false, recentErrors: true,  callEvents: true, perfRows: DIAGNOSTIC_LIMITS.maxPerfRows },
    notifications: { settings: ['general', 'notifications'],         entitlement: false, webrtc: false, crash: false, recentErrors: false, callEvents: false, perfRows: 60 },
    other:         { settings: ['general'],                          entitlement: false, webrtc: false, crash: false, recentErrors: false, callEvents: false, perfRows: 60 },
};

/** Plain-language "What's collected" lines for the Details step. */
export function describeCollection(category: DiagnosticCategory): string[] {
    const spec = CATEGORY_SPEC[category];
    const lines = ['App version, OS, CPU, memory, GPU model ids and driver, display sizes and refresh rates'];
    const groups = spec.settings.filter(g => g !== 'general');
    const label: Record<SettingsGroup, string> = {
        general: '', screen_share: 'screen-share settings (frame rate, resolution, codec, capture method)',
        call: 'call audio settings (noise suppression, gain, how many audio devices — never their names)',
        camera: 'camera settings (how many cameras — never their names)',
        notifications: 'notification settings and OS permission (on/off values only — never your keywords)',
    };
    lines.push(groups.length ? `Your ${groups.map(g => label[g]).join('; ')}` : 'Hardware acceleration on or off');
    if (spec.entitlement) lines.push('Your plan’s limits (e.g. the highest screen-share frame rate you can pick)');
    if (spec.webrtc) lines.push('Call quality numbers from the last ~2 minutes of your current or most recent call: frame rates, resolution, codec and encoder, bitrate, packet loss, round-trip time — tracks are labelled “screen-1”, “remote-video-1”, never with who they belong to');
    if (spec.crash) lines.push('The crash: which process, Electron’s reason code and exit code, and the error name, message and stack with personal details removed');
    if (spec.recentErrors) lines.push(`Up to ${DIAGNOSTIC_LIMITS.maxRecentErrors} recent app errors, with personal details removed`);
    if (spec.callEvents) lines.push(`The last ${DIAGNOSTIC_LIMITS.maxCallEvents} call events: what the call engine decided (connection type and whether a relay was used, codec choices and fallbacks, quality-limit changes, freezes) — with tracks labelled “self-camera” or “remote-video-1”, never who they belong to`);
    lines.push(`The last ${spec.perfRows} Performance log rows (freezes, window and power events, CPU and memory use)`);
    return lines;
}

/**
 * Highest screen-share fps this account may pick. The picker
 * (ScreenSharePickerModal) offers 15 / 30 / 60 / 90 to everyone who can share
 * at all; screen sharing itself is gated on `canPublishVideo` (Pro or trial —
 * ControlBar routes a free account to the upgrade sheet, and the LiveKit token
 * allows audio only). So the ceiling is 90 when canPublishVideo, else 0. The
 * annotation pins 90 to the picker's own frameRate union: if the top choice
 * ever changes, this stops compiling instead of silently reporting a stale 90.
 */
export const TOP_SCREEN_SHARE_FPS: ScreenShareOptions['frameRate'] = 90;
export function maxScreenShareFps(canPublishVideo: boolean): number {
    return canPublishVideo ? TOP_SCREEN_SHARE_FPS : 0;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface PerfLogInput { at: number; source: PerfRow['source']; ms: number; activity: string }
export type { CallEventInput } from './callEventsSource';
export interface RecentErrorInput { at: number; kind: RecentError['kind']; name?: string; message: string; stack?: string }

export interface BundleInput {
    category: DiagnosticCategory;
    trigger: DiagnosticTrigger;
    /** ms since epoch — becomes `generated_at`; every `t_s` is relative to it. */
    now: number;
    description?: string;
    replyEmail?: string;
    system: SystemInfo;
    settings: SettingsSnapshot;
    entitlement?: { isPaid: boolean; canPublishVideo: boolean; maxUploadBytes: number } | null;
    /** Any order; newest are kept. */
    perfLog?: readonly PerfLogInput[];
    webrtc?: WebrtcSummary | null;
    crash?: CrashInfo | null;
    recentErrors?: readonly RecentErrorInput[];
    /** The call engine's event log (callEventsSource.ts). Any order; newest are kept. */
    callEvents?: readonly CallEventInput[];
    scrub: { sensitiveTerms: readonly string[]; homeDir?: string };
}

export interface BuiltReport {
    body: DiagnosticReportBody;
    /** UTF-8 bytes of JSON.stringify(body.payload). */
    payloadBytes: number;
    /** UTF-8 bytes of JSON.stringify(body) — what is uploaded. */
    bodyBytes: number;
    /** Sections that were trimmed to fit the size limit. */
    trimmed: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const KEY_OK = /^[a-z][a-z0-9_]{0,63}$/;
const EMAIL_OK = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const tS = (at: number, now: number) => Math.round(((at - now) / 1000) * 10) / 10;
const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

function flattenSettings(snapshot: SettingsSnapshot, groups: readonly SettingsGroup[]): Record<string, SettingsValue> {
    const out: Record<string, SettingsValue> = {};
    for (const g of groups) {
        for (const [k, v] of Object.entries(snapshot[g] ?? {})) {
            if (!KEY_OK.test(k) || k in out) continue;
            if (v === null || typeof v === 'boolean') out[k] = v;
            else if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; }
            else if (typeof v === 'string') out[k] = v.slice(0, 64);
            // objects / arrays are not settings — dropped, never stringified
        }
    }
    return out;
}

const CALL_EVENT_NAME_RE = DIAGNOSTIC_VERBATIM_KEYS.event;
const CALL_EVENT_DETAIL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
/**
 * `detail` string values that are plain technical vocabulary (ICE types,
 * codecs, limitation reasons, …). Only these join the "structured strings"
 * that suppress colliding sensitive terms — so a friend called "relay" does not
 * turn `type: relay` into `<name>`. Every other `detail` string stays subject to
 * every term: the producer is not trusted to keep an identity out of it.
 */
const CALL_EVENT_VOCAB = /^(?:relay|host|srflx|prflx|udp|tcp|tls|none|cpu|bandwidth|other|vp8|vp9|av1|h\.?26[45]|hevc|opus|red|simulcast|svc|true|false|auto|hardware|software|accepted|declined|offered|ignored|camera|screen|video|audio|mic)$/i;

/**
 * Validate, order, cap and shape the call-event log: newest
 * DIAGNOSTIC_LIMITS.maxCallEvents kept; an event whose name is not a snake_case
 * identifier is dropped whole; `detail` keeps only short scalars (boolean,
 * finite number, string ≤ maxCallEventDetailChars) under identifier keys, at
 * most maxCallEventDetailKeys of them — nested values are dropped, never
 * stringified. Strings are scrubbed afterwards by scrubDeep, like everything else.
 */
export function shapeCallEvents(input: readonly CallEventInput[] | undefined, now: number): CallEvent[] {
    const ok = (input ?? []).filter(e => e && typeof e.t === 'number' && Number.isFinite(e.t)
        && typeof e.kind === 'string' && CALL_EVENT_NAME_RE.test(e.kind));
    const kept = [...ok].sort((a, b) => a.t - b.t).slice(-DIAGNOSTIC_LIMITS.maxCallEvents);
    return kept.map(e => {
        const detail: Record<string, string | number | boolean> = {};
        let n = 0;
        if (e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail)) {
            for (const [k, v] of Object.entries(e.detail)) {
                if (n >= DIAGNOSTIC_LIMITS.maxCallEventDetailKeys) break;
                if (!CALL_EVENT_DETAIL_KEY_RE.test(k)) continue;
                if (typeof v === 'boolean') detail[k] = v;
                else if (typeof v === 'number') { if (!Number.isFinite(v)) continue; detail[k] = Math.round(v * 1000) / 1000; }
                else if (typeof v === 'string') { if (v.length === 0 || v.length > DIAGNOSTIC_LIMITS.maxCallEventDetailChars) continue; detail[k] = v; }
                else continue;
                n++;
            }
        }
        return { t_s: tS(e.t, now), event: e.kind, ...(n > 0 ? { detail } : {}) };
    });
}

/** Every string in the raw payload that our code or the OS produced (not free text). */
function structuredStrings(raw: DiagnosticPayload): string[] {
    const out = new Set<string>();
    const freeText = new Set(['message', 'stack']);
    const walk = (v: unknown, key: string | null): void => {
        if (key === 'detail' && v && typeof v === 'object') {
            // call_events[].detail is producer-supplied: only plain vocabulary counts as structured.
            for (const x of Object.values(v)) if (typeof x === 'string' && CALL_EVENT_VOCAB.test(x)) out.add(x);
            return;
        }
        if (typeof v === 'string') { if (!key || !freeText.has(key)) out.add(v); return; }
        if (Array.isArray(v)) { for (const x of v) walk(x, null); return; }
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(raw, null);
    return [...out];
}

// ── The builder ──────────────────────────────────────────────────────────────

export function buildDiagnosticReport(input: BundleInput): BuiltReport {
    const spec = CATEGORY_SPEC[input.category];
    const now = input.now;

    const raw: DiagnosticPayload = {
        generated_at: new Date(now).toISOString(),
        trigger: input.trigger,
        system: input.system,
        settings: flattenSettings(input.settings, spec.settings),
    };

    if (spec.entitlement && input.entitlement) {
        const e: EntitlementInfo = {
            is_paid: input.entitlement.isPaid,
            can_publish_video: input.entitlement.canPublishVideo,
            max_screen_share_fps: maxScreenShareFps(input.entitlement.canPublishVideo),
            max_upload_mb: Math.round(input.entitlement.maxUploadBytes / (1024 * 1024)),
        };
        raw.entitlement = e;
    }

    const perfAll = [...(input.perfLog ?? [])].filter(r => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
    const perfKept = perfAll.slice(-Math.min(spec.perfRows, DIAGNOSTIC_LIMITS.maxPerfRows));
    raw.perf_log = {
        total_rows: perfAll.length,
        rows: perfKept.map(r => ({ t_s: tS(r.at, now), source: r.source, ms: Math.round(r.ms), activity: r.activity })),
    };

    if (spec.webrtc) {
        const w = input.webrtc ?? { call_active: false, samples: [] };
        raw.webrtc = { ...w, samples: w.samples.slice(-DIAGNOSTIC_LIMITS.maxWebrtcSamples) };
    }

    if (spec.callEvents) raw.call_events = shapeCallEvents(input.callEvents, now);

    if (spec.crash && input.crash) raw.crash = { ...input.crash };

    if (spec.recentErrors) {
        const errs = [...(input.recentErrors ?? [])].sort((a, b) => a.at - b.at).slice(-DIAGNOSTIC_LIMITS.maxRecentErrors);
        raw.recent_errors = errs.map(e => ({
            t_s: tS(e.at, now),
            kind: e.kind,
            ...(e.name ? { name: e.name } : {}),
            message: e.message,
            ...(e.stack ? { stack: e.stack } : {}),
        }));
    }

    // 2–3. Scrub.
    const terms = filterTermsAgainstStructured(input.scrub.sensitiveTerms, structuredStrings(raw));
    const scrubber = createScrubber({ sensitiveTerms: terms, homeDir: input.scrub.homeDir });
    const payload = scrubDeep(raw, scrubber, DEFAULT_DEEP_LIMITS, DIAGNOSTIC_VERBATIM_KEYS) as DiagnosticPayload;

    // 4. Fit.
    const trimmed = fitPayload(payload, DIAGNOSTIC_LIMITS.maxPayloadBytes);

    const description = input.description?.trim()
        ? scrubber.text(input.description.trim(), DIAGNOSTIC_LIMITS.maxDescriptionChars)
        : '';
    const reply = input.replyEmail?.trim() ?? '';

    const body: DiagnosticReportBody = {
        schema: 1,
        category: input.category,
        ...(description ? { description } : {}),
        ...(reply && reply.length <= DIAGNOSTIC_LIMITS.maxReplyEmailChars && EMAIL_OK.test(reply) ? { reply_email: reply } : {}),
        app_version: payload.system.app_version,
        platform: payload.system.platform,
        os_version: payload.system.os_version,
        payload,
    };
    return { body, payloadBytes: bytes(payload), bodyBytes: bytes(body), trimmed };
}

/** Is this a plausible reply address? (the UI validates before building) */
export function isValidReplyEmail(s: string): boolean {
    const t = s.trim();
    return t.length > 0 && t.length <= DIAGNOSTIC_LIMITS.maxReplyEmailChars && EMAIL_OK.test(t);
}

/**
 * Trim an already-scrubbed payload until it fits. Oldest first, in order of
 * how much each section is worth to a support engineer. Mutates; returns the
 * names of the sections it touched.
 */
export function fitPayload(p: DiagnosticPayload, max: number): string[] {
    const trimmed = new Set<string>();
    const over = () => bytes(p) > max;
    let guard = 0;
    while (over() && guard++ < 200) {
        if (p.perf_log && p.perf_log.rows.length > 20) {
            p.perf_log.rows = p.perf_log.rows.slice(Math.ceil(p.perf_log.rows.length / 2));
            trimmed.add('perf_log');
        } else if (p.call_events && p.call_events.length > 60) {
            p.call_events = p.call_events.slice(Math.ceil(p.call_events.length / 2));
            trimmed.add('call_events');
        } else if (p.webrtc && p.webrtc.samples.length > 6) {
            p.webrtc.samples = p.webrtc.samples.slice(Math.ceil(p.webrtc.samples.length / 2));
            trimmed.add('webrtc');
        } else if (p.recent_errors?.some(e => e.stack)) {
            p.recent_errors = p.recent_errors.map(e => { const c = { ...e }; delete c.stack; return c; });
            trimmed.add('recent_errors');
        } else if (p.webrtc?.samples.some(s => s.inbound.length > 2)) {
            p.webrtc.samples = p.webrtc.samples.map(s => ({ ...s, inbound: s.inbound.slice(0, 2) }));
            trimmed.add('webrtc');
        } else if (p.crash?.stack && p.crash.stack.length > 2000) {
            p.crash.stack = p.crash.stack.slice(0, 1999) + '…';
            trimmed.add('crash');
        } else if (p.recent_errors && p.recent_errors.length > 5) {
            p.recent_errors = p.recent_errors.slice(-5);
            trimmed.add('recent_errors');
        } else if (p.perf_log && p.perf_log.rows.length > 0) {
            p.perf_log.rows = p.perf_log.rows.slice(Math.ceil(p.perf_log.rows.length / 2));
            trimmed.add('perf_log');
        } else if (p.webrtc && p.webrtc.samples.length > 0) {
            p.webrtc.samples = p.webrtc.samples.slice(1);
            trimmed.add('webrtc');
        } else if (p.call_events && p.call_events.length > 0) {
            p.call_events = p.call_events.slice(Math.ceil(p.call_events.length / 2));
            trimmed.add('call_events');
        } else {
            break;
        }
    }
    return [...trimmed];
}

/** The exact text "Save to file" writes (pretty JSON of the same body). */
export function reportFileText(body: DiagnosticReportBody): string {
    return JSON.stringify(body, null, 2) + '\n';
}
