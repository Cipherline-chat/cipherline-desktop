import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    logCallEvent, getCallEvents, clearCallEvents, markCallStart, markCallEnd, trackPlaceholder, formatCallEvents,
    validateCallEvent, CALL_EVENT_KINDS, MAX_EVENTS, MAX_AGE_MS, COALESCE_MS, type CallEventKind,
} from './callEventLog';

let clock = 0;
const EPOCH = 1_791_000_000_000;
beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(Date, 'now').mockImplementation(() => EPOCH + clock);
    clearCallEvents();
});
afterEach(() => vi.restoreAllMocks());

describe('ring buffer', () => {
    it(`keeps at most ${MAX_EVENTS} events, oldest dropped first`, () => {
        for (let i = 0; i < MAX_EVENTS + 120; i++) { clock += COALESCE_MS + 1; logCallEvent('camera_codec', { n: i }); }
        const ev = getCallEvents();
        expect(ev).toHaveLength(MAX_EVENTS);
        expect(ev[0].detail?.n).toBe(120);
        expect(ev[ev.length - 1].detail?.n).toBe(MAX_EVENTS + 119);
    });

    it('drops events older than MAX_AGE_MS', () => {
        logCallEvent('call_join', { participants: 2 });
        clock += MAX_AGE_MS + 1;
        logCallEvent('call_leave', { participants: 1 });
        expect(getCallEvents().map(e => e.kind)).toEqual(['call_leave']);
    });

    it('clearCallEvents (sign-out) empties it', () => {
        logCallEvent('call_join', { participants: 2 });
        clearCallEvents();
        expect(getCallEvents()).toEqual([]);
    });
});

describe('shape and sanitising', () => {
    it('entries are exactly { t, kind, detail? } with t = epoch ms (Date.now)', () => {
        clock = 7_500;
        logCallEvent('call_join', { participants: 3 });
        logCallEvent('reconnecting');
        const [a, b] = getCallEvents();
        expect(a).toEqual({ t: EPOCH + 7500, kind: 'call_join', detail: { participants: 3 } });
        expect(b).toEqual({ t: EPOCH + 7500, kind: 'reconnecting' });
        expect(Object.keys(b)).toEqual(['t', 'kind']);
    });

    it('detail: scalars only, strings 1–64 chars, no NaN, snake_case keys, no reserved keys, ≤ 12 keys', () => {
        logCallEvent('camera_codec', {
            codec: 'h264', ok: true, kbps: 1234.567, bad: Number.NaN, empty: '',
            reason: 'x'.repeat(200), camelCase: 1, kind: 'x', source: 'camera',
            // @ts-expect-error objects are not allowed
            nested: { a: 1 },
        });
        const d = getCallEvents()[0].detail!;
        expect(d).toEqual({ codec: 'h264', ok: true, kbps: 1234.57, reason: 'x'.repeat(64) });
        const many: Record<string, number> = {};
        for (let i = 0; i < 20; i++) many[`k${i}`] = i;
        clock += COALESCE_MS + 1;
        logCallEvent('camera_codec', many);
        expect(Object.keys(getCallEvents()[1].detail!).length).toBeLessThanOrEqual(12);
        for (const e of getCallEvents()) expect(validateCallEvent(e)).toEqual([]);
    });

    it('validateCallEvent enforces the reporter contract', () => {
        const t = EPOCH;
        expect(validateCallEvent({ t, kind: 'ice_route', detail: { type: 'relay', turn: true } })).toEqual([]);
        expect(validateCallEvent({ t: 1234, kind: 'call_join' })).toContain('t is not epoch ms');
        expect(validateCallEvent({ t, kind: 'Bad-Kind' }).length).toBeGreaterThan(0);
        expect(validateCallEvent({ t, kind: 'quality_limitation', detail: { to: 'slow' } })).toContain('quality_limitation.to');
        expect(validateCallEvent({ t, kind: 'camera_fallback', detail: { to: 'vp8' } })).toContain('fallback from/to');
        expect(validateCallEvent({ t, kind: 'ice_route', detail: { turn: true } })).toContain('ice_route.type');
        expect(validateCallEvent({ t, kind: 'freeze_start', detail: { track: 'remote-screen-1' } })).toContain('track ref remote-screen-1');
        expect(validateCallEvent({ t, kind: 'freeze_start', detail: { track: 'remote-video-3' } })).toEqual([]);
        expect(validateCallEvent({ t, kind: 'camera_codec', detail: { source: 'x' } })).toContain('reserved key source');
        expect(validateCallEvent({ t, kind: 'camera_codec', detail: { camelKey: 1 } })).toContain('key camelKey');
        expect(validateCallEvent({ t, kind: 'camera_codec', detail: { s: '' } })).toContain('value of s');
    });

    it('every kind satisfies the kind pattern; freeze kinds say freeze; H.265 kinds say h265', () => {
        for (const k of CALL_EVENT_KINDS) expect(k).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        expect(CALL_EVENT_KINDS.filter(k => k.startsWith('freeze'))).toEqual(['freeze_start', 'freeze_end']);
        expect(CALL_EVENT_KINDS.filter(k => k.startsWith('h265'))).toEqual(['h265_caps', 'h265_switch']);
    });

    it('unknown kinds are dropped (the kind list is the contract)', () => {
        logCallEvent('not_a_kind' as CallEventKind);
        expect(getCallEvents()).toEqual([]);
    });

    it('getCallEvents returns copies', () => {
        logCallEvent('camera_codec', { codec: 'vp8' });
        getCallEvents()[0].detail!.codec = 'tampered';
        expect(getCallEvents()[0].detail!.codec).toBe('vp8');
    });
});

describe('coalescing', () => {
    it('identical repeats within 2 s collapse into one entry with a repeat count', () => {
        for (let i = 0; i < 5; i++) { logCallEvent('freeze_start', { track: 'remote-video-1' }); clock += 300; }
        const ev = getCallEvents();
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ track: 'remote-video-1', repeat: 5 });
    });

    it('noisy kinds coalesce even with changing detail (latest wins)', () => {
        logCallEvent('participants', { count: 3 });
        clock += 500;
        logCallEvent('participants', { count: 4 });
        expect(getCallEvents()).toEqual([{ t: expect.any(Number), kind: 'participants', detail: { count: 4, repeat: 2 } }]);
    });

    it('non-noisy kinds with different detail stay separate; anything after 2 s is new', () => {
        logCallEvent('camera_codec', { codec: 'h264' });
        logCallEvent('camera_codec', { codec: 'vp8' });
        clock += COALESCE_MS + 1;
        logCallEvent('camera_codec', { codec: 'vp8' });
        expect(getCallEvents()).toHaveLength(3);
    });
});

describe('placeholders', () => {
    it('stable per call, numbered per kind, never the key', () => {
        markCallStart();
        expect(trackPlaceholder('TR_abc', 'remote-video')).toBe('remote-video-1');
        expect(trackPlaceholder('TR_def', 'remote-video')).toBe('remote-video-2');
        expect(trackPlaceholder('TR_abc', 'remote-video')).toBe('remote-video-1');
        expect(trackPlaceholder('TR_xyz', 'remote-screen')).toBe('remote-video-3'); // one remote namespace (reporter scheme)
        expect(trackPlaceholder('anything', 'self-camera')).toBe('self-camera');
        markCallEnd();
        markCallStart();
        expect(trackPlaceholder('TR_def', 'remote-video')).toBe('remote-video-1');
    });

    it('formatCallEvents renders one line per event (UTC clock time)', () => {
        logCallEvent('camera_codec', { codec: 'h264', hardware: true });
        expect(formatCallEvents(getCallEvents())).toMatch(/^\d\d:\d\d:\d\d\.\d{3} camera_codec codec=h264 hardware=true$/);
    });
});

/**
 * Privacy guard: every logCallEvent call site in the app must pass a LITERAL
 * kind from the list and a literal detail object whose keys are all on this
 * allowlist. Anything that could identify a person (identity, sid, name,
 * label, device, room, user, email, ip, address, text…) fails the build.
 */
const ALLOWED_KEYS = new Set([
    'participants', 'count', 'pc', 'type', 'local', 'remote', 'turn', 'protocol',
    'width', 'height', 'fps', 'tier', 'cap_tier', 'why',
    'codec', 'profile', 'hardware', 'reason', 'verdict', 'from', 'to',
    'layers', 'top', 'top_kbps', 'low', 'mode',
    'res', 'lighter_copy', 'on', 'viewers',
    'track', 'prev_seconds', 'ms', 'quality', 'role', 'size',
    'cap', 'decoded', 'avatars',
    'encode', 'decode', 'network', 'sources', 'decoding', 'drop_pct', 'decode_ms',
    'offer', 'answer',
    'capable', 'total', 'self_encode',
    // Share picker timings (ScreenSharePickerModal): durations and a cache flag only.
    'open_ms', 'list_ms', 'preview_ms', 'cached', 'tab',
    // Share start stages (SidebarConference.startScreenShareFrom): durations only.
    'probe_ms', 'publish_ms',
    // A/V sync (avSyncMonitor.ts, SidebarConference share-audio ring). `slot`
    // is a per-call placeholder (remote-av-N) built in avSyncMonitor, never an identity.
    'slot', 'stream', 'path', 'chain', 'offset_ms', 'uncertainty_ms', 'audio_path_ms', 'video_path_ms',
    'web_audio_extra_ms', 'base_latency_ms', 'output_latency_ms', 'sample_rate', 'dropped_ms', 'trims',
    // E2EE frame health (e2eeWorkerStats.ts): frame counts only.
    'frames', 'rewritten', 'short_sc', 'leading', 'key_rewritten', 'delta_rewritten',
    // Annotation overlay / transport health (desktopAnnotationOverlay.ts,
    // useAnnotationTransport.ts, e2eeWorkerStats.ts): outcome + reason enums,
    // share KIND (screen|window), a display COUNT, booleans.
    'result', 'how', 'share', 'captured', 'displays', 'addon',
]);
const FORBIDDEN = /[iI]dentity|^sid$|Sid|[nN]ame|[lL]abel|[dD]evice|[rR]oom|[uU]ser|[eE]mail|^ip$|^ip[A-Z]|IP|[aA]ddr|[tT]ext|[tT]itle|[mM]essage|[mM]etadata/;

/** Keys of a detail object literal: `key: value` and shorthand `key`. */
function detailKeys(body: string): string[] {
    const colon = [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(k => k[1]);
    const shorthand = body.split(',').map(t => t.trim()).filter(t => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    return [...new Set([...colon, ...shorthand])];
}

const stripPlaceholders = (body: string) => body.replace(/trackPlaceholder\([^)]*\)/g, '');
const READS_IDENTITY = /\.(identity|name|sid|trackSid|metadata|attributes|label|deviceId)\b/;

function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
    }
    return out;
}

describe('call-site privacy scan', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = walk(src).filter(f => !f.endsWith('callEventLog.ts'));
    const sites: { file: string; kind: string; keys: string[]; body: string }[] = [];
    for (const f of files) {
        const text = readFileSync(f, 'utf8');
        const re = /logCallEvent\(\s*'([a-z0-9_]+)'\s*(?:,\s*\{([\s\S]*?)\}\s*)?\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const body = m[2] ?? '';
            // keys = identifiers before ':' at the top level of the literal
            sites.push({ file: relative(src, f), kind: m[1], keys: detailKeys(body), body });
        }
        // Every call must have a literal kind (no variables).
        const all = text.match(/logCallEvent\(/g)?.length ?? 0;
        const literal = text.match(/logCallEvent\(\s*'[a-z0-9_]+'/g)?.length ?? 0;
        expect({ file: relative(src, f), nonLiteral: all - literal }).toEqual({ file: relative(src, f), nonLiteral: 0 });
    }

    it('finds the call sites (positive control)', () => {
        expect(sites.length).toBeGreaterThan(20);
        expect(new Set(sites.map(s => s.file)).size).toBeGreaterThanOrEqual(6);
    });

    it('the A/V-sync call sites are part of the scan (merged from the av-sync stand-in log)', () => {
        const kinds = new Set(sites.map(s => s.kind));
        for (const k of ['av_sync_offset', 'av_sync_playback_path', 'av_sync_webaudio_latency', 'av_sync_ss_audio_trim']) expect(kinds).toContain(k);
    });

    it('every kind used is on the published list', () => {
        for (const s of sites) expect(CALL_EVENT_KINDS as readonly string[]).toContain(s.kind);
    });

    it('every detail key is snake_case per the reporter contract', () => {
        const bad = sites.flatMap(s => s.keys.filter(k => !/^[a-z][a-z0-9_]{0,31}$/.test(k) || ['kind', 'source', 'quality_limitation_reason'].includes(k)).map(k => `${s.file}: ${s.kind}.${k}`));
        expect(bad).toEqual([]);
    });

    it('literal track refs use only the reporter placeholders', () => {
        const refs = sites.flatMap(s => [...s.body.matchAll(/track:\s*'([^']+)'/g)].map(m => m[1]));
        expect(refs.length).toBeGreaterThan(0);
        for (const r of refs) expect(r).toMatch(/^(self-camera|self-screen|self-screen-audio|self-mic)(-\d+)?$|^remote-video-\d+$/);
    });

    it('every detail key is allowlisted and none looks identifying', () => {
        const bad = sites.flatMap(s => s.keys.filter(k => !ALLOWED_KEYS.has(k) || FORBIDDEN.test(k)).map(k => `${s.file}: ${s.kind}.${k}`));
        expect(bad).toEqual([]);
    });

    it('no detail VALUE reads an identity, name, sid or metadata (track refs only via trackPlaceholder)', () => {
        const bad = sites.filter(s => READS_IDENTITY.test(stripPlaceholders(s.body)));
        expect(bad.map(s => `${s.file}: ${s.kind}`)).toEqual([]);
    });

    it('the scan itself catches identifying keys and values (negative controls)', () => {
        const flagged = (b: string) => detailKeys(b).filter(k => !ALLOWED_KEYS.has(k) || FORBIDDEN.test(k));
        expect(flagged("identity: p.identity, codec: 'h264'")).toEqual(['identity']);
        expect(flagged('codec, deviceLabel')).toEqual(['deviceLabel']);
        expect(READS_IDENTITY.test(stripPlaceholders('track: pub.trackSid'))).toBe(true);
        expect(READS_IDENTITY.test(stripPlaceholders("track: trackPlaceholder(pub.trackSid, 'remote-video')"))).toBe(false);
    });
});
